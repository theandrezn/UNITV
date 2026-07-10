import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const openAIResponsesCreate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/openai/client", () => ({
  createOpenAIClient: () => ({ responses: { create: openAIResponsesCreate } }),
  getStrongSalesAgentOpenAIModel: () => "gpt-5.4"
}));

import { DailySpecialistLearningService } from "@/services/agent/daily-specialist-learning.service";
import { AgentLearningMemoriesRepository } from "@/repositories/agent-learning-memories.repository";

describe("daily specialist learning", () => {
  it("turns approved specialist outcomes into reusable operational directives", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    openAIResponsesCreate.mockResolvedValueOnce({
      output_text: JSON.stringify({
        summary: "O especialista confirma o que o cliente acabou de informar e conduz apenas um proximo passo.",
        directives: [
          {
            intent: "technical_support",
            stage: "awaiting_download_installation",
            rule: "Quando o cliente der uma resposta curta, interprete-a pela ultima pergunta e mantenha a etapa de instalacao.",
            style_directive: "Responder curto, confirmar o contexto e pedir apenas o proximo passo necessario.",
            avoid: ["reiniciar saudacao", "repetir aparelho"],
            confidence: 0.93,
            source_example_ids: ["d5589076-5a12-4fa6-bcd4-f9cfad12dba4"]
          }
        ]
      })
    });
    const upsertMemories = vi.fn(async (memories) => memories);
    const service = new DailySpecialistLearningService({ upsertMemories } as never);

    const result = await service.synthesizeDailyLearning({
      auditDate: "2026-07-10",
      timezone: "America/Sao_Paulo",
      examples: [{
        id: "d5589076-5a12-4fa6-bcd4-f9cfad12dba4",
        review_status: "approved",
        outcome_status: "positive",
        inferred_intent: "technical_support",
        inferred_stage: "awaiting_download_installation",
        inferred_specialist_action: "confirmou_contexto",
        style_notes: "Curto e direto."
      }]
    });

    expect(result).toMatchObject({ createdCount: 1 });
    expect(upsertMemories).toHaveBeenCalledWith([
      expect.objectContaining({
        intent: "technical_support",
        stage: "awaiting_download_installation",
        source_example_ids: ["d5589076-5a12-4fa6-bcd4-f9cfad12dba4"]
      })
    ]);
  });

  it("does not persist directives containing mutable commercial facts", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    openAIResponsesCreate.mockResolvedValueOnce({
      output_text: JSON.stringify({
        summary: "Regra insegura.",
        directives: [{
          intent: "ask_price",
          stage: "price_discovery",
          rule: "Oferecer por R$ 19,99 quando houver silencio.",
          style_directive: "Mandar a promocao no Pix.",
          avoid: ["esperar"],
          confidence: 0.9,
          source_example_ids: ["d5589076-5a12-4fa6-bcd4-f9cfad12dba4"]
        }]
      })
    });
    const upsertMemories = vi.fn();
    const service = new DailySpecialistLearningService({ upsertMemories } as never);

    const result = await service.synthesizeDailyLearning({
      auditDate: "2026-07-10",
      timezone: "America/Sao_Paulo",
      examples: [{ id: "d5589076-5a12-4fa6-bcd4-f9cfad12dba4", review_status: "approved", outcome_status: "positive" }]
    });

    expect(result).toMatchObject({ createdCount: 0, skippedReason: "no_safe_directives" });
    expect(upsertMemories).not.toHaveBeenCalled();
  });

  it("retrieves the most relevant active memory for the current stage", async () => {
    const memories = [
      {
        id: "generic",
        status: "active",
        intent: "greeting",
        stage: "new_lead",
        rule: "Entender o objetivo inicial.",
        style_directive: "Responder curto.",
        confidence: 0.8,
        created_at: "2026-07-10T10:00:00.000Z"
      },
      {
        id: "download",
        status: "active",
        intent: "technical_support",
        stage: "awaiting_download_installation",
        rule: "Interpretar a resposta pela ultima pergunta e continuar a instalacao.",
        style_directive: "Confirmar contexto e pedir um unico proximo passo.",
        confidence: 0.94,
        created_at: "2026-07-10T09:00:00.000Z"
      }
    ];
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order", "limit"]) query[method] = vi.fn(() => query);
    query.then = (resolve: (value: unknown) => void) => resolve({ data: memories, error: null });
    const repository = new AgentLearningMemoriesRepository({ from: vi.fn(() => query) } as never);

    const result = await repository.getRelevantMemories({
      intent: "technical_support",
      stage: "awaiting_download_installation",
      customerMessage: "ok",
      recentContext: "assistant: voce conseguiu realizar o download?",
      limit: 1
    });

    expect(result[0].id).toBe("download");
  });
});
