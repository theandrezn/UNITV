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

  it("sends a selectable WhatsApp list through Evolution sendList", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ key: { id: "list-message-id" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient({
      apiUrl: "https://evolution.example.com",
      apiKey: "evolution-key",
      instanceName: "unitv"
    });

    await client.sendListMessage({
      phone: "5511999998888",
      title: "Como posso te ajudar?",
      description: "Escolha uma opcao abaixo",
      buttonText: "Ver opcoes",
      footerText: "UNiTV",
      sections: [
        {
          title: "Atendimento",
          rows: [
            { title: "Ver planos", description: "Conheca os valores", rowId: "menu:main:view_plans" }
          ]
        }
      ]
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://evolution.example.com/message/sendList/unitv",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          number: "5511999998888",
          title: "Como posso te ajudar?",
          description: "Escolha uma opcao abaixo",
          buttonText: "Ver opcoes",
          footerText: "UNiTV",
          sections: [
            {
              title: "Atendimento",
              rows: [
                { title: "Ver planos", description: "Conheca os valores", rowId: "menu:main:view_plans" }
              ]
            }
          ]
        })
      })
    );
  });
});
