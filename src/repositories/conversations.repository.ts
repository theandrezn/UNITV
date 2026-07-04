import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { assertSupabaseSuccess } from "./errors";

type UpsertConversationInput = {
  customer_id: string;
  channel: "whatsapp";
  external_conversation_id: string;
  status?: "open" | "pending" | "closed" | "archived";
  last_message_at?: string;
  metadata?: Record<string, unknown>;
};

export class ConversationsRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async findByExternalConversationId(externalConversationId: string) {
    const { data, error } = await this.supabase
      .from("conversations")
      .select("*")
      .eq("external_conversation_id", externalConversationId)
      .eq("channel", "whatsapp")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return assertSupabaseSuccess(data, error);
  }

  async createConversation(data: UpsertConversationInput) {
    const { data: conversation, error } = await this.supabase.from("conversations").insert(data).select("*").single();
    return assertSupabaseSuccess(conversation, error);
  }

  async touchConversation(id: string, lastMessageAt = new Date().toISOString()) {
    const { data, error } = await this.supabase
      .from("conversations")
      .update({ last_message_at: lastMessageAt, status: "open" })
      .eq("id", id)
      .select("*")
      .single();

    return assertSupabaseSuccess(data, error);
  }
}
