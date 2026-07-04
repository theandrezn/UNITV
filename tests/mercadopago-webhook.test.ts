import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { handleMercadoPagoWebhook } from "@/app/api/webhooks/mercadopago/route";

const secret = "webhook-secret";
const dataId = "987654";
const requestId = "request-id";
const timestamp = "1783188000";

function signature(id = dataId) {
  const digest = createHmac("sha256", secret)
    .update(`id:${id.toLowerCase()};request-id:${requestId};ts:${timestamp};`)
    .digest("hex");
  return `ts=${timestamp},v1=${digest}`;
}

function createRequest(input: { type?: string; signature?: string; body?: Record<string, unknown> } = {}) {
  const type = input.type ?? "payment";
  return new Request(`http://localhost/api/webhooks/mercadopago?data.id=${dataId}&type=${type}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
      ...(input.signature === undefined ? { "x-signature": signature() } : input.signature ? { "x-signature": input.signature } : {})
    },
    body: JSON.stringify(input.body ?? { id: "notification-id", type, data: { id: dataId } })
  });
}

function createDependencies(existing: Record<string, unknown> | null = null) {
  const webhooksService = {
    findWebhookByIdempotencyKey: vi.fn(async () => existing),
    createWebhookEvent: vi.fn(async (data) => ({ id: "webhook-id", ...data })),
    markWebhookIgnored: vi.fn(async () => ({}))
  };
  const paymentConfirmationService = { process: vi.fn(async () => ({})) };
  const scheduled: Array<() => Promise<unknown>> = [];
  const schedule = vi.fn((task: () => Promise<unknown>) => scheduled.push(task));

  return { webhooksService, paymentConfirmationService, schedule, scheduled, secret };
}

describe("Mercado Pago webhook route", () => {
  it("returns 401 when the signature is missing", async () => {
    const dependencies = createDependencies();
    const response = await handleMercadoPagoWebhook(createRequest({ signature: "" }), dependencies as never);

    expect(response.status).toBe(401);
    expect(dependencies.webhooksService.createWebhookEvent).not.toHaveBeenCalled();
  });

  it("returns 401 when the signature is invalid", async () => {
    const dependencies = createDependencies();
    const response = await handleMercadoPagoWebhook(
      createRequest({ signature: `ts=${timestamp},v1=${"0".repeat(64)}` }),
      dependencies as never
    );

    expect(response.status).toBe(401);
  });

  it("stores and ignores a signed non-payment event", async () => {
    const dependencies = createDependencies();
    const response = await handleMercadoPagoWebhook(createRequest({ type: "merchant_order" }), dependencies as never);

    expect(response.status).toBe(200);
    expect(dependencies.webhooksService.createWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "mercado_pago", event_type: "merchant_order", status: "received" })
    );
    expect(dependencies.webhooksService.markWebhookIgnored).toHaveBeenCalledWith("webhook-id");
    expect(dependencies.schedule).not.toHaveBeenCalled();
  });

  it("stores a signed payment event and schedules processing", async () => {
    const dependencies = createDependencies();
    const response = await handleMercadoPagoWebhook(createRequest(), dependencies as never);

    expect(response.status).toBe(200);
    expect(dependencies.webhooksService.createWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "mercado_pago",
        event_id: "notification-id",
        idempotency_key: "mercado_pago:notification-id",
        raw_payload: expect.objectContaining({ data: { id: dataId } })
      })
    );
    expect(dependencies.schedule).toHaveBeenCalledTimes(1);

    await dependencies.scheduled[0]();
    expect(dependencies.paymentConfirmationService.process).toHaveBeenCalledWith({
      webhookEventId: "webhook-id",
      paymentId: dataId
    });
  });

  it("acknowledges a duplicate without scheduling it again", async () => {
    const dependencies = createDependencies({ id: "existing-webhook" });
    const response = await handleMercadoPagoWebhook(createRequest(), dependencies as never);

    expect(response.status).toBe(200);
    expect(dependencies.webhooksService.createWebhookEvent).not.toHaveBeenCalled();
    expect(dependencies.schedule).not.toHaveBeenCalled();
  });
});
