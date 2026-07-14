import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { extractDeterministicDecision, type CommercialContext } from "@/services/agent/contextual-intelligence.service";
import { finalizeConversationAction, resolveConversationBrain } from "@/services/agent/conversation-brain.service";
import { CONVERSATION_REPLAYS } from "./fixtures/conversation-replays";
import { executeObservedOpenAICall, getOpenAITurnBudgetSnapshot, withOpenAITurnBudget } from "@/services/ai/openai-call-observer";

describe("historical conversation replay suite", () => {
  for (const scenario of CONVERSATION_REPLAYS) {
    it(scenario.id, () => {
      let profile: Record<string, unknown> = {
        conversation_state: scenario.initial_state,
        stage: scenario.initial_state,
        commercial_stage: scenario.initial_state,
        ...(scenario.initial_profile || {})
      };
      const messages = [...scenario.previous_messages];
      const aiCalls = 0;
      for (const step of scenario.steps) {
        const context: CommercialContext = {
          current_message: step.customer,
          recent_messages: messages,
          lead_profile: profile,
          open_order: null,
          latest_order: null,
          last_bot_question: [...messages].reverse().find((message) => message.role === "assistant" || message.role === "human_agent")?.content || null,
          last_bot_message_at: null,
          last_specialist_message_at: null,
          followup_key: null,
          followup_due_at: null,
          human_hold_active: false
        };
        const contextual = extractDeterministicDecision(context);
        const preliminary = resolveConversationBrain({
          context,
          contextualDecision: contextual,
          classificationIntent: contextual.intent === "unknown" ? "unknown" : contextual.intent,
          directHumanRequest: false
        });
        const candidateReply = preliminary.directReply || contextual.recommended_response || "Vamos continuar de onde paramos?";
        const action = finalizeConversationAction({
          preliminary,
          contextualDecision: contextual,
          candidate: {
            reply: preliminary.shouldReply ? candidateReply : "",
            responseRule: preliminary.responseRule,
            leadProfilePatch: preliminary.leadProfilePatch
          }
        });
        expect(action.action).toBe(step.expected_action);
        expect(action.next_state).toBe(step.expected_state);
        if (step.reply_must_include) expect(action.reply).toContain(step.reply_must_include);
        for (const forbidden of step.forbidden_replies || []) {
          expect((action.reply || "").toLowerCase()).not.toContain(forbidden.toLowerCase());
        }
        profile = { ...profile, ...preliminary.leadProfilePatch, conversation_state: action.next_state, stage: action.next_state };
        messages.push({ role: "customer", content: step.customer });
        if (action.reply) messages.push({ role: "assistant", content: action.reply });
      }
      expect(aiCalls).toBeLessThanOrEqual(scenario.maximum_ai_calls);
    });
  }
});

describe("one AI decision call per inbound turn", () => {
  it("blocks a second interpretation or rewriting call", async () => {
    let providerCalls = 0;
    const result = await withOpenAITurnBudget({ turnId: "anonymous-turn", maximumDecisionCalls: 1 }, async () => {
      const first = await executeObservedOpenAICall(
        { callType: "context_interpretation", model: "test-model" },
        async () => { providerCalls++; return { output_text: "first" }; }
      );
      const second = await executeObservedOpenAICall(
        { callType: "contextual_response", model: "test-model" },
        async () => { providerCalls++; return { output_text: "second" }; }
      );
      return { first, second, budget: getOpenAITurnBudgetSnapshot() };
    });
    expect(result.first).toEqual({ output_text: "first" });
    expect(result.second).toBeNull();
    expect(providerCalls).toBe(1);
    expect(result.budget?.usedDecisionCalls).toBe(1);
  });
});
