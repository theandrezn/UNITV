import "server-only";
import { AuditService } from "@/services/audit.service";
import { EvolutionService } from "@/services/evolution/evolution.service";
import { OrdersService } from "@/services/orders.service";
import { PaymentsService } from "@/services/payments.service";
import { WebhooksService } from "@/services/webhooks.service";
import { MercadoPagoService } from "./mercadopago.service";

type ProcessPaymentInput = {
  webhookEventId: string;
  paymentId: string;
};

type PaymentData = Awaited<ReturnType<MercadoPagoService["getPayment"]>>;

export class PaymentConfirmationService {
  constructor(
    private readonly mercadoPagoService = new MercadoPagoService(),
    private readonly ordersService = new OrdersService(),
    private readonly paymentsService = new PaymentsService(),
    private readonly webhooksService = new WebhooksService(),
    private readonly auditService = new AuditService(),
    private readonly evolutionService = new EvolutionService()
  ) {}

  async process(input: ProcessPaymentInput) {
    try {
      await this.webhooksService.markWebhookProcessing(input.webhookEventId);
      const payment = await this.mercadoPagoService.getPayment(input.paymentId);
      const order = await this.findOrder(payment);

      if (!order) {
        const message = "Mercado Pago payment has no matching UNITV order.";
        await this.webhooksService.markWebhookFailed(input.webhookEventId, message);
        return { status: "failed" as const };
      }

      const paymentStatus = mapPaymentStatus(payment.status);
      await this.paymentsService.upsertProviderPayment({
        order_id: String(order.id),
        provider: "mercado_pago",
        provider_payment_id: payment.id,
        transaction_id: payment.transactionId,
        status: paymentStatus,
        amount_cents: payment.amountCents,
        currency: payment.currency,
        paid_at: payment.approvedAt,
        raw_payload: payment.rawPayload
      });

      const result = await this.applyOrderState(order, payment);
      await this.webhooksService.markWebhookProcessed(input.webhookEventId);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Mercado Pago payment processing error.";
      await this.webhooksService.markWebhookFailed(input.webhookEventId, message);
      return { status: "failed" as const };
    }
  }

  private async findOrder(payment: PaymentData) {
    const metadataOrderNumber = readMetadataString(payment.metadata, "order_number");
    const orderNumber = payment.externalReference || metadataOrderNumber;

    if (orderNumber) {
      const order = await this.ordersService.findOrderByOrderNumber(orderNumber);
      if (order) {
        return order;
      }
    }

    const orderId = readMetadataString(payment.metadata, "order_id");
    return orderId ? this.ordersService.findOrderById(orderId) : null;
  }

  private async applyOrderState(order: Record<string, unknown>, payment: PaymentData) {
    const orderId = String(order.id);

    if (payment.status === "approved") {
      const valuesMatch = Number(order.amount_cents) === payment.amountCents && String(order.currency) === payment.currency;
      if (!valuesMatch) {
        await this.ordersService.transitionStatus(
          orderId,
          ["pending_payment", "receipt_under_review", "manual_review"],
          "manual_review",
          { payment_provider: "mercado_pago", payment_reference: payment.id }
        );
        await this.audit(orderId, "mercado_pago_amount_mismatch", order, payment);
        return { status: "manual_review" as const, orderId };
      }

      const transitioned = await this.ordersService.transitionToPaid(
        orderId,
        payment.approvedAt || new Date().toISOString(),
        payment.id
      );
      if (!transitioned) {
        return { status: "duplicate" as const, orderId };
      }

      await this.audit(orderId, "mercado_pago_payment_confirmed", order, payment);
      await this.sendConfirmation(transitioned as Record<string, unknown>);
      return { status: "paid" as const, orderId };
    }

    if (payment.status === "refunded") {
      await this.ordersService.transitionStatus(orderId, ["paid", "manual_review"], "refunded", {
        payment_provider: "mercado_pago",
        payment_reference: payment.id
      });
    } else if (payment.status === "charged_back") {
      await this.ordersService.transitionStatus(orderId, ["paid", "manual_review"], "manual_review", {
        payment_provider: "mercado_pago",
        payment_reference: payment.id
      });
    }

    await this.audit(orderId, "mercado_pago_payment_status_recorded", order, payment);
    return { status: mapPaymentStatus(payment.status), orderId };
  }

  private async sendConfirmation(order: Record<string, unknown>) {
    const customers = order.customers;
    const phone =
      customers && typeof customers === "object" && !Array.isArray(customers)
        ? (customers as { phone?: unknown }).phone
        : null;
    if (typeof phone !== "string" || !phone) {
      return;
    }

    try {
      await this.evolutionService.sendTextMessage({
        phone,
        text: `Pagamento confirmado. Seu pedido ${String(order.order_number)} foi aprovado. Agora vou encaminhar para liberacao do acesso.`
      });
    } catch (error) {
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: "mercado_pago_confirmation_message_failed",
        entity_type: "orders",
        entity_id: String(order.id),
        metadata: { error: error instanceof Error ? error.message : "unknown" }
      });
    }
  }

  private audit(orderId: string, action: string, order: Record<string, unknown>, payment: PaymentData) {
    return this.auditService.createAuditLog({
      actor_type: "webhook",
      action,
      entity_type: "orders",
      entity_id: orderId,
      metadata: {
        payment_id: payment.id,
        provider_status: payment.status,
        expected_amount_cents: order.amount_cents,
        received_amount_cents: payment.amountCents,
        expected_currency: order.currency,
        received_currency: payment.currency
      }
    });
  }
}

function mapPaymentStatus(status: string) {
  if (status === "approved") return "confirmed" as const;
  if (status === "pending" || status === "in_process") return "pending" as const;
  if (status === "rejected" || status === "cancelled") return "rejected" as const;
  if (status === "refunded") return "refunded" as const;
  if (status === "charged_back") return "chargeback" as const;
  return "failed" as const;
}

function readMetadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" && value ? value : null;
}
