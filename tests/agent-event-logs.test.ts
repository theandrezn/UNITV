import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AgentEventLogsRepository } from "@/repositories/agent-event-logs.repository";

describe("agent event logs repository", () => {
  it("sanitizes metadata before inserting event logs", async () => {
    const insert = vi.fn((value) => ({
      select: () => ({
        single: () => Promise.resolve({ data: { id: "event-id", ...value }, error: null })
      })
    }));
    const repository = new AgentEventLogsRepository({ from: vi.fn(() => ({ insert })) } as never);

    await repository.createEvent({
      event_type: "customer_message",
      event_source: "webhook",
      metadata: {
        text: "CPF 123.456.789-09 Pix: 67070222000151 codigo ABC12345",
        media: { base64: "abc" }
      }
    });

    const inserted = insert.mock.calls[0][0];
    expect(inserted.metadata.text).not.toContain("123.456.789-09");
    expect(inserted.metadata.text).not.toContain("67070222000151");
    expect(inserted.metadata.text).not.toContain("ABC12345");
    expect(inserted.metadata.media).toBe("[DADO_MASCARADO]");
  });
});
