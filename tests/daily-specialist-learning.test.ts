import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const openAIResponsesCreate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/openai/client", () => ({
  createOpenAIClient: () => ({ responses: { create: openAIResponsesCreate } }),
  getSalesAgentOpenAIModel: () => "gpt-5.4-mini",
  getStrongSalesAgentOpenAIModel: () => "gpt-5.4"
}));

import { DailySpecialistLearningService } from "@/services/agent/daily-specialist-learning.service";
import { AgentLearningMemoriesRepository } from "@/repositories/agent-learning-memories.repository";

function createLearningService(upsertMemories = vi.fn(async (memories) => memories)) {
  const progressRepository = {
    filterUnprocessedExamples: vi.fn(async (examples) => examples),
    markExamplesProcessed: vi.fn(async () => [])
  };
  return {
    service: new DailySpecialistLearningService({ upsertMemories } as never, progressRepository as never),
    progressRepository
  };
}

describe("daily specialist learning", () => {
  beforeEach(() => {
    openAIResponsesCreate.mockReset();
    process.env.UNITV_DAILY_LEARNING_ENABLED = "true";
    process.env.UNITV_DAILY_LEARNING_QUALITY_GATE_ENABLED = "true";
  });

  it("does not spend tokens on automatic learning under the economy policy", async () => {
    process.env.UNITV_DAILY_LEARNING_ENABLED = "false";
    process.env.OPENAI_API_KEY = "test-key";
    const { service, progressRepository } = createLearningService();

    const result = await service.synthesizeDailyLearning({ auditDate: "2026-07-13", timezone: "America/Sao_Paulo", examples: [] });

    expect(result.skippedReason).toBe("learning_disabled_by_quality_gate");
    expect(progressRepository.filterUnprocessedExamples).not.toHaveBeenCalled();
    expect(openAIResponsesCreate).not.toHaveBeenCalled();
  });

  it("keeps a new directive as candidate until multiple positive examples support it", async () => {
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
    const { service, progressRepository } = createLearningService(upsertMemories);

    const result = await service.synthesizeDailyLearning({
      auditDate: "2026-07-10",
      timezone: "America/Sao_Paulo",
      examples: [{
        id: "d5589076-5a12-4fa6-bcd4-f9cfad12dba4",
        review_status: "approved",
        quality_gate_status: "qualified",
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
        source_example_ids: ["d5589076-5a12-4fa6-bcd4-f9cfad12dba4"],
        status: "candidate"
      })
    ]);
    expect(progressRepository.markExamplesProcessed).toHaveBeenCalledWith(expect.any(Array), 1);
  });

  it("activates a directive only when three reviewed positive examples support it", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const sourceIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333"
    ];
    openAIResponsesCreate.mockResolvedValueOnce({
      output_text: JSON.stringify({
        summary: "Tres resultados positivos sustentam a mesma orientacao contextual.",
        directives: [{
          intent: "technical_support",
          stage: "awaiting_download_installation",
          rule: "Interpretar respostas curtas pela ultima pergunta e manter o proximo passo da instalacao.",
          style_directive: "Responder em uma unica mensagem curta e contextual.",
          avoid: ["reiniciar a conversa"],
          confidence: 0.95,
          source_example_ids: sourceIds
        }]
      })
    });
    const upsertMemories = vi.fn(async (memories) => memories);
    const { service } = createLearningService(upsertMemories);
    const examples = sourceIds.map((id) => ({
      id,
      review_status: "approved",
      quality_gate_status: "qualified",
      outcome_status: "positive",
      inferred_intent: "technical_support",
      inferred_stage: "awaiting_download_installation"
    }));

    await service.synthesizeDailyLearning({ auditDate: "2026-07-14", timezone: "America/Sao_Paulo", examples });

    expect(upsertMemories).toHaveBeenCalledWith([
      expect.objectContaining({ evidence_count: 3, source_example_ids: sourceIds, status: "active" })
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
    const { service, progressRepository } = createLearningService(upsertMemories);

    const result = await service.synthesizeDailyLearning({
      auditDate: "2026-07-10",
      timezone: "America/Sao_Paulo",
      examples: [{ id: "d5589076-5a12-4fa6-bcd4-f9cfad12dba4", review_status: "approved", outcome_status: "positive", quality_gate_status: "qualified" }]
    });

    expect(result).toMatchObject({ createdCount: 0, skippedReason: "no_safe_directives" });
    expect(upsertMemories).not.toHaveBeenCalled();
    expect(progressRepository.markExamplesProcessed).toHaveBeenCalledWith(expect.any(Array), 0);
  });

  it("preserves approved examples for retry when the learning model has no quota", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    openAIResponsesCreate.mockRejectedValueOnce(Object.assign(new Error("quota"), {
      status: 429,
      code: "insufficient_quota"
    }));
    const upsertMemories = vi.fn();
    const { service, progressRepository } = createLearningService(upsertMemories);

    const result = await service.synthesizeDailyLearning({
      auditDate: "2026-07-10",
      timezone: "America/Sao_Paulo",
      examples: [{ id: "d5589076-5a12-4fa6-bcd4-f9cfad12dba4", review_status: "approved", outcome_status: "positive", quality_gate_status: "qualified" }]
    });

    expect(result).toMatchObject({ createdCount: 0, skippedReason: "learning_model_quota_exhausted" });
    expect(result.summary).toContain("preservados");
    expect(upsertMemories).not.toHaveBeenCalled();
    expect(progressRepository.markExamplesProcessed).not.toHaveBeenCalled();
  });

  it("does not pay to synthesize an approved example that has not changed", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const progressRepository = {
      filterUnprocessedExamples: vi.fn(async () => []),
      markExamplesProcessed: vi.fn()
    };
    const service = new DailySpecialistLearningService({ upsertMemories: vi.fn() } as never, progressRepository as never);

    await expect(service.synthesizeDailyLearning({
      auditDate: "2026-07-10",
      timezone: "America/Sao_Paulo",
      examples: [{ id: "d5589076-5a12-4fa6-bcd4-f9cfad12dba4", review_status: "approved", outcome_status: "positive", quality_gate_status: "qualified" }]
    })).resolves.toMatchObject({ createdCount: 0, skippedReason: "no_new_learning_examples" });
    expect(openAIResponsesCreate).not.toHaveBeenCalled();
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
