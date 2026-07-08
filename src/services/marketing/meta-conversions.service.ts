import "server-only";
import { createHash } from "node:crypto";
import { getMetaConversionsConfig, type MetaConversionsConfig } from "@/lib/env";

type MetaConversionsClient = (input: string, init?: RequestInit) => Promise<Response>;

type TrackPurchaseInput = {
  eventId: string;
  eventTime: number;
  orderId: string;
  orderNumber: string;
  amountCents: number;
  currency: string;
  customerPhone?: string | null;
  planSlug?: string | null;
};

type TrackPurchaseResult =
  | { status: "skipped"; reason: "disabled" | "missing_config" }
  | { status: "sent"; eventId: string; response: Record<string, unknown> }
  | { status: "failed"; eventId: string; error: string };

export class MetaConversionsService {
  constructor(
    private readonly config: MetaConversionsConfig = getMetaConversionsConfig(),
    private readonly client: MetaConversionsClient = fetch
  ) {}

  async trackPurchase(input: TrackPurchaseInput): Promise<TrackPurchaseResult> {
    if (!this.config.enabled) {
      return { status: "skipped", reason: "disabled" };
    }

    if (!this.config.accessToken || !this.config.datasetId || !this.config.apiVersion) {
      return { status: "skipped", reason: "missing_config" };
    }

    const payload = {
      data: [
        {
          event_name: "Purchase",
          event_time: input.eventTime,
          event_id: input.eventId,
          action_source: "business_messaging",
          messaging_channel: "whatsapp",
          user_data: buildUserData(input.customerPhone),
          custom_data: {
            currency: input.currency,
            value: input.amountCents / 100,
            order_id: input.orderNumber,
            content_name: input.planSlug || "unitv",
            content_type: "product"
          }
        }
      ],
      ...(this.config.testEventCode ? { test_event_code: this.config.testEventCode } : {})
    };

    try {
      const response = await this.client(
        `https://graph.facebook.com/${this.config.apiVersion}/${this.config.datasetId}/events`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.config.accessToken}`
          },
          body: JSON.stringify(payload)
        }
      );
      const body = await readJsonResponse(response);
      if (!response.ok) {
        return { status: "failed", eventId: input.eventId, error: JSON.stringify(body) };
      }
      return { status: "sent", eventId: input.eventId, response: body };
    } catch (error) {
      return {
        status: "failed",
        eventId: input.eventId,
        error: error instanceof Error ? error.message : "unknown_meta_capi_error"
      };
    }
  }
}

function buildUserData(phone?: string | null) {
  const normalizedPhone = normalizePhone(phone);
  return normalizedPhone ? { ph: [sha256(normalizedPhone)] } : {};
}

function normalizePhone(phone?: string | null) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits || null;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = await response.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
