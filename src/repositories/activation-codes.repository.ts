import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { assertSupabaseSuccess } from "./errors";

export class ActivationCodesRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async countAvailableCodes(productId: string, planId?: string | null) {
    if (!planId) {
      const { count, error } = await this.supabase
        .from("activation_codes")
        .select("id", { count: "exact", head: true })
        .eq("product_id", productId)
        .eq("status", "available")
        .is("plan_id", null);
      assertSupabaseSuccess(count, error);
      return count ?? 0;
    }

    const [{ count: planCount, error: planError }, { count: universalCount, error: universalError }] = await Promise.all([
      this.supabase
        .from("activation_codes")
        .select("id", { count: "exact", head: true })
        .eq("product_id", productId)
        .eq("status", "available")
        .eq("plan_id", planId),
      this.supabase
        .from("activation_codes")
        .select("id", { count: "exact", head: true })
        .eq("product_id", productId)
        .eq("status", "available")
        .is("plan_id", null)
    ]);

    assertSupabaseSuccess(planCount, planError);
    assertSupabaseSuccess(universalCount, universalError);
    return (planCount ?? 0) + (universalCount ?? 0);
  }

  async findAvailableCode(productId: string, planId?: string | null) {
    const codes = await this.findAvailableCodes(productId, planId, 1);
    return codes[0] || null;
  }

  async findAvailableCodes(productId: string, planId: string | null | undefined, limit: number) {
    const safeLimit = Math.max(1, Math.floor(limit));
    const codes: Array<Record<string, unknown>> = [];

    if (planId) {
      codes.push(...(await this.findAvailableCodesByPlan(productId, planId, safeLimit)));
    }

    if (codes.length < safeLimit) {
      codes.push(...(await this.findAvailableCodesByPlan(productId, null, safeLimit - codes.length)));
    }

    return codes;
  }

  private async findAvailableCodesByPlan(productId: string, planId: string | null, limit: number) {
    let query = this.supabase
      .from("activation_codes")
      .select("*")
      .eq("product_id", productId)
      .eq("status", "available")
      .order("created_at", { ascending: true })
      .limit(limit);

    query = planId ? query.eq("plan_id", planId) : query.is("plan_id", null);
    const { data, error } = await query;

    return assertSupabaseSuccess(data || [], error);
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

  async releaseReservedCodesForOrder(orderId: string, codeIds: string[]) {
    if (!codeIds.length) {
      return [];
    }

    const { data, error } = await this.supabase
      .from("activation_codes")
      .update({
        status: "available",
        assigned_order_id: null,
        assigned_customer_id: null,
        reserved_at: null
      })
      .eq("assigned_order_id", orderId)
      .eq("status", "reserved")
      .in("id", codeIds)
      .select("*");

    return assertSupabaseSuccess(data || [], error);
  }
}
