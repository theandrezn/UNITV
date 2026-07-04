import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { assertSupabaseSuccess } from "./errors";

export class PlansRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async listActivePlans() {
    const { data, error } = await this.supabase
      .from("plans")
      .select("*, products(id, name, slug, description)")
      .eq("status", "active")
      .order("price_cents", { ascending: true });

    return assertSupabaseSuccess(data || [], error);
  }

  async findPlanById(id: string) {
    const { data, error } = await this.supabase
      .from("plans")
      .select("*, products(id, name, slug, description)")
      .eq("id", id)
      .maybeSingle();

    return assertSupabaseSuccess(data, error);
  }
}
