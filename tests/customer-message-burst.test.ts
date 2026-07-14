import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildEffectiveCustomerBurstMessage,
  CustomerMessageBurstService
} from "@/services/whatsapp/customer-message-burst.service";

describe("CustomerMessageBurstService", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("uses a 5 second default window to read consecutive WhatsApp bubbles before answering", async () => {
    vi.stubEnv("UNITV_MESSAGE_BURST_DEBOUNCE_MS", "");
    vi.useFakeTimers();
    const service = new CustomerMessageBurstService();
    let settled = false;
    const pending = service.isLatestMessageInBurst("default-window").then((value) => {
      settled = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(true);
  });

  it("lets only the last message in a short customer burst reach the AI pipeline", async () => {
    const service = new CustomerMessageBurstService(15);

    const first = service.isLatestMessageInBurst("conversation-id");
    await new Promise((resolve) => setTimeout(resolve, 3));
    const second = service.isLatestMessageInBurst("conversation-id");

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
  });

  it("does not delay or suppress a message when batching is disabled", async () => {
    const service = new CustomerMessageBurstService(0);
    await expect(service.isLatestMessageInBurst("conversation-id")).resolves.toBe(true);
  });

  it("joins consecutive customer bubbles so the last webhook keeps the complete request", () => {
    const effectiveMessage = buildEffectiveCustomerBurstMessage({
      currentMessage: "Tem como",
      currentMessageId: "customer-2",
      recentMessages: [
        { role: "assistant", content: "Como posso ajudar?", external_message_id: "assistant-1", created_at: "2026-07-14T19:45:12.000Z" },
        { role: "customer", content: "Queria fazer um teste", external_message_id: "customer-1", created_at: "2026-07-14T19:45:59.000Z" },
        { role: "customer", content: "Tem como", external_message_id: "customer-2", created_at: "2026-07-14T19:46:01.000Z" }
      ]
    });

    expect(effectiveMessage).toBe("Queria fazer um teste Tem como");
  });

  it("does not join an old customer message or cross an assistant boundary", () => {
    expect(buildEffectiveCustomerBurstMessage({
      currentMessage: "Tem como",
      currentMessageId: "customer-2",
      recentMessages: [
        { role: "customer", content: "Queria fazer um teste", external_message_id: "customer-old", created_at: "2026-07-14T19:44:00.000Z" },
        { role: "customer", content: "Tem como", external_message_id: "customer-2", created_at: "2026-07-14T19:46:01.000Z" }
      ]
    })).toBe("Tem como");

    expect(buildEffectiveCustomerBurstMessage({
      currentMessage: "Tem como",
      currentMessageId: "customer-2",
      recentMessages: [
        { role: "customer", content: "Queria fazer um teste", external_message_id: "customer-1", created_at: "2026-07-14T19:45:59.000Z" },
        { role: "assistant", content: "Qual aparelho?", external_message_id: "assistant-1", created_at: "2026-07-14T19:46:00.000Z" },
        { role: "customer", content: "Tem como", external_message_id: "customer-2", created_at: "2026-07-14T19:46:01.000Z" }
      ]
    })).toBe("Tem como");
  });
});
