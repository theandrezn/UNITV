import "server-only";
import { AuditService } from "@/services/audit.service";
import { ActivationCodesService } from "@/services/activation-codes.service";
import { EvolutionService } from "@/services/evolution/evolution.service";
import { OrdersService } from "@/services/orders.service";
import { PaymentsService } from "@/services/payments.service";
import { WebhooksService } from "@/services/webhooks.service";
import { buildNoAccessCodeAvailableMessage, buildPostPurchaseMessages } from "@/lib/unitv/post-purchase-messages";
import { MercadoPagoService } from "./mercadopago.service";

const ADMIN_WHATSAPP_PHONE = "558699802602";

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
    private readonly evolutionService = new EvolutionService(),
    private readonly activationCodesService = new ActivationCodesService()
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
      const code = await this.releaseActivationCode(order);
      if (code) {
        for (const text of buildPostPurchaseMessages(code)) {
          await this.evolutionService.sendTextMessage({ phone, text });
        }
        return;
      }

      const orderNumber = String(order.order_number || "seu pedido");
      await this.evolutionService.sendTextMessage({
        phone,
        text: buildNoAccessCodeAvailableMessage(orderNumber)
      });
      await this.evolutionService.sendTextMessage({
        phone: ADMIN_WHATSAPP_PHONE,
        text:
          "⚠️ Pagamento confirmado sem código disponível.\n\n" +
          `Pedido: ${orderNumber}\n` +
          `Cliente: ${String(order.customer_id || "sem cliente")}\n\n` +
          "Cadastre/libere um código válido no banco para o cliente receber o acesso."
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

  private async releaseActivationCode(order: Record<string, unknown>) {
    const productId = typeof order.product_id === "string" ? order.product_id : null;
    if (!productId) {
      return null;
    }

    const planId = typeof order.plan_id === "string" ? order.plan_id : null;
    const availableCode = await this.activationCodesService.findAvailableCode(productId, planId);
    if (!availableCode) {
      await this.ordersService.transitionStatus(String(order.id), ["paid", "code_reserved"], "waiting_stock");
      return null;
    }

    const reservedCode = await this.activationCodesService.reserveCode(
      String(availableCode.id),
      String(order.id),
      String(order.customer_id)
    );
    if (!reservedCode) {
      return null;
    }

    await this.ordersService.updateOrder(String(order.id), { code_id: String(reservedCode.id), status: "code_reserved" });
    await this.activationCodesService.markCodeAsSent(String(reservedCode.id));
    await this.ordersService.updateOrder(String(order.id), { code_id: String(reservedCode.id), status: "code_sent" });
    await this.auditService.createAuditLog({
      actor_type: "webhook",
      action: "activation_code_sent_after_mercado_pago_webhook",
      entity_type: "orders",
      entity_id: String(order.id),
      metadata: { code_id: reservedCode.id }
    });

    return String(reservedCode.code);
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
