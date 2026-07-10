import "server-only";
import { z } from "zod";
import { createOpenAIClient, getStrongSalesAgentOpenAIModel } from "@/lib/openai/client";
import { AgentLearningMemoriesRepository, type AgentLearningMemory } from "@/repositories/agent-learning-memories.repository";

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
  constructor(private readonly memoriesRepository = new AgentLearningMemoriesRepository()) {}

  async synthesizeDailyLearning(input: DailySpecialistLearningInput): Promise<DailySpecialistLearningResult> {
    const examples = input.examples.filter(isEligibleExample).slice(-30);
    if (!examples.length) {
      return { createdCount: 0, summary: "Sem exemplos aprovados com resultado observado no periodo.", skippedReason: "no_eligible_examples" };
    }
    if (!process.env.OPENAI_API_KEY) {
      return { createdCount: 0, summary: "Aprendizado diario aguardando configuracao da IA.", skippedReason: "learning_model_unavailable" };
    }

    const learning = await this.generateLearning(examples);
    if (!learning) {
      return { createdCount: 0, summary: "Nao foi possivel sintetizar uma regra segura a partir dos exemplos do dia.", skippedReason: "unsafe_or_invalid_learning" };
    }

    const eligibleExampleIds = new Set(examples.map((example) => String(example.id || "")).filter(Boolean));
    const memories = learning.directives
      .filter((directive) => isSafeDirective(directive, eligibleExampleIds))
      .map((directive) => toMemory(directive, input, examples));
    if (input.dryRun || !memories.length) {
      return { createdCount: memories.length, summary: learning.summary, skippedReason: input.dryRun ? "dry_run" : "no_safe_directives" };
    }

    await this.memoriesRepository.upsertMemories(memories);
    return { createdCount: memories.length, summary: learning.summary };
  }

  private async generateLearning(examples: Array<Record<string, unknown>>) {
    try {
      const response = await createOpenAIClient().responses.create({
        model: getStrongSalesAgentOpenAIModel(),
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
        }
      });
      const parsed = learningSchema.safeParse(JSON.parse(response.output_text || "{}"));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
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
