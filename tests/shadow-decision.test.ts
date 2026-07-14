import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ShadowDecisionService, summarizeShadowDecisions } from "@/services/agent/shadow-decision.service";

describe("shadow decision evaluation", () => {
  it("detects a reply that should have remained silent", async () => {
    const upsertDecision = vi.fn(async (value) => value);
    const service = new ShadowDecisionService({ upsertDecision } as never);
    await service.compareReply({
      conversationId: "11111111-1111-4111-8111-111111111111",
      messageId: "anonymous-message",
      currentState: "incompatible_device",
      legacyCandidate: { reply: "Baixe pelo Downloader e tente instalar novamente.", responseRule: "legacy_install" },
      unifiedAction: {
        action: "silent",
        next_state: "incompatible_device",
        reason: "device_incompatible",
        reply: null,
        followup_action: { type: "cancel", key: null, dueAt: null },
        backend_artifact: null,
        response_rule: "conversation_brain_incompatible_installation_failure_silent"
      }
    });

    expect(upsertDecision).toHaveBeenCalledWith(expect.objectContaining({
      active_action: "reply",
      shadow_action: "silent",
      comparison_status: "divergent",
      divergence_types: expect.arrayContaining(["reply_when_should_be_silent", "installation_for_incompatible_device"])
    }));
  });

  it("summarizes review and token metrics", () => {
    expect(summarizeShadowDecisions([
      { comparison_status: "match", would_send: false, blocked_before_ai: true, ai_call_count: 0, input_tokens: 0, output_tokens: 0, divergence_types: [] },
      { comparison_status: "divergent", would_send: true, blocked_before_ai: false, ai_call_count: 1, input_tokens: 120, output_tokens: 20, divergence_types: ["false_handoff"] }
    ])).toMatchObject({
      total: 2,
      matches: 1,
      divergences: 1,
      would_send: 1,
      blocked_before_ai: 1,
      ai_calls: 1,
      input_tokens: 120,
      output_tokens: 20,
      by_divergence: { false_handoff: 1 }
    });
  });
});
