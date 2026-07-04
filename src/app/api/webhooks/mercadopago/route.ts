import { after, NextResponse } from "next/server";
import { getMercadoPagoEnv } from "@/lib/env";
import { validateMercadoPagoSignature } from "@/lib/mercadopago/signature";
import { PaymentConfirmationService } from "@/services/payments/payment-confirmation.service";
import { WebhooksService } from "@/services/webhooks.service";

type MercadoPagoWebhookDependencies = {
  webhooksService: Pick<
    WebhooksService,
    "findWebhookByIdempotencyKey" | "createWebhookEvent" | "markWebhookIgnored"
  >;
  paymentConfirmationService: Pick<PaymentConfirmationService, "process">;
  schedule: (task: () => Promise<unknown>) => void;
  secret: string;
};

export async function POST(request: Request) {
  const env = getMercadoPagoEnv();
  return handleMercadoPagoWebhook(request, {
    webhooksService: new WebhooksService(),
    paymentConfirmationService: new PaymentConfirmationService(),
    schedule: (task) => after(task),
    secret: env.MERCADO_PAGO_WEBHOOK_SECRET
  });
}

export async function handleMercadoPagoWebhook(
  request: Request,
  dependencies: MercadoPagoWebhookDependencies
) {
  const url = new URL(request.url);
  const body = await readJsonBody(request);
  const dataId = url.searchParams.get("data.id") || readNestedString(body, "data", "id");
  const eventType = url.searchParams.get("type") || readString(body, "type") || readString(body, "action") || "unknown";
  const signature = request.headers.get("x-signature") || "";
  const requestId = request.headers.get("x-request-id") || "";

  if (
    !dataId ||
    !validateMercadoPagoSignature({
      dataId,
      requestId,
      signature,
      secret: dependencies.secret
    })
  ) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }

  const notificationId = readString(body, "id") || requestId;
  const idempotencyKey = `mercado_pago:${notificationId}`;
  const existing = await dependencies.webhooksService.findWebhookByIdempotencyKey(idempotencyKey);
  if (existing) {
    return NextResponse.json({ status: "ok", result: "duplicate" });
  }

  const webhookEvent = await dependencies.webhooksService.createWebhookEvent({
    provider: "mercado_pago",
    event_type: eventType,
    event_id: notificationId,
    idempotency_key: idempotencyKey,
    status: "received",
    raw_payload: {
      ...body,
      query: { data_id: dataId, type: eventType }
    }
  });

  if (eventType !== "payment") {
    await dependencies.webhooksService.markWebhookIgnored(String(webhookEvent.id));
    return NextResponse.json({ status: "ok", result: "ignored" });
  }

  dependencies.schedule(() =>
    dependencies.paymentConfirmationService.process({
      webhookEventId: String(webhookEvent.id),
      paymentId: dataId
    })
  );

  return NextResponse.json({ status: "ok", result: "received" });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readString(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return typeof field === "string" || typeof field === "number" ? String(field) : null;
}

function readNestedString(value: Record<string, unknown>, parent: string, key: string) {
  const nested = value[parent];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? readString(nested as Record<string, unknown>, key)
    : null;
}
