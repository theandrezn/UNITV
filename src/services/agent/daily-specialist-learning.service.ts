import "server-only";
import { z } from "zod";
import { createOpenAIClient, getSalesAgentOpenAIModel, getStrongSalesAgentOpenAIModel } from "@/lib/openai/client";
import { AgentLearningMemoriesRepository, type AgentLearningMemory } from "@/repositories/agent-learning-memories.repository";
import { AgentLearningExampleProgressRepository } from "@/repositories/agent-learning-example-progress.repository";
import { executeObservedOpenAICall } from "@/services/ai/openai-call-observer";

const directiveSchema = z.object({
  intent: z.string().nullable(),
  stage: z.string().nullable(),
  rule: z.string().min(20).max(360),
  style_directive: z.string().min(12).max(220),
  avoid: z.array(z.string().min(3).max(140)).max(4),
  confidence: z.number().min(0).max(1),
  source_example_ids: z.array(z.string().uuid()).min(1).max(10)
});

const learningSchema = z.object({
  summary: z.string().min(1).max(600),
  directives: z.array(directiveSchema).max(6)
});

export type DailySpecialistLearningResult = {
  createdCount: number;
  summary: string;
  skippedReason?: string;
};

type DailySpecialistLearningInput = {
  auditDate: string;
  timezone: string;
  examples: Array<Record<string, unknown>>;
  dryRun?: boolean;
};

export class DailySpecialistLearningService {
  constructor(
    private readonly memoriesRepository = new AgentLearningMemoriesRepository(),
    private readonly progressRepository = new AgentLearningExampleProgressRepository()
  ) {}

  async synthesizeDailyLearning(input: DailySpecialistLearningInput): Promise<DailySpecialistLearningResult> {
    const eligibleExamples = input.examples.filter(isEligibleExample);
    const examples = (await this.progressRepository.filterUnprocessedExamples(eligibleExamples)).slice(0, 18);
    if (!examples.length) {
      return { createdCount: 0, summary: "Nenhum exemplo novo ou revisado precisa ser sintetizado hoje.", skippedReason: "no_new_learning_examples" };
    }
    if (!process.env.OPENAI_API_KEY) {
      return { createdCount: 0, summary: "Aprendizado diario aguardando configuracao da IA.", skippedReason: "learning_model_unavailable" };
    }

    const generated = await this.generateLearning(examples);
    if (!generated.learning) {
      return {
        createdCount: 0,
        summary: learningFailureSummary(generated.skippedReason),
        skippedReason: generated.skippedReason
      };
    }

    const eligibleExampleIds = new Set(examples.map((example) => String(example.id || "")).filter(Boolean));
    const memories = generated.learning.directives
      .filter((directive) => isSafeDirective(directive, eligibleExampleIds))
      .map((directive) => toMemory(directive, input, examples));
    if (input.dryRun) {
      return { createdCount: memories.length, summary: generated.learning.summary, skippedReason: input.dryRun ? "dry_run" : "no_safe_directives" };
    }

    if (memories.length) {
      await this.memoriesRepository.upsertMemories(memories);
    }
    await this.progressRepository.markExamplesProcessed(examples, memories.length);
    return {
      createdCount: memories.length,
      summary: generated.learning.summary,
      ...(memories.length ? {} : { skippedReason: "no_safe_directives" })
    };
  }

