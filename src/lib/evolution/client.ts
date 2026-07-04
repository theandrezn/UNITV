import { getEvolutionEnv } from "@/lib/env";
import {
  extractIncomingMessageFromWebhook,
  getEvolutionIdempotencyKey,
  normalizePhone,
  type IncomingEvolutionMessage
} from "@/lib/evolution/payload";

export { extractIncomingMessageFromWebhook, getEvolutionIdempotencyKey, normalizePhone };
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
