import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { assertSupabaseSuccess } from "./errors";

export type ShadowDecisionRecord = {
  conversation_id?: string | null;
  message_id?: string | null;
  decision_key: string;
  channel: "reply" | "followup";
  active_action: string;
  shadow_action: string;
  active_next_state?: string | null;
  shadow_next_state?: string | null;
  active_reason?: string | null;
  shadow_reason?: string | null;
  divergence_types: string[];
  comparison_status: "match" | "divergent" | "pending_review" | "approved" | "rejected";
  would_send: boolean;
  blocked_before_ai: boolean;
  ai_call_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  metadata?: Record<string, unknown>;
};

export class AgentShadowDecisionsRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async upsertDecision(record: ShadowDecisionRecord) {
    const now = new Date().toISOString();
    const { data, error } = await this.supabase
      .from("agent_shadow_decisions")
      .upsert({ ...record, last_evaluated_at: now, updated_at: now }, { onConflict: "decision_key" })
      .select("*")
      .single();
    return assertSupabaseSuccess(data, error) as Record<string, unknown>;
  }

  async listRecent(limit = 100) {
    const { data, error } = await this.supabase
      .from("agent_shadow_decisions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 500));
    return assertSupabaseSuccess(data || [], error) as Array<Record<string, unknown>>;
  }
}