  private async generateLearning(examples: Array<Record<string, unknown>>) {
    try {
      const model = shouldUseStrongLearning(examples) ? getStrongSalesAgentOpenAIModel() : getSalesAgentOpenAIModel();
      const response = await executeObservedOpenAICall(
        { callType: "daily_specialist_learning", model },
        () => createOpenAIClient().responses.create({
        model,
        input: [
          {
            role: "system",
            content: [{
              type: "input_text",
              text: [
                "Voce e o curador de aprendizado operacional da UNITV.",
                "Transforme somente exemplos aprovados e com resultado positivo ou neutro do especialista Andre em regras reutilizaveis.",
                "Extraia raciocinio, ordem de perguntas, tom, tamanho e proximo passo. Nao copie frases, nao crie templates e nao invente respostas prontas.",
                "Nunca inclua dados pessoais, telefone, link, codigo, Pix, preco, promocao, promessa comercial ou fato mutavel.",
                "Cada regra precisa ser curta, aplicavel e subordinada ao estado atual da conversa e as regras de seguranca.",
                "Em source_example_ids, cite somente os IDs dos exemplos que realmente sustentam cada regra.",
                "Retorne somente JSON no schema solicitado."
              ].join("\n")
            }]
          },
          {
            role: "user",
            content: [{
              type: "input_text",
              text: JSON.stringify(examples.map((example) => ({
                example_id: example.id || null,
                intent: example.inferred_intent || null,
                stage: example.inferred_stage || null,
                action: example.inferred_specialist_action || null,
                style: example.style_notes || null,
                pattern: example.metadata && typeof example.metadata === "object"
                  ? (example.metadata as Record<string, unknown>).learned_pattern || null
                  : null,
                outcome: example.outcome_status || example.success_signal || null
              })))
            }]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "unitv_daily_specialist_learning",
            schema: toJsonSchema(),
            strict: true
          }
        },
        reasoning: { effort: "low" },
        max_output_tokens: 520
      })
      );
      if (!response) {
        return { learning: null, skippedReason: "learning_model_circuit_open" };
      }
      const parsed = learningSchema.safeParse(JSON.parse(response.output_text || "{}"));
      return parsed.success
        ? { learning: parsed.data, skippedReason: undefined }
        : { learning: null, skippedReason: "unsafe_or_invalid_learning" };
    } catch (error) {
      return { learning: null, skippedReason: classifyLearningModelError(error) };
    }
  }
}

function shouldUseStrongLearning(examples: Array<Record<string, unknown>>) {
  if (process.env.UNITV_DAILY_LEARNING_STRONG_MODEL_ENABLED !== "true") {
    return false;
  }
  const stages = new Set(examples.map((example) => String(example.inferred_stage || "")).filter(Boolean));
  const intents = new Set(examples.map((example) => String(example.inferred_intent || "")).filter(Boolean));
  return stages.size >= 4 || intents.size >= 5;
}

function classifyLearningModelError(error: unknown) {
  const candidate = error as { status?: unknown; code?: unknown } | null;
  if (Number(candidate?.status) === 429 || candidate?.code === "insufficient_quota") {
    return "learning_model_quota_exhausted";
  }
  return "learning_model_request_failed";
}

function learningFailureSummary(reason: string | undefined) {
  if (reason === "learning_model_quota_exhausted") {
    return "A IA ficou sem quota. Os exemplos aprovados foram preservados e o aprendizado sera tentado novamente no proximo ciclo.";
  }
  if (reason === "learning_model_request_failed") {
    return "A IA de aprendizado ficou indisponivel. Os exemplos aprovados foram preservados para nova tentativa.";
  }
  return "Nao foi possivel sintetizar uma regra segura a partir dos exemplos do dia.";
}

function isEligibleExample(example: Record<string, unknown>) {
  return example.review_status === "approved" && ["positive", "neutral"].includes(String(example.outcome_status || example.success_signal || ""));
}

function isSafeDirective(directive: z.infer<typeof directiveSchema>, eligibleExampleIds: Set<string>) {
  const text = [directive.rule, directive.style_directive, ...directive.avoid].join(" ").toLowerCase();
  return (
    directive.source_example_ids.every((id) => eligibleExampleIds.has(id)) &&
    !/(https?:\/\/|mediafire|youtube|\b\d{5,}\b|r\$|pix|chave|codigo|cartao|telefone|whatsapp)/.test(text)
  );
}

function toMemory(
  directive: z.infer<typeof directiveSchema>,
  input: DailySpecialistLearningInput,
  examples: Array<Record<string, unknown>>
): AgentLearningMemory {
  return {
    learning_date: input.auditDate,
    timezone: input.timezone,
    intent: directive.intent,
    stage: directive.stage,
    rule: directive.rule,
    style_directive: directive.style_directive,
    avoid: directive.avoid,
    evidence_count: directive.source_example_ids.length,
    confidence: directive.confidence,
    source_example_ids: directive.source_example_ids,
    metadata: { source: "daily_specialist_learning", approved_examples_count: examples.length }
  };
}

function toJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      directives: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            intent: { type: ["string", "null"] },
            stage: { type: ["string", "null"] },
            rule: { type: "string" },
            style_directive: { type: "string" },
            avoid: { type: "array", items: { type: "string" } },
            confidence: { type: "number" },
            source_example_ids: { type: "array", items: { type: "string", format: "uuid" } }
          },
          required: ["intent", "stage", "rule", "style_directive", "avoid", "confidence", "source_example_ids"]
        }
      }
    },
    required: ["summary", "directives"]
  };
}
