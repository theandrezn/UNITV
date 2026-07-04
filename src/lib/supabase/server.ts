import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseServerEnv } from "@/lib/env";

export function createSupabaseAdminClient() {
  const env = getSupabaseServerEnv();

  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}
