import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { sanitizeAuditMetadata } from "@/lib/unitv/audit-privacy";
import { assertSupabaseSuccess } from "./errors";

export type AgentEventType =
  | "customer_message"
  | "bot_message"
  | "specialist_message"
  | "ai_called"
  | "local_rule_used"
  | "human_intervention"
  | "repetition_blocked"
  | "followup_sent"
  | "price_asked"
  | "download_asked"
  | "installation_asked"
  | "test_asked"
  | "pix_asked"
  | "plan_selected"
  | "proof_sent"
  | "payment_confirmed"
  | "converted"
  | "support_requested"
  | "customer_abandoned"
  | "install_stuck"
  | "pix_requested_not_paid"
  | "response_sanitized"
  | "debug_blocked"
  | "handoff_started"
  | "handoff_resumed";

export type AgentEventSource =
  | "webhook"
  | "chat_agent"
  | "followup_job"
  | "payment_webhook"
  | "specialist_training"
  | "audit_job"
  | "system";

export type CreateAgentEventLogInput = {
  conversation_id?: string | null;
  customer_phone?: string | null;
  event_type: AgentEventType;
  event_source: AgentEventSource;
  intent?: string | null;
  stage?: string | null;
  objection?: string | null;
  device?: string | null;
  plan_interest?: string | null;
  message_id?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
};

export class AgentEventLogsRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async createEvent(data: CreateAgentEventLogInput) {
    const { data: event, error } = await this.supabase
      .from("agent_event_logs")
      .insert({
        ...data,
        metadata: sanitizeAuditMetadata(data.metadata || {})
      })
      .select("*")
      .single();

    return assertSupabaseSuccess(event, error);
  }

  async listEventsBetween(periodStart: string, periodEnd: string) {
    const { data, error } = await this.supabase
      .from("agent_event_logs")
      .select("*")
      .gte("created_at", periodStart)
      .lte("created_at", periodEnd)
      .order("created_at", { ascending: true });

    return assertSupabaseSuccess(data || [], error) as Array<Record<string, unknown>>;
  }
}
