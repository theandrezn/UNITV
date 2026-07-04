import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { WebhookEvent } from "@/types/domain";
import { assertSupabaseSuccess } from "./errors";

export class WebhookEventsRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async createWebhookEvent(data: WebhookEvent) {
    const { data: event, error } = await this.supabase.from("webhook_events").insert(data).select("*").single();
    return assertSupabaseSuccess(event, error);
  }

  async findWebhookByIdempotencyKey(key: string) {
    const { data, error } = await this.supabase
      .from("webhook_events")
      .select("*")
      .eq("idempotency_key", key)
      .maybeSingle();
    return assertSupabaseSuccess(data, error);
  }

  async markWebhookIgnored(id: string) {
    const { data, error } = await this.supabase
      .from("webhook_events")
      .update({ status: "ignored", processed_at: new Date().toISOString(), error_message: null })
      .eq("id", id)
      .select("*")
      .single();
    return assertSupabaseSuccess(data, error);
  }

  async markWebhookProcessing(id: string) {
    const { data, error } = await this.supabase
      .from("webhook_events")
      .update({ status: "processing", error_message: null })
      .eq("id", id)
      .select("*")
      .single();
    return assertSupabaseSuccess(data, error);
  }

  async markWebhookProcessed(id: string) {
    const { data, error } = await this.supabase
      .from("webhook_events")
      .update({ status: "processed", processed_at: new Date().toISOString(), error_message: null })
      .eq("id", id)
      .select("*")
      .single();
    return assertSupabaseSuccess(data, error);
  }

  async markWebhookFailed(id: string, errorMessage: string) {
    const { data, error } = await this.supabase
      .from("webhook_events")
      .update({ status: "failed", error_message: errorMessage })
      .eq("id", id)
      .select("*")
      .single();
    return assertSupabaseSuccess(data, error);
  }
}
