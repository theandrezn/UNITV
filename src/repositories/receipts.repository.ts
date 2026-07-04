import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { Receipt } from "@/types/domain";
import { assertSupabaseSuccess } from "./errors";

export class ReceiptsRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async createReceipt(data: Receipt) {
    const { data: receipt, error } = await this.supabase.from("receipts").insert(data).select("*").single();
    return assertSupabaseSuccess(receipt, error);
  }
}
