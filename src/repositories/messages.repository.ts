import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { assertSupabaseSuccess } from "./errors";

type CreateMessageInput = {
  conversation_id: string;
  customer_id?: string | null;
  role: "customer" | "assistant" | "system" | "human_agent" | "tool";
  content?: string | null;
  content_type?: string;
  external_message_id?: string | null;
  metadata?: Record<string, unknown>;
};

export class MessagesRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async findByExternalMessageId(externalMessageId: string) {
    const { data, error } = await this.supabase
      .from("messages")
      .select("*")
      .eq("external_message_id", externalMessageId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return assertSupabaseSuccess(data, error);
  }

  async createMessage(data: CreateMessageInput) {
    const { data: message, error } = await this.supabase.from("messages").insert(data).select("*").single();
    return assertSupabaseSuccess(message, error);
  }

  async listMessagesByConversationId(conversationId: string, limit = 100) {
    const { data, error } = await this.supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(limit);

    return assertSupabaseSuccess((data || []).reverse(), error);
  }

  async listMessagesBetween(periodStart: string, periodEnd: string) {
    const { data, error } = await this.supabase
      .from("messages")
      .select("*, conversations(id, metadata, customers(id, phone))")
      .gte("created_at", periodStart)
      .lte("created_at", periodEnd)
      .order("created_at", { ascending: true });

    return assertSupabaseSuccess(data || [], error) as Array<Record<string, unknown>>;
  }
}
