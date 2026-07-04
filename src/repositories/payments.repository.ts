import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { Payment } from "@/types/domain";
import { assertSupabaseSuccess } from "./errors";

export class PaymentsRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async upsertProviderPayment(data: Payment) {
    const { data: payment, error } = await this.supabase
      .from("payments")
      .upsert(data, { onConflict: "provider,provider_payment_id" })
      .select("*")
      .single();

    return assertSupabaseSuccess(payment, error);
  }
}
