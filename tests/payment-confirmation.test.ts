import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PaymentConfirmationService } from "@/services/payments/payment-confirmation.service";

type TestPayment = {
  id: string;
  status: string;
  amountCents: number;
  currency: string;
  externalReference: string | null;
  metadata: Record<string, unknown>;
  transactionId: string | null;
  approvedAt: string | null;
  rawPayload: Record<string, unknown>;
};

const basePayment: TestPayment = {
  id: "987654",
  status: "approved",
  amountCents: 2500,
  currency: "BRL",
  externalReference: "UTV-20260704-000100",
  metadata: {},
  transactionId: "transaction-id",
  approvedAt: "2026-07-04T18:00:00.000Z",
  rawPayload: { id: 987654, status: "approved" }
};

const baseOrder = {
  id: "11111111-1111-4111-8111-111111111111",
  order_number: "UTV-20260704-000100",
  customer_id: "22222222-2222-4222-8222-222222222222",
  plan_id: "33333333-3333-4333-8333-333333333333",
  amount_cents: 2500,
  currency: "BRL",
  status: "pending_payment",
  code_id: null,
  customers: { phone: "5511999998888" }
};

function createHarness() {
  const mercadoPagoService = { getPayment: vi.fn(async () => basePayment) };
  const ordersService = {
    findOrderByOrderNumber: vi.fn(async (): Promise<typeof baseOrder | null> => baseOrder),
    findOrderById: vi.fn(async (): Promise<typeof baseOrder | null> => null),
    transitionToPaid: vi.fn(async (): Promise<(typeof baseOrder & { status: string }) | null> => ({
      ...baseOrder,
      status: "paid"
    })),
    transitionStatus: vi.fn(async (): Promise<typeof baseOrder | null> => ({ ...baseOrder }))
  };
  const paymentsService = { upsertProviderPayment: vi.fn(async (data) => ({ id: "payment-row", ...data })) };
  const webhooksService = {
    markWebhookProcessing: vi.fn(async () => ({})),
    markWebhookProcessed: vi.fn(async () => ({})),
    markWebhookFailed: vi.fn(async () => ({}))
  };
  const auditService = { createAuditLog: vi.fn(async () => ({})) };
  const evolutionService = { sendTextMessage: vi.fn(async () => ({ sent: true })) };
  const service = new PaymentConfirmationService(
    mercadoPagoService as never,
    ordersService as never,
    paymentsService as never,
    webhooksService as never,
    auditService as never,
    evolutionService as never
  );

  return {
    service,
    mercadoPagoService,
    ordersService,
    paymentsService,
    webhooksService,
    auditService,
    evolutionService
  };
}

