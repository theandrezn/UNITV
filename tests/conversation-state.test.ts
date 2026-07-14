import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CANONICAL_CONVERSATION_STATES,
  isAllowedConversationStateTransition,
  normalizeConversationState,
  prepareConversationStatePersistence,
  resolveConversationState
} from "@/lib/conversation-state";

describe("canonical conversation state", () => {
  it.each([
    ["welcome_activation", "welcome_sent"],
    ["download_instructions", "download_link_sent"],
    ["install_support", "awaiting_download_installation"],
    ["checkout", "pix_permission"],
    ["awaiting_payment", "payment_pending"],
    ["human_support_reseller", "human_handoff"]
  ])("normalizes legacy state %s to %s", (legacy, canonical) => {
    expect(normalizeConversationState(legacy)).toBe(canonical);
  });

  it("uses conversation_state as authority when legacy fields disagree", () => {
    expect(resolveConversationState({
      conversationState: "payment_pending",
      metadata: {
        conversation_state: "payment_pending",
        conversation_stage: "welcome_activation",
        lead_profile: {
          stage: "welcome_activation",
          commercial_stage: "welcome_activation",
          etapa_atual: "welcome_activation"
        }
      }
    })).toBe("payment_pending");
  });

  it("prepares legacy writes for the canonical database column", () => {
    const persisted = prepareConversationStatePersistence({
      lead_profile: {
        stage: "download_instructions",
        last_customer_intent: "device_android_confirmed"
      }
    });

    expect(persisted.state).toBe("download_link_sent");
    expect(persisted.metadata).toMatchObject({
      conversation_state: "download_link_sent",
      state_transition_event: "device_android_confirmed"
    });
  });

  it("blocks regressions while preserving legitimate alternate flows", () => {
    expect(isAllowedConversationStateTransition("payment_pending", "welcome_sent")).toBe(false);
    expect(isAllowedConversationStateTransition("code_delivered", "device_qualification")).toBe(false);
    expect(isAllowedConversationStateTransition("price_discovery", "device_qualification")).toBe(true);
    expect(isAllowedConversationStateTransition("post_sale", "plan_preference")).toBe(true);
    expect(isAllowedConversationStateTransition("incompatible_device", "device_qualification")).toBe(true);
  });

  it("defines the database transition table, audit history and compatibility trigger", () => {
    const migration = readFileSync(
      join(process.cwd(), "supabase/migrations/20260714161058_add_canonical_conversation_state.sql"),
      "utf8"
    );

    expect(CANONICAL_CONVERSATION_STATES).toHaveLength(21);
    expect(migration).toContain("create table if not exists public.conversation_state_transitions");
    expect(migration).toContain("create table if not exists public.conversation_state_history");
    expect(migration).toContain("conversation_state_version bigint not null default 0");
    expect(migration).toContain("transition_status in ('initial', 'accepted', 'blocked')");
    expect(migration).toContain("create trigger conversations_enforce_canonical_state");
    expect(migration).toContain("public.mirror_unitv_conversation_state(new.metadata, old.conversation_state)");
    expect(migration).toContain("revoke all on table public.conversation_state_history from anon, authenticated");
  });
});
