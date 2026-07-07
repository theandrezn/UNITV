import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { assertSupabaseSuccess } from "./errors";

type CreateSpecialistTrainingExampleInput = {
  conversation_id: string;
  customer_id?: string | null;
  customer_phone?: string | null;
  source?: string;
  customer_last_message?: string | null;
  bot_previous_message?: string | null;
  specialist_message: string;
  conversation_excerpt?: string | null;
  inferred_intent?: string | null;
  inferred_stage?: string | null;
  inferred_objection?: string | null;
  inferred_customer_state?: string | null;
  inferred_specialist_action?: string | null;
  why_specialist_intervened?: string | null;
  style_notes?: string | null;
  should_copy_style?: boolean;
  reason: "human_takeover" | "correction" | "sales_style" | "support_resolution";
  bot_response_was_overridden?: boolean;
  human_intervention_detected?: boolean;
  success_signal?: "unknown" | "positive" | "neutral" | "negative" | null;
  metadata?: Record<string, unknown>;
};

export type RelevantSpecialistExamplesInput = {
  intent?: string | null;
  stage?: string | null;
  objection?: string | null;
  device?: string | null;
  customerMessage?: string | null;
  recentContext?: string | null;
  limit?: number;
};

export class SpecialistTrainingExamplesRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async createExample(data: CreateSpecialistTrainingExampleInput) {
    const { data: example, error } = await this.supabase
      .from("specialist_training_examples")
      .insert({
        ...data,
        source: data.source || "whatsapp",
        human_intervention_detected: data.human_intervention_detected ?? true,
        success_signal: data.success_signal || "unknown",
        used_count: 0
      })
      .select("*")
      .single();

    return assertSupabaseSuccess(example, error);
  }

  async getRelevantSpecialistExamples(input: RelevantSpecialistExamplesInput) {
    const { data, error } = await this.supabase
      .from("specialist_training_examples")
      .select("*")
      .eq("should_copy_style", true)
      .order("created_at", { ascending: false })
      .limit(50);

    const candidates = assertSupabaseSuccess(data || [], error) as Array<Record<string, unknown>>;
    const keywords = tokenize(`${input.customerMessage || ""} ${input.recentContext || ""}`);
    const ranked = candidates
      .map((example) => ({ example, score: scoreExample(example, input, keywords) }))
      .filter((item) => item.score > 0 || candidates.length <= 3)
      .sort((a, b) => b.score - a.score || dateValue(b.example.created_at) - dateValue(a.example.created_at))
      .slice(0, input.limit || 3)
      .map((item) => item.example);

    await Promise.allSettled(ranked.map((example) => this.markExampleUsed(String(example.id), Number(example.used_count || 0))));
    return ranked;
  }

  async listSimilarExamples(input: RelevantSpecialistExamplesInput) {
    return this.getRelevantSpecialistExamples(input);
  }

  async markLatestConversationExampleSignal(conversationId: string, signal: "positive" | "neutral" | "negative") {
    const { data: latest, error: findError } = await this.supabase
      .from("specialist_training_examples")
      .select("id, success_signal")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    assertSupabaseSuccess(latest, findError);
    if (!latest?.id) {
      return null;
    }

    const nextSignal = signal === "neutral" && latest.success_signal && latest.success_signal !== "unknown"
      ? latest.success_signal
      : signal;

    const { data, error } = await this.supabase
      .from("specialist_training_examples")
      .update({ success_signal: nextSignal, updated_at: new Date().toISOString() })
      .eq("id", latest.id)
      .select("*")
      .single();
    return assertSupabaseSuccess(data, error);
  }

  async listExamplesBetween(periodStart: string, periodEnd: string) {
    const { data, error } = await this.supabase
      .from("specialist_training_examples")
      .select("*")
      .gte("created_at", periodStart)
      .lte("created_at", periodEnd)
      .order("created_at", { ascending: true });

    return assertSupabaseSuccess(data || [], error) as Array<Record<string, unknown>>;
  }

  private async markExampleUsed(id: string, usedCount: number) {
    const { error } = await this.supabase
      .from("specialist_training_examples")
      .update({ used_count: usedCount + 1, last_used_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      throw error;
    }
  }
}

function scoreExample(example: Record<string, unknown>, input: RelevantSpecialistExamplesInput, keywords: Set<string>) {
  let score = example.success_signal === "positive" ? 30 : example.success_signal === "negative" ? -20 : 0;
  if (input.intent && example.inferred_intent === input.intent) score += 24;
  if (input.stage && example.inferred_stage === input.stage) score += 18;
  if (input.objection && example.inferred_objection === input.objection) score += 12;
  const metadata = example.metadata && typeof example.metadata === "object" ? example.metadata as Record<string, unknown> : {};
  if (input.device && (metadata.device === input.device || metadata.aparelho === input.device)) score += 10;
  const exampleKeywords = tokenize([
    example.customer_last_message || "",
    example.bot_previous_message || "",
    example.specialist_message || "",
    example.conversation_excerpt || "",
    example.inferred_customer_state || "",
    example.inferred_specialist_action || "",
    example.why_specialist_intervened || "",
    example.style_notes || ""
  ].join(" "));
  score += [...keywords].filter((keyword) => exampleKeywords.has(keyword)).length * 3;
  score += Math.min(Number(example.used_count || 0), 10) * 0.2;
  return score;
}

function tokenize(value: string) {
  return new Set(value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/\W+/).filter((word) => word.length >= 3));
}

function dateValue(value: unknown) {
  const date = typeof value === "string" ? new Date(value).getTime() : 0;
  return Number.isNaN(date) ? 0 : date;
}
