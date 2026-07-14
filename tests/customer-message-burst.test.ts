import { afterEach, describe, expect, it, vi } from "vitest";

import { CustomerMessageBurstService } from "@/services/whatsapp/customer-message-burst.service";

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
});
