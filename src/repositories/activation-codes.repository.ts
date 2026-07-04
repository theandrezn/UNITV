import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { assertSupabaseSuccess } from "./errors";

export class ActivationCodesRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async countAvailableCodes(productId: string, planId?: string | null) {
    let query = this.supabase
      .from("activation_codes")
      .select("id", { count: "exact", head: true })
      .eq("product_id", productId)
      .eq("status", "available");

    query = planId ? query.eq("plan_id", planId) : query.is("plan_id", null);
    const { count, error } = await query;

    assertSupabaseSuccess(count, error);
    return count ?? 0;
  }

  async findAvailableCode(productId: string, planId?: string | null) {
    let query = this.supabase
      .from("activation_codes")
      .select("*")
      .eq("product_id", productId)
      .eq("status", "available")
      .order("created_at", { ascending: true })
      .limit(1);

    query = planId ? query.eq("plan_id", planId) : query.is("plan_id", null);
    const { data, error } = await query.maybeSingle();

    return assertSupabaseSuccess(data, error);
  }

  async reserveCode(codeId: string, orderId: string, customerId: string) {
    const { data, error } = await this.supabase
      .from("activation_codes")
      .update({
        status: "reserved",
        assigned_order_id: orderId,
        assigned_customer_id: customerId,
        reserved_at: new Date().toISOString()
      })
      .eq("id", codeId)
      .eq("status", "available")
      .select("*")
      .maybeSingle();

    return assertSupabaseSuccess(data, error);
  }

  async markCodeAsSent(codeId: string) {
    const { data, error } = await this.supabase
      .from("activation_codes")
      .update({
        status: "sent",
        sent_at: new Date().toISOString()
      })
      .eq("id", codeId)
      .eq("status", "reserved")
      .select("*")
      .maybeSingle();

    return assertSupabaseSuccess(data, error);
  }
}
