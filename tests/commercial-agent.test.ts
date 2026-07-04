import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ChatAgentService } from "@/services/agent/chat-agent.service";
import { PlansService } from "@/services/plans.service";
import { WhatsappMessageService } from "@/services/whatsapp/whatsapp-message.service";

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
    searchKnowledge: vi.fn(async () => [])
  };
  const ordersService = {
    createOrder: vi.fn(async (data) => ({ ...data, id: "33333333-3333-4333-8333-333333333333", order_number: "UTV-20260704-000001" })),
    findLatestOpenOrderByCustomerId: vi.fn(async () => null as Record<string, unknown> | null),
    updateOrder: vi.fn(async (_id, data) => data)
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
    }))
  };

  return {
    service: new ChatAgentService(
      plansService as never,
      knowledgeService as never,
      ordersService as never,
      appSettingsService as never,
      agentActionsService as never,
      auditService as never,
      mercadoPagoService as never
    ),
    plansService,
    ordersService,
    appSettingsService,
    agentActionsService,
    auditService,
    mercadoPagoService,
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
    expect(mercadoPagoService.createOrderPreference).toHaveBeenCalledWith({
      order: expect.objectContaining({
        id: "33333333-3333-4333-8333-333333333333",
        order_number: "UTV-20260704-000001",
        customer_id: "44444444-4444-4444-8444-444444444444",
        plan_id: plan.id,
        amount_cents: 2500,
        currency: "BRL"
      }),
      plan: { name: plan.name, slug: plan.slug }
    });
    expect(ordersService.updateOrder).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      expect.objectContaining({
        payment_provider: "mercado_pago",
        payment_reference: "preference-id",
        metadata: expect.objectContaining({
          mercado_pago_checkout_url: "https://www.mercadopago.com.br/checkout/dynamic-order-link"
        })
      })
    );
    expect(appSettingsService.getPixInstructions).toHaveBeenCalled();
    expect(result.reply).toContain("https://www.mercadopago.com.br/checkout/dynamic-order-link");
    expect(result.reply.toLowerCase()).not.toContain("codigo de ativacao");
  });

  it("hands off when the order-specific Checkout Pro preference cannot be created", async () => {
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
    expect(result.requiresHuman).toBe(true);
    expect(agentActionsService.createAgentAction).toHaveBeenCalledWith(
      expect.objectContaining({ action_name: "handoff_to_human", requires_human_approval: true })
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

  it("hands a free trial to a human without creating a paid order", async () => {
    const { service, ordersService, agentActionsService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "tem teste gratis?",
      classification: { intent: "free_trial", confidence: 0.99, summary: "teste", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444" },
      conversation: { id: "55555555-5555-4555-8555-555555555555" },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).not.toHaveBeenCalled();
    expect(result.requiresHuman).toBe(true);
    expect(result.reply).toContain("3 dias");
    expect(agentActionsService.createAgentAction).toHaveBeenCalledWith(
      expect.objectContaining({ action_name: "handoff_to_human", requires_human_approval: true })
    );
  });

  it("returns the order-specific payment link for later card-payment questions", async () => {
    const { service, ordersService, appSettingsService } = createChatAgent();
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

    expect(appSettingsService.getPixInstructions).toHaveBeenCalled();
    expect(result.reply).toContain("https://www.mercadopago.com.br/checkout/dynamic-order-link");
    expect(appSettingsService.getPaymentInstructions).not.toHaveBeenCalled();
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
    expect(result.reply).toContain("Qual plano");
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
