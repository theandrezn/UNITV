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
}
