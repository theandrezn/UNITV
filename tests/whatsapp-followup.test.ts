import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildFollowupText, WhatsappFollowupService } from "@/services/followups/whatsapp-followup.service";

function createService(conversations: Array<Record<string, unknown>>) {
  const conversationsRepository = {
    listOpenConversations: vi.fn(async () => conversations),
    updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: _id, metadata })),
    touchConversation: vi.fn(async () => ({}))
  };
  const messagesRepository = {
    createMessage: vi.fn(async (data) => ({ id: "message-id", ...data }))
  };
  const evolutionService = {
    sendTextMessage: vi.fn(async () => ({ sent: true }))
  };
  const auditService = {
    createAuditLog: vi.fn(async () => ({}))
  };

  return {
    service: new WhatsappFollowupService(
      conversationsRepository as never,
      messagesRepository as never,
      evolutionService as never,
      auditService as never
    ),
    conversationsRepository,
    messagesRepository,
    evolutionService,
    auditService
  };
}

describe("WhatsappFollowupService", () => {
  it("builds human commercial follow-up text", () => {
    expect(buildFollowupText({ followup_key: "values", plan_interest: "mensal" })).toContain("plano mensal");
    expect(buildFollowupText({ followup_key: "download", device: "TV Box / Android TV" })).toContain("Downloader");
  });

  it("sends a due follow-up once for the current stage", async () => {
    const now = new Date("2026-07-06T12:00:00.000Z");
    const { service, evolutionService, messagesRepository, conversationsRepository } = createService([
      {
        id: "conversation-id",
        customer_id: "customer-id",
        external_conversation_id: "5511999998888@s.whatsapp.net",
        customers: { id: "customer-id", phone: "5511999998888" },
        metadata: {
          followup_key: "values",
          followup_due_at: "2026-07-06T11:59:00.000Z",
          last_bot_message_at: "2026-07-06T11:54:00.000Z",
          last_customer_message_at: "2026-07-06T11:53:00.000Z",
          last_followup_stage_id: "ask_price:values:1",
          followup_count: 0
        }
      }
    ]);

    const result = await service.processDueFollowups(now);

    expect(result).toEqual({ checked: 1, sent: 1, skipped: 0 });
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ phone: "5511999998888", text: expect.stringContaining("valores") })
    );
    expect(messagesRepository.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", external_message_id: "followup:conversation-id:ask_price:values:1" })
    );
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        followup_due_at: null,
        followup_sent_stage_id: "ask_price:values:1",
        followup_count: 1
      })
    );
  });

  it("does not send when the customer already replied after the bot", async () => {
    const { service, evolutionService } = createService([
      {
        id: "conversation-id",
        customers: { phone: "5511999998888" },
        metadata: {
          followup_key: "pix",
          followup_due_at: "2026-07-06T11:59:00.000Z",
          last_bot_message_at: "2026-07-06T11:54:00.000Z",
          last_customer_message_at: "2026-07-06T11:55:00.000Z"
        }
      }
    ]);

    const result = await service.processDueFollowups(new Date("2026-07-06T12:00:00.000Z"));

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
  });

  it("does not send while a specialist is active in the last 5 minutes", async () => {
    const { service, evolutionService } = createService([
      {
        id: "conversation-id",
        customers: { phone: "5511999998888" },
        metadata: {
          requires_human: true,
          followup_key: "support",
          followup_due_at: "2026-07-06T11:59:00.000Z",
          last_specialist_message_at: "2026-07-06T11:58:00.000Z"
        }
      }
    ]);

    const result = await service.processDueFollowups(new Date("2026-07-06T12:00:00.000Z"));

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
  });

  it("does not duplicate a follow-up for the same stage", async () => {
    const { service, evolutionService } = createService([
      {
        id: "conversation-id",
        customers: { phone: "5511999998888" },
        metadata: {
          followup_key: "test",
          followup_due_at: "2026-07-06T11:59:00.000Z",
          followup_sent_at: "2026-07-06T11:59:20.000Z",
          followup_sent_stage_id: "free_trial:test:1",
          last_followup_stage_id: "free_trial:test:1",
          followup_count: 1
        }
      }
    ]);

    const result = await service.processDueFollowups(new Date("2026-07-06T12:00:00.000Z"));

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
  });
});
