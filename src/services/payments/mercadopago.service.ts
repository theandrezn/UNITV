import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createMercadoPagoClient, MercadoPagoClient } from "@/lib/mercadopago/client";
import { getMercadoPagoEnv } from "@/lib/env";

const preferenceResponseSchema = z.object({
  id: z.string().min(1),
  init_point: z.string().url()
});

const paymentResponseSchema = z.object({
  id: z.union([z.string(), z.number()]),
  status: z.string().min(1),
  transaction_amount: z.coerce.number().nonnegative(),
  currency_id: z.string().min(1),
  external_reference: z.string().nullable().optional(),
  date_approved: z.string().nullable().optional(),
  transaction_details: z
    .object({ transaction_id: z.string().nullable().optional() })
    .passthrough()
    .optional(),
  metadata: z.record(z.unknown()).default({})
}).passthrough();

const pixPaymentResponseSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    status: z.string().min(1),
    date_of_expiration: z.string().nullable().optional(),
    point_of_interaction: z.object({
      transaction_data: z.object({
        qr_code: z.string().min(1),
        qr_code_base64: z.string().min(1),
        ticket_url: z.string().url()
      })
    })
  })
  .passthrough();

type MercadoPagoOrderInput = {
  id: string;
  order_number: string;
  customer_id: string;
  plan_id: string;
  amount_cents: number;
  currency: string;
};

type CreateOrderPreferenceInput = {
  order: MercadoPagoOrderInput;
  plan: { name: string; slug: string };
};

type CreatePixPaymentInput = CreateOrderPreferenceInput & {
  payer: { email: string };
  description?: string;
};

export class MercadoPagoService {
  constructor(
    private readonly client: MercadoPagoClient = createMercadoPagoClient(),
    private readonly webhookUrl: string = getMercadoPagoEnv().MERCADO_PAGO_WEBHOOK_URL
  ) {}

  async createOrderPreference(input: CreateOrderPreferenceInput) {
    const response = preferenceResponseSchema.parse(
      await this.client.requestJson("/checkout/preferences", {
        method: "POST",
        headers: { "x-idempotency-key": randomUUID() },
        body: JSON.stringify({
          items: [
            {
              id: input.plan.slug,
              title: `UNiTV - ${input.plan.name}`,
              quantity: 1,
              currency_id: input.order.currency,
              unit_price: input.order.amount_cents / 100
            }
          ],
          external_reference: input.order.order_number,
          notification_url: this.webhookUrl,
          statement_descriptor: "UNITV",
          metadata: {
            order_id: input.order.id,
            order_number: input.order.order_number,
            customer_id: input.order.customer_id,
            plan_id: input.order.plan_id
          },
          payment_methods: {
            installments: 12,
            excluded_payment_types: [{ id: "bank_transfer" }, { id: "ticket" }, { id: "atm" }]
          }
        })
      })
    );

    return { id: response.id, checkoutUrl: response.init_point };
  }

  async createPixPayment(input: CreatePixPaymentInput) {
    const response = pixPaymentResponseSchema.parse(
      await this.client.requestJson("/v1/payments", {
        method: "POST",
        headers: { "x-idempotency-key": input.order.id },
        body: JSON.stringify({
          transaction_amount: input.order.amount_cents / 100,
          description: input.description || `UNiTV - ${input.plan.name}`,
          payment_method_id: "pix",
          external_reference: input.order.order_number,
          notification_url: this.webhookUrl,
          payer: { email: input.payer.email },
          metadata: {
            order_id: input.order.id,
            order_number: input.order.order_number,
            customer_id: input.order.customer_id,
            plan_id: input.order.plan_id,
            plan_slug: input.plan.slug
          }
        })
      })
    );
    const transactionData = response.point_of_interaction.transaction_data;

    return {
      id: String(response.id),
      status: response.status,
      qrCode: transactionData.qr_code,
      qrCodeBase64: transactionData.qr_code_base64,
      ticketUrl: transactionData.ticket_url,
      expiresAt: response.date_of_expiration || null,
      rawPayload: response
    };
  }

  async getPayment(paymentId: string) {
    const response = paymentResponseSchema.parse(await this.client.requestJson(`/v1/payments/${paymentId}`));

    return {
      id: String(response.id),
      status: response.status,
      amountCents: Math.round(response.transaction_amount * 100),
      currency: response.currency_id,
      externalReference: response.external_reference || null,
      metadata: response.metadata,
      transactionId: response.transaction_details?.transaction_id || null,
      approvedAt: response.date_approved || null,
      rawPayload: response
    };
  }
}
