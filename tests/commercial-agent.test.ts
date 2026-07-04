import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ChatAgentService } from "@/services/agent/chat-agent.service";
import { PlansService } from "@/services/plans.service";
import { WhatsappMessageService } from "@/services/whatsapp/whatsapp-message.service";
import { MAIN_MENU } from "@/lib/whatsapp/menus";

const plan = {
  id: "11111111-1111-4111-8111-111111111111",
  product_id: "22222222-2222-4222-8222-222222222222",
  name: "Plano Mensal",
  slug: "mensal",
  duration_days: 30,
  price_cents: 2500,
  currency: "BRL"
};

function createChatAgent(overrides: Record<string, unknown> = {}) {
  const plansService = {
    listActivePlans: vi.fn(async () => [plan]),
    findPlanMentionedInText: vi.fn(async (text: string) => ({
      plan: text.toLowerCase().includes("mensal") ? plan : null,
      plans: [plan]
    }))
  };
  const knowledgeService = {
    searchKnowledge: vi.fn(async (): Promise<Array<{ category: string; content: string }>> => [])
  };
  const ordersService = {
    createOrder: vi.fn(async (data) => ({ ...data, id: "33333333-3333-4333-8333-333333333333", order_number: "UTV-20260704-000001" })),
    findLatestOpenOrderByCustomerId: vi.fn(async () => null as Record<string, unknown> | null),
    findLatestOrderByCustomerId: vi.fn(async () => null as Record<string, unknown> | null),
    updateOrder: vi.fn(async (_id, data) => data),
    transitionStatus: vi.fn(async (_id, _from, status, data = {}) => ({ id: _id, status, ...data })),
    transitionToPaid: vi.fn(async (_id, paidAt, paymentReference) => ({ id: _id, status: "paid", paid_at: paidAt, payment_reference: paymentReference }))
  };
  const appSettingsService = {
    getPaymentInstructions: vi.fn(async () => "Instrucoes de pagamento cadastradas."),
    getPixInstructions: vi.fn(async () => "PIX configurado. Envie o comprovante por aqui.")
  };
  const agentActionsService = {
    createAgentAction: vi.fn(async (data) => data)
  };
  const auditService = {
    createAuditLog: vi.fn(async (data) => data)
  };
  const mercadoPagoService = {
    createOrderPreference: vi.fn(async () => ({
      id: "preference-id",
      checkoutUrl: "https://www.mercadopago.com.br/checkout/dynamic-order-link"
    })),
    createPixPayment: vi.fn(async () => ({
      id: "pix-payment-id",
      status: "pending",
      qrCode: "000201-pix-copy-paste",
      qrCodeBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
      ticketUrl: "https://www.mercadopago.com.br/payments/pix-payment-id/ticket",
      expiresAt: "2026-07-05T18:00:00.000Z",
      rawPayload: { id: "pix-payment-id", status: "pending" }
    })),
    getPayment: vi.fn(async () => ({
      id: "pix-payment-id",
      status: "pending",
      amountCents: 2500,
      currency: "BRL",
      approvedAt: null as string | null
    }))
  };
  const activationCodesService = {
    findAvailableCode: vi.fn(async () => null as Record<string, unknown> | null),
    reserveCode: vi.fn(async () => null as Record<string, unknown> | null),
    markCodeAsSent: vi.fn(async () => null as Record<string, unknown> | null)
  };

  return {
    service: new ChatAgentService(
      plansService as never,
      knowledgeService as never,
      ordersService as never,
      appSettingsService as never,
      agentActionsService as never,
      auditService as never,
      mercadoPagoService as never,
      activationCodesService as never
    ),
    plansService,
    knowledgeService,
    ordersService,
    appSettingsService,
    agentActionsService,
    auditService,
    mercadoPagoService,
    activationCodesService,
    ...overrides
  };
}

