import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MercadoPagoService } from "@/services/payments/mercadopago.service";

describe("MercadoPagoService", () => {
  it("creates a Checkout Pro preference tied to one UNITV order", async () => {
    const client = {
      requestJson: vi.fn(async (_path: string, _request?: RequestInit) => ({
        id: "preference-id",
        init_point: "https://www.mercadopago.com.br/checkout/preference-id"
      }))
    };
    const service = new MercadoPagoService(client as never, "https://unitv.example/api/webhooks/mercadopago");

    const result = await service.createOrderPreference({
      order: {
        id: "11111111-1111-4111-8111-111111111111",
        order_number: "UTV-20260704-000100",
        customer_id: "22222222-2222-4222-8222-222222222222",
        plan_id: "33333333-3333-4333-8333-333333333333",
        amount_cents: 2500,
        currency: "BRL"
      },
      plan: { name: "Mensal", slug: "mensal" }
    });

    expect(client.requestJson).toHaveBeenCalledWith(
      "/checkout/preferences",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-idempotency-key": expect.any(String) }),
        body: expect.any(String)
      })
    );
    const request = client.requestJson.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({
      external_reference: "UTV-20260704-000100",
      notification_url: "https://unitv.example/api/webhooks/mercadopago",
      metadata: {
        order_id: "11111111-1111-4111-8111-111111111111",
        order_number: "UTV-20260704-000100",
        customer_id: "22222222-2222-4222-8222-222222222222",
        plan_id: "33333333-3333-4333-8333-333333333333"
      },
      items: [
        expect.objectContaining({
          id: "mensal",
          title: "UNiTV - Mensal",
          quantity: 1,
          currency_id: "BRL",
          unit_price: 25
        })
      ]
    });
    expect(result).toEqual({
      id: "preference-id",
      checkoutUrl: "https://www.mercadopago.com.br/checkout/preference-id"
    });
  });

  it("retrieves and normalizes an authoritative payment", async () => {
    const client = {
      requestJson: vi.fn(async () => ({
        id: 987654,
        status: "approved",
        transaction_amount: 25,
        currency_id: "BRL",
        external_reference: "UTV-20260704-000100",
        date_approved: "2026-07-04T18:00:00.000Z",
        transaction_details: { transaction_id: "transaction-id" },
        metadata: {
          order_id: "11111111-1111-4111-8111-111111111111",
          order_number: "UTV-20260704-000100"
        },
        fee_details: [{ type: "mercadopago_fee", amount: 1.25 }]
      }))
    };
    const service = new MercadoPagoService(client as never, "https://unitv.example/api/webhooks/mercadopago");

    const payment = await service.getPayment("987654");

    expect(client.requestJson).toHaveBeenCalledWith("/v1/payments/987654");
    expect(payment).toMatchObject({
      id: "987654",
      status: "approved",
      amountCents: 2500,
      currency: "BRL",
      externalReference: "UTV-20260704-000100",
      transactionId: "transaction-id",
      approvedAt: "2026-07-04T18:00:00.000Z"
    });
    expect(payment.rawPayload).toHaveProperty("fee_details");
  });

  it("creates one idempotent Pix charge tied to the UNITV order", async () => {
    const client = {
      requestJson: vi.fn(async (_path: string, _request?: RequestInit) => ({
        id: 987654321,
        status: "pending",
        date_of_expiration: "2026-07-05T18:00:00.000Z",
        point_of_interaction: {
          transaction_data: {
            qr_code: "000201-pix-copy-paste",
            qr_code_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
            ticket_url: "https://www.mercadopago.com.br/payments/987654321/ticket"
          }
        }
      }))
    };
    const service = new MercadoPagoService(client as never, "https://unitv.example/api/webhooks/mercadopago");

    const result = await service.createPixPayment({
      order: {
        id: "11111111-1111-4111-8111-111111111111",
        order_number: "UTV-20260704-000100",
        customer_id: "22222222-2222-4222-8222-222222222222",
        plan_id: "33333333-3333-4333-8333-333333333333",
        amount_cents: 2500,
        currency: "BRL"
      },
      plan: { name: "Mensal", slug: "mensal" },
      payer: { email: "cliente@example.com" },
      description: "UNITV - cobranca manual do especialista"
    });

    expect(client.requestJson).toHaveBeenCalledWith(
      "/v1/payments",
      expect.objectContaining({
        method: "POST",
        headers: { "x-idempotency-key": "11111111-1111-4111-8111-111111111111" },
        body: expect.any(String)
      })
    );
    const request = client.requestJson.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({
      transaction_amount: 25,
      description: "UNITV - cobranca manual do especialista",
      payment_method_id: "pix",
      external_reference: "UTV-20260704-000100",
      notification_url: "https://unitv.example/api/webhooks/mercadopago",
      payer: { email: "cliente@example.com" },
      metadata: {
        order_id: "11111111-1111-4111-8111-111111111111",
        order_number: "UTV-20260704-000100"
      }
    });
    expect(result).toMatchObject({
      id: "987654321",
      status: "pending",
      qrCode: "000201-pix-copy-paste",
      qrCodeBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
      ticketUrl: "https://www.mercadopago.com.br/payments/987654321/ticket",
      expiresAt: "2026-07-05T18:00:00.000Z"
    });
  });
});
