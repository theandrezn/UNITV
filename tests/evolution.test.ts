import { describe, expect, it } from "vitest";
import {
  extractIncomingMessageFromWebhook,
  getEvolutionIdempotencyKey,
  normalizePhone
} from "@/lib/evolution/payload";
import { sanitizeReply } from "@/lib/agent/reply-safety";
import fixture from "./fixtures/evolution-message.json";

describe("Evolution webhook helpers", () => {
  it("normalizes WhatsApp phones", () => {
    expect(normalizePhone("5511999998888@s.whatsapp.net")).toBe("5511999998888");
    expect(normalizePhone("+55 (11) 99999-8888")).toBe("5511999998888");
  });

  it("extracts an incoming message from an Evolution payload", () => {
    const message = extractIncomingMessageFromWebhook(fixture);

    expect(message).toMatchObject({
      event: "messages.upsert",
      instance: "unitv",
      externalMessageId: "BAE51234567890",
      remoteJid: "5511999998888@s.whatsapp.net",
      phone: "5511999998888",
      contactName: "Cliente Teste",
      text: "Oi, quero saber os planos da UniTV",
      messageType: "conversation",
      fromMe: false,
      isGroup: false
    });
  });

  it("extracts the selected row id from an interactive WhatsApp list", () => {
    const payload = structuredClone(fixture) as Record<string, any>;
    payload.data.message = {
      listResponseMessage: {
        title: "Mensal - R$ 25,00",
        singleSelectReply: { selectedRowId: "menu:plans:mensal" }
      }
    };
    payload.data.messageType = "listResponseMessage";

    expect(extractIncomingMessageFromWebhook(payload)?.text).toBe("menu:plans:mensal");
  });

  it("extracts reply button ids from interactive WhatsApp messages", () => {
    const payload = structuredClone(fixture) as Record<string, any>;
    payload.data.message = {
      buttonsResponseMessage: {
        selectedButtonId: "menu:payment:pix",
        selectedDisplayText: "Pagar com Pix"
      }
    };
    payload.data.messageType = "buttonsResponseMessage";

    expect(extractIncomingMessageFromWebhook(payload)?.text).toBe("menu:payment:pix");
  });

  it("extracts Meta click-to-WhatsApp attribution from Evolution contextInfo", () => {
    const payload = structuredClone(fixture) as Record<string, any>;
    payload.data.contextInfo = {
      ctwaSignals: "all,all",
      entryPointConversionSource: "ctwa_ad",
      externalAdReply: {
        ctwaClid: "ctwa-click-id",
        sourceId: "120247137528920330",
        sourceUrl: "https://fb.me/76XPxmNTl",
        sourceType: "ad",
        title: "Anuncio UNITV",
        body: "Teste UNITV"
      }
    };

    expect(extractIncomingMessageFromWebhook(payload)?.metaReferral).toEqual(expect.objectContaining({
      ctwaClid: "ctwa-click-id",
      sourceId: "120247137528920330",
      sourceUrl: "https://fb.me/76XPxmNTl",
      entryPointConversionSource: "ctwa_ad",
      ctwaSignals: "all,all"
    }));
  });

  it("marks messages sent by myself for ignore", () => {
    const payload = structuredClone(fixture);
    payload.data.key.fromMe = true;

    expect(extractIncomingMessageFromWebhook(payload)?.fromMe).toBe(true);
  });

  it("marks group messages for ignore", () => {
    const payload = structuredClone(fixture);
    payload.data.key.remoteJid = "5511999998888-123456@g.us";

    expect(extractIncomingMessageFromWebhook(payload)?.isGroup).toBe(true);
  });

  it("creates idempotency keys from external message ids", () => {
    expect(getEvolutionIdempotencyKey("BAE51234567890")).toBe("evolution:BAE51234567890");
  });

  it("allows callers to skip empty messages", () => {
    const payload = structuredClone(fixture);
    payload.data.message.conversation = "";

    expect(extractIncomingMessageFromWebhook(payload)?.text).toBe("");
  });

  it("does not allow activation codes in generated replies at this phase", () => {
    expect(sanitizeReply("Seu código de ativação e ABCD-1234-XYZ")).not.toContain("ABCD-1234-XYZ");
    expect(sanitizeReply("Seu código de ativação e ABCD-1234-XYZ").toLowerCase()).not.toContain(
      "código de ativação"
    );
  });
});
