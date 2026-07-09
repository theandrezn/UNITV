import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

import { GET } from "@/app/api/admin/conversations/[conversationId]/decision-trace/route";

describe("conversation decision trace route", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.ADMIN_API_KEY = "secret";
  });

  it("requires the admin API key", async () => {
    const response = await GET(
      new NextRequest("https://unitv.test/api/admin/conversations/conversation-1/decision-trace"),
      { params: Promise.resolve({ conversationId: "conversation-1" }) },
      { repository: { listEventsByConversationId: vi.fn() } }
    );

    expect(response.status).toBe(401);
  });

  it("returns a privacy-safe decision trail without message content", async () => {
    const repository = {
      listEventsByConversationId: vi.fn(async () => [{
        id: "event-1",
        created_at: "2026-07-09T20:00:00.000Z",
        event_type: "local_rule_used",
        event_source: "chat_agent",
        intent: "greeting",
        stage: "awaiting_download_installation",
        device: "android_phone",
        plan_interest: null,
        metadata: {
          rule: "conversation_brain_download_android_confirmation",
          brain_stage: "awaiting_download_installation",
          brain_context_active: true,
          brain_allows_initial_greeting: false,
          brain_allows_human_handoff: false,
          brain_allows_followup: true,
          last_customer_message: "E Android"
        }
      }])
    };
    const response = await GET(
      new NextRequest("https://unitv.test/api/admin/conversations/conversation-1/decision-trace", {
        headers: { "x-admin-api-key": "secret" }
      }),
      { params: Promise.resolve({ conversationId: "conversation-1" }) },
      { repository }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(repository.listEventsByConversationId).toHaveBeenCalledWith("conversation-1", 100);
    expect(body.traces).toEqual([expect.objectContaining({
      stage: "awaiting_download_installation",
      decision: expect.objectContaining({
        rule: "conversation_brain_download_android_confirmation",
        initial_greeting_allowed: false,
        human_handoff_allowed: false
      })
    })]);
    expect(JSON.stringify(body)).not.toContain("E Android");
  });
});
