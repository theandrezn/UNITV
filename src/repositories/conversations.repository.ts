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
    const { data: conversation, error } = await this.supabase
      .from("conversations")
      .insert({ ...data, ...extractAgentDueFields(data.metadata) })
      .select("*")
      .single();
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

  async updateConversationMetadata(id: string, metadata: Record<string, unknown>) {
    const { data, error } = await this.supabase
      .from("conversations")
      .update({ metadata, ...extractAgentDueFields(metadata) })
      .eq("id", id)
      .select("*")
      .single();

    return assertSupabaseSuccess(data, error);
  }

  async listRecentConversations(limit = 50) {
    const { data, error } = await this.supabase
      .from("conversations")
      .select("*, customers(id, name, phone)")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(limit);

    return assertSupabaseSuccess(data || [], error);
  }

  async listOpenConversations(limit = 200) {
    const { data, error } = await this.supabase
      .from("conversations")
      .select("*, customers(id, name, phone)")
      .eq("channel", "whatsapp")
      .eq("status", "open")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(limit);

    return assertSupabaseSuccess(data || [], error);
  }

  async listFollowupCandidates(now: Date, limit = 200) {
    const nowIso = now.toISOString();
    const { data, error } = await this.supabase
      .from("conversations")
      .select("*, customers(id, name, phone)")
      .eq("channel", "whatsapp")
      .eq("status", "open")
      .or(`followup_due_at.lte.${nowIso},response_due_at.lte.${nowIso}`)
      .order("followup_due_at", { ascending: true, nullsFirst: false })
      .limit(limit);

    return assertSupabaseSuccess(data || [], error);
  }

  async listTouchedBetween(periodStart: string, periodEnd: string, limit = 1000) {
    const { data, error } = await this.supabase
      .from("conversations")
      .select("*, customers(id, name, phone)")
      .eq("channel", "whatsapp")
      .or(`last_message_at.gte.${periodStart},created_at.gte.${periodStart},updated_at.gte.${periodStart}`)
      .lte("created_at", periodEnd)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(limit);

    return assertSupabaseSuccess(data || [], error) as Array<Record<string, unknown>>;
  }
}

function extractAgentDueFields(metadata: Record<string, unknown> | undefined) {
  return {
    followup_due_at: parseTimestamp(metadata?.followup_due_at),
    response_due_at: parseTimestamp(metadata?.response_due_at)
  };
}

function parseTimestamp(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
