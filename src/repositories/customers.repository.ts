import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { Customer } from "@/types/domain";
import { assertSupabaseSuccess } from "./errors";

export class CustomersRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async findCustomerByPhone(phone: string) {
    const { data, error } = await this.supabase.from("customers").select("*").eq("phone", phone).maybeSingle();
    return assertSupabaseSuccess(data, error);
  }

  async createCustomer(data: Customer) {
    const { data: customer, error } = await this.supabase.from("customers").insert(data).select("*").single();
    return assertSupabaseSuccess(customer, error);
  }

  async upsertCustomerByPhone(data: Customer) {
    const { data: customer, error } = await this.supabase
      .from("customers")
      .upsert(data, { onConflict: "phone" })
      .select("*")
      .single();
    return assertSupabaseSuccess(customer, error);
  }
}
