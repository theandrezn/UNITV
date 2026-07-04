import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { AgentAction } from "@/types/domain";
import { assertSupabaseSuccess } from "./errors";

export class AgentActionsRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async createAgentAction(data: AgentAction) {
    const { data: action, error } = await this.supabase.from("agent_actions").insert(data).select("*").single();
    return assertSupabaseSuccess(action, error);
  }
}
