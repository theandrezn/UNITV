import { describe, expect, it, vi } from "vitest";

import { afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const openAIClient = {
  responses: {
    create: vi.fn()
  },
  chat: {
    completions: {
      create: vi.fn()
    }
  }
};

vi.mock("@/lib/openai/client", () => ({
  createOpenAIClient: vi.fn(() => openAIClient),
  getDefaultOpenAIModel: vi.fn(() => "test-model"),
  getIntentOpenAIModel: vi.fn(() => "intent-test-model")
}));

import { createOpenAIClient } from "@/lib/openai/client";
import { IntentClassifierService } from "@/services/agent/intent-classifier.service";

describe("IntentClassifierService", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["oi", "greeting"],
    ["Olq", "greeting"],
    ["quero saber", "greeting"],
    ["Olá! Posso ter mais informações sobre isso?", "greeting"],
    ["Tenho interesse", "greeting"],
    ["quero fazer teste gratis", "free_trial"],
    ["Oferece ?", "free_trial"],
    ["Quanto", "ask_price"],
    ["quanto custa o mensal?", "ask_price"],
    ["quero comprar um codigo", "buy_plan"],
    ["manda o pix copia e cola", "pix_payment"],
    ["quero pagar no cartao", "card_payment"],
    ["quero download no celular", "technical_support"],
    ["minha tv Ã© samsung", "technical_support"],
    ["tenho LG", "technical_support"],
    ["tenho fire stick", "technical_support"],
    ["tenho roku", "technical_support"],
    ["minha TV HQ funciona?", "technical_support"],
    ["Como faco para revender?", "human_help"],
    ["Voce tem revenda do UNITV?", "human_help"],
    ["ja paguei", "unknown"]
  ] as const)("classifies %s locally without calling OpenAI", async (message, intent) => {
    vi.clearAllMocks();
    const service = new IntentClassifierService();

    const result = await service.classify({ message });

    expect(result.intent).toBe(intent);
    expect(result.summary).toBeTruthy();
    expect(createOpenAIClient).not.toHaveBeenCalled();
  });

  it("does not spend on a redundant intent call for ambiguous messages by default", async () => {
    vi.clearAllMocks();
    const service = new IntentClassifierService();

    const result = await service.classify({ message: "abc xyz sem contexto claro" });

    expect(result.intent).toBe("unknown");
    expect(createOpenAIClient).not.toHaveBeenCalled();
  });

  it("uses OpenAI for ambiguous intent only when explicitly enabled", async () => {
    vi.clearAllMocks();
    vi.stubEnv("UNITV_AI_INTENT_CLASSIFIER_ENABLED", "true");
    openAIClient.responses.create.mockResolvedValueOnce({
      output_text: JSON.stringify({
        intent: "unknown",
        confidence: 0.5,
        summary: "Mensagem ambigua.",
        suggested_reply: "Como posso te ajudar?"
      })
    });
    const service = new IntentClassifierService();

    const result = await service.classify({ message: "abc xyz sem contexto claro" });

    expect(result.intent).toBe("unknown");
    expect(createOpenAIClient).toHaveBeenCalledTimes(1);
    expect(openAIClient.responses.create).toHaveBeenCalledTimes(1);
    expect(openAIClient.chat.completions.create).not.toHaveBeenCalled();
  });

  it("falls back safely when OpenAI quota or network fails", async () => {
    vi.clearAllMocks();
    vi.stubEnv("UNITV_AI_INTENT_CLASSIFIER_ENABLED", "true");
    openAIClient.responses.create.mockRejectedValueOnce(new Error("429 quota exceeded"));
    const service = new IntentClassifierService();

    const result = await service.classify({ message: "Eu estarei agora" });

    expect(result.intent).toBe("unknown");
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.suggested_reply).toContain("comprar um plano");
    expect(openAIClient.chat.completions.create).not.toHaveBeenCalled();
  });

  it("never makes a second paid request when the economical Responses call returns empty", async () => {
    vi.clearAllMocks();
    vi.stubEnv("UNITV_AI_INTENT_CLASSIFIER_ENABLED", "true");
    openAIClient.responses.create.mockResolvedValueOnce({ output_text: "" });
    const service = new IntentClassifierService();

    const result = await service.classify({ message: "abc xyz sem contexto claro" });

    expect(result.intent).toBe("unknown");
    expect(openAIClient.responses.create).toHaveBeenCalledTimes(1);
    expect(openAIClient.chat.completions.create).not.toHaveBeenCalled();
  });
});
