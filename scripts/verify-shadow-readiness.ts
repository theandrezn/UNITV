import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

async function main() {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceRoleKey) throw new Error("Supabase environment is incomplete.");

  const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  const anon = createClient(url, anonKey, { auth: { persistSession: false } });

  const conversationCheck = await admin.from("conversations")
    .select("id,device_brand,device_type,operating_system,has_play_store,android_confirmed,compatibility_status,installation_attempt_status")
    .limit(1);
  if (conversationCheck.error) throw conversationCheck.error;

  const decisionKey = `readiness-${randomUUID()}`;
  const inserted = await admin.from("agent_shadow_decisions").insert({
    decision_key: decisionKey,
    channel: "followup",
    active_action: "wait",
    shadow_action: "silent",
    active_reason: "readiness_check",
    shadow_reason: "readiness_check",
    comparison_status: "match",
    blocked_before_ai: true,
    metadata: { synthetic: true }
  }).select("id").single();
  if (inserted.error || !inserted.data?.id) throw inserted.error || new Error("Synthetic shadow insert did not return an id.");

  const anonymousRead = await anon.from("agent_shadow_decisions").select("id").limit(1);
  const removed = await admin.from("agent_shadow_decisions").delete().eq("id", inserted.data.id);
  if (removed.error) throw removed.error;
  if (!anonymousRead.error && (anonymousRead.data || []).length > 0) {
    throw new Error("Anonymous access unexpectedly exposed shadow decisions.");
  }

  process.stdout.write(`${JSON.stringify({
    status: "ok",
    device_columns_readable: true,
    shadow_insert_delete: true,
    anonymous_shadow_rows: anonymousRead.data?.length || 0,
    anonymous_access_blocked_or_empty: true
  })}\n`);
}

void main();
