import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const openAIClient = {
  chat: {
    completions: {
      create: vi.fn()
    }
  }
};

vi.mock("@/lib/openai/client", () => ({
  createOpenAIClient: vi.fn(() => openAIClient),
  getDefaultOpenAIModel: vi.fn(() => "test-model")
}));

import { createOpenAIClient } from "@/lib/openai/client";
import { IntentClassifierService } from "@/services/agent/intent-classifier.service";

describe("IntentClassifierService", () => {
  it.each([
    ["oi", "greeting"],
    ["quero fazer teste gratis", "free_trial"],
    ["quanto custa o mensal?", "ask_price"],
    ["quero comprar um codigo", "buy_plan"],
    ["manda o pix copia e cola", "pix_payment"],
    ["quero pagar no cartao", "card_payment"],
    ["quero download no celular", "technical_support"],
    ["ja paguei", "unknown"]
  ] as const)("classifies %s locally without calling OpenAI", async (message, intent) => {
    vi.clearAllMocks();
    const service = new IntentClassifierService();

    const result = await service.classify({ message });

    expect(result.intent).toBe(intent);
    expect(result.summary).toBeTruthy();
    expect(createOpenAIClient).not.toHaveBeenCalled();
  });

  it("uses OpenAI only when the local rules cannot classify the message", async () => {
    vi.clearAllMocks();
    openAIClient.chat.completions.create.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              intent: "unknown",
              confidence: 0.5,
              summary: "Mensagem ambigua.",
              suggested_reply: "Como posso te ajudar?"
            })
          }
        }
      ]
    });
    const service = new IntentClassifierService();

    const result = await service.classify({ message: "abc xyz sem contexto claro" });

    expect(result.intent).toBe("unknown");
    expect(createOpenAIClient).toHaveBeenCalledTimes(1);
    expect(openAIClient.chat.completions.create).toHaveBeenCalledTimes(1);
  });
});
