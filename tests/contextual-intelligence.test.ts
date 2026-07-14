import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const openAIResponsesCreate = vi.fn();

vi.mock("@/lib/openai/client", () => ({
  createOpenAIClient: () => ({ responses: { create: openAIResponsesCreate } }),
  getSalesAgentOpenAIModel: () => "gpt-5.4-mini",
  getStrongSalesAgentOpenAIModel: () => "gpt-5.4-mini"
}));

vi.mock("@/services/ai/openai-call-observer", () => ({
  executeObservedOpenAICall: async (_metadata: unknown, call: () => Promise<unknown>) => call()
}));

import {
  CONTEXTUAL_DECISION_SYSTEM_PROMPT,
  ContextualIntelligenceService,
  type CommercialContext
} from "@/services/agent/contextual-intelligence.service";

function makeContext(overrides: Partial<CommercialContext> = {}): CommercialContext {
  return {
    conversation_id: "conversation-id",
    current_message: "estou vendo isso aqui",
    recent_messages: [
      { role: "assistant", content: "Em qual etapa voce esta?" },
      { role: "customer", content: "estou vendo isso aqui" }
    ],
    lead_profile: { conversation_state: "price_discovery" },
    open_order: null,
    latest_order: null,
    last_bot_question: "Em qual etapa voce travou?",
    last_bot_message_at: null,
    last_specialist_message_at: null,
    followup_key: null,
    followup_due_at: null,
    human_hold_active: false,
    ...overrides
  };
}

describe("ContextualIntelligenceService ultra-low token path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENAI_API_KEY", "test-key");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("uses one compact call only for an ambiguous turn and expands the safe result locally", async () => {
    openAIResponsesCreate.mockResolvedValueOnce({
      output_text: JSON.stringify({
        action: "reply",
        intent: "unknown",
        next_state: "price_discovery",
        meaning: "Cliente precisa esclarecer o objetivo.",
        reason: "A mensagem depende do contexto recente.",
        reply: "Me conta onde voce travou para eu te orientar.",
        confidence: 0.86
      })
    });
    const service = new ContextualIntelligenceService();

    const result = await service.extract({
      context: makeContext(),
      specialistLearning: {
        pattern: "cliente_ja_instalou_nao_repetir_download",
        action: "reconhecer_contexto_e_avancar",
        style: "Curto e com uma pergunta."
      }
    });

    expect(result.source).toBe("ai");
    expect(result.recommended_response).toContain("onde voce travou");
    expect(result.should_generate_pix).toBe(false);
    expect(result.should_create_order).toBe(false);
    expect(openAIResponsesCreate).toHaveBeenCalledTimes(1);

    const request = openAIResponsesCreate.mock.calls[0][0];
    const compactContext = JSON.parse(request.input[1].content[0].text);
    expect(request.reasoning).toBeUndefined();
    expect(request.max_output_tokens).toBe(90);
    expect(request.text.format.schema.required).toEqual([
      "action", "intent", "next_state", "meaning", "reason", "reply", "confidence"
    ]);
    expect(compactContext.recent_messages).toHaveLength(2);
    expect(compactContext.profile).toEqual({});
    expect(compactContext.specialist_hint).toBe(
      "cliente_ja_instalou_nao_repetir_download | reconhecer_contexto_e_avancar"
    );
    expect(request.input[1].content[0].text.length).toBeLessThan(1_500);
    expect(CONTEXTUAL_DECISION_SYSTEM_PROMPT.length).toBeLessThan(1_000);
  });

  it("caps a bloated profile, history and specialist memory before the API request", async () => {
    openAIResponsesCreate.mockResolvedValueOnce({
      output_text: JSON.stringify({
        action: "reply",
        intent: "unknown",
        next_state: "price_discovery",
        meaning: "Duvida ambigua.",
        reason: "Precisa do contexto recente.",
        reply: "Me explica em uma frase o que apareceu para voce.",
        confidence: 0.8
      })
    });
    const long = "x".repeat(2_000);

    await new ContextualIntelligenceService().extract({
      context: makeContext({
        current_message: `duvida diferente ${long}`,
        recent_messages: Array.from({ length: 12 }, (_, index) => ({
          role: index % 2 ? "assistant" : "customer",
          content: `${index}-${long}`
        })),
        lead_profile: {
          conversation_state: "price_discovery",
          stage: long,
          commercial_stage: long,
          customer_stage: long,
          selected_plan: long,
          device: long,
          operating_system: long,
          compatibility_status: long,
          install_status: long,
          payment_status: long,
          payment_method: long,
          next_expected_reply: long,
          main_objection: long,
          unrelated_private_blob: long
        },
        last_bot_question: long
      }),
      specialistLearning: { pattern: long, action: long, style: long }
    });

    const requestText = openAIResponsesCreate.mock.calls[0][0].input[1].content[0].text;
    const compactContext = JSON.parse(requestText);
    expect(requestText.length).toBeLessThan(2_500);
    expect(compactContext.recent_messages).toHaveLength(2);
    expect(compactContext.profile).not.toHaveProperty("stage");
    expect(compactContext.profile).not.toHaveProperty("commercial_stage");
    expect(compactContext.profile).not.toHaveProperty("unrelated_private_blob");
  });

  it.each([
    ["obrigado", "silent"],
    ["quais os valores de todos os planos?", "reply"],
    ["quanto custa o trimestral?", "reply"],
    ["tem ESPN?", "reply"],
    ["quero renovar", "reply"],
    ["meu celular e Android", "reply"],
    ["vou usar uma TV Box", "reply"],
    ["LG antiga, nao deu certo", "silent"]
  ])("resolves '%s' without spending tokens", async (message, expectedAction) => {
    const result = await new ContextualIntelligenceService().extract({
      context: makeContext({ current_message: message })
    });

    expect(result.source).toBe("deterministic");
    expect(result.action).toBe(expectedAction);
    expect(result.confidence).toBeGreaterThanOrEqual(0.96);
    expect(openAIResponsesCreate).not.toHaveBeenCalled();
  });

  it("uses the fixed greeting only for a genuinely new conversation without history", async () => {
    const result = await new ContextualIntelligenceService().extract({
      context: makeContext({
        current_message: "oi",
        recent_messages: [],
        lead_profile: { conversation_state: "new_lead" },
        last_bot_question: null
      })
    });

    expect(result.source).toBe("deterministic");
    expect(result.next_state).toBe("welcome_sent");
    expect(result.recommended_response).toContain("Como posso ajudar?");
    expect(openAIResponsesCreate).not.toHaveBeenCalled();
  });
});
