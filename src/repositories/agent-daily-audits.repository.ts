import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { assertSupabaseSuccess } from "./errors";

export type AgentDailyAuditRecord = Record<string, unknown> & {
  id?: string;
  audit_date: string;
  timezone: string;
};

export class AgentDailyAuditsRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async upsertAudit(data: AgentDailyAuditRecord) {
    const { data: audit, error } = await this.supabase
      .from("agent_daily_audits")
      .upsert(data, { onConflict: "audit_date,timezone" })
      .select("*")
      .single();

    return assertSupabaseSuccess(audit, error) as Record<string, unknown>;
  }

  async findByDate(auditDate: string, timezone: string) {
    const { data, error } = await this.supabase
      .from("agent_daily_audits")
      .select("*")
      .eq("audit_date", auditDate)
      .eq("timezone", timezone)
      .maybeSingle();

    return assertSupabaseSuccess(data, error) as Record<string, unknown> | null;
  }

  async findById(id: string) {
    const { data, error } = await this.supabase
      .from("agent_daily_audits")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    return assertSupabaseSuccess(data, error) as Record<string, unknown> | null;
  }

  async findPrevious(auditDate: string, timezone: string) {
    const { data, error } = await this.supabase
      .from("agent_daily_audits")
      .select("*")
      .eq("timezone", timezone)
      .lt("audit_date", auditDate)
      .order("audit_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    return assertSupabaseSuccess(data, error) as Record<string, unknown> | null;
  }

  async markSent(id: string, data: { admin_message_id?: string | null }) {
    const { data: audit, error } = await this.supabase
      .from("agent_daily_audits")
      .update({
        sent_to_admin: true,
        sent_to_admin_at: new Date().toISOString(),
        admin_message_id: data.admin_message_id || null
      })
      .eq("id", id)
      .select("*")
      .single();

    return assertSupabaseSuccess(audit, error) as Record<string, unknown>;
  }
}
