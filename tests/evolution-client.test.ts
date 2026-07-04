import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { EvolutionClient } from "@/lib/evolution/client";

describe("EvolutionClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends a base64 Pix QR image through Evolution sendMedia", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ key: { id: "message-id" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      apiUrl: "https://evolution.example.com",
      apiKey: "evolution-key",
      instanceName: "unitv"
    });

    await client.sendMediaMessage({
      phone: "5511999998888",
      base64: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
      mimetype: "image/png",
      fileName: "pix-order.png",
      caption: "QR Code Pix"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://evolution.example.com/message/sendMedia/unitv",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: "evolution-key" },
        body: JSON.stringify({
          number: "5511999998888",
          mediatype: "image",
          mimetype: "image/png",
          caption: "QR Code Pix",
          media: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
          fileName: "pix-order.png"
        })
      })
    );
  });
});
