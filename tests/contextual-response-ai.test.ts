import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const openAIResponsesCreate = vi.fn();

vi.mock("@/lib/openai/client", () => ({
  createOpenAIClient: () => ({ responses: { create: openAIResponsesCreate } }),
  getSalesAgentOpenAIModel: () => "test-contextual-model",
  getStrongSalesAgentOpenAIModel: () => "test-contextual-strong-model"
}));

vi.mock("@/services/ai/openai-call-observer", () => ({
  executeObservedOpenAICall: async (_metadata: unknown, call: () => Promise<unknown>) => call()
}));

import {
  ContextualResponseAIService,
  extractDirectiveContract,
  extractRequiredArtifacts,
  validateResponseAgainstDirectiveContract
} from "@/services/agent/contextual-response-ai.service";

describe("ContextualResponseAIService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENAI_API_KEY", "test-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes the final reply with AI after consulting identity, guardrails and relevant Obsidian knowledge", async () => {
    const knowledgeService = createKnowledgeService();
    openAIResponsesCreate.mockResolvedValueOnce({
      output_text: JSON.stringify({
        reply: "Oi! Me conta se voce ja conhece a UNITV ou se quer entender como funciona primeiro."
      })
    });
    const service = new ContextualResponseAIService(knowledgeService as never);

    const result = await service.generateResponse({
      currentMessage: "Oi, quero saber mais",
      intent: "greeting",
      leadProfile: { stage: "new_lead" },
      recentMessages: [{ role: "customer", content: "Oi, quero saber mais" }],
      responseDirective: "Cumprimentar e descobrir se o cliente ja usa o aplicativo.",
      conversationId: "conversation-id",
      operationalContext: {
        specialist_pattern: "manter_etapa_atual",
        specialist_action: "responder_duvida_especifica",
        specialist_style: "curto_e_contextual"
      }
    });

    expect(result).toBe("Oi! Me conta se voce ja conhece a UNITV ou se quer entender como funciona primeiro.");
    expect(knowledgeService.getKnowledgeByCategory).toHaveBeenCalledWith("identidade_do_agente");
    expect(knowledgeService.getKnowledgeByCategory).toHaveBeenCalledWith("o_que_nunca_fazer");
    expect(knowledgeService.searchKnowledge).toHaveBeenCalled();
    const request = openAIResponsesCreate.mock.calls[0][0];
    const userContext = JSON.parse(request.input[1].content[0].text);
    expect(request.model).toBe("test-contextual-model");
    expect(request.max_output_tokens).toBe(140);
    expect(request.reasoning).toEqual({ effort: "low" });
    expect(userContext.writing_contract.programmed_copy_forbidden).toBe(true);
    expect(userContext.operational_directive_not_customer_copy).toBeUndefined();
    expect(userContext.operational_context).toEqual(expect.objectContaining({
      specialist_pattern: "manter_etapa_atual",
      specialist_action: "responder_duvida_especifica",
      specialist_style: "curto_e_contextual"
    }));
    expect(userContext.knowledge_base.map((article: { category: string }) => article.category)).toEqual(
      expect.arrayContaining(["identidade_do_agente", "o_que_nunca_fazer", "fluxo_comercial"])
    );
  });

  it("blocks the programmed directive when OpenAI is unavailable", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const service = new ContextualResponseAIService(createKnowledgeService() as never);

    const result = await service.generateResponse({
      currentMessage: "Oi",
      intent: "greeting",
      leadProfile: {},
      responseDirective: "Oi, tudo bem? Voce ja usa o aplicativo?"
    });

    expect(result).toBeNull();
    expect(openAIResponsesCreate).not.toHaveBeenCalled();
  });

  it("rejects an AI response that drops an authorized payment artifact", async () => {
    openAIResponsesCreate.mockResolvedValueOnce({
      output_text: JSON.stringify({ reply: "Seu pagamento esta pronto. Pode abrir o link para continuar." })
    });
    const service = new ContextualResponseAIService(createKnowledgeService() as never);

    const result = await service.generateResponse({
      currentMessage: "quero pagar com cartao",
      intent: "card_payment",
      leadProfile: { stage: "awaiting_payment", selected_plan: "mensal" },
      responseDirective: "Pagamento autorizado no valor de R$ 25. Link: https://www.mercadopago.com.br/checkout/seguro"
    });

    expect(result).toBeNull();
    expect(extractRequiredArtifacts("R$ 25 https://www.mercadopago.com.br/checkout/seguro")).toEqual([
      "https://www.mercadopago.com.br/checkout/seguro",
      "R$ 25"
    ]);
    expect(openAIResponsesCreate.mock.calls[0][0].max_output_tokens).toBe(190);
  });

  it("preserves interest for today and blocks screen questions in the monthly offer", async () => {
    const directive = "O plano mensal fica em R$ 20,90.\n\nVoce tem interesse pra hoje?";
    const contract = extractDirectiveContract(directive);
    expect(validateResponseAgainstDirectiveContract(
      "Boa noite! O plano mensal fica em R$ 20,90. Se quiser, me diga em quantas telas voce pretende usar?",
      contract
    )).toBe(false);
    expect(validateResponseAgainstDirectiveContract(
      "Boa noite! O plano mensal fica em R$ 20,90. Voce tem interesse pra hoje?",
      contract
    )).toBe(true);

    openAIResponsesCreate.mockResolvedValueOnce({
      output_text: JSON.stringify({
        reply: "Boa noite! O plano mensal fica em R$ 20,90. Se quiser, me diga em quantas telas voce pretende usar?"
      })
    });
    const service = new ContextualResponseAIService(createKnowledgeService() as never);
    await expect(service.generateResponse({
      currentMessage: "Quanto e o mensal?",
      intent: "ask_price",
      leadProfile: { stage: "monthly_offer_pending", selected_plan: "mensal" },
      responseDirective: directive
    })).resolves.toBeNull();

    openAIResponsesCreate.mockResolvedValueOnce({
      output_text: JSON.stringify({
        reply: "Boa noite! O plano mensal fica em R$ 20,90. Voce tem interesse pra hoje?"
      })
    });
    await expect(service.generateResponse({
      currentMessage: "Quanto e o mensal?",
      intent: "ask_price",
      leadProfile: { stage: "monthly_offer_pending", selected_plan: "mensal" },
      responseDirective: directive
    })).resolves.toContain("interesse pra hoje");
  });
});

function createKnowledgeService() {
  const identity = {
    id: "obsidian:01_IDENTIDADE_DO_AGENTE.md",
    title: "Identidade do Agente",
    category: "identidade_do_agente",
    content: "Responder de forma humana, consultiva e contextual. Nunca copiar mensagem pronta."
  };
  const guardrails = {
    id: "obsidian:02_O_QUE_NUNCA_FAZER.md",
    title: "O Que Nunca Fazer",
    category: "o_que_nunca_fazer",
    content: "Nunca reiniciar conversa nem confirmar pagamento sem validacao real."
  };
  const relevant = {
    id: "obsidian:04_FLUXO_COMERCIAL.md",
    title: "Fluxo Comercial",
    category: "fluxo_comercial",
    content: "Em lead novo, entender primeiro o objetivo e conduzir uma acao por vez."
  };
  return {
    getKnowledgeByCategory: vi.fn(async (category: string) => category === "identidade_do_agente" ? [identity] : [guardrails]),
    searchKnowledge: vi.fn(async () => [relevant])
  };
}
