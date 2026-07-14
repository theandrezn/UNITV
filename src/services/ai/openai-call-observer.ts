import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { AuditService } from "@/services/audit.service";

type OpenAIUsage = {
  input_tokens?: number | null;
  input_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number | null } | null;
  output_tokens?: number | null;
  output_tokens_details?: { reasoning_tokens?: number | null } | null;
  total_tokens?: number | null;
};

type OpenAICallInput = {
  callType: string;
  model: string;
  conversationId?: string | null;
  promptVersion?: string | null;
  promptCharacters?: number | null;
};

const QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
let circuitOpenUntil = 0;
const TURN_LIMITED_CALL_TYPES = new Set(["intent_classification", "context_interpretation", "sales_response", "contextual_response"]);
type OpenAITurnBudget = { turnId: string; maximumDecisionCalls: number; usedDecisionCalls: number };
const turnBudgetStorage = new AsyncLocalStorage<OpenAITurnBudget>();

export function withOpenAITurnBudget<T>(
  input: { turnId: string; maximumDecisionCalls?: number },
  operation: () => Promise<T>
) {
  return turnBudgetStorage.run({
    turnId: input.turnId,
    maximumDecisionCalls: input.maximumDecisionCalls ?? 1,
    usedDecisionCalls: 0
  }, operation);
}

export function getOpenAITurnBudgetSnapshot() {
  const budget = turnBudgetStorage.getStore();
  return budget ? { ...budget } : null;
}

export async function executeObservedOpenAICall<T>(
  input: OpenAICallInput,
  operation: () => Promise<T>
): Promise<T | null> {
  const turnBudget = turnBudgetStorage.getStore();
  if (turnBudget && TURN_LIMITED_CALL_TYPES.has(input.callType)) {
    if (turnBudget.usedDecisionCalls >= turnBudget.maximumDecisionCalls) {
      void recordOpenAICall(input, {
        outcome: "turn_budget_blocked",
        turn_id: turnBudget.turnId,
        turn_decision_calls: turnBudget.usedDecisionCalls
      });
      return null;
    }
    turnBudget.usedDecisionCalls += 1;
  }
  if (Date.now() < circuitOpenUntil) {
    void recordOpenAICall(input, { outcome: "circuit_open" });
    return null;
  }

  try {
    const response = await operation();
    circuitOpenUntil = 0;
    void recordOpenAICall(input, { outcome: "success", usage: readUsage(response) });
    return response;
  } catch (error) {
    const failure = readOpenAIFailure(error);
    if (failure.status === 429 || failure.code === "insufficient_quota") {
      circuitOpenUntil = Date.now() + QUOTA_COOLDOWN_MS;
    }
    void recordOpenAICall(input, { outcome: "error", ...failure });
    throw error;
  }
}

export function getOpenAICircuitOpenUntil() {
  return circuitOpenUntil || null;
}

export function resetOpenAICircuitForTests() {
  circuitOpenUntil = 0;
}

function readOpenAIFailure(error: unknown) {
  const candidate = error as { status?: unknown; code?: unknown; type?: unknown } | null;
  return {
    status: typeof candidate?.status === "number" ? candidate.status : null,
    code: typeof candidate?.code === "string" ? candidate.code : null,
    error_type: typeof candidate?.type === "string" ? candidate.type : null
  };
}

function readUsage(response: unknown): OpenAIUsage | null {
  const candidate = response as { usage?: OpenAIUsage | null } | null;
  return candidate?.usage || null;
}

async function recordOpenAICall(
  input: OpenAICallInput,
  result: {
    outcome: "success" | "error" | "circuit_open" | "turn_budget_blocked";
    usage?: OpenAIUsage | null;
    status?: number | null;
    code?: string | null;
    error_type?: string | null;
    turn_id?: string | null;
    turn_decision_calls?: number | null;
  }
) {
  try {
    await new AuditService().createAuditLog({
      actor_type: "ai_agent",
      action: "openai_usage",
      entity_type: isUuid(input.conversationId) ? "conversations" : "openai",
      entity_id: isUuid(input.conversationId) ? input.conversationId : null,
      metadata: {
        call_type: input.callType,
        model: input.model,
        prompt_version: input.promptVersion || null,
        prompt_characters: Number(input.promptCharacters || 0),
        outcome: result.outcome,
        input_tokens: Number(result.usage?.input_tokens || 0),
        cached_input_tokens: Number(result.usage?.input_tokens_details?.cached_tokens || 0),
        cache_write_tokens: Number(result.usage?.input_tokens_details?.cache_write_tokens || 0),
        output_tokens: Number(result.usage?.output_tokens || 0),
        reasoning_tokens: Number(result.usage?.output_tokens_details?.reasoning_tokens || 0),
        total_tokens: Number(result.usage?.total_tokens || 0),
        error_status: result.status || null,
        error_code: result.code || null,
        error_type: result.error_type || null,
        turn_id: result.turn_id || turnBudgetStorage.getStore()?.turnId || null,
        turn_decision_calls: result.turn_decision_calls ?? turnBudgetStorage.getStore()?.usedDecisionCalls ?? null
      }
    });
  } catch {
    // Observability must never block a customer response.
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
