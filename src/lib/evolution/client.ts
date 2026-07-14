import { getEvolutionEnv } from "@/lib/env";
import {
  extractIncomingMessageFromWebhook,
  getEvolutionIdempotencyKey,
  normalizePhone,
  isIncomingAudioMessage,
  type IncomingEvolutionMessage
} from "@/lib/evolution/payload";

export { extractIncomingMessageFromWebhook, getEvolutionIdempotencyKey, isIncomingAudioMessage, normalizePhone };
export type { IncomingEvolutionMessage };

type EvolutionClientOptions = {
  apiUrl?: string;
  apiKey?: string;
  instanceName?: string;
};

type SendTextMessageInput = {
  phone: string;
  text: string;
};

type SendMediaMessageInput = {
  phone: string;
  base64: string;
  mimetype: string;
  fileName: string;
  caption: string;
};

type SendListMessageInput = {
  phone: string;
  title: string;
  description: string;
  buttonText: string;
  footerText: string;
  sections: Array<{
    title: string;
    rows: Array<{ title: string; description: string; rowId: string }>;
  }>;
};

type SendButtonMessageInput = {
  phone: string;
  title: string;
  description: string;
  footerText: string;
  buttons: Array<{ id: string; displayText: string }>;
};

type GetMediaBase64Input = {
  externalMessageId: string;
};

export class EvolutionClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly instanceName: string;

  constructor(options: EvolutionClientOptions = {}) {
    const env = options.apiUrl && options.apiKey && options.instanceName ? null : getEvolutionEnv();
    this.apiUrl = (options.apiUrl || env?.EVOLUTION_API_URL || "").replace(/\/+$/, "");
    this.apiKey = options.apiKey || env?.EVOLUTION_API_KEY || "";
    this.instanceName = options.instanceName || env?.EVOLUTION_INSTANCE_NAME || "";
  }

  normalizePhone(phone: string) {
    return normalizePhone(phone);
  }

  extractIncomingMessageFromWebhook(payload: unknown) {
    return extractIncomingMessageFromWebhook(payload);
  }

  async sendTextMessage({ phone, text }: SendTextMessageInput) {
    const response = await fetch(`${this.apiUrl}/message/sendText/${encodeURIComponent(this.instanceName)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: this.apiKey
      },
      body: JSON.stringify({
        number: normalizePhone(phone),
        text
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Evolution sendTextMessage failed: ${response.status} ${body}`);
    }

    return response.json().catch(() => ({}));
  }

  async getMediaBase64({ externalMessageId }: GetMediaBase64Input) {
    const response = await fetch(`${this.apiUrl}/chat/getBase64FromMediaMessage/${encodeURIComponent(this.instanceName)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: this.apiKey
      },
      body: JSON.stringify({
        message: { key: { id: externalMessageId } },
        convertToMp4: false
      }),
      signal: AbortSignal.timeout(20_000)
    });

    if (!response.ok) {
      throw new Error(`Evolution getMediaBase64 failed with status ${response.status}.`);
    }

    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
    const base64 = firstNonEmptyString(payload.base64, data.base64);
    if (!base64) {
      throw new Error("Evolution getMediaBase64 returned no media data.");
    }

    return {
      base64,
      mimeType: firstNonEmptyString(payload.mimetype, payload.mimeType, data.mimetype, data.mimeType) || null,
      fileName: firstNonEmptyString(payload.fileName, data.fileName) || null
    };
  }

  async sendMediaMessage({ phone, base64, mimetype, fileName, caption }: SendMediaMessageInput) {
    const response = await fetch(`${this.apiUrl}/message/sendMedia/${encodeURIComponent(this.instanceName)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: this.apiKey
      },
      body: JSON.stringify({
        number: normalizePhone(phone),
        mediatype: "image",
        mimetype,
        caption,
        media: base64.replace(/^data:[^;]+;base64,/, ""),
        fileName
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Evolution sendMediaMessage failed: ${response.status} ${body}`);
    }

    return response.json().catch(() => ({}));
  }

  async sendListMessage({ phone, title, description, buttonText, footerText, sections }: SendListMessageInput) {
    const response = await fetch(`${this.apiUrl}/message/sendList/${encodeURIComponent(this.instanceName)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: this.apiKey
      },
      body: JSON.stringify({
        number: normalizePhone(phone),
        title,
        description,
        buttonText,
        footerText,
        sections
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Evolution sendListMessage failed: ${response.status} ${body}`);
    }

    return response.json().catch(() => ({}));
  }

  async sendButtonMessage({ phone, title, description, footerText, buttons }: SendButtonMessageInput) {
    const response = await fetch(`${this.apiUrl}/message/sendButtons/${encodeURIComponent(this.instanceName)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: this.apiKey
      },
      body: JSON.stringify({
        number: normalizePhone(phone),
        title,
        description,
        footer: footerText,
        buttons: buttons.map((button) => ({
          type: "reply",
          displayText: button.displayText,
          id: button.id
        }))
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Evolution sendButtonMessage failed: ${response.status} ${body}`);
    }

    return response.json().catch(() => ({}));
  }

  async getInstanceStatus() {
    const response = await fetch(`${this.apiUrl}/instance/connectionState/${encodeURIComponent(this.instanceName)}`, {
      method: "GET",
      headers: {
        apikey: this.apiKey
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Evolution getInstanceStatus failed: ${response.status} ${body}`);
    }

    return response.json().catch(() => ({}));
  }
}

function firstNonEmptyString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim() || "";
}