describe("PaymentConfirmationService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks an exact approved payment paid and sends one WhatsApp message", async () => {
    const harness = createHarness();

    const result = await harness.service.process({ webhookEventId: "webhook-id", paymentId: "987654" });

    expect(harness.paymentsService.upsertProviderPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: baseOrder.id,
        provider: "mercado_pago",
        provider_payment_id: "987654",
        status: "confirmed",
        amount_cents: 2500,
        currency: "BRL"
      })
    );
    expect(harness.ordersService.transitionToPaid).toHaveBeenCalledWith(
      baseOrder.id,
      "2026-07-04T18:00:00.000Z",
      "987654"
    );
    expect(harness.evolutionService.sendTextMessage).toHaveBeenCalledWith({
      phone: "5511999998888",
      text: "Pagamento confirmado. Seu pedido UTV-20260704-000100 foi aprovado. Agora vou encaminhar para liberacao do acesso."
    });
    expect(harness.webhooksService.markWebhookProcessed).toHaveBeenCalledWith("webhook-id");
    expect(result).toEqual({ status: "paid", orderId: baseOrder.id });
  });

  it("does not send a second message when the order was already transitioned", async () => {
    const harness = createHarness();
    harness.ordersService.transitionToPaid.mockResolvedValueOnce(null);

    const result = await harness.service.process({ webhookEventId: "webhook-id", paymentId: "987654" });

    expect(harness.paymentsService.upsertProviderPayment).toHaveBeenCalledTimes(1);
    expect(harness.evolutionService.sendTextMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "duplicate", orderId: baseOrder.id });
  });

  it("moves an approved amount mismatch to manual review", async () => {
    const harness = createHarness();
    harness.mercadoPagoService.getPayment.mockResolvedValueOnce({ ...basePayment, amountCents: 2400 });

    const result = await harness.service.process({ webhookEventId: "webhook-id", paymentId: "987654" });

    expect(harness.paymentsService.upsertProviderPayment).toHaveBeenCalledWith(
      expect.objectContaining({ status: "confirmed", amount_cents: 2400 })
    );
    expect(harness.ordersService.transitionStatus).toHaveBeenCalledWith(
      baseOrder.id,
      ["pending_payment", "receipt_under_review", "manual_review"],
      "manual_review",
      expect.any(Object)
    );
    expect(harness.evolutionService.sendTextMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "manual_review", orderId: baseOrder.id });
  });

  it("uses metadata order number when external reference is missing", async () => {
    const harness = createHarness();
    harness.mercadoPagoService.getPayment.mockResolvedValueOnce({
      ...basePayment,
      externalReference: null,
      metadata: { order_number: baseOrder.order_number }
    });

    await harness.service.process({ webhookEventId: "webhook-id", paymentId: "987654" });

    expect(harness.ordersService.findOrderByOrderNumber).toHaveBeenCalledWith(baseOrder.order_number);
  });

  it("uses metadata order id when no order number is present", async () => {
    const harness = createHarness();
    harness.mercadoPagoService.getPayment.mockResolvedValueOnce({
      ...basePayment,
      externalReference: null,
      metadata: { order_id: baseOrder.id }
    });
    harness.ordersService.findOrderByOrderNumber.mockResolvedValueOnce(null);
    harness.ordersService.findOrderById.mockResolvedValueOnce(baseOrder);

    await harness.service.process({ webhookEventId: "webhook-id", paymentId: "987654" });

    expect(harness.ordersService.findOrderById).toHaveBeenCalledWith(baseOrder.id);
  });

  it("fails safely when no order can be identified", async () => {
    const harness = createHarness();
    harness.ordersService.findOrderByOrderNumber.mockResolvedValueOnce(null);
    harness.ordersService.findOrderById.mockResolvedValueOnce(null);

    const result = await harness.service.process({ webhookEventId: "webhook-id", paymentId: "987654" });

    expect(harness.paymentsService.upsertProviderPayment).not.toHaveBeenCalled();
    expect(harness.webhooksService.markWebhookFailed).toHaveBeenCalledWith("webhook-id", "Mercado Pago payment has no matching UNITV order.");
    expect(result).toEqual({ status: "failed" });
  });

  it.each([
    ["pending", "pending", null],
    ["in_process", "pending", null],
    ["rejected", "rejected", null],
    ["cancelled", "rejected", null],
    ["refunded", "refunded", "refunded"],
    ["charged_back", "chargeback", "manual_review"]
  ])("maps %s deterministically", async (providerStatus, paymentStatus, orderStatus) => {
    const harness = createHarness();
    harness.mercadoPagoService.getPayment.mockResolvedValueOnce({ ...basePayment, status: providerStatus });

    await harness.service.process({ webhookEventId: "webhook-id", paymentId: "987654" });

    expect(harness.paymentsService.upsertProviderPayment).toHaveBeenCalledWith(
      expect.objectContaining({ status: paymentStatus })
    );
    if (orderStatus) {
      expect(harness.ordersService.transitionStatus).toHaveBeenCalledWith(
        baseOrder.id,
        expect.any(Array),
        orderStatus,
        expect.any(Object)
      );
    } else {
      expect(harness.ordersService.transitionStatus).not.toHaveBeenCalled();
    }
    expect(harness.evolutionService.sendTextMessage).not.toHaveBeenCalled();
  });
});
