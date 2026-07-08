import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { sanitizeAuditMetadata } from "@/lib/unitv/audit-privacy";
import { assertSupabaseSuccess } from "./errors";

export type LeadTemperature = "frio" | "morno" | "quente" | "muito_quente";
export type LeadHotAlertType =
  | "pix_requested"
  | "plan_selected"
  | "wants_to_pay"
  | "downloaded_app"
  | "proof_sent"
  | "test_requested"
  | "installation_stuck"
  | "price_asked_multiple_times"
  | "screens_question"
  | "human_support_needed"
  | "hot_lead_abandoned"
  | "payment_pending"
  | "manual_review_needed";

export type CreateLeadHotAlertInput = {
  conversation_id: string;
  customer_phone: string;
  customer_name?: string | null;
  alert_type: LeadHotAlertType;
  lead_temperature: LeadTemperature;
  trigger_message?: string | null;
  trigger_intent?: string | null;
  trigger_stage?: string | null;
  plan_interest?: string | null;
  device?: string | null;
  main_objection?: string | null;
  last_customer_message?: string | null;
  last_bot_message?: string | null;
  next_best_action?: string | null;
  admin_message?: string | null;
  dedupe_key: string;
  metadata?: Record<string, unknown>;
};

export class LeadHotAlertsRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async createAlert(data: CreateLeadHotAlertInput) {
    const { data: alert, error } = await this.supabase
      .from("lead_hot_alerts")
      .insert({
        ...data,
        metadata: sanitizeAuditMetadata(data.metadata || {})
      })
      .select("*")
      .single();

    if (error && error.code === "23505") {
      return null;
    }

    return assertSupabaseSuccess(alert, error) as Record<string, unknown> | null;
  }

  async findRecentAlert(conversationId: string, alertType: LeadHotAlertType, sinceIso: string) {
    const { data, error } = await this.supabase
      .from("lead_hot_alerts")
      .select("*")
      .eq("conversation_id", conversationId)
      .eq("alert_type", alertType)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return assertSupabaseSuccess(data, error) as Record<string, unknown> | null;
  }

  async findRecentAlertByPhone(customerPhone: string, sinceIso: string) {
    const { data, error } = await this.supabase
      .from("lead_hot_alerts")
      .select("*")
      .eq("customer_phone", customerPhone)
      .neq("alert_type", "proof_sent")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return assertSupabaseSuccess(data, error) as Record<string, unknown> | null;
  }

  async markSent(id: string, adminMessageId?: string | null) {
    const { data, error } = await this.supabase
      .from("lead_hot_alerts")
      .update({
        sent_to_admin: true,
        sent_to_admin_at: new Date().toISOString(),
        admin_message_id: adminMessageId || null,
        send_attempts: 1,
        last_send_error: null
      })
      .eq("id", id)
      .select("*")
      .single();

    return assertSupabaseSuccess(data, error) as Record<string, unknown>;
  }

  async markFailed(id: string, errorMessage: string, currentAttempts = 0) {
    const { data, error } = await this.supabase
      .from("lead_hot_alerts")
      .update({
        sent_to_admin: false,
        send_attempts: currentAttempts + 1,
        last_send_error: errorMessage
      })
      .eq("id", id)
      .select("*")
      .single();

    return assertSupabaseSuccess(data, error) as Record<string, unknown>;
  }
}
