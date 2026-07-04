import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { assertSupabaseSuccess } from "./errors";

export class AppSettingsRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async getSetting(key: string) {
    const { data, error } = await this.supabase.from("app_settings").select("*").eq("key", key).maybeSingle();
    return assertSupabaseSuccess(data, error);
  }
}
