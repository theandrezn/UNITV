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

export type ReviewSpecialistTrainingExampleInput = {
  review_status: "approved" | "rejected";
  outcome_status?: "positive" | "neutral" | "negative";
  reviewed_by: string;
  approval_reason?: string | null;
  outcome_notes?: string | null;
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
      .eq("review_status", "approved")
      .order("created_at", { ascending: false })
      .limit(50);

    const rawCandidates = assertSupabaseSuccess(data || [], error) as Array<Record<string, unknown>>;
    const candidates = rawCandidates.filter((example) =>
      example.success_signal !== "negative" &&
      (example.outcome_status === "positive" || example.outcome_status === "neutral")
    );
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
      .select("id, success_signal, review_status")
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
    const autoApprove = nextSignal === "positive" && latest.review_status === "pending_review";
    const observedAt = new Date().toISOString();

    const { data, error } = await this.supabase
      .from("specialist_training_examples")
      .update({
        success_signal: nextSignal,
        outcome_status: nextSignal,
        outcome_observed_at: observedAt,
        ...(autoApprove ? {
          review_status: "approved",
          reviewed_at: observedAt,
          reviewed_by: "automatic_outcome",
          approval_reason: "customer_positive_signal"
        } : {}),
        updated_at: observedAt
      })
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

  async listLearningCandidatesBetween(periodStart: string, periodEnd: string) {
    const { data, error } = await this.supabase
      .from("specialist_training_examples")
      .select("*")
      .eq("review_status", "approved")
      .in("outcome_status", ["positive", "neutral"])
      .gte("updated_at", periodStart)
      .lte("updated_at", periodEnd)
      .order("updated_at", { ascending: true });

    return assertSupabaseSuccess(data || [], error) as Array<Record<string, unknown>>;
  }

  async listApprovedLearningBacklog(limit = 120) {
    const { data, error } = await this.supabase
      .from("specialist_training_examples")
      .select("*")
      .eq("review_status", "approved")
      .in("outcome_status", ["positive", "neutral"])
      .order("updated_at", { ascending: true })
      .limit(limit);

    return assertSupabaseSuccess(data || [], error) as Array<Record<string, unknown>>;
  }

  async listReviewQueue(limit = 50) {
    const { data, error } = await this.supabase
      .from("specialist_training_examples")
      .select("*")
      .eq("review_status", "pending_review")
      .order("created_at", { ascending: false })
      .limit(limit);

    return assertSupabaseSuccess(data || [], error) as Array<Record<string, unknown>>;
  }

  async reviewExample(id: string, input: ReviewSpecialistTrainingExampleInput) {
    const reviewedAt = new Date().toISOString();
    const { data, error } = await this.supabase
      .from("specialist_training_examples")
      .update({
        review_status: input.review_status,
        reviewed_at: reviewedAt,
        reviewed_by: input.reviewed_by,
        approval_reason: input.approval_reason || null,
        outcome_status: input.outcome_status || (input.review_status === "approved" ? "neutral" : "negative"),
        outcome_notes: input.outcome_notes || null,
        outcome_observed_at: reviewedAt,
        should_copy_style: input.review_status === "approved",
        updated_at: reviewedAt
      })
      .eq("id", id)
      .select("*")
      .single();

    return assertSupabaseSuccess(data, error);
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
  let score = example.success_signal === "positive" ? 55 : example.success_signal === "negative" ? -60 : 5;
  if (input.intent && example.inferred_intent === input.intent) score += 24;
  if (input.stage && example.inferred_stage === input.stage) score += 18;
  if (input.objection && example.inferred_objection === input.objection) score += 12;
  const metadata = example.metadata && typeof example.metadata === "object" ? example.metadata as Record<string, unknown> : {};
  if (input.device && (metadata.device === input.device || metadata.aparelho === input.device)) score += 10;
  if (metadata.fast_learning === true) score += 14;
  if (metadata.global_reusable_example === true) score += 8;
  if (metadata.specialist_message_is_short === true || Number(metadata.specialist_message_words || 0) <= 22) score += 8;
  if (metadata.human_style === "curto_direto_uma_acao") score += 6;
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
  score += recencyBoost(example.created_at);
  return score;
}

function tokenize(value: string) {
  return new Set(value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/\W+/).filter((word) => word.length >= 3));
}

function dateValue(value: unknown) {
  const date = typeof value === "string" ? new Date(value).getTime() : 0;
  return Number.isNaN(date) ? 0 : date;
}

function recencyBoost(value: unknown) {
  const timestamp = dateValue(value);
  if (!timestamp) return 0;
  const ageHours = (Date.now() - timestamp) / 3_600_000;
  if (ageHours <= 6) return 12;
  if (ageHours <= 24) return 8;
  if (ageHours <= 72) return 4;
  return 0;
}
