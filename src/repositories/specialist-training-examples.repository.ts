import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { assertSupabaseSuccess } from "./errors";

type CreateSpecialistTrainingExampleInput = {
  conversation_id: string;
  customer_id?: string | null;
  customer_phone?: string | null;
  customer_last_message?: string | null;
  bot_previous_message?: string | null;
  specialist_message: string;
  inferred_intent?: string | null;
  inferred_stage?: string | null;
  inferred_objection?: string | null;
  reason: "human_takeover" | "correction" | "sales_style" | "support_resolution";
  bot_response_was_overridden?: boolean;
  success_signal?: string | null;
  metadata?: Record<string, unknown>;
};

export class SpecialistTrainingExamplesRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async createExample(data: CreateSpecialistTrainingExampleInput) {
    const { data: example, error } = await this.supabase
      .from("specialist_training_examples")
      .insert({
        ...data,
        used_count: 0
      })
      .select("*")
      .single();

    return assertSupabaseSuccess(example, error);
  }

  async listSimilarExamples(input: { intent?: string | null; stage?: string | null; objection?: string | null; limit?: number }) {
    let query = this.supabase
      .from("specialist_training_examples")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(input.limit || 3);

    if (input.intent) {
      query = query.eq("inferred_intent", input.intent);
    } else if (input.stage) {
      query = query.eq("inferred_stage", input.stage);
    } else if (input.objection) {
      query = query.eq("inferred_objection", input.objection);
    }

    const { data, error } = await query;
    return assertSupabaseSuccess(data || [], error);
  }
}
