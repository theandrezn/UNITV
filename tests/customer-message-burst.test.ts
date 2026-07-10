import { describe, expect, it } from "vitest";

import { CustomerMessageBurstService } from "@/services/whatsapp/customer-message-burst.service";

describe("CustomerMessageBurstService", () => {
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
