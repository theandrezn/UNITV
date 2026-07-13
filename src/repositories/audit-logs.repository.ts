import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { AuditLog } from "@/types/domain";
import { assertSupabaseSuccess } from "./errors";

export class AuditLogsRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async createAuditLog(data: AuditLog) {
    const { data: auditLog, error } = await this.supabase.from("audit_logs").insert(data).select("*").single();
    return assertSupabaseSuccess(auditLog, error);
  }

  async listOpenAIUsageSince(since: string) {
    const pageSize = 1000;
    const rows: Array<Record<string, unknown>> = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await this.supabase
        .from("audit_logs")
        .select("id, created_at, metadata")
        .eq("action", "openai_usage")
        .gte("created_at", since)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      const page = assertSupabaseSuccess(data || [], error) as Array<Record<string, unknown>>;
      rows.push(...page);
      if (page.length < pageSize) break;
    }

    return rows;
  }
}
