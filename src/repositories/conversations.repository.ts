import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { assertSupabaseSuccess } from "./errors";
import { prepareConversationStatePersistence } from "@/lib/conversation-state";

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
    const statePersistence = prepareConversationStatePersistence(data.metadata || {});
    if (data.metadata) Object.assign(data.metadata, statePersistence.metadata);
    const { data: conversation, error } = await this.supabase
      .from("conversations")
      .insert({
        ...data,
        metadata: statePersistence.metadata,
        conversation_state: statePersistence.state,
        conversation_state_changed_at: new Date().toISOString(),
        ...extractDeviceContextFields(statePersistence.metadata),
        ...extractAgentDueFields(statePersistence.metadata)
      })
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
    const statePersistence = prepareConversationStatePersistence(metadata);
    const { data, error } = await this.supabase
      .from("conversations")
      .update({
        metadata: statePersistence.metadata,
        conversation_state: statePersistence.state,
        ...extractDeviceContextFields(statePersistence.metadata),
        ...extractAgentDueFields(statePersistence.metadata)
      })
      .eq("id", id)
      .select("*")
      .single();

    const conversation = assertSupabaseSuccess(data, error) as Record<string, unknown>;
    const persistedMetadata = conversation?.metadata;
    if (persistedMetadata && typeof persistedMetadata === "object" && !Array.isArray(persistedMetadata)) {
      for (const key of Object.keys(metadata)) delete metadata[key];
      Object.assign(metadata, persistedMetadata);
    }
    return conversation;
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

function extractDeviceContextFields(metadata: Record<string, unknown>) {
  const profile = metadata.lead_profile && typeof metadata.lead_profile === "object" && !Array.isArray(metadata.lead_profile)
    ? metadata.lead_profile as Record<string, unknown>
    : {};
  const keys = [
    "device_brand",
    "device_type",
    "operating_system",
    "has_play_store",
    "android_confirmed",
    "compatibility_status",
    "installation_attempt_status"
  ] as const;
  return keys.reduce<Record<string, unknown>>((result, key) => {
    if (profile[key] !== undefined) result[key] = profile[key];
    return result;
  }, {});
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