describe("commercial WhatsApp agent", () => {
  it("answers prices from Supabase plans", async () => {
    const { service, plansService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "quanto custa?",
      classification: { intent: "ask_price", confidence: 0.9, summary: "preco", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(plansService.listActivePlans).toHaveBeenCalled();
    expect(result.reply).toContain("Plano Mensal");
    expect(result.reply).toMatch(/R\$\s*25,00/);
    expect(result.menu).toEqual(expect.objectContaining({ id: "plans", title: "Escolha seu plano UNiTV" }));
  });

  it("opens the main selectable menu for a greeting", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "oi",
      classification: { intent: "greeting", confidence: 0.99, summary: "saudacao", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.menu).toEqual(expect.objectContaining({ id: "main" }));
    expect(result.reply).toContain("Ver planos");
    expect(result.reply).toContain("Falar com especialista");
  });

  it("offers selectable payment methods", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "como posso pagar?",
      classification: { intent: "ask_payment", confidence: 0.99, summary: "pagamento", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.menu).toEqual(expect.objectContaining({ id: "payment" }));
    expect(result.reply).toContain("Pagar com Pix");
  });

  it("creates an order when the requested plan is clear", async () => {
    const { service, ordersService, appSettingsService, mercadoPagoService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "quero comprar o plano mensal",
      classification: { intent: "buy_plan", confidence: 0.95, summary: "compra", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444" },
      conversation: { id: "55555555-5555-4555-8555-555555555555" },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        plan_id: plan.id,
        amount_cents: plan.price_cents,
        status: "pending_payment"
      })
    );
    expect(result.reply).toContain("UTV-20260704-000001");
    expect(mercadoPagoService.createOrderPreference).not.toHaveBeenCalled();
    expect(ordersService.updateOrder).not.toHaveBeenCalled();
    expect(appSettingsService.getPixInstructions).not.toHaveBeenCalled();
    expect(result.reply).not.toContain("https://www.mercadopago.com.br/checkout/dynamic-order-link");
    expect(result.reply).not.toContain("Cartao:");
    expect(result.reply).not.toContain("Para gerar o Pix Copia e Cola");
    expect(result.reply).toContain("Pagar com Pix");
    expect(result.reply).toContain("Pagar com cartão");
    expect(result.menu).toEqual(expect.objectContaining({ id: "payment" }));
    expect(result.reply.toLowerCase()).not.toContain("codigo de ativacao");
  });

  it("does not create a card preference while only creating the order", async () => {
    const { service, ordersService, mercadoPagoService, agentActionsService } = createChatAgent();
    mercadoPagoService.createOrderPreference.mockRejectedValueOnce(new Error("Mercado Pago unavailable"));

    const result = await service.generateCommercialReply({
      message: "quero comprar o plano mensal",
      classification: { intent: "buy_plan", confidence: 0.95, summary: "compra", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444" },
      conversation: { id: "55555555-5555-4555-8555-555555555555" },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).toHaveBeenCalled();
    expect(ordersService.updateOrder).not.toHaveBeenCalled();
    expect(mercadoPagoService.createOrderPreference).not.toHaveBeenCalled();
    expect(result.requiresHuman).not.toBe(true);
    expect(agentActionsService.createAgentAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ action_name: "handoff_to_human" })
    );
  });

  it("does not create an order when the matched plan has no configured price", async () => {
    const { service, ordersService, plansService } = createChatAgent();
    plansService.findPlanMentionedInText.mockResolvedValueOnce({
      plan: { ...plan, price_cents: 0 },
      plans: [{ ...plan, price_cents: 0 }]
    });

    const result = await service.generateCommercialReply({
      message: "quero comprar o plano mensal",
      classification: { intent: "buy_plan", confidence: 0.95, summary: "compra", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444" },
      conversation: { id: "55555555-5555-4555-8555-555555555555" },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).not.toHaveBeenCalled();
    expect(result.requiresHuman).toBe(true);
    expect(result.reply).toContain("valor ainda precisa ser confirmado");
  });

  it("creates the six-month order with the official amount", async () => {
    const { service, ordersService, plansService } = createChatAgent();
    plansService.findPlanMentionedInText.mockResolvedValueOnce({
      plan: { ...plan, id: "semestral-id", name: "6 meses", slug: "semestral", duration_days: 180, price_cents: 12000 },
      plans: []
    });

    await service.generateCommercialReply({
      message: "quero o de 6 meses",
      classification: { intent: "buy_plan", confidence: 0.99, summary: "semestral", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444" },
      conversation: { id: "55555555-5555-4555-8555-555555555555" },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ plan_id: "semestral-id", amount_cents: 12000, status: "pending_payment" })
    );
  });

  it("sends installation instructions for a free trial without creating a paid order", async () => {
    const { service, ordersService, agentActionsService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "tem teste gratis?",
      classification: { intent: "free_trial", confidence: 0.99, summary: "teste", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444" },
      conversation: { id: "55555555-5555-4555-8555-555555555555" },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).not.toHaveBeenCalled();
    expect(result.requiresHuman).not.toBe(true);
    expect(result.reply).toContain("3 dias");
    expect(result.reply).toContain("instale o UNiTV");
    expect(result.menu).toEqual(expect.objectContaining({ id: "install" }));
    expect(result.sendTextBeforeMenu).toBe(true);
    expect(agentActionsService.createAgentAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ action_name: "handoff_to_human" })
    );
  });

  it("returns an existing card link only when card is selected", async () => {
    const { service, ordersService, appSettingsService, mercadoPagoService } = createChatAgent();
    ordersService.findLatestOpenOrderByCustomerId.mockResolvedValueOnce({
      id: "33333333-3333-4333-8333-333333333333",
      metadata: { mercado_pago_checkout_url: "https://www.mercadopago.com.br/checkout/dynamic-order-link" }
    });
    const result = await service.generateCommercialReply({
      message: "quero pagar no cartao",
      classification: { intent: "card_payment", confidence: 0.99, summary: "cartao", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444" },
      conversation: { id: "55555555-5555-4555-8555-555555555555" },
      webhookEventId: "webhook-id"
    });

    expect(appSettingsService.getPixInstructions).not.toHaveBeenCalled();
    expect(mercadoPagoService.createOrderPreference).not.toHaveBeenCalled();
    expect(result.reply).toBe("PAGUE COM CARTAO AQUI ABAIXO\nhttps://www.mercadopago.com.br/checkout/dynamic-order-link");
    expect(result.reply).not.toContain("Pedido criado");
    expect(result.reply).not.toContain("Pagar com Pix");
    expect(appSettingsService.getPaymentInstructions).not.toHaveBeenCalled();
  });

  it("creates the card link only when card is selected", async () => {
    const { service, ordersService, mercadoPagoService } = createChatAgent();
    const order = {
      id: "33333333-3333-4333-8333-333333333333",
      order_number: "UTV-20260704-000001",
      customer_id: "44444444-4444-4444-8444-444444444444",
      plan_id: plan.id,
      amount_cents: 2500,
      currency: "BRL",
      metadata: {},
      plans: { name: plan.name, slug: plan.slug }
    };
    ordersService.findLatestOpenOrderByCustomerId.mockResolvedValueOnce(order);

    const result = await service.generateCommercialReply({
      message: "quero pagar no cartao",
      classification: { intent: "card_payment", confidence: 0.99, summary: "cartao", suggested_reply: "" },
      customer: { id: order.customer_id },
      conversation: { id: "55555555-5555-4555-8555-555555555555" },
      webhookEventId: "webhook-id"
    });

    expect(mercadoPagoService.createOrderPreference).toHaveBeenCalledWith({
      order: expect.objectContaining({
        id: order.id,
        order_number: order.order_number,
        customer_id: order.customer_id,
        plan_id: plan.id,
        amount_cents: 2500,
        currency: "BRL"
      }),
      plan: { name: plan.name, slug: plan.slug }
    });
    expect(ordersService.updateOrder).toHaveBeenCalledWith(
      order.id,
      expect.objectContaining({
        payment_provider: "mercado_pago",
        payment_reference: "preference-id",
        metadata: expect.objectContaining({
          mercado_pago_checkout_url: "https://www.mercadopago.com.br/checkout/dynamic-order-link"
        })
      })
    );
    expect(result.reply).toBe("PAGUE COM CARTAO AQUI ABAIXO\nhttps://www.mercadopago.com.br/checkout/dynamic-order-link");
  });

  it("checks payment status when the customer says payment is done before following card intent", async () => {
    const { service, ordersService, mercadoPagoService } = createChatAgent();
    ordersService.findLatestOrderByCustomerId.mockResolvedValueOnce({
      id: "33333333-3333-4333-8333-333333333333",
      order_number: "UTV-20260704-000008",
      customer_id: "customer-id",
      status: "pending_payment",
      metadata: { mercado_pago_checkout_url: "https://www.mercadopago.com.br/checkout/dynamic-order-link" }
    });

    const result = await service.generateCommercialReply({
      message: "feito o pagamento",
      classification: { intent: "card_payment", confidence: 0.99, summary: "pagamento", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("FEITO");
    expect(result.reply.toLowerCase()).toContain("ainda nao consta pagamento aprovado");
    expect(result.reply).toContain("UTV-20260704-000008");
    expect(result.reply).toContain("webhook");
    expect(result.reply).not.toContain("PAGUE COM CARTAO");
    expect(mercadoPagoService.createOrderPreference).not.toHaveBeenCalled();
    expect(result.reply.toLowerCase()).not.toContain("codigo");
  });

  it("recognizes an already paid order when the customer confirms payment", async () => {
    const { service, ordersService } = createChatAgent();
    ordersService.findLatestOrderByCustomerId.mockResolvedValueOnce({
      id: "33333333-3333-4333-8333-333333333333",
      order_number: "UTV-20260704-000009",
      customer_id: "customer-id",
      status: "paid"
    });

    const result = await service.generateCommercialReply({
      message: "ja fiz o pix",
      classification: { intent: "pix_payment", confidence: 0.99, summary: "pix", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("Pagamento confirmado");
    expect(result.reply).toContain("UTV-20260704-000009");
    expect(result.reply).not.toContain("PIX do pedido");
  });

  it("checks Mercado Pago and sends an available recharge code after approval", async () => {
    const { service, ordersService, mercadoPagoService, activationCodesService } = createChatAgent();
    const pendingOrder = {
      id: "33333333-3333-4333-8333-333333333333",
      order_number: "UTV-20260704-000010",
      customer_id: "customer-id",
      product_id: plan.product_id,
      plan_id: plan.id,
      amount_cents: 2500,
      currency: "BRL",
      status: "pending_payment",
      metadata: { mercado_pago_pix_payment_id: "123456789" }
    };
    const paidOrder = { ...pendingOrder, status: "paid", paid_at: "2026-07-04T22:30:00.000Z", payment_reference: "123456789" };
    ordersService.findLatestOrderByCustomerId.mockResolvedValueOnce(pendingOrder);
    ordersService.transitionToPaid.mockResolvedValueOnce(paidOrder);
    mercadoPagoService.getPayment.mockResolvedValueOnce({
      id: "123456789",
      status: "approved",
      amountCents: 2500,
      currency: "BRL",
      approvedAt: "2026-07-04T22:30:00.000Z"
    });
    activationCodesService.findAvailableCode.mockResolvedValueOnce({
      id: "code-id",
      code: "UNITV-RECARGA-001"
    });
    activationCodesService.reserveCode.mockResolvedValueOnce({
      id: "code-id",
      code: "UNITV-RECARGA-001"
    });
    activationCodesService.markCodeAsSent.mockResolvedValueOnce({ id: "code-id", status: "sent" });

    const result = await service.generateCommercialReply({
      message: "ja paguei",
      classification: { intent: "unknown", confidence: 0.99, summary: "pagou", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(mercadoPagoService.getPayment).toHaveBeenCalledWith("123456789");
    expect(ordersService.transitionToPaid).toHaveBeenCalledWith(
      pendingOrder.id,
      "2026-07-04T22:30:00.000Z",
      "123456789"
    );
    expect(activationCodesService.reserveCode).toHaveBeenCalledWith("code-id", pendingOrder.id, "customer-id");
    expect(activationCodesService.markCodeAsSent).toHaveBeenCalledWith("code-id");
    expect(result.reply).toContain("Pagamento confirmado");
    expect(result.reply).toContain("UNITV-RECARGA-001");
  });

  it("creates a dynamic Pix charge without asking the customer for email", async () => {
    const { service, ordersService, mercadoPagoService } = createChatAgent();
    ordersService.findLatestOpenOrderByCustomerId.mockResolvedValueOnce({
      id: "33333333-3333-4333-8333-333333333333",
      order_number: "UTV-20260704-000001",
      customer_id: "44444444-4444-4444-8444-444444444444",
      plan_id: plan.id,
      amount_cents: 2500,
      currency: "BRL",
      metadata: {},
      plans: { name: plan.name, slug: plan.slug }
    });

    const result = await service.generateCommercialReply({
      message: "me manda a chave pix",
      classification: { intent: "pix_payment", confidence: 0.99, summary: "pix", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444", email: null },
      conversation: { id: "55555555-5555-4555-8555-555555555555" },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("proxima mensagem");
    expect(result.reply).not.toContain("000201-pix-copy-paste");
    expect(result.copyText).toBe("000201-pix-copy-paste");
    expect(result.reply).not.toContain("mercadopago.com.br/payments");
    expect(result.reply).not.toContain("e-mail");
    expect(mercadoPagoService.createPixPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        payer: { email: "pix-utv-20260704-000001@unitv.com.br" }
      })
    );
  });

  it("creates a dynamic Pix charge and returns copy-paste plus QR media", async () => {
    const { service, ordersService, mercadoPagoService } = createChatAgent();
    const order = {
      id: "33333333-3333-4333-8333-333333333333",
      order_number: "UTV-20260704-000001",
      customer_id: "44444444-4444-4444-8444-444444444444",
      plan_id: plan.id,
      amount_cents: 2500,
      currency: "BRL",
      metadata: { source: "whatsapp_agent" },
      plans: { name: plan.name, slug: plan.slug }
    };
    ordersService.findLatestOpenOrderByCustomerId.mockResolvedValueOnce(order);

    const result = await service.generateCommercialReply({
      message: "quero pagar no pix",
      classification: { intent: "pix_payment", confidence: 0.99, summary: "pix", suggested_reply: "" },
      customer: { id: order.customer_id, email: null },
      conversation: { id: "55555555-5555-4555-8555-555555555555" },
      webhookEventId: "webhook-id"
    });

    expect(mercadoPagoService.createPixPayment).toHaveBeenCalledWith({
      order: expect.objectContaining({ id: order.id, order_number: order.order_number, amount_cents: 2500 }),
      plan: { name: plan.name, slug: plan.slug },
      payer: { email: "pix-utv-20260704-000001@unitv.com.br" }
    });
    expect(ordersService.updateOrder).toHaveBeenCalledWith(
      order.id,
      expect.objectContaining({
        payment_provider: "mercado_pago",
        payment_reference: "pix-payment-id",
        metadata: expect.objectContaining({
          mercado_pago_pix_payment_id: "pix-payment-id",
          mercado_pago_pix_qr_code: "000201-pix-copy-paste"
        })
      })
    );
    expect(result.reply).toContain("proxima mensagem");
    expect(result.reply).not.toContain("000201-pix-copy-paste");
    expect(result.copyText).toBe("000201-pix-copy-paste");
    expect(result.reply).not.toContain("mercadopago.com.br/payments");
    expect(result.reply).toContain("confirmacao e automatica");
    expect(result.media).toEqual(
      expect.objectContaining({
        base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
        mimetype: "image/png"
      })
    );
  });

  it("reuses an existing Pix charge instead of creating a duplicate", async () => {
    const { service, ordersService, mercadoPagoService } = createChatAgent();
    ordersService.findLatestOpenOrderByCustomerId.mockResolvedValueOnce({
      id: "33333333-3333-4333-8333-333333333333",
      order_number: "UTV-20260704-000001",
      customer_id: "44444444-4444-4444-8444-444444444444",
      plan_id: plan.id,
      amount_cents: 2500,
      currency: "BRL",
      metadata: {
        mercado_pago_pix_payment_id: "existing-pix-id",
        mercado_pago_pix_qr_code: "existing-pix-copy-paste",
        mercado_pago_pix_ticket_url: "https://www.mercadopago.com.br/payments/existing-pix-id/ticket"
      },
      plans: { name: plan.name, slug: plan.slug }
    });

    const result = await service.generateCommercialReply({
      message: "manda o pix de novo",
      classification: { intent: "pix_payment", confidence: 0.99, summary: "pix", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444", email: "cliente@example.com" },
      conversation: { id: "55555555-5555-4555-8555-555555555555" },
      webhookEventId: "webhook-id"
    });

    expect(mercadoPagoService.createPixPayment).not.toHaveBeenCalled();
    expect(result.reply).not.toContain("existing-pix-copy-paste");
    expect(result.copyText).toBe("existing-pix-copy-paste");
    expect(result.reply).not.toContain("mercadopago.com.br/payments");
  });

  it("asks for clarification when purchase intent has no clear plan", async () => {
    const { service, ordersService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "quero comprar",
      classification: { intent: "buy_plan", confidence: 0.9, summary: "compra", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).not.toHaveBeenCalled();
    expect(result.reply).toContain("Escolha seu plano UNiTV");
    expect(result.menu).toEqual(expect.objectContaining({ id: "plans" }));
  });

  it("offers the installation menu for installation requests", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "quero aprender a instalar",
      classification: { intent: "technical_support", confidence: 0.99, summary: "instalacao", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.menu).toEqual(expect.objectContaining({ id: "install" }));
    expect(result.reply).toContain("Instalação UNiTV");
    expect(result.reply).toContain("Instalar na TV pelo Downloader");
  });

  it("sends downloader instructions with the current test code and tutorial link", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "instalar na tv pelo downloader",
      classification: { intent: "technical_support", confidence: 1, summary: "downloader", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("Downloader by AFTVnews");
    expect(result.reply).toContain("8322904");
    expect(result.reply).toContain("https://www.youtube.com/watch?v=XlCPDdqnOuI");
  });

  it("answers objections from trained knowledge and keeps a next step", async () => {
    const { service, knowledgeService } = createChatAgent();
    knowledgeService.searchKnowledge.mockResolvedValueOnce([
      { category: "objecao_estabilidade", content: "A experiencia depende da internet e do aparelho. Voce pode testar por 3 dias." }
    ]);

    const result = await service.generateCommercialReply({
      message: "e se travar?",
      classification: { intent: "unknown", confidence: 0.2, summary: "objecao", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("depende da internet");
    expect(result.menu).toEqual(expect.objectContaining({ id: "continue" }));
    expect(result.sendTextBeforeMenu).toBe(true);
  });

  it("marks handoff when the customer asks for a human", async () => {
    const { service, agentActionsService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "quero falar com atendente",
      classification: { intent: "human_help", confidence: 0.98, summary: "humano", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "66666666-6666-4666-8666-666666666666" },
      webhookEventId: "webhook-id"
    });

    expect(result.requiresHuman).toBe(true);
    expect(agentActionsService.createAgentAction).toHaveBeenCalledWith(
      expect.objectContaining({ action_name: "handoff_to_human", requires_human_approval: true })
    );
  });

  it("does not hardcode prices in the OpenAI classifier prompt", () => {
    const source = readFileSync("src/services/agent/intent-classifier.service.ts", "utf8");

    expect(source).not.toMatch(/R\$\s*\d/);
    expect(source).not.toContain("39,90");
  });

  it("matches the most specific plan mention", async () => {
    const service = new PlansService({
      listActivePlans: vi.fn(async () => [
        { ...plan, id: "generic", name: "Teste", slug: "teste", price_cents: 0 },
        { ...plan, id: "specific", name: "Plano Teste Fase 3", slug: "fase3-teste", price_cents: 100 }
      ])
    } as never);

    const result = await service.findPlanMentionedInText("quero comprar o plano teste fase 3");

    expect(result.plan?.id).toBe("specific");
  });

  it("handles receipt messages without releasing activation codes", async () => {
    const messages: Array<Record<string, unknown>> = [];
    const ordersService = {
      findLatestOpenOrderByCustomerId: vi.fn(async () => ({
        id: "77777777-7777-4777-8777-777777777777",
        order_number: "UTV-20260704-000002",
        metadata: {}
      })),
      updateOrder: vi.fn(async (_id, data) => ({
        id: "77777777-7777-4777-8777-777777777777",
        order_number: "UTV-20260704-000002",
        ...data
      }))
    };
    const receiptsService = { createReceipt: vi.fn(async (data) => data) };
    const evolutionService = { sendTextMessage: vi.fn(async () => ({ sent: true })) };

    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id" })) } as never,
      {
        findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", metadata: {} })),
        createConversation: vi.fn(),
        touchConversation: vi.fn(async () => ({})),
        updateConversationMetadata: vi.fn()
      } as never,
      {
        findByExternalMessageId: vi.fn(async () => null),
        createMessage: vi.fn(async (data) => {
          messages.push(data);
          return { id: `message-${messages.length}`, ...data };
        })
      } as never,
      { classify: vi.fn() } as never,
      {} as never,
      evolutionService as never,
      { createAuditLog: vi.fn(async (data) => data) } as never,
      ordersService as never,
      receiptsService as never,
      { createAgentAction: vi.fn(async (data) => data) } as never
    );

    const result = await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "receipt-message-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "",
        messageType: "imageMessage",
        hasMedia: true,
        media: { mimeType: "image/jpeg", url: "https://example.com/receipt.jpg" },
        timestamp: 1,
        fromMe: false,
        isGroup: false
      }
    });

    expect(result.status).toBe("processed");
    expect(ordersService.updateOrder).toHaveBeenCalledWith(
      "77777777-7777-4777-8777-777777777777",
      expect.objectContaining({ status: "receipt_under_review" })
    );
    expect(receiptsService.createReceipt).toHaveBeenCalled();
    const assistantMessage = messages.find((message) => message.role === "assistant");
    expect(String(assistantMessage?.content)).toContain("Recebi o comprovante");
    expect(String(assistantMessage?.content).toLowerCase()).not.toContain("codigo");
  });

  it("does not treat plain paid text as a manual receipt", async () => {
    const ordersService = {
      findLatestOpenOrderByCustomerId: vi.fn(),
      updateOrder: vi.fn()
    };
    const receiptsService = { createReceipt: vi.fn() };
    const intentClassifier = { classify: vi.fn(async () => ({ intent: "unknown", confidence: 1, summary: "pagou", suggested_reply: "" })) };
    const chatAgent = {
      generateCommercialReply: vi.fn(async () => ({ reply: "FEITO. Ainda nao consta pagamento aprovado." }))
    };
    const evolutionService = { sendTextMessage: vi.fn(async () => ({ sent: true })) };

    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id" })) } as never,
      {
        findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", metadata: {} })),
        createConversation: vi.fn(),
        touchConversation: vi.fn(async () => ({})),
        updateConversationMetadata: vi.fn()
      } as never,
      {
        findByExternalMessageId: vi.fn(async () => null),
        createMessage: vi.fn(async (data) => ({ id: "message-id", ...data }))
      } as never,
      intentClassifier as never,
      chatAgent as never,
      evolutionService as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      ordersService as never,
      receiptsService as never,
      { createAgentAction: vi.fn(async (data) => data) } as never
    );

    await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "paid-text-message-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "Já paguei",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1,
        fromMe: false,
        isGroup: false
      }
    });

    expect(receiptsService.createReceipt).not.toHaveBeenCalled();
    expect(ordersService.updateOrder).not.toHaveBeenCalled();
    expect(chatAgent.generateCommercialReply).toHaveBeenCalled();
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith({
      phone: "5511999998888",
      text: "FEITO. Ainda nao consta pagamento aprovado."
    });
  });

  it("ignores stale pending Pix email metadata and classifies the message normally", async () => {
    const customersRepository = {
      upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id", email: null })),
      updateCustomer: vi.fn()
    };
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({
        id: "conversation-id",
        metadata: { awaiting_pix_email: true, awaiting_pix_order_id: "order-id" }
      })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const messagesRepository = {
      findByExternalMessageId: vi.fn(async () => null),
      createMessage: vi.fn(async (data) => ({ id: "message-id", ...data }))
    };
    const intentClassifier = { classify: vi.fn(async () => ({ intent: "pix_payment", confidence: 1, summary: "pix", suggested_reply: "" })) };
    const chatAgent = {
      generateCommercialReply: vi.fn(async () => ({
        reply: "PIX do pedido UTV-1:\n000201-pix-copy-paste",
        copyText: "000201-pix-copy-paste",
        media: {
          base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
          mimetype: "image/png",
          fileName: "pix-UTV-1.png",
          caption: "QR Code Pix do pedido UTV-1"
        }
      }))
    };
    const evolutionService = {
      sendTextMessage: vi.fn(async () => ({ sent: true })),
      sendMediaMessage: vi.fn(async () => ({ sent: true }))
    };

    const service = new WhatsappMessageService(
      customersRepository as never,
      conversationsRepository as never,
      messagesRepository as never,
      intentClassifier as never,
      chatAgent as never,
      evolutionService as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      {} as never,
      {} as never,
      {} as never
    );

    const result = await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "pix-message-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "pix",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1,
        fromMe: false,
        isGroup: false
      }
    });

    expect(customersRepository.updateCustomer).not.toHaveBeenCalled();
    expect(intentClassifier.classify).toHaveBeenCalledWith({ message: "pix" });
    expect(chatAgent.generateCommercialReply).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: expect.objectContaining({ intent: "pix_payment" }),
        customer: expect.objectContaining({ email: null })
      })
    );
    expect(evolutionService.sendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "5511999998888",
        mimetype: "image/png",
        base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
      })
    );
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith({
      phone: "5511999998888",
      text: "000201-pix-copy-paste"
    });
    expect(result.status).toBe("processed");
  });

  it("interprets a clicked menu row before AI and sends a universal text menu", async () => {
    const customersRepository = {
      upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id", email: null }))
    };
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", metadata: {} })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const messagesRepository = {
      findByExternalMessageId: vi.fn(async () => null),
      createMessage: vi.fn(async (data) => ({ id: "message-id", ...data }))
    };
    const intentClassifier = { classify: vi.fn() };
    const chatAgent = {
      generateCommercialReply: vi.fn(async () => ({ reply: MAIN_MENU.fallbackText, menu: MAIN_MENU }))
    };
    const evolutionService = {
      sendTextMessage: vi.fn(async () => ({ sent: true })),
      sendButtonMessage: vi.fn(async () => ({ sent: true })),
      sendListMessage: vi.fn(async () => ({ sent: true }))
    };
    const service = new WhatsappMessageService(
      customersRepository as never,
      conversationsRepository as never,
      messagesRepository as never,
      intentClassifier as never,
      chatAgent as never,
      evolutionService as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      {} as never,
      {} as never,
      {} as never
    );

    await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "menu-click-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "menu:main:view_plans",
        messageType: "listResponseMessage",
        hasMedia: false,
        media: {},
        timestamp: 1,
        fromMe: false,
        isGroup: false
      }
    });

    expect(intentClassifier.classify).not.toHaveBeenCalled();
    expect(chatAgent.generateCommercialReply).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "quero ver os planos",
        classification: expect.objectContaining({ intent: "ask_price", confidence: 1 })
      })
    );
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith({
      phone: "5511999998888",
      text: MAIN_MENU.fallbackText
    });
    expect(evolutionService.sendButtonMessage).not.toHaveBeenCalled();
    expect(evolutionService.sendListMessage).not.toHaveBeenCalled();
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({ last_menu_id: "main" })
    );
  });

  it("sends the numbered menu directly instead of unsupported interactive messages", async () => {
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", metadata: {} })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async () => ({})),
      touchConversation: vi.fn(async () => ({}))
    };
    const evolutionService = {
      sendTextMessage: vi.fn(async () => ({ sent: true })),
      sendButtonMessage: vi.fn(async () => {
        throw new Error("buttons unavailable");
      }),
      sendListMessage: vi.fn(async () => {
        throw new Error("lists unavailable");
      })
    };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id" })) } as never,
      conversationsRepository as never,
      {
        findByExternalMessageId: vi.fn(async () => null),
        createMessage: vi.fn(async (data) => ({ id: "message-id", ...data }))
      } as never,
      { classify: vi.fn(async () => ({ intent: "greeting", confidence: 1, summary: "oi", suggested_reply: "" })) } as never,
      { generateCommercialReply: vi.fn(async () => ({ reply: MAIN_MENU.fallbackText, menu: MAIN_MENU })) } as never,
      evolutionService as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      {} as never,
      {} as never,
      {} as never
    );

    await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "greeting-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "oi",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1,
        fromMe: false,
        isGroup: false
      }
    });

    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith({
      phone: "5511999998888",
      text: MAIN_MENU.fallbackText
    });
    expect(evolutionService.sendButtonMessage).not.toHaveBeenCalled();
    expect(evolutionService.sendListMessage).not.toHaveBeenCalled();
  });

  it("detects human handoff requests directly and notifies the owner WhatsApp", async () => {
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", metadata: {} })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const intentClassifier = { classify: vi.fn() };
    const chatAgent = {
      generateCommercialReply: vi.fn(async () => ({
        reply: "Vou encaminhar para atendimento humano te ajudar melhor.",
        requiresHuman: true
      }))
    };
    const evolutionService = {
      sendTextMessage: vi.fn(async () => ({ sent: true })),
      sendButtonMessage: vi.fn(),
      sendListMessage: vi.fn()
    };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id", name: "Cliente Teste", phone: "5511999998888" })) } as never,
      conversationsRepository as never,
      {
        findByExternalMessageId: vi.fn(async () => null),
        createMessage: vi.fn(async (data) => ({ id: "message-id", ...data }))
      } as never,
      intentClassifier as never,
      chatAgent as never,
      evolutionService as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      {} as never,
      {} as never,
      {} as never
    );

    await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "human-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente Teste",
        text: "quero falar com humano",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1,
        fromMe: false,
        isGroup: false
      }
    });

    expect(intentClassifier.classify).not.toHaveBeenCalled();
    expect(chatAgent.generateCommercialReply).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: expect.objectContaining({ intent: "human_help", confidence: 1 })
      })
    );
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({ requires_human: true, handoff_reason: "human_help" })
    );
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "558699802602",
        text: expect.stringContaining("Um cliente quer falar com voce.")
      })
    );
  });

  it("does not let the agent keep answering after a human takeover is active", async () => {
    const intentClassifier = { classify: vi.fn() };
    const chatAgent = { generateCommercialReply: vi.fn() };
    const evolutionService = { sendTextMessage: vi.fn() };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id" })) } as never,
      {
        findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", metadata: { requires_human: true } })),
        createConversation: vi.fn(),
        updateConversationMetadata: vi.fn(),
        touchConversation: vi.fn(async () => ({}))
      } as never,
      {
        findByExternalMessageId: vi.fn(async () => null),
        createMessage: vi.fn(async (data) => ({ id: "message-id", ...data }))
      } as never,
      intentClassifier as never,
      chatAgent as never,
      evolutionService as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      {} as never,
      {} as never,
      {} as never
    );

    const result = await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "after-human-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "tem alguem ai?",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1,
        fromMe: false,
        isGroup: false
      }
    });

    expect(result.status).toBe("ignored");
    expect(intentClassifier.classify).not.toHaveBeenCalled();
    expect(chatAgent.generateCommercialReply).not.toHaveBeenCalled();
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
  });

  it("allows a resume command to reactivate the bot after human takeover", async () => {
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", metadata: { requires_human: true, handoff_reason: "human_help" } })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const intentClassifier = { classify: vi.fn(async () => ({ intent: "greeting", confidence: 1, summary: "resume", suggested_reply: "" })) };
    const chatAgent = { generateCommercialReply: vi.fn(async () => ({ reply: "Bot reativado." })) };
    const evolutionService = { sendTextMessage: vi.fn(async () => ({ sent: true })) };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id" })) } as never,
      conversationsRepository as never,
      {
        findByExternalMessageId: vi.fn(async () => null),
        createMessage: vi.fn(async (data) => ({ id: "message-id", ...data }))
      } as never,
      intentClassifier as never,
      chatAgent as never,
      evolutionService as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      {} as never,
      {} as never,
      {} as never
    );

    const result = await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "resume-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "reativar bot",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1,
        fromMe: false,
        isGroup: false
      }
    });

    expect(result.status).toBe("processed");
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({ requires_human: false, handoff_reason: null })
    );
    expect(intentClassifier.classify).toHaveBeenCalledWith({ message: "reativar bot" });
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith({ phone: "5511999998888", text: "Bot reativado." });
  });

  it("does not process duplicated messages", async () => {
    const evolutionService = { sendTextMessage: vi.fn() };
    const service = new WhatsappMessageService(
      {} as never,
      {} as never,
      { findByExternalMessageId: vi.fn(async () => ({ id: "existing" })) } as never,
      {} as never,
      {} as never,
      evolutionService as never,
      { createAuditLog: vi.fn(async (data) => data) } as never,
      {} as never,
      {} as never,
      {} as never
    );

    const result = await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "duplicate-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "oi",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1,
        fromMe: false,
        isGroup: false
      }
    });

    expect(result.status).toBe("duplicate");
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
  });
});
