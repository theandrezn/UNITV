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

import { ContextualIntelligenceService } from "@/services/agent/contextual-intelligence.service";

describe("ContextualIntelligenceService economy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENAI_API_KEY", "test-key");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("uses one knowledge-grounded contextual call and returns a final reusable reply", async () => {
    openAIResponsesCreate.mockResolvedValueOnce({
      output_text: JSON.stringify({
        intent: "unknown",
        detected_intent: "UNKNOWN_BUT_CLARIFIABLE",
        stage: "qualified",
        selected_plan: null,
        payment_method: null,
        should_create_order: false,
        should_generate_pix: false,
        should_send_download: false,
        should_schedule_followup: false,
        should_reply: true,
        should_handoff: false,
        should_clarify: true,
        next_action: "clarify_intent",
        customer_message_meaning: "Cliente precisa esclarecer o objetivo.",
        reason: "A mensagem depende do contexto recente.",
        recommended_response: "Me conta onde voce travou para eu te orientar por aqui.",
        next_expected_reply: null,
        install_status: null,
        confidence: 0.86
      })
    });
    const knowledgeService = {
      getKnowledgeByCategory: vi.fn(async (category: string) => [{ id: category, title: category, category, content: `Regra operacional ${category}.` }]),
      searchKnowledge: vi.fn(async () => [{ id: "relevant", title: "Suporte", category: "suporte", content: "Pergunte onde o cliente travou e conduza uma etapa por vez." }])
    };
    const service = new ContextualIntelligenceService(knowledgeService as never);

    const result = await service.extract({
      context: {
        conversation_id: "conversation-id",
        current_message: "estou vendo isso aqui",
        recent_messages: [{ role: "assistant", content: "Em qual etapa voce esta?" }, { role: "customer", content: "estou vendo isso aqui" }],
        lead_profile: { stage: "qualified" },
        open_order: null,
        latest_order: null,
        last_bot_question: "Em qual etapa voce travou?",
        last_bot_message_at: null,
        last_specialist_message_at: null,
        followup_key: null,
        followup_due_at: null,
        human_hold_active: false
      }
    });

    expect(result.source).toBe("ai");
    expect(result.recommended_response).toContain("onde voce travou");
    expect(openAIResponsesCreate).toHaveBeenCalledTimes(1);
    const request = openAIResponsesCreate.mock.calls[0][0];
    const compactContext = JSON.parse(request.input[1].content[0].text);
    expect(compactContext.knowledge_base).toHaveLength(3);
    expect(compactContext.recent_messages).toHaveLength(2);
    expect(knowledgeService.searchKnowledge).toHaveBeenCalledTimes(1);
  });
});
