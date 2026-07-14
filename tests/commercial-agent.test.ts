import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { contextualResponseGenerate } = vi.hoisted(() => ({
  contextualResponseGenerate: vi.fn(async (input: { responseDirective: string }): Promise<string | null> => input.responseDirective)
}));

vi.mock("@/services/agent/contextual-response-ai.service", () => ({
  extractRequiredArtifacts: () => [],
  ContextualResponseAIService: class {
    generateResponse(input: { responseDirective: string }) {
      return contextualResponseGenerate(input);
    }
  }
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

import { ChatAgentService, INITIAL_UNITV_REPLY } from "@/services/agent/chat-agent.service";
import { AudioTranscriptionError } from "@/services/audio/audio-transcription.service";
import { extractDeterministicDecision } from "@/services/agent/contextual-intelligence.service";
import { PlansService } from "@/services/plans.service";
import {
  canReuseUpstreamAIReply,
  isCustomerMessageSuperseded,
  WhatsappMessageService
} from "@/services/whatsapp/whatsapp-message.service";
import { MAIN_MENU } from "@/lib/whatsapp/menus";
import {
  classifyCustomerFacingResponseIntent,
  sanitizeCustomerMessage,
  validateConciseUnitvReply,
  validateResponseAgainstLeadProfile
} from "@/lib/whatsapp/customer-message-safety";

const plan = {
  id: "11111111-1111-4111-8111-111111111111",
  product_id: "22222222-2222-4222-8222-222222222222",
  name: "Plano Mensal",
  slug: "mensal",
  duration_days: 30,
  price_cents: 2500,
  currency: "BRL"
};
const trimestralPlan = { ...plan, id: "trimestral-id", name: "Plano Trimestral", slug: "trimestral", duration_days: 90, price_cents: 7000 };
const semestralPlan = { ...plan, id: "semestral-id", name: "Plano Semestral", slug: "semestral", duration_days: 180, price_cents: 12000 };
const anualPlan = { ...plan, id: "anual-id", name: "Plano Anual", slug: "anual", duration_days: 365, price_cents: 20000 };
const activePlans = [plan, trimestralPlan, semestralPlan, anualPlan];

function createChatAgent(overrides: Record<string, unknown> = {}) {
  const plansService = {
    listActivePlans: vi.fn(async () => activePlans),
    findPlanMentionedInText: vi.fn(async (text: string) => {
      const normalized = text.toLowerCase();
      const matchedPlan =
        /\b(mensal|25)\b/.test(normalized) ? plan :
        /\b(trimestral|3 meses|70)\b/.test(normalized) ? trimestralPlan :
        /\b(semestral|6 meses|120)\b/.test(normalized) ? semestralPlan :
        /\b(anual|200)\b/.test(normalized) ? anualPlan :
        null;
      return { plan: matchedPlan, plans: activePlans };
    })
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
    findAvailableCodes: vi.fn(async () => [] as Array<Record<string, unknown>>),
    reserveCode: vi.fn(async () => null as Record<string, unknown> | null),
    markCodeAsSent: vi.fn(async () => null as Record<string, unknown> | null),
    releaseReservedCodesForOrder: vi.fn(async () => [] as Array<Record<string, unknown>>)
  };
  const salesResponseAIService = (overrides.salesResponseAIService as { generateResponse: ReturnType<typeof vi.fn> } | undefined) || {
    generateResponse: vi.fn(async () => null as string | null)
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
      activationCodesService as never,
      salesResponseAIService as never
    ),
    plansService,
    knowledgeService,
    ordersService,
    appSettingsService,
    agentActionsService,
    auditService,
    mercadoPagoService,
    activationCodesService,
    salesResponseAIService,
    ...overrides
  };
}

describe("commercial WhatsApp agent", () => {
  it("hands reseller questions to the specialist without entering the customer plan flow", async () => {
    const { service, agentActionsService, ordersService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "Como faco para revender?",
      classification: { intent: "human_help", confidence: 0.95, summary: "revenda", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.requiresHuman).toBe(true);
    expect(result.responseRule).toBe("reseller_handoff");
    expect(result.reply).toContain("diretamente pelo especialista");
    expect(result.reply.toLowerCase()).not.toContain("plano mensal");
    expect(result.leadProfilePatch).toMatchObject({
      reseller_intent: true,
      stage: "human_support_reseller"
    });
    expect(agentActionsService.createAgentAction).toHaveBeenCalledWith(
      expect.objectContaining({ action_name: "handoff_to_human" })
    );
    expect(ordersService.createOrder).not.toHaveBeenCalled();
  });

  it.each([
    ["Tem canais e filmes em espanhol?", "canais e filmes em espanhol"],
    ["Tem ESPN?", "nao possui ESPN como canal fixo"],
    ["Tem Premiere?", "possui Premiere"]
  ])("answers authoritative catalog question %s locally", async (message, expected) => {
    const salesResponseAIService = { generateResponse: vi.fn(async () => "resposta incorreta da IA") };
    const { service } = createChatAgent({ salesResponseAIService });

    const result = await service.generateCommercialReply({
      message,
      classification: { intent: "unknown", confidence: 0.95, summary: "catalogo", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id", metadata: { lead_profile: { stage: "price_discovery" } } },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain(expected);
    expect(result.responseSource).toBe("local_rule");
    expect(salesResponseAIService.generateResponse).not.toHaveBeenCalled();
  });

  it("checks Android before confirming compatibility for TV HQ", async () => {
    const salesResponseAIService = { generateResponse: vi.fn(async () => "funciona sim") };
    const { service } = createChatAgent({ salesResponseAIService });

    const result = await service.generateCommercialReply({
      message: "Minha TV HQ funciona?",
      classification: { intent: "technical_support", confidence: 0.95, summary: "compatibilidade", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("possui Android ou Android TV?");
    expect(result.reply.toLowerCase()).not.toContain("funciona sim");
    expect(result.leadProfilePatch).toMatchObject({ device: "hq_tv", device_compatible: "unknown" });
    expect(salesResponseAIService.generateResponse).not.toHaveBeenCalled();
  });

  it("blocks internal debug text before it reaches the customer", () => {
    for (const message of [
      "Resolvido por regra local sem uso de IA.",
      "debug intent=buy_plan",
      '{"schema":"lead_profile","requires_human":false}',
      "OpenAI Responses API"
    ]) {
      const result = sanitizeCustomerMessage(message);
      expect(result.blocked).toBe(true);
      expect(result.text).toBe("");
    }
  });

  it("blocks responses that repeat facts already known in the lead profile", () => {
    expect(validateResponseAgainstLeadProfile("Voce ja baixou?", { downloaded_app: true }).valid).toBe(false);
    expect(validateResponseAgainstLeadProfile("Qual aparelho voce vai usar?", { device: "tvbox" }).valid).toBe(false);
    expect(validateResponseAgainstLeadProfile("Qual plano voce quer?", { selected_plan: "mensal" }).valid).toBe(false);
    expect(validateResponseAgainstLeadProfile("Se ja pagou, envie o comprovante.", { has_paid: false }).valid).toBe(false);
    expect(validateResponseAgainstLeadProfile(
      "Oi, tudo bem? Você já usa o aplicativo UNITV ou seria sua primeira vez?",
      { stage: "download_instructions", download_status: "link_sent", last_download_url_sent: "https://www.mediafire.com/app.apk" }
    ).valid).toBe(false);
    expect(validateResponseAgainstLeadProfile(
      "Olá! Seja bem-vindo ao melhor aplicativo de filmes e canais 🧡. Meu nome é André.",
      { saudacao_enviada: true }
    ).valid).toBe(false);
    expect(validateResponseAgainstLeadProfile(
      "Claro 👍 Pra eu liberar seu teste grátis de 3 dias, me diz só em qual aparelho você vai usar: celular Android, TV Box, Android TV, Google TV ou Fire Stick?",
      { pergunta_aparelho_enviada: true }
    ).valid).toBe(false);
    expect(validateResponseAgainstLeadProfile(
      "Perfeito 👍 Só me confirma qual aparelho você vai usar pra eu liberar certinho: celular Android, TV Box, Android TV, Google TV ou Fire Stick?",
      { pergunta_aparelho_enviada: true }
    ).valid).toBe(true);
  });

  it("classifies customer-facing response intents for operational dedupe", () => {
    expect(classifyCustomerFacingResponseIntent("Olá! Seja bem-vindo. Meu nome é André.")).toBe("saudacao_inicial");
    expect(classifyCustomerFacingResponseIntent("Mensal — R$ 25\n3 meses — R$ 70\n6 meses — R$ 120\nAnual — R$ 200")).toBe("valores_enviados");
    expect(classifyCustomerFacingResponseIntent("Vou te passar a chave PIX agora.")).toBe("pix_enviado");
  });

  it("uses contextual AI before fixed commercial templates for non-sensitive replies", async () => {
    const salesResponseAIService = {
      generateResponse: vi.fn(async () => "Consigo te passar os valores sim. Pelo seu caso, eu comecaria pelo mensal ou pelo teste antes de fechar.")
    };
    const { service } = createChatAgent({ salesResponseAIService });

    const result = await service.generateCommercialReply({
      message: "quais valores?",
      classification: { intent: "ask_price", confidence: 0.99, summary: "valores", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id", metadata: { lead_profile: { learned_from_specialist: true } } },
      webhookEventId: "webhook-id",
      recentMessages: [
        { role: "customer", content: "quero conhecer" },
        { role: "human_agent", content: "Se quiser, comeco te explicando o mensal e depois vemos teste." }
      ],
      specialistExamples: [
        {
          customer_last_message: "quais valores?",
          specialist_message: "Eu comecaria te passando o mensal e vendo se prefere testar primeiro."
        }
      ]
    });

    expect(salesResponseAIService.generateResponse).toHaveBeenCalled();
    expect(result.responseRule).toBe("sales_response_ai_contextual_first");
    expect(result.reply).toContain("Pelo seu caso");
    expect(result.reply).not.toContain("Hoje temos");
    expect(result.reply).not.toContain("O mensal é bom para começar");
  });

  it("keeps order creation out of free AI writing until payment method is selected", async () => {
    const salesResponseAIService = {
      generateResponse: vi.fn(async () => "texto da IA que nao deve ser usado")
    };
    const { service, ordersService } = createChatAgent({ salesResponseAIService });

    const result = await service.generateCommercialReply({
      message: "quero mensal",
      classification: { intent: "buy_plan", confidence: 0.99, summary: "compra", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(salesResponseAIService.generateResponse).not.toHaveBeenCalled();
    expect(ordersService.createOrder).not.toHaveBeenCalled();
    expect(result.reply).toContain("mensal");
    expect(result.reply).toContain("R$");
    expect(result.reply).toContain("Voce tem interesse pra hoje?");
    expect(result.reply).not.toContain("R$ 19,99");
  });

  it.each([
    ["Ativar", {}, "ja usa o UNITV", "R$ 25"],
    ["Nao paguei ainda", {}, "3 dias", "comprovante"],
    ["Mensal", { wants_activation: true }, "Voce tem interesse pra hoje?", "Qual plano"],
    ["Ja baixei", { device: "tvbox" }, "3 dias", "ja baixou"],
    ["Sim", { last_bot_question: "Voce ja baixou o app?" }, "ativa\u00e7\u00e3o", "ja baixou"],
    ["Ja usei", {}, "preferencia por qual plano", "R$ 25"],
    ["É unitv mesmo?", { valores_enviados: true }, "Sim, é UNITV mesmo", "Seja bem-vindo"],
    ["Quero logo um teste", {}, "teste grátis de 3 dias", "Seja bem-vindo"],
    ["Pode ser", { last_bot_question: "Pra eu liberar seu teste gratis, em qual aparelho voce vai usar?" }, "Só me confirma qual aparelho", "Seja bem-vindo"]
  ])("advances contextual message %s without repeating the funnel", async (message, leadProfile, expected, forbidden) => {
    const { service } = createChatAgent();
    const result = await service.generateCommercialReply({
      message,
      classification: { intent: "unknown", confidence: 0.95, summary: "contexto", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id", metadata: { lead_profile: leadProfile } },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain(expected);
    expect(result.reply.toLowerCase()).not.toContain(forbidden.toLowerCase());
  });

  it("extracts contextual commercial decisions from short customer replies", () => {
    const pixDecision = extractDeterministicDecision({
      current_message: "sim",
      recent_messages: [],
      lead_profile: { selected_plan: "mensal" },
      open_order: null,
      latest_order: null,
      last_bot_question: "Quer que eu gere o Pix?",
      last_bot_message_at: null,
      last_specialist_message_at: null,
      followup_key: null,
      followup_due_at: null,
      human_hold_active: false
    });

    expect(pixDecision).toMatchObject({
      intent: "request_pix",
      selected_plan: "mensal",
      payment_method: "pix",
      should_create_order: true,
      should_generate_pix: true,
      next_expected_reply: "payment_proof"
    });

    const planAfterPixDecision = extractDeterministicDecision({
      current_message: "Mensal",
      recent_messages: [],
      lead_profile: { pediu_pix: true },
      open_order: null,
      latest_order: null,
      last_bot_question: "Qual plano você quer ativar para eu gerar o Pix?",
      last_bot_message_at: null,
      last_specialist_message_at: null,
      followup_key: null,
      followup_due_at: null,
      human_hold_active: false
    });

    expect(planAfterPixDecision).toMatchObject({
      intent: "choose_plan",
      selected_plan: "mensal",
      payment_method: "pix",
      should_create_order: true,
      should_generate_pix: true
    });

    const freeTrialDecision = extractDeterministicDecision({
      current_message: "Ola! Quero fazer teste tem como",
      recent_messages: [],
      lead_profile: {},
      open_order: null,
      latest_order: null,
      last_bot_question: null,
      last_bot_message_at: null,
      last_specialist_message_at: null,
      followup_key: null,
      followup_due_at: null,
      human_hold_active: false
    });

    expect(freeTrialDecision).toMatchObject({
      detected_intent: "FREE_TRIAL_REQUEST",
      stage: "device_qualification",
      selected_plan: null,
      should_create_order: false,
      should_generate_pix: false,
      should_send_download: false,
      next_action: "ask_device_for_trial",
      next_expected_reply: "device"
    });

    const trialSelectionDecision = extractDeterministicDecision({
      current_message: "Testes",
      recent_messages: [],
      lead_profile: { last_customer_intent: "first_time_user" },
      open_order: null,
      latest_order: null,
      last_bot_question: "Perfeito, entao e sua primeira vez. Voce prefere fazer o teste gratis de 3 dias primeiro ou quer ver os planos?",
      last_bot_message_at: null,
      last_specialist_message_at: null,
      followup_key: null,
      followup_due_at: null,
      human_hold_active: false
    });

    expect(trialSelectionDecision).toMatchObject({
      intent: "activate",
      detected_intent: "FREE_TRIAL_REQUEST",
      next_action: "ask_device_for_trial",
      stage: "device_qualification",
      should_reply: true,
      should_handoff: false,
      next_expected_reply: "device"
    });
    expect(trialSelectionDecision.recommended_response).toContain("aparelho");

    const phoneNeedsConfirmationDecision = extractDeterministicDecision({
      current_message: "celular",
      recent_messages: [],
      lead_profile: { wants_test: true },
      open_order: null,
      latest_order: null,
      last_bot_question: "Me fala so qual aparelho voce vai usar: celular Android, TV Box, Android TV/Google TV ou Fire Stick?",
      last_bot_message_at: null,
      last_specialist_message_at: null,
      followup_key: null,
      followup_due_at: null,
      human_hold_active: false
    });

    expect(phoneNeedsConfirmationDecision).toMatchObject({
      detected_intent: "DEVICE_ANDROID_PHONE_NEEDS_CONFIRMATION",
      next_action: "confirm_android_phone",
      stage: "device_qualification",
      next_expected_reply: "device"
    });

    const downloadDecision = extractDeterministicDecision({
      current_message: "já baixei",
      recent_messages: [],
      lead_profile: { device: "tvbox_android" },
      open_order: null,
      latest_order: null,
      last_bot_question: "Conseguiu baixar?",
      last_bot_message_at: null,
      last_specialist_message_at: null,
      followup_key: "download",
      followup_due_at: null,
      human_hold_active: false
    });

    expect(downloadDecision).toMatchObject({
      intent: "already_downloaded",
      install_status: "downloaded",
      stage: "install_support"
    });

    const failedDownloadDecision = extractDeterministicDecision({
      current_message: "não consegui baixar",
      recent_messages: [],
      lead_profile: {},
      open_order: null,
      latest_order: null,
      last_bot_question: "Conseguiu baixar?",
      last_bot_message_at: null,
      last_specialist_message_at: null,
      followup_key: "download",
      followup_due_at: null,
      human_hold_active: false
    });

    expect(failedDownloadDecision).toMatchObject({
      intent: "download_issue",
      detected_intent: "DOWNLOAD_HELP",
      next_action: "ask_download_problem",
      install_status: "failed",
      stage: "download_support"
    });

    const shortNoDownloadDecision = extractDeterministicDecision({
      current_message: "nao",
      recent_messages: [],
      lead_profile: { install_status: "link_sent" },
      open_order: null,
      latest_order: null,
      last_bot_question: "Voce conseguiu baixar?",
      last_bot_message_at: null,
      last_specialist_message_at: null,
      followup_key: "post_download_check_10min",
      followup_due_at: null,
      human_hold_active: false
    });

    expect(shortNoDownloadDecision).toMatchObject({
      intent: "download_issue",
      detected_intent: "DOWNLOAD_HELP",
      next_action: "ask_download_problem",
      recommended_response: "Tudo bem, me fala onde travou: no link, no Downloader ou na instalacao?"
    });

    const genericPriceDecision = extractDeterministicDecision({
      current_message: "Valor",
      recent_messages: [],
      lead_profile: {},
      open_order: null,
      latest_order: null,
      last_bot_question: null,
      last_bot_message_at: null,
      last_specialist_message_at: null,
      followup_key: null,
      followup_due_at: null,
      human_hold_active: false
    });

    expect(genericPriceDecision).toMatchObject({
      intent: "ask_price",
      detected_intent: "PLAN_PRICE_REQUEST",
      selected_plan: "mensal",
      next_action: "show_monthly_plan",
      should_clarify: false,
      confidence: 0.98
    });
    expect(genericPriceDecision.recommended_response).toContain("R$ 20,90");
    expect(genericPriceDecision.recommended_response).toContain("interesse pra hoje?");

    const fragmentedPriceDecision = extractDeterministicDecision({
      current_message: "Preciso ver valores tbm",
      recent_messages: [{ role: "customer", content: "Sim" }],
      lead_profile: { stage: "plan_preference" },
      open_order: null,
      latest_order: null,
      last_bot_question: "Quer que eu continue com voce?",
      last_bot_message_at: null,
      last_specialist_message_at: null,
      followup_key: null,
      followup_due_at: null,
      human_hold_active: false
    });
    expect(fragmentedPriceDecision).toMatchObject({
      detected_intent: "PLAN_PRICE_REQUEST",
      next_action: "show_monthly_plan",
      selected_plan: "mensal"
    });
    expect(fragmentedPriceDecision.recommended_response).not.toMatch(/R\$ (70|120|200)/);

    const screenCoverageDecision = extractDeterministicDecision({
      current_message: "Quantas telas o mensal cobre?",
      recent_messages: [],
      lead_profile: {},
      open_order: null,
      latest_order: null,
      last_bot_question: null,
      last_bot_message_at: null,
      last_specialist_message_at: null,
      followup_key: null,
      followup_due_at: null,
      human_hold_active: false
    });

    expect(screenCoverageDecision).toMatchObject({
      detected_intent: "PLAN_SCREEN_COVERAGE",
      selected_plan: "mensal",
      next_action: "answer_screen_coverage",
      should_clarify: false,
      confidence: 0.98
    });
    expect(screenCoverageDecision.recommended_response).toContain("ate 3 telas");
  });

  it("enforces Andre's concise response rhythm before an AI reply can be used", () => {
    expect(validateConciseUnitvReply("Está saindo a R$ 20,90 o plano mensal. Você tem interesse?").valid).toBe(true);
    expect(validateConciseUnitvReply(INITIAL_UNITV_REPLY).valid).toBe(true);
    expect(validateConciseUnitvReply(
      "Claro! A UNITV tem canais, filmes e séries para celular, TV Box e smart TV. Posso explicar todos os planos e depois você me diz quantas telas quer usar?"
    )).toMatchObject({ valid: false, reason: "response_too_long" });
    expect(validateConciseUnitvReply("Você quer testar? Quer ver planos?")).toMatchObject({
      valid: false,
      reason: "too_many_questions"
    });
  });

  it("replaces an unsafe agent reply in the real WhatsApp send path", async () => {
    const evolutionService = { sendTextMessage: vi.fn(async () => ({ sent: true })) };
    const auditService = { createAuditLog: vi.fn(async () => ({})) };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id" })) } as never,
      {
        findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", metadata: {} })),
        createConversation: vi.fn(),
        updateConversationMetadata: vi.fn(async () => ({})),
        touchConversation: vi.fn(async () => ({}))
      } as never,
      {
        findByExternalMessageId: vi.fn(async () => null),
        createMessage: vi.fn(async (data) => ({ id: "message-id", ...data }))
      } as never,
      { classify: vi.fn(async () => ({ intent: "unknown", confidence: 1, summary: "teste", suggested_reply: "" })) } as never,
      { generateCommercialReply: vi.fn(async () => ({ reply: "Resolvido por regra local sem uso de IA." })) } as never,
      evolutionService as never,
      auditService as never,
      {} as never,
      {} as never,
      {} as never,
      { createExample: vi.fn() } as never
    );

    await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "unsafe-reply-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "quero ajuda",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1,
        fromMe: false,
        isGroup: false
      }
    });

    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
    expect(auditService.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "customer_message_safety_blocked" })
    );
  });

  it("schedules a 4h pre-sale follow-up when a hot recharge lead says they will do it later", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id", name: "Fabio", phone: "5511999998888" })) } as never,
      {
        findByExternalConversationId: vi.fn(async () => ({
          id: "conversation-id",
          customer_id: "customer-id",
          metadata: {
            lead_profile: {
              nome: "Fabio",
              selected_plan: "mensal",
              asked_price: true,
              requested_screens: 2
            },
            last_bot_message_at: "2026-07-09T15:23:00.000Z"
          }
        })),
        createConversation: vi.fn(),
        updateConversationMetadata: vi.fn(async (_id, metadata) => {
          updates.push(metadata);
          return { id: _id, metadata };
        }),
        touchConversation: vi.fn(async () => ({}))
      } as never,
      {
        findByExternalMessageId: vi.fn(async () => null),
        createMessage: vi.fn(async (data) => ({ id: "message-id", ...data })),
        listMessagesByConversationId: vi.fn(async () => [
          { role: "customer", content: "Valor de 30 dias", created_at: "2026-07-09T15:22:00.000Z" },
          { role: "assistant", content: "O mensal esta saindo a R$ 25. Voce ja faz a recarga?", created_at: "2026-07-09T15:23:00.000Z" },
          { role: "customer", content: "15", created_at: "2026-07-09T15:32:00.000Z" },
          { role: "customer", content: "E duas telas", created_at: "2026-07-09T15:34:00.000Z" }
        ])
      } as never,
      { classify: vi.fn(async () => ({ intent: "unknown", confidence: 0.8, summary: "vai fazer depois", suggested_reply: "" })) } as never,
      { generateCommercialReply: vi.fn(async () => ({ reply: "Perfeito, deixo anotado por aqui." })) } as never,
      { sendTextMessage: vi.fn(async () => ({ sent: true })) } as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      {} as never,
      {} as never,
      {} as never,
      { createExample: vi.fn() } as never
    );

    await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "later-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Fabio",
        text: "Mais tarde eu faço",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: Date.parse("2026-07-09T15:35:00.000Z") / 1000,
        fromMe: false,
        isGroup: false
      }
    });

    const finalMetadata = updates.at(-1) || {};
    expect(finalMetadata).toMatchObject({
      followup_key: "pre_sale_recharge_later_4h",
      followup_due_at: "2026-07-09T19:35:00.000Z",
      customer_stage: "pre_sale_recharge_intent",
      payment_intent_status: "later",
      last_detected_intent: "wants_to_recharge_later"
    });
    expect(finalMetadata.lead_profile).toMatchObject({
      nome: "Fabio",
      selected_plan: "mensal",
      requested_screens: 2,
      last_detected_intent: "wants_to_recharge_later",
      next_best_action: "follow_up_4h_pedir_permissao_pix"
    });
  });

  it("does not schedule the 4h pre-sale follow-up for a cold 'mais tarde eu vejo' message", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id", phone: "5511999998888" })) } as never,
      {
        findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", customer_id: "customer-id", metadata: { lead_profile: {} } })),
        createConversation: vi.fn(),
        updateConversationMetadata: vi.fn(async (_id, metadata) => {
          updates.push(metadata);
          return { id: _id, metadata };
        }),
        touchConversation: vi.fn(async () => ({}))
      } as never,
      {
        findByExternalMessageId: vi.fn(async () => null),
        createMessage: vi.fn(async (data) => ({ id: "message-id", ...data })),
        listMessagesByConversationId: vi.fn(async () => [])
      } as never,
      { classify: vi.fn(async () => ({ intent: "unknown", confidence: 0.8, summary: "frio", suggested_reply: "" })) } as never,
      { generateCommercialReply: vi.fn(async () => ({ reply: "Tudo bem, fico por aqui." })) } as never,
      { sendTextMessage: vi.fn(async () => ({ sent: true })) } as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      {} as never,
      {} as never,
      {} as never,
      { createExample: vi.fn() } as never
    );

    await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "cold-later-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "Mais tarde eu vejo",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: Date.parse("2026-07-09T15:35:00.000Z") / 1000,
        fromMe: false,
        isGroup: false
      }
    });

    expect(updates.at(-1)).toMatchObject({ followup_key: null, followup_due_at: null });
  });

  it("offers the monthly plan directly for a broad price question", async () => {
    const { service, plansService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "quanto custa?",
      classification: { intent: "ask_price", confidence: 0.9, summary: "preco", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(plansService.listActivePlans).toHaveBeenCalled();
    expect(result.reply).toContain("R$ 20,90");
    expect(result.reply).toContain("Voce tem interesse pra hoje?");
    expect(result.reply).not.toContain("quantas telas");
    expect(result.reply).not.toContain("trimestral");
    expect(result.reply).not.toContain("R$ 70");
    expect(result.menu).toBeUndefined();
    expect(result.reply).not.toContain("Ver planos");
    expect(result.leadProfilePatch).toMatchObject({
      selected_plan: "mensal",
      stage: "monthly_offer_pending",
      next_expected_reply: "monthly_offer_interest"
    });
  });

  it("answers a short quanto message with the monthly offer", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "Quanto",
      classification: { intent: "ask_price", confidence: 0.95, summary: "preco", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id", metadata: { lead_profile: { valores_enviados: true } } },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("R$ 20,90");
    expect(result.reply).toContain("Voce tem interesse pra hoje?");
    expect(result.reply).not.toContain("quantas telas");
    expect(result.reply).not.toContain("trimestral");
    expect(result.reply).not.toContain("R$ 70");
  });

  it("does not go silent when OpenAI is unavailable and the customer says no plan preference", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const { service, salesResponseAIService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "Não",
      classification: { intent: "unknown", confidence: 0.2, summary: "fallback", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            last_bot_question: "Voce tem interesse em algum plano especifico: mensal, trimestral, semestral ou anual?"
          }
        }
      },
      webhookEventId: "webhook-id"
    });

    expect(salesResponseAIService.generateResponse).toHaveBeenCalled();
    expect(result.reply).toContain("teste gratis");
    expect(result.reply).toContain("mensal");
    expect(result.requiresHuman).toBeUndefined();
    expect(result.responseRule).toBe("contextual_reply");
  });

  it("handles a customer who says they want to start now after broad qualification", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "Eu estarei agora",
      classification: { intent: "unknown", confidence: 0.2, summary: "fallback", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            last_bot_question: "Voce tem interesse em algum plano especifico: mensal, trimestral, semestral ou anual? E seria para usar em quantas telas?"
          }
        }
      },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("comecar agora");
    expect(result.reply).toContain("teste gratis");
    expect(result.reply).toContain("mensal");
    expect(result.requiresHuman).toBeUndefined();
  });

  it("shows the monthly value and asks whether the customer is interested", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "sim",
      classification: { intent: "unknown", confidence: 0.95, summary: "confirmacao", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: { lead_profile: { last_bot_question: "Voce teria interesse no mensal mesmo?" } }
      },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("mensal");
    expect(result.reply).toContain("R$ 20,90");
    expect(result.reply).toContain("Voce tem interesse pra hoje?");
    expect(result.reply.toLowerCase()).not.toContain("telas");
    expect(result.reply).not.toContain("Voce ja faz a recarga?");
    expect(result.leadProfilePatch).toMatchObject({
      selected_plan: "mensal",
      next_expected_reply: "monthly_offer_interest",
      commercial_stage: "monthly_offer_pending"
    });
  });

  it("answers monthly price at the fixed value and keeps the offer pending before payment", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "Qual o valor mensal?",
      classification: { intent: "ask_price", confidence: 0.95, summary: "valor mensal", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id", metadata: { lead_profile: { nome: "Celio Luiz" } } },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("O plano mensal esta saindo por R$ 20,90");
    expect(result.reply).toContain("Voce tem interesse pra hoje?");
    expect(result.reply.toLowerCase()).not.toContain("tela");
    expect(result.reply.toLowerCase()).not.toContain("aparelho");
    expect(result.reply).not.toContain("Voce ja faz a recarga?");
    expect(result.reply).not.toContain("Pix");
    expect(result.reply).not.toContain("R$ 70");
    expect(result.leadProfilePatch).toMatchObject({
      selected_plan: "mensal",
      next_expected_reply: "monthly_offer_interest",
      last_bot_question: "Voce tem interesse pra hoje?"
    });
  });

  it("moves to payment choice after the customer accepts the monthly offer", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "sim",
      classification: { intent: "unknown", confidence: 0.95, summary: "aceite", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: { lead_profile: { selected_plan: "mensal", last_bot_question: "Voce tem interesse?" } }
      },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("Pix ou cartão");
    expect(result.leadProfilePatch).toMatchObject({
      selected_plan: "mensal",
      commercial_stage: "payment_choice",
      next_expected_reply: "payment_method"
    });
  });

  it("keeps the fixed monthly price when customer says current recharge is 20", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "faço a 20",
      classification: { intent: "unknown", confidence: 0.95, summary: "preco atual", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: { lead_profile: { last_bot_question: "Voce ja faz a recarga? Se sim, faz a quanto?" } }
      },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("R$ 20,90");
    expect(result.reply).toContain("Voce tem interesse pra hoje?");
    expect(result.reply).not.toContain("R$ 19,99");
    expect(result.reply).not.toContain("Pix");
    expect(result.leadProfilePatch).toMatchObject({
      selected_plan: "mensal",
      current_recharge_price_cents: 2000,
      commercial_stage: "monthly_offer_pending",
      next_expected_reply: "monthly_offer_interest",
      last_bot_question: "Voce tem interesse pra hoje?"
    });
  });

  it("keeps the fixed monthly price after customer says they only tested", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "So feito o teste",
      classification: { intent: "unknown", confidence: 0.95, summary: "teste anterior", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            selected_plan: "mensal",
            last_bot_question: "Voce ja faz a recarga? Se sim, faz a quanto?"
          }
        }
      },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("R$ 20,90");
    expect(result.reply).toContain("Voce tem interesse pra hoje?");
    expect(result.reply).not.toContain("R$ 19,99");
    expect(result.reply).not.toContain("Pix");
    expect(result.leadProfilePatch).toMatchObject({
      selected_plan: "mensal",
      commercial_stage: "monthly_offer_pending",
      next_expected_reply: "monthly_offer_interest",
      last_bot_question: "Voce tem interesse pra hoje?"
    });
  });

  it("shows all values only when the customer explicitly asks for all prices", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "quais valores dos planos?",
      classification: { intent: "ask_price", confidence: 0.9, summary: "preco", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("R$ 20,90");
    expect(result.reply).toContain("R$ 70");
    expect(result.reply).toContain("R$ 120");
    expect(result.reply).toContain("R$ 200");
    expect(result.reply).toContain("Mensal");
    expect(result.reply).toContain("Trimestral");
    expect(result.reply).toContain("Semestral");
    expect(result.reply).toContain("Anual");
    expect(result.reply).not.toContain("Qual voce quer seguir");
  });

  it("does not treat a casual request to see values as permission to reveal every plan", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "Preciso ver valores tbm",
      classification: { intent: "ask_price", confidence: 0.98, summary: "quer ver valor", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: { lead_profile: { stage: "plan_preference", saudacao_enviada: true } }
      },
      recentMessages: [
        { role: "assistant", content: "Quer que eu continue com voce?" },
        { role: "customer", content: "Sim" },
        { role: "customer", content: "Preciso ver valores tbm" }
      ],
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toBe("O plano mensal esta saindo por R$ 20,90. Voce tem interesse pra hoje?");
    expect(result.reply).not.toMatch(/R\$ (70|120|200)/);
    expect(result.leadProfilePatch).toMatchObject({
      selected_plan: "mensal",
      stage: "monthly_offer_pending",
      next_expected_reply: "monthly_offer_interest"
    });
  });

  it("uses the official knowledge value when the customer asks for the trimestral plan", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "qual o valor do trimestral?",
      classification: { intent: "ask_price", confidence: 0.95, summary: "valor trimestral", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("trimestral");
    expect(result.reply).toContain("R$ 70");
    expect(result.reply).not.toContain("R$ 20,90");
    expect(result.reply).not.toContain("quantas telas");
    expect(result.leadProfilePatch).toMatchObject({ selected_plan: "trimestral", stage: "plan_selected" });
  });

  it("does not reveal prices on traffic-source recharge opener", async () => {
    const { service, ordersService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "Olá! Quero fazer Recarga Codigo UNITV",
      classification: { intent: "renew_plan", confidence: 0.95, summary: "recarga", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).not.toHaveBeenCalled();
    expect(result.reply).toBe(INITIAL_UNITV_REPLY);
    expect(result.reply).not.toContain("renovação de qual plano");
    expect(result.reply).not.toContain("mensal, 3 meses");
    expect(result.reply).not.toContain("R$ 25");
    expect(result.reply).not.toContain("R$ 70");
    expect(result.reply).not.toContain("R$ 120");
    expect(result.reply).not.toContain("R$ 200");
    expect(result.leadProfilePatch).toMatchObject({
      traffic_source_opener: true,
      stage: "welcome_activation",
      next_expected_reply: "customer_need"
    });
  });

  it("answers ad information request locally without spending an AI call", async () => {
    const { service, salesResponseAIService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "Olá! Posso ter mais informações sobre isso?",
      classification: { intent: "greeting", confidence: 0.95, summary: "saudacao de anuncio", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(salesResponseAIService.generateResponse).not.toHaveBeenCalled();
    expect(result.reply).toBe(INITIAL_UNITV_REPLY);
    expect(result.responseSource).toBe("local_rule");
    expect(result.responseRule).toBe("fixed_initial_greeting");
    expect(result.leadProfilePatch).toMatchObject({
      traffic_source_opener: true,
      stage: "welcome_activation",
      next_expected_reply: "customer_need"
    });
  });

  it.each(["buy_plan", "ask_price", "unknown", "greeting"] as const)(
    "keeps the traffic-source recharge opener as welcome before plan flow when intent is %s",
    async (intent) => {
      const { service, ordersService, mercadoPagoService } = createChatAgent();

      const result = await service.generateCommercialReply({
        message: "Olá! Quero fazer Recarga Codigo UNITV",
        classification: { intent, confidence: 0.95, summary: "trafego", suggested_reply: "" },
        customer: { id: "customer-id" },
        conversation: { id: "conversation-id" },
        webhookEventId: "webhook-id"
      });

      expect(ordersService.createOrder).not.toHaveBeenCalled();
      expect(mercadoPagoService.createPixPayment).not.toHaveBeenCalled();
      expect(result.reply).toBe(INITIAL_UNITV_REPLY);
      expect(result.reply).not.toContain("Qual plano");
      expect(result.reply).not.toContain("mensal, 3 meses");
      expect(result.reply).not.toContain("R$ 25");
      expect(result.menu).toBeUndefined();
      expect(result.leadProfilePatch).toMatchObject({
        traffic_source_opener: true,
        stage: "welcome_activation",
        next_expected_reply: "customer_need"
      });
    }
  );

  it("asks plan preference without prices when customer says they already use UNITV", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "ja uso",
      classification: { intent: "unknown", confidence: 0.95, summary: "ja usa", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id", metadata: { lead_profile: {} } },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("preferencia por qual plano");
    expect(result.reply).not.toContain("R$ 25");
    expect(result.reply).not.toContain("R$ 70");
  });

  it("answers only the selected monthly plan price", async () => {
    const { service, ordersService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "mensal",
      classification: { intent: "buy_plan", confidence: 0.99, summary: "mensal", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).not.toHaveBeenCalled();
    expect(result.reply).toContain("mensal");
    expect(result.reply).toContain("R$");
    expect(result.reply).toContain("Voce tem interesse pra hoje?");
    expect(result.reply).not.toContain("Pix");
    expect(result.reply).not.toContain("R$ 70");
    expect(result.reply).not.toContain("R$ 120");
    expect(result.reply).not.toContain("R$ 200");
  });

  it("infers the trimestral plan when the customer mentions value 70", async () => {
    const { service, ordersService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "vou querer o de 70",
      classification: { intent: "buy_plan", confidence: 0.99, summary: "valor", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).not.toHaveBeenCalled();
    expect(result.reply).toContain("trimestral");
    expect(result.reply).toContain("R$");
    expect(result.reply).not.toContain("R$ 25");
    expect(result.reply).not.toContain("R$ 120");
    expect(result.reply).not.toContain("R$ 200");
  });

  it("answers greeting with the human welcome and no main menu", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "oi",
      classification: { intent: "greeting", confidence: 0.99, summary: "saudacao", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toBe(INITIAL_UNITV_REPLY);
    expect(result.reply.trim().endsWith("?")).toBe(true);
    expect(result.menu).toBeUndefined();
    expect(result.sendTextBeforeMenu).toBe(false);
    expect(result.reply).not.toContain("Ver planos");
    expect(result.reply).not.toContain("Fazer teste grátis");
    expect(result.reply).not.toContain("Comprar agora");
    expect(result.reply).not.toContain("Aprender a instalar");
    expect(result.reply).not.toContain("Enviar comprovante");
    expect(result.reply).not.toContain("Falar com especialista");
  });

  it("answers typo greeting with activation question and no menu", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "Olq",
      classification: { intent: "greeting", confidence: 0.95, summary: "saudacao com typo", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toBe(INITIAL_UNITV_REPLY);
    expect(result.reply.trim().endsWith("?")).toBe(true);
    expect(result.menu).toBeUndefined();
  });

  it("uses the exact fixed greeting for the first agent reply even when the lead asks a price", async () => {
    const { service, salesResponseAIService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "qual o valor?",
      classification: { intent: "ask_price", confidence: 0.99, summary: "preco", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      recentMessages: [{ role: "customer", content: "qual o valor?" }],
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toBe(INITIAL_UNITV_REPLY);
    expect(result.responseRule).toBe("fixed_initial_greeting");
    expect(result.leadProfilePatch).toMatchObject({
      stage: "welcome_activation",
      next_expected_reply: "customer_need",
      last_bot_question: "Como posso ajudar?"
    });
    expect(salesResponseAIService.generateResponse).not.toHaveBeenCalled();
  });

  it.each(["Oi", "Olá", "Bom dia", "Tenho interesse"] as const)(
    "does not pause low-risk opener when contextual AI returns empty: %s",
    async (message) => {
      vi.stubEnv("OPENAI_API_KEY", "test-key");
      const { service, agentActionsService } = createChatAgent({
        salesResponseAIService: {
          generateResponse: vi.fn(async () => null)
        }
      });

      const result = await service.generateCommercialReply({
        message,
        classification: { intent: "greeting", confidence: 0.95, summary: "baixo risco", suggested_reply: "" },
        customer: { id: "customer-id" },
        conversation: { id: "conversation-id" },
        webhookEventId: "webhook-id"
      });

      expect(result.requiresHuman).not.toBe(true);
      expect(result.reply).toBe(INITIAL_UNITV_REPLY);
      expect(result.responseRule).toBe("fixed_initial_greeting");
      expect(agentActionsService.createAgentAction).not.toHaveBeenCalledWith(
        expect.objectContaining({ action_name: "handoff_to_human" })
      );
    }
  );

  it("keeps price question low-risk when contextual AI returns empty", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const { service, agentActionsService } = createChatAgent({
      salesResponseAIService: {
        generateResponse: vi.fn(async () => null)
      }
    });

    const result = await service.generateCommercialReply({
      message: "Qual valor?",
      classification: { intent: "ask_price", confidence: 0.95, summary: "valor", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.requiresHuman).not.toBe(true);
    expect(result.reply).toContain("R$ 20,90");
    expect(result.reply).toContain("Voce tem interesse pra hoje?");
    expect(result.reply).not.toContain("quantas telas");
    expect(result.reply).not.toContain("R$ 70");
    expect(result.leadProfilePatch).toMatchObject({ selected_plan: "mensal", stage: "monthly_offer_pending" });
    expect(agentActionsService.createAgentAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ action_name: "handoff_to_human" })
    );
  });

  it("continues from the previous greeting when the customer answers sim", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "sim",
      classification: { intent: "unknown", confidence: 0.2, summary: "resposta curta", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            last_bot_question: "Você já usa o aplicativo UNITV ou seria sua primeira vez?"
          }
        }
      },
      recentMessages: [
        { role: "assistant", content: "Oi, tudo bem? Você já usa o aplicativo UNITV ou seria sua primeira vez?" }
      ],
      webhookEventId: "webhook-id"
    });

    expect(result.requiresHuman).not.toBe(true);
    expect(result.reply).toContain("recarga");
    expect(result.reply).toContain("primeira ativação");
    expect(result.reply).not.toContain("Seja bem-vindo");
  });

  it("interprets first-time answers after the traffic greeting without repeating the greeting", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "Nunca primeira vez",
      classification: { intent: "unknown", confidence: 0.2, summary: "primeira vez", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            saudacao_enviada: true,
            last_bot_question: "Voce ja faz o uso do app? Ou e a primeira vez?"
          }
        }
      },
      recentMessages: [
        { role: "assistant", content: "Ola! Seja bem-vindo ao melhor aplicativo de filmes e canais. Voce ja faz o uso do app? Ou e a primeira vez?" }
      ],
      webhookEventId: "webhook-id"
    });

    expect(result.requiresHuman).not.toBe(true);
    expect(result.reply).toContain("teste gratis");
    expect(result.reply).toContain("planos");
    expect(result.reply).not.toContain("Voce ja faz o uso do app");
  });

  it("interprets a short no after first-time and test question as first-time user without restarting greeting", async () => {
    const { service } = createChatAgent();

    const lastQuestion = "Voce ja usou o UNITV? Se nao, posso liberar 3 dias gratis. Qual aparelho voce quer testar?";
    const result = await service.generateCommercialReply({
      message: "Não",
      classification: { intent: "greeting", confidence: 0.9, summary: "resposta curta", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            saudacao_enviada: true,
            commercial_stage: "first_time_check",
            stage: "first_time_check",
            last_bot_question: lastQuestion
          }
        }
      },
      recentMessages: [
        { role: "assistant", content: lastQuestion }
      ],
      webhookEventId: "webhook-id"
    });

    expect(result.requiresHuman).not.toBe(true);
    expect(result.reply).toBe("Entendi. Em qual aparelho voce quer fazer o teste gratis de 3 dias?");
    expect(result.reply).not.toContain("Oi, tudo bem?");
    expect(result.reply).not.toContain("Voce ja usa o aplicativo UNITV");
    expect(result.leadProfilePatch).toMatchObject({
      commercial_stage: "device_qualification",
      stage: "device_qualification",
      first_time_user: true,
      wants_test: true,
      last_customer_intent: "first_time_user",
      next_expected_reply: "device"
    });
  });

  it("asks for device clarification when the customer says no after a device question", async () => {
    const { service } = createChatAgent();

    const lastQuestion = "Qual aparelho voce quer testar?";
    const result = await service.generateCommercialReply({
      message: "Não",
      classification: { intent: "greeting", confidence: 0.9, summary: "resposta curta", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            commercial_stage: "device_qualification",
            stage: "device_qualification",
            wants_test: true,
            last_bot_question: lastQuestion
          }
        }
      },
      recentMessages: [
        { role: "assistant", content: lastQuestion }
      ],
      webhookEventId: "webhook-id"
    });

    expect(result.requiresHuman).not.toBe(true);
    expect(result.reply).toBe("Sem problema. Em qual aparelho voce quer fazer o teste?");
    expect(result.reply).not.toContain("Oi, tudo bem?");
    expect(result.reply).not.toContain("Voce ja usa o aplicativo UNITV");
    expect(result.leadProfilePatch).toMatchObject({
      commercial_stage: "device_qualification",
      stage: "device_qualification",
      last_customer_intent: "device_not_provided",
      next_expected_reply: "device"
    });
  });

  it("uses contextual understanding to turn 'Testes' into the trial device question", async () => {
    const { service } = createChatAgent();
    const lastQuestion = "Perfeito, entao e sua primeira vez. Voce prefere fazer o teste gratis de 3 dias primeiro ou quer ver os planos?";
    const contextualDecision = extractDeterministicDecision({
      current_message: "Testes",
      recent_messages: [],
      lead_profile: { last_customer_intent: "first_time_user", last_bot_question: lastQuestion },
      open_order: null,
      latest_order: null,
      last_bot_question: lastQuestion,
      last_bot_message_at: null,
      last_specialist_message_at: null,
      followup_key: null,
      followup_due_at: null,
      human_hold_active: false
    });

    const result = await service.generateCommercialReply({
      message: "Testes",
      classification: { intent: "unknown", confidence: 0.4, summary: "resposta curta", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            commercial_stage: "trial_selection",
            stage: "trial_selection",
            first_time_user: true,
            last_customer_intent: "first_time_user",
            last_bot_question: lastQuestion
          }
        }
      },
      recentMessages: [
        { role: "assistant", content: lastQuestion }
      ],
      contextualDecision,
      webhookEventId: "webhook-id"
    });

    expect(result.requiresHuman).not.toBe(true);
    expect(result.responseRule).toBe("contextual_understanding_free_trial");
    expect(result.reply).toContain("teste gratis de 3 dias");
    expect(result.reply).toContain("qual aparelho");
    expect(result.reply).not.toContain("Oi, tudo bem?");
    expect(result.reply).not.toContain("Voce ja usa o aplicativo UNITV");
    expect(result.leadProfilePatch).toMatchObject({
      stage: "device_qualification",
      wants_test: true,
      last_customer_intent: "free_trial_request",
      next_expected_reply: "device"
    });
  });

  it("uses one contextual AI conclusion instead of paying a second model to restyle it", async () => {
    const salesResponseAIService = { generateResponse: vi.fn(async () => "nao deveria chamar") };
    const { service } = createChatAgent({ salesResponseAIService });
    const contextualDecision = {
      ...extractDeterministicDecision({
        current_message: "quais planos voce tem?",
        recent_messages: [],
        lead_profile: { stage: "price_discovery" },
        open_order: null,
        latest_order: null,
        last_bot_question: "",
        last_bot_message_at: null,
        last_specialist_message_at: null,
        followup_key: null,
        followup_due_at: null,
        human_hold_active: false
      }),
      source: "ai" as const,
      confidence: 0.91,
      detected_intent: "PLAN_PRICE_REQUEST" as const,
      next_action: "ask_plan_preference" as const,
      recommended_response: "Posso te mostrar o mensal ou voce prefere um plano maior?"
    };

    const result = await service.generateCommercialReply({
      message: "quais planos voce tem?",
      classification: { intent: "ask_price", confidence: 0.7, summary: "preco", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id", metadata: { lead_profile: { stage: "price_discovery" } } },
      recentMessages: [],
      contextualDecision,
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toBe("Posso te mostrar o mensal ou voce prefere um plano maior?");
    expect(result.responseRule).toBe("contextual_interpreter_single_ai_reply");
    expect(salesResponseAIService.generateResponse).not.toHaveBeenCalled();
  });

  it("reuses a safe contextual recharge continuation instead of opening a second AI writer", async () => {
    const salesResponseAIService = { generateResponse: vi.fn(async () => "nao deveria chamar") };
    const { service } = createChatAgent({ salesResponseAIService });
    const contextualDecision = {
      ...extractDeterministicDecision({
        current_message: "quero continuar",
        recent_messages: [],
        lead_profile: { stage: "qualified", wants_recharge: true },
        open_order: null,
        latest_order: null,
        last_bot_question: "Quer continuar sua recarga?",
        last_bot_message_at: null,
        last_specialist_message_at: null,
        followup_key: null,
        followup_due_at: null,
        human_hold_active: false
      }),
      source: "ai" as const,
      intent: "renew" as const,
      confidence: 0.9,
      next_action: "continue_recharge_flow" as const,
      recommended_response: "Perfeito. Qual plano voce quer renovar?"
    };

    const result = await service.generateCommercialReply({
      message: "quero continuar",
      classification: { intent: "renew_plan", confidence: 0.7, summary: "recarga", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id", metadata: { lead_profile: { stage: "qualified", wants_recharge: true } } },
      recentMessages: [{ role: "assistant", content: "Quer continuar sua recarga?" }],
      contextualDecision,
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toBe("Perfeito. Qual plano voce quer renovar?");
    expect(result.responseRule).toBe("contextual_interpreter_single_ai_reply");
    expect(result.responseSource).toBe("ai");
    expect(salesResponseAIService.generateResponse).not.toHaveBeenCalled();
  });

  it("reuses a safe knowledge-grounded AI reply but never bypasses the protected payment writer", () => {
    expect(canReuseUpstreamAIReply({
      responseGeneratedByAI: true,
      intent: "unknown",
      reply: "Me conta onde voce travou para eu te orientar por aqui."
    })).toBe(true);
    expect(canReuseUpstreamAIReply({
      responseGeneratedByAI: true,
      intent: "pix_payment",
      reply: "Vou gerar o Pix para voce."
    })).toBe(false);
    expect(canReuseUpstreamAIReply({
      responseGeneratedByAI: true,
      intent: "ask_price",
      reply: "O plano custa R$ 25."
    })).toBe(false);
  });

  it("recognizes that an older customer bubble was superseded before its reply is sent", async () => {
    const messages = [
      { role: "assistant", external_message_id: "assistant-before" },
      { role: "customer", external_message_id: "customer-sim" },
      { role: "customer", external_message_id: "customer-values" }
    ];
    expect(isCustomerMessageSuperseded(messages, "customer-sim")).toBe(true);
    expect(isCustomerMessageSuperseded(messages, "customer-values")).toBe(false);

    const evolutionService = { sendTextMessage: vi.fn(async () => ({ id: "provider-id" })) };
    const auditService = { createAuditLog: vi.fn(async () => ({})) };
    const service = new WhatsappMessageService(
      {} as never,
      {} as never,
      {
        listMessagesByConversationId: vi.fn(async () => messages),
        createMessage: vi.fn()
      } as never,
      {} as never,
      {} as never,
      evolutionService as never,
      auditService as never,
      {} as never,
      {} as never,
      {} as never
    );

    const result = await (service as unknown as {
      sendAndStoreAssistantReply: (input: Record<string, unknown>) => Promise<{ status: string }>;
    }).sendAndStoreAssistantReply({
      webhookEventId: "webhook-sim",
      message: { externalMessageId: "customer-sim", phone: "5511999998888", text: "Sim" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id", metadata: { lead_profile: { stage: "plan_preference" } } },
      reply: "Perfeito. Quer que eu continue com voce?",
      classification: { intent: "unknown" }
    });

    expect(result.status).toBe("ignored");
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
    expect(auditService.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "superseded_customer_reply_suppressed",
      metadata: expect.objectContaining({ checkpoint: "before_whatsapp_send" })
    }));
  });

  it("sends the safe contextual conclusion without a second OpenAI writer call", async () => {
    vi.clearAllMocks();
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", customer_id: "customer-id", metadata: { lead_profile: { stage: "qualified" } } })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: _id, metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const messagesRepository = {
      findByExternalMessageId: vi.fn(async () => null),
      createMessage: vi.fn(async (data) => ({ id: "message-id", ...data })),
      listMessagesByConversationId: vi.fn(async () => [])
    };
    const evolutionService = { sendTextMessage: vi.fn(async () => ({ id: "provider-id" })) };
    const contextualDecision = {
      ...extractDeterministicDecision({
        current_message: "me ajuda nisso",
        recent_messages: [],
        lead_profile: { stage: "qualified" },
        open_order: null,
        latest_order: null,
        last_bot_question: "Como posso te ajudar?",
        last_bot_message_at: null,
        last_specialist_message_at: null,
        followup_key: null,
        followup_due_at: null,
        human_hold_active: false
      }),
      source: "ai" as const,
      confidence: 0.86,
      recommended_response: "Me conta onde voce travou para eu te orientar por aqui."
    };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id", phone: "5511999998888" })) } as never,
      conversationsRepository as never,
      messagesRepository as never,
      { classify: vi.fn(async () => ({ intent: "unknown", confidence: 0.2, summary: "ambiguo", suggested_reply: "" })) } as never,
      { generateCommercialReply: vi.fn(async () => ({ reply: contextualDecision.recommended_response, responseSource: "ai" })) } as never,
      evolutionService as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      { findLatestOpenOrderByCustomerId: vi.fn(async () => null), findLatestOrderByCustomerId: vi.fn(async () => null) } as never,
      {} as never,
      {} as never,
      undefined,
      {} as never,
      { safeCreateEvent: vi.fn(async () => ({})) } as never,
      undefined,
      { extract: vi.fn(async () => contextualDecision) } as never,
      undefined,
      undefined,
      { isLatestMessageInBurst: vi.fn(async () => true) } as never
    );

    const result = await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "single-ai-call-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "me ajuda nisso",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1,
        fromMe: false,
        isGroup: false
      }
    });

    expect(result).toMatchObject({ status: "processed", reply: contextualDecision.recommended_response });
    expect(contextualResponseGenerate).not.toHaveBeenCalled();
    expect(evolutionService.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("transcribes customer audio and keeps the active installation context", async () => {
    vi.clearAllMocks();
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({
        id: "conversation-id",
        customer_id: "customer-id",
        metadata: {
          lead_profile: {
            stage: "awaiting_download_installation",
            commercial_stage: "awaiting_download_installation",
            last_bot_question: "Conseguiu instalar?"
          }
        }
      })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: _id, metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const messagesRepository = {
      findByExternalMessageId: vi.fn(async () => null),
      createMessage: vi.fn(async (data) => ({ id: "message-id", ...data })),
      listMessagesByConversationId: vi.fn(async () => [])
    };
    const intentClassifier = {
      classify: vi.fn(async () => ({ intent: "technical_support", confidence: 0.98, summary: "falha ao instalar", suggested_reply: "" }))
    };
    const reply = "Entendi. O que apareceu na tela quando voce tentou instalar?";
    const chatAgent = { generateCommercialReply: vi.fn(async () => ({ reply, responseSource: "ai" })) };
    const evolutionService = { sendTextMessage: vi.fn(async () => ({ id: "provider-id" })) };
    const contextualDecision = {
      ...extractDeterministicDecision({
        current_message: "nao consegui instalar",
        recent_messages: [],
        lead_profile: { stage: "awaiting_download_installation", last_bot_question: "Conseguiu instalar?" },
        open_order: null,
        latest_order: null,
        last_bot_question: "Conseguiu instalar?",
        last_bot_message_at: null,
        last_specialist_message_at: null,
        followup_key: null,
        followup_due_at: null,
        human_hold_active: false
      }),
      source: "ai" as const,
      confidence: 0.95,
      recommended_response: reply
    };
    const audioTranscriptionService = {
      transcribeWhatsAppAudio: vi.fn(async () => ({
        text: "nao consegui instalar",
        model: "gpt-4o-mini-transcribe",
        bytes: 4_096,
        mimeType: "audio/ogg",
        truncated: false
      }))
    };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id", phone: "5511999998888", name: "Cliente" })) } as never,
      conversationsRepository as never,
      messagesRepository as never,
      intentClassifier as never,
      chatAgent as never,
      evolutionService as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      { findLatestOpenOrderByCustomerId: vi.fn(async () => null), findLatestOrderByCustomerId: vi.fn(async () => null) } as never,
      {} as never,
      {} as never,
      undefined,
      {} as never,
      { safeCreateEvent: vi.fn(async () => ({})) } as never,
      undefined,
      { extract: vi.fn(async () => contextualDecision) } as never,
      undefined,
      undefined,
      { isLatestMessageInBurst: vi.fn(async () => true) } as never,
      { generateResponse: vi.fn() } as never,
      audioTranscriptionService as never
    );

    const result = await service.processIncomingMessage({
      webhookEventId: "webhook-audio",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "audio-message-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "",
        messageType: "audioMessage",
        hasMedia: true,
        media: { mimeType: "audio/ogg; codecs=opus", url: "https://media.example.com/encrypted" },
        timestamp: 1,
        fromMe: false,
        isGroup: false
      }
    });

    expect(audioTranscriptionService.transcribeWhatsAppAudio).toHaveBeenCalledWith(expect.objectContaining({
      externalMessageId: "audio-message-id",
      conversationId: "conversation-id"
    }));
    expect(intentClassifier.classify).toHaveBeenCalledWith({ message: "nao consegui instalar", conversationId: "conversation-id" });
    expect(chatAgent.generateCommercialReply).toHaveBeenCalledWith(expect.objectContaining({ message: "nao consegui instalar" }));
    expect(messagesRepository.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: "customer",
      content: "nao consegui instalar",
      content_type: "audioMessage",
      metadata: expect.objectContaining({
        media: { mimeType: "audio/ogg; codecs=opus", fileName: null },
        audio_transcription: expect.objectContaining({ status: "completed", model: "gpt-4o-mini-transcribe" })
      })
    }));
    expect(result).toMatchObject({ status: "processed", reply });
    expect(result.status === "processed" ? result.reply : "").not.toContain("Oi, tudo bem?");
  });

  it("asks for audio resend without changing the commercial stage when transcription fails", async () => {
    vi.clearAllMocks();
    const originalMetadata = {
      response_due_at: "2026-07-14T00:00:00.000Z",
      followup_due_at: "2026-07-14T01:00:00.000Z",
      lead_profile: { stage: "awaiting_payment", commercial_stage: "awaiting_payment", payment_status: "pending" }
    };
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", customer_id: "customer-id", metadata: originalMetadata })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: _id, metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const messagesRepository = {
      findByExternalMessageId: vi.fn(async () => null),
      createMessage: vi.fn(async (data) => ({ id: "message-id", ...data }))
    };
    const intentClassifier = { classify: vi.fn() };
    const chatAgent = { generateCommercialReply: vi.fn() };
    const evolutionService = { sendTextMessage: vi.fn(async () => ({ id: "provider-id" })) };
    const audioTranscriptionService = {
      transcribeWhatsAppAudio: vi.fn(async () => {
        throw new AudioTranscriptionError("audio_no_speech", "No speech detected");
      })
    };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id" })) } as never,
      conversationsRepository as never,
      messagesRepository as never,
      intentClassifier as never,
      chatAgent as never,
      evolutionService as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      {} as never,
      { safeCreateEvent: vi.fn(async () => ({})) } as never,
      undefined,
      {} as never,
      undefined,
      undefined,
      {} as never,
      {} as never,
      audioTranscriptionService as never
    );

    const result = await service.processIncomingMessage({
      webhookEventId: "webhook-audio-failure",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "silent-audio-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "",
        messageType: "audioMessage",
        hasMedia: true,
        media: { mimeType: "audio/ogg", url: "https://media.example.com/encrypted" },
        timestamp: 1,
        fromMe: false,
        isGroup: false
      }
    });

    expect(intentClassifier.classify).not.toHaveBeenCalled();
    expect(chatAgent.generateCommercialReply).not.toHaveBeenCalled();
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Pode enviar novamente")
    }));
    expect(messagesRepository.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: "customer",
      content: null,
      metadata: expect.objectContaining({
        media: { mimeType: "audio/ogg", fileName: null },
        audio_transcription: { status: "failed", error_code: "audio_no_speech" }
      })
    }));
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        followup_due_at: null,
        response_due_at: null,
        lead_profile: expect.objectContaining({ stage: "awaiting_payment", payment_status: "pending" })
      })
    );
    expect(result).toMatchObject({ status: "processed" });
    expect(result.status === "processed" ? result.reply : "").not.toContain("Oi, tudo bem?");
  });

  it("asks Android confirmation when the contextual answer is only celular", async () => {
    const { service } = createChatAgent();
    const lastQuestion = "Me fala so qual aparelho voce vai usar: celular Android, TV Box, Android TV/Google TV ou Fire Stick?";
    const contextualDecision = extractDeterministicDecision({
      current_message: "celular",
      recent_messages: [],
      lead_profile: { wants_test: true, last_bot_question: lastQuestion },
      open_order: null,
      latest_order: null,
      last_bot_question: lastQuestion,
      last_bot_message_at: null,
      last_specialist_message_at: null,
      followup_key: null,
      followup_due_at: null,
      human_hold_active: false
    });

    const result = await service.generateCommercialReply({
      message: "celular",
      classification: { intent: "unknown", confidence: 0.4, summary: "aparelho curto", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            stage: "device_qualification",
            wants_test: true,
            last_bot_question: lastQuestion
          }
        }
      },
      recentMessages: [
        { role: "assistant", content: lastQuestion }
      ],
      contextualDecision,
      webhookEventId: "webhook-id"
    });

    expect(result.requiresHuman).not.toBe(true);
    expect(result.responseRule).toBe("contextual_understanding_confirm_android_phone");
    expect(result.reply).toBe("So me confirma: esse celular e Android?");
    expect(result.reply).not.toContain("Oi, tudo bem?");
    expect(result.leadProfilePatch).toMatchObject({
      stage: "device_qualification",
      last_customer_intent: "device_android_phone_needs_confirmation",
      next_expected_reply: "device"
    });
  });

  it("keeps download context when customer says no after download follow-up", async () => {
    const { service } = createChatAgent();
    const lastQuestion = "Voce conseguiu baixar?";
    const contextualDecision = extractDeterministicDecision({
      current_message: "nao",
      recent_messages: [],
      lead_profile: { stage: "awaiting_download_installation", install_status: "link_sent" },
      open_order: null,
      latest_order: null,
      last_bot_question: lastQuestion,
      last_bot_message_at: null,
      last_specialist_message_at: null,
      followup_key: "post_download_check_10min",
      followup_due_at: null,
      human_hold_active: false
    });

    const result = await service.generateCommercialReply({
      message: "nao",
      classification: { intent: "unknown", confidence: 0.4, summary: "nao baixou", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            stage: "awaiting_download_installation",
            install_status: "link_sent",
            last_bot_question: lastQuestion
          }
        }
      },
      recentMessages: [
        { role: "assistant", content: lastQuestion }
      ],
      contextualDecision,
      webhookEventId: "webhook-id"
    });

    expect(result.requiresHuman).not.toBe(true);
    expect(result.responseRule).toBe("contextual_understanding_download_help");
    expect(result.reply).toBe("Tudo bem, me fala onde travou: no link, no Downloader ou na instalacao?");
    expect(result.reply).not.toContain("Oi, tudo bem?");
    expect(result.leadProfilePatch).toMatchObject({
      stage: "download_support",
      install_status: "failed",
      last_customer_intent: "download_issue"
    });
  });

  it("clarifies a question mark after first-time qualification instead of restarting the greeting", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "?",
      classification: { intent: "unknown", confidence: 0.2, summary: "duvida curta", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            last_customer_intent: "first_time_user",
            next_expected_reply: "test_or_plan_choice",
            last_bot_question: "Perfeito, entao e sua primeira vez. Voce prefere fazer o teste gratis de 3 dias primeiro ou quer ver os planos?"
          }
        }
      },
      recentMessages: [
        { role: "assistant", content: "Perfeito, entao e sua primeira vez. Voce prefere fazer o teste gratis de 3 dias primeiro ou quer ver os planos?" }
      ],
      webhookEventId: "webhook-id"
    });

    expect(result.requiresHuman).not.toBe(true);
    expect(result.reply).toContain("comecar pelo teste");
    expect(result.reply).not.toContain("Voce ja faz o uso do app");
  });

  it("keeps pre-sale recharge context when the customer says they will do it later", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "Mais tarde eu faco",
      classification: { intent: "unknown", confidence: 0.8, summary: "vai fazer depois", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            selected_plan: "mensal",
            asked_price: true,
            requested_screens: 2
          }
        }
      },
      recentMessages: [
        { role: "customer", content: "Valor de 30 dias" },
        { role: "assistant", content: "O mensal esta saindo a R$ 25." },
        { role: "customer", content: "E duas telas" }
      ],
      webhookEventId: "webhook-id"
    });

    expect(result.requiresHuman).not.toBe(true);
    expect(result.reply).toContain("Vou deixar anotado");
    expect(result.reply).toContain("chave Pix");
    expect(result.reply).not.toContain("Voce ja faz o uso do app");
    expect(result.leadProfilePatch).toMatchObject({
      stage: "pre_sale_recharge_intent",
      payment_intent_status: "later",
      last_customer_intent: "wants_to_recharge_later"
    });
  });

  it("answers an ad recharge lead as Andre without sending a menu", async () => {
    const { service, ordersService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "Olá! Quero fazer Recarga Código UNITV",
      classification: { intent: "renew_plan", confidence: 0.99, summary: "recarga", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).not.toHaveBeenCalled();
    expect(result.reply).toBe(INITIAL_UNITV_REPLY);
    expect(result.reply).not.toContain("renovação de qual plano");
    expect(result.reply).not.toContain("R$ 25");
    expect(result.reply).not.toContain("R$ 70");
    expect(result.menu).toBeUndefined();
    expect(result.reply).not.toContain("Ver planos");
    expect(result.reply).not.toContain("Fazer teste grátis");
    expect(result.reply).not.toContain("Comprar agora");
  });

  it("answers short 'oferece?' as free-trial context without human handoff", async () => {
    const { service, agentActionsService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "Oferece ?",
      classification: { intent: "free_trial", confidence: 0.95, summary: "pergunta se oferece teste", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            wants_test: true,
            last_customer_answer: "Teste"
          }
        }
      },
      recentMessages: [
        { role: "customer", content: "Teste" },
        { role: "assistant", content: "Claro. O teste gratis e de 3 dias." }
      ],
      webhookEventId: "webhook-id"
    });

    expect(result.requiresHuman).not.toBe(true);
    expect(result.reply).toContain("teste");
    expect(result.reply).toContain("3 dias");
    expect(agentActionsService.createAgentAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ action_name: "handoff_to_human" })
    );
  });

  it("does not hand off when low confidence happens while waiting for the device answer", async () => {
    const { service, agentActionsService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "?",
      classification: { intent: "unknown", confidence: 0.2, summary: "mensagem curta", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            wants_test: true,
            stage: "device_qualification",
            next_expected_reply: "device",
            last_bot_question: "Voce vai usar em TV Box Android, Android TV, Fire Stick ou celular Android?"
          }
        }
      },
      recentMessages: [
        { role: "assistant", content: "Voce vai usar em TV Box Android, Android TV, Fire Stick ou celular Android?" }
      ],
      webhookEventId: "webhook-id"
    });

    expect(result.requiresHuman).not.toBe(true);
    expect(result.responseRule).toBe("blocked_low_risk_handoff_awaiting_customer");
    expect(result.reply).toContain("aparelho");
    expect(result.leadProfilePatch).toMatchObject({
      stage: "device_qualification",
      state: "awaiting_customer_response"
    });
    expect(agentActionsService.createAgentAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ action_name: "handoff_to_human" })
    );
  });

  it("sends Android download when the customer answers the expected device question", async () => {
    const { service, agentActionsService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "Celular Android",
      classification: { intent: "unknown", confidence: 0.2, summary: "aparelho", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            wants_test: true,
            stage: "device_qualification",
            next_expected_reply: "device",
            last_bot_question: "Voce vai usar em TV Box Android, Android TV, Fire Stick ou celular Android?"
          }
        }
      },
      recentMessages: [
        { role: "assistant", content: "Voce vai usar em TV Box Android, Android TV, Fire Stick ou celular Android?" }
      ],
      webhookEventId: "webhook-id"
    });

    expect(result.requiresHuman).not.toBe(true);
    expect(result.responseRule).toBe("expected_device_answer");
    expect(result.reply).toContain("UniTV_mobile_3.21.6.apk");
    expect(result.reply).toContain("Tutorial:");
    expect(result.leadProfilePatch).toMatchObject({
      device: "android_phone",
      stage: "download_instructions",
      next_expected_reply: "download_confirmation"
    });
    expect(agentActionsService.createAgentAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ action_name: "handoff_to_human" })
    );
  });

  it("recovers low-confidence 'oferece?' in a free-trial flow without human handoff", async () => {
    const { service, agentActionsService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "Oferece?",
      classification: { intent: "unknown", confidence: 0.2, summary: "mensagem curta", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            wants_test: true,
            stage: "device_qualification",
            next_expected_reply: "device",
            last_bot_question: "Voce vai usar em TV Box Android, Android TV, Fire Stick ou celular Android?"
          }
        }
      },
      recentMessages: [
        { role: "customer", content: "Teste" },
        { role: "assistant", content: "Voce vai usar em TV Box Android, Android TV, Fire Stick ou celular Android?" }
      ],
      webhookEventId: "webhook-id"
    });

    expect(result.requiresHuman).not.toBe(true);
    expect(result.responseRule).toBe("blocked_low_risk_handoff_awaiting_customer");
    expect(result.reply).toContain("teste");
    expect(result.reply).toContain("3 dias");
    expect(agentActionsService.createAgentAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ action_name: "handoff_to_human" })
    );
  });

  it("keeps download context when customer confirms it is Android after the link was sent", async () => {
    const { service, agentActionsService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "É Android",
      classification: { intent: "greeting", confidence: 0.9, summary: "confirmacao", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            wants_test: true,
            device: "android_phone",
            stage: "download_instructions",
            download_status: "link_sent",
            install_status: "link_sent",
            last_download_url_sent: "https://www.mediafire.com/file_premium/e2jc97dcqr80tjw/UniTV_mobile_3.21.6.apk/file",
            last_bot_question: "Seu celular é Android?"
          }
        }
      },
      recentMessages: [
        { role: "assistant", content: "No celular Android funciona sim.\n\nBaixe por aqui:\n\nhttps://www.mediafire.com/file_premium/e2jc97dcqr80tjw/UniTV_mobile_3.21.6.apk/file\n\nTutorial:\nhttps://www.youtube.com/watch?v=LBBAbs2-I0c\n\nSeu celular é Android?" }
      ],
      webhookEventId: "webhook-id"
    });

    expect(result.requiresHuman).not.toBe(true);
    expect(result.responseRule).toBe("active_download_flow");
    expect(result.reply).toContain("esse link e o correto");
    expect(result.reply).toContain("quando terminar de instalar");
    expect(result.reply).not.toContain("Você já usa");
    expect(result.reply).not.toContain("seria sua primeira vez");
    expect(result.leadProfilePatch).toMatchObject({
      stage: "awaiting_download_installation",
      next_expected_reply: "install_confirmation"
    });
    expect(agentActionsService.createAgentAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ action_name: "handoff_to_human" })
    );
  });

  it("continues installation flow when customer says they downloaded the app", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "Baixei",
      classification: { intent: "unknown", confidence: 0.2, summary: "baixou", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            stage: "download_instructions",
            download_status: "link_sent",
            last_download_url_sent: "https://www.mediafire.com/file_premium/e2jc97dcqr80tjw/UniTV_mobile_3.21.6.apk/file"
          }
        }
      },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("Agora abre o aplicativo");
    expect(result.reply).toContain("tela de login/cadastro");
    expect(result.reply).not.toContain("Você já usa");
    expect(result.leadProfilePatch).toMatchObject({
      downloaded_app: true,
      download_status: "downloaded"
    });
  });

  it("asks what failed when customer cannot download after the link was sent", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "Não consegui baixar",
      classification: { intent: "unknown", confidence: 0.2, summary: "erro download", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            stage: "download_instructions",
            download_status: "link_sent",
            last_download_url_sent: "https://www.mediafire.com/file_premium/e2jc97dcqr80tjw/UniTV_mobile_3.21.6.apk/file"
          }
        }
      },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("deu erro no link");
    expect(result.reply).toContain("celular bloqueou");
    expect(result.reply).not.toContain("Você já usa");
    expect(result.leadProfilePatch).toMatchObject({
      download_status: "failed"
    });
  });

  it("answers payment question without a selectable menu", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "como posso pagar?",
      classification: { intent: "ask_payment", confidence: 0.99, summary: "pagamento", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("Pix ou cartão");
    expect(result.menu).toBeUndefined();
    expect(result.sendTextBeforeMenu).toBe(false);
  });

  it("stores plan preference when the requested plan is clear", async () => {
    const { service, ordersService, appSettingsService, mercadoPagoService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "quero comprar o plano mensal",
      classification: { intent: "buy_plan", confidence: 0.95, summary: "compra", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444" },
      conversation: { id: "55555555-5555-4555-8555-555555555555" },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).not.toHaveBeenCalled();
    expect(result.reply).toContain("mensal");
    expect(result.reply).toContain("R$");
    expect(mercadoPagoService.createOrderPreference).not.toHaveBeenCalled();
    expect(ordersService.updateOrder).not.toHaveBeenCalled();
    expect(appSettingsService.getPixInstructions).not.toHaveBeenCalled();
    expect(result.reply).not.toContain("https://www.mercadopago.com.br/checkout/dynamic-order-link");
    expect(result.reply).not.toContain("Cartao:");
    expect(result.reply).not.toContain("Para gerar o Pix Copia e Cola");
    expect(result.reply).toContain("Voce tem interesse pra hoje?");
    expect(result.reply).not.toContain("Quer que eu gere o Pix");
    expect(result.menu).toBeUndefined();
    expect(result.reply.toLowerCase()).not.toContain("codigo de ativacao");
  });

  it("does not create payment artifacts while only storing plan preference", async () => {
    const { service, ordersService, mercadoPagoService, agentActionsService } = createChatAgent();
    mercadoPagoService.createOrderPreference.mockRejectedValueOnce(new Error("Mercado Pago unavailable"));

    const result = await service.generateCommercialReply({
      message: "quero comprar o plano mensal",
      classification: { intent: "buy_plan", confidence: 0.95, summary: "compra", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444" },
      conversation: { id: "55555555-5555-4555-8555-555555555555" },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).not.toHaveBeenCalled();
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

  it("responds with only the six-month official amount after plan selection", async () => {
    const { service, ordersService, plansService } = createChatAgent();
    plansService.findPlanMentionedInText.mockResolvedValueOnce({
      plan: { ...plan, id: "semestral-id", name: "6 meses", slug: "semestral", duration_days: 180, price_cents: 12000 },
      plans: []
    });

    const result = await service.generateCommercialReply({
      message: "quero o de 6 meses",
      classification: { intent: "buy_plan", confidence: 0.99, summary: "semestral", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444" },
      conversation: { id: "55555555-5555-4555-8555-555555555555" },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).not.toHaveBeenCalled();
    expect(result.reply).toContain("semestral");
    expect(result.reply).toContain("R$");
    expect(result.reply).not.toContain("R$ 25");
    expect(result.reply).not.toContain("R$ 70");
    expect(result.reply).not.toContain("R$ 200");
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
    expect(result.reply).toContain("em qual aparelho você vai usar");
    expect(result.menu).toBeUndefined();
    expect(result.sendTextBeforeMenu).toBeUndefined();
    expect(agentActionsService.createAgentAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ action_name: "handoff_to_human" })
    );
  });

  it("does not silently hand off clear free trial requests when contextual AI has no safe reply", async () => {
    const { service, ordersService, agentActionsService, salesResponseAIService } = createChatAgent({
      salesResponseAIService: {
        generateResponse: vi.fn(async () => null)
      }
    });

    const result = await service.generateCommercialReply({
      message: "Olá! Quero fazer teste tem como",
      classification: { intent: "free_trial", confidence: 0.95, summary: "Cliente pediu teste grátis.", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444" },
      conversation: { id: "55555555-5555-4555-8555-555555555555" },
      webhookEventId: "webhook-id"
    });

    expect(salesResponseAIService.generateResponse).toHaveBeenCalled();
    expect(ordersService.createOrder).not.toHaveBeenCalled();
    expect(result.requiresHuman).not.toBe(true);
    expect(result.reply).toContain("3 dias");
    expect(result.reply).toMatch(/aparelho/i);
    expect(agentActionsService.createAgentAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ action_name: "handoff_to_human" })
    );
  });

  it("does not ask device again when free trial is requested during active Downloader support", async () => {
    const contextualAiReply = "Tem sim, o teste gratis dura 3 dias. Como voce ja esta pelo Downloader, abre o app e me avisa quando chegar na tela de login.";
    const { service, ordersService } = createChatAgent({
      salesResponseAIService: {
        generateResponse: vi.fn(async () => contextualAiReply)
      }
    });

    const result = await service.generateCommercialReply({
      message: "Sim mas nao tem teste nao",
      classification: { intent: "free_trial", confidence: 0.99, summary: "teste durante instalacao", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444" },
      conversation: { id: "55555555-5555-4555-8555-555555555555" },
      webhookEventId: "webhook-id",
      recentMessages: [
        { role: "customer", content: "Pelo Downloader" },
        { role: "human_agent", content: "Vou lhe mandar o codigo certo" },
        { role: "human_agent", content: "862585" },
        { role: "human_agent", content: "se esse da certo" },
        { role: "assistant", content: "Conseguiu abrir o app e chegar na tela de login?" }
      ]
    });

    expect(ordersService.createOrder).not.toHaveBeenCalled();
    expect(result.reply).toBe(contextualAiReply);
    expect(result.reply).toMatch(/Downloader|codigo|login|app/i);
    expect(result.reply).not.toContain("em qual aparelho");
    expect(result.reply).not.toContain("TV Box Android, Android TV, Fire Stick ou celular Android");
    expect(result.reply).not.toBe(
      "Tem sim, o teste gratis e de 3 dias.\n\n" +
      "Como voce ja esta pelo Downloader, abre o app e chega na tela de login. " +
      "Quando aparecer essa tela, eu libero o teste por aqui."
    );
    expect(result.responseRule).toMatch(/sales_response_ai_contextual_first|sales_response_ai_install_trial_context/);
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
    expect(result.reply).toBe("PAGUE COM CARTÃO AQUI ABAIXO\nhttps://www.mercadopago.com.br/checkout/dynamic-order-link");
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
    expect(result.reply).toBe("PAGUE COM CARTÃO AQUI ABAIXO\nhttps://www.mercadopago.com.br/checkout/dynamic-order-link");
  });

  it("creates the selected monthly order from conversation context before generating card link", async () => {
    const { service, ordersService, mercadoPagoService } = createChatAgent();
    ordersService.findLatestOpenOrderByCustomerId.mockResolvedValueOnce(null);
    ordersService.createOrder.mockResolvedValueOnce({
      id: "33333333-3333-4333-8333-333333333333",
      order_number: "UTV-20260704-000012",
      customer_id: "44444444-4444-4444-8444-444444444444",
      product_id: plan.product_id,
      plan_id: plan.id,
      amount_cents: 2500,
      currency: "BRL",
      status: "pending_payment",
      metadata: { source: "whatsapp_agent", created_from_context: true }
    });

    const result = await service.generateCommercialReply({
      message: "cartao",
      classification: { intent: "card_payment", confidence: 0.99, summary: "cartao", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444" },
      conversation: {
        id: "55555555-5555-4555-8555-555555555555",
        metadata: {
          lead_profile: {
            selected_plan: "mensal",
            plano_interesse: "mensal",
            last_bot_question: "Perfeito, o plano mensal fica R$ 25. Voce prefere pagar por Pix ou cartao?"
          }
        }
      },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        customer_id: "44444444-4444-4444-8444-444444444444",
        product_id: plan.product_id,
        plan_id: plan.id,
        status: "pending_payment",
        amount_cents: 2500,
        metadata: expect.objectContaining({
          created_from_context: true,
          selected_plan_from_lead_profile: "mensal",
          payment_method_requested: "card"
        })
      })
    );
    expect(mercadoPagoService.createOrderPreference).toHaveBeenCalledWith({
      order: expect.objectContaining({
        order_number: "UTV-20260704-000012",
        plan_id: plan.id,
        amount_cents: 2500
      }),
      plan: { name: plan.name, slug: plan.slug }
    });
    expect(result.reply).toContain("https://www.mercadopago.com.br/checkout/dynamic-order-link");
    expect(result.leadProfilePatch).toMatchObject({
      stage: "awaiting_payment",
      payment_method: "card",
      payment_status: "pending"
    });
  });

  it("creates a promo monthly order before generating a card link when the promo was accepted", async () => {
    const { service, ordersService, mercadoPagoService } = createChatAgent();
    ordersService.findLatestOpenOrderByCustomerId.mockResolvedValueOnce(null);
    ordersService.createOrder.mockResolvedValueOnce({
      id: "33333333-3333-4333-8333-333333333333",
      order_number: "UTV-20260704-000013",
      customer_id: "44444444-4444-4444-8444-444444444444",
      product_id: plan.product_id,
      plan_id: plan.id,
      amount_cents: 1999,
      currency: "BRL",
      status: "pending_payment",
      metadata: { source: "whatsapp_agent", created_from_context: true, special_promo_offer: "mensal_19_99_first_2_months" }
    });

    const result = await service.generateCommercialReply({
      message: "mensal cartao promocao",
      classification: { intent: "card_payment", confidence: 1, summary: "comando manual", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444" },
      conversation: {
        id: "55555555-5555-4555-8555-555555555555",
        metadata: {
          lead_profile: {
            selected_plan: "mensal",
            accepted_special_promo: true,
            special_promo_offer: "mensal_19_99_first_2_months",
            special_promo_price_cents: 1999
          }
        }
      },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        amount_cents: 1999,
        metadata: expect.objectContaining({
          special_promo_offer: "mensal_19_99_first_2_months",
          special_promo_price_cents: 1999,
          original_price_cents: 2500
        })
      })
    );
    expect(mercadoPagoService.createOrderPreference).toHaveBeenCalledWith({
      order: expect.objectContaining({
        order_number: "UTV-20260704-000013",
        amount_cents: 1999
      }),
      plan: { name: plan.name, slug: plan.slug }
    });
    expect(result.reply).toContain("https://www.mercadopago.com.br/checkout/dynamic-order-link");
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
    expect(result.reply.toLowerCase()).toContain("ainda não consta pagamento aprovado");
    expect(result.reply).toContain("UTV-20260704-000008");
    expect(result.reply).toContain("webhook");
    expect(result.reply).not.toContain("PAGUE COM CARTÃO");
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

  it("does not release codes from plain paid text before webhook confirmation", async () => {
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
    ordersService.findLatestOrderByCustomerId.mockResolvedValueOnce(pendingOrder);

    const result = await service.generateCommercialReply({
      message: "ja paguei",
      classification: { intent: "unknown", confidence: 0.99, summary: "pagou", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(mercadoPagoService.getPayment).not.toHaveBeenCalled();
    expect(ordersService.transitionToPaid).not.toHaveBeenCalled();
    expect(activationCodesService.findAvailableCodes).not.toHaveBeenCalled();
    expect(activationCodesService.reserveCode).not.toHaveBeenCalled();
    expect(activationCodesService.markCodeAsSent).not.toHaveBeenCalled();
    expect(result.reply).toContain("Ainda não consta pagamento aprovado");
    expect(result.reply).toContain("confirmação automática do Mercado Pago");
    expect(result.reply).not.toContain("Agradecemos pela sua compra");
    expect(result.reply).not.toContain("UNITV-RECARGA-001");
    expect(result.followUpMessages).toBeUndefined();
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

    expect(result.reply).toContain("Pix Copia e Cola");
    expect(result.reply).toContain("000201-pix-copy-paste");
    expect(result.reply).not.toContain("67070222000151");
    expect(result.copyText).toBe("000201-pix-copy-paste");
    expect(result.reply).not.toContain("mercadopago.com.br/payments");
    expect(result.reply).not.toContain("e-mail");
    expect(mercadoPagoService.createPixPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        payer: { email: "pix-utv-20260704-000001@unitv.com.br" }
      })
    );
  });

  it("creates the selected monthly order from conversation context before generating Pix", async () => {
    const { service, ordersService, mercadoPagoService } = createChatAgent();
    ordersService.findLatestOpenOrderByCustomerId.mockResolvedValueOnce(null);
    ordersService.createOrder.mockResolvedValueOnce({
      id: "33333333-3333-4333-8333-333333333333",
      order_number: "UTV-20260704-000011",
      customer_id: "44444444-4444-4444-8444-444444444444",
      product_id: plan.product_id,
      plan_id: plan.id,
      amount_cents: 2500,
      currency: "BRL",
      status: "pending_payment",
      metadata: { source: "whatsapp_agent", created_from_context: true },
      plans: { name: plan.name, slug: plan.slug }
    });

    const result = await service.generateCommercialReply({
      message: "Pix",
      classification: { intent: "pix_payment", confidence: 0.99, summary: "pix", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444", email: null },
      conversation: {
        id: "55555555-5555-4555-8555-555555555555",
        metadata: {
          lead_profile: {
            wants_activation: true,
            selected_plan: "mensal",
            plano_interesse: "mensal",
            last_bot_question: "Perfeito, o plano mensal fica R$ 25 e a ativação é rápida. Você prefere pagar por Pix ou cartão?"
          }
        }
      },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        customer_id: "44444444-4444-4444-8444-444444444444",
        product_id: plan.product_id,
        plan_id: plan.id,
        status: "pending_payment",
        amount_cents: 2500,
        metadata: expect.objectContaining({
          created_from_context: true,
          selected_plan_from_lead_profile: "mensal"
        })
      })
    );
    expect(mercadoPagoService.createPixPayment).toHaveBeenCalledWith({
      order: expect.objectContaining({
        order_number: "UTV-20260704-000011",
        plan_id: plan.id,
        amount_cents: 2500
      }),
      plan: { name: plan.name, slug: plan.slug },
      payer: { email: "pix-utv-20260704-000011@unitv.com.br" }
    });
    expect(result.reply).toContain("PIX do pedido UTV-20260704-000011");
    expect(result.copyText).toBe("000201-pix-copy-paste");
  });

  it("creates an exact specialist Pix charge for a selected plan", async () => {
    const { service, ordersService, mercadoPagoService } = createChatAgent();
    ordersService.createOrder.mockResolvedValueOnce({
      id: "33333333-3333-4333-8333-333333333333",
      order_number: "UTV-20260704-000020",
      customer_id: "44444444-4444-4444-8444-444444444444",
      product_id: plan.product_id,
      plan_id: plan.id,
      amount_cents: 2090,
      currency: "BRL",
      status: "pending_payment",
      metadata: { manual_payment_command: true },
      plans: { name: plan.name, slug: plan.slug }
    });

    const result = await service.generateCommercialReply({
      message: "mensal pix",
      classification: { intent: "pix_payment", confidence: 1, summary: "manual pix", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444", email: null },
      conversation: {
        id: "55555555-5555-4555-8555-555555555555",
        metadata: {
          lead_profile: {
            selected_plan: "mensal",
            plano_interesse: "mensal",
            payment_method: "pix",
            manual_payment_command: true,
            manual_payment_amount_cents: 2090,
            manual_payment_requires_human_review: false,
            manual_payment_command_message_id: "manual-pix-20-90"
          }
        }
      },
      webhookEventId: "webhook-id",
      deferResponseWritingToContextualAI: true
    });

    expect(ordersService.findLatestOpenOrderByCustomerId).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444");
    expect(ordersService.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      amount_cents: 2090,
      metadata: expect.objectContaining({
        source: "whatsapp_specialist_manual_pix",
        manual_payment_command: true,
        manual_payment_requires_human_review: false
      })
    }));
    expect(mercadoPagoService.createPixPayment).toHaveBeenCalledWith(expect.objectContaining({
      order: expect.objectContaining({ amount_cents: 2090 }),
      description: "UNITV - cobranca manual do especialista"
    }));
    expect(result.reply).toMatch(/20,90/);
    expect(result.copyText).toBe("000201-pix-copy-paste");
  });

  it("reuses an unexpired manual Pix of the same exact amount instead of creating another charge", async () => {
    const { service, ordersService, mercadoPagoService } = createChatAgent();
    ordersService.findLatestOpenOrderByCustomerId.mockResolvedValueOnce({
      id: "33333333-3333-4333-8333-333333333333",
      order_number: "UTV-20260713-000016",
      customer_id: "44444444-4444-4444-8444-444444444444",
      plan_id: plan.id,
      amount_cents: 2000,
      currency: "BRL",
      status: "pending_payment",
      metadata: {
        source: "whatsapp_specialist_manual_pix",
        mercado_pago_pix_qr_code: "existing-manual-pix-copy-paste",
        mercado_pago_pix_expires_at: "2099-07-14T23:22:03.000Z"
      },
      plans: { name: plan.name, slug: plan.slug }
    });

    const result = await service.generateCommercialReply({
      message: "manual pix",
      classification: { intent: "pix_payment", confidence: 1, summary: "manual pix", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444", email: null },
      conversation: {
        id: "55555555-5555-4555-8555-555555555555",
        metadata: {
          lead_profile: {
            payment_method: "pix",
            manual_payment_command: true,
            manual_payment_amount_cents: 2000,
            manual_payment_command_message_id: "manual-pix-retry"
          }
        }
      },
      webhookEventId: "webhook-retry"
    });

    expect(ordersService.createOrder).not.toHaveBeenCalled();
    expect(mercadoPagoService.createPixPayment).not.toHaveBeenCalled();
    expect(result.copyText).toBe("existing-manual-pix-copy-paste");
    expect(result.reply).toMatch(/R\$\s*20,00/);
  });

  it("returns a visible safe failure for a manual Pix without creating a pointless handoff", async () => {
    const { service, ordersService, mercadoPagoService, agentActionsService, auditService } = createChatAgent();
    mercadoPagoService.createPixPayment.mockRejectedValueOnce(new Error("provider unavailable"));
    ordersService.createOrder.mockResolvedValueOnce({
      id: "33333333-3333-4333-8333-333333333333",
      order_number: "UTV-20260713-000018",
      customer_id: "44444444-4444-4444-8444-444444444444",
      product_id: plan.product_id,
      plan_id: plan.id,
      amount_cents: 2090,
      currency: "BRL",
      status: "pending_payment",
      metadata: { source: "whatsapp_specialist_manual_pix" },
      plans: { name: plan.name, slug: plan.slug }
    });

    const result = await service.generateCommercialReply({
      message: "mensal pix",
      classification: { intent: "pix_payment", confidence: 1, summary: "manual pix", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444", email: null },
      conversation: {
        id: "55555555-5555-4555-8555-555555555555",
        metadata: {
          lead_profile: {
            selected_plan: "mensal",
            payment_method: "pix",
            manual_payment_command: true,
            manual_payment_amount_cents: 2090
          }
        }
      },
      webhookEventId: "webhook-provider-failure"
    });

    expect(result.reply).toMatch(/Nao consegui gerar o Pix de R\$\s*20,90/);
    expect(result.reply).toContain("Nenhuma confirmacao de pagamento foi feita");
    expect(result.leadProfilePatch).toMatchObject({ payment_status: "generation_failed", next_expected_reply: "retry_pix" });
    expect(agentActionsService.createAgentAction).not.toHaveBeenCalled();
    expect(auditService.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "mercado_pago_pix_creation_failed" }));
  });

  it("does not create an order when Pix is requested without a selected plan", async () => {
    const { service, ordersService, mercadoPagoService } = createChatAgent();
    ordersService.findLatestOpenOrderByCustomerId.mockResolvedValueOnce(null);

    const result = await service.generateCommercialReply({
      message: "Pix",
      classification: { intent: "pix_payment", confidence: 0.99, summary: "pix", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444", email: null },
      conversation: { id: "55555555-5555-4555-8555-555555555555", metadata: { lead_profile: {} } },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).not.toHaveBeenCalled();
    expect(mercadoPagoService.createPixPayment).not.toHaveBeenCalled();
    expect(result.reply).toBe("Perfeito. Qual plano você quer ativar: mensal, trimestral ou anual?");
    expect(result.leadProfilePatch).toMatchObject({
      payment_method: "pix",
      next_expected_reply: "plan_choice"
    });
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
    expect(result.reply).toContain("Pix Copia e Cola");
    expect(result.reply).toContain("000201-pix-copy-paste");
    expect(result.reply).not.toContain("67070222000151");
    expect(result.copyText).toBe("000201-pix-copy-paste");
    expect(result.reply).not.toContain("mercadopago.com.br/payments");
    expect(result.reply).toContain("confirmação é automática");
    expect(result.media).toEqual(
      expect.objectContaining({
        base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
        mimetype: "image/png"
      })
    );
  });

  it("applies the special recovery promotion when the customer accepts it and asks for Pix", async () => {
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
    const promoOrder = {
      ...order,
      amount_cents: 1999,
      metadata: {
        ...order.metadata,
        special_promo_offer: "mensal_19_99_first_2_months",
        special_promo_price_cents: 1999,
        original_price_cents: 2500
      }
    };
    ordersService.findLatestOpenOrderByCustomerId.mockResolvedValueOnce(order);
    ordersService.updateOrder.mockResolvedValueOnce(promoOrder).mockResolvedValueOnce(promoOrder);

    const result = await service.generateCommercialReply({
      message: "mensal pix promocao",
      classification: { intent: "pix_payment", confidence: 1, summary: "promo aceita", suggested_reply: "" },
      customer: { id: order.customer_id, email: null },
      conversation: {
        id: "55555555-5555-4555-8555-555555555555",
        metadata: {
          lead_profile: {
            special_promo_followup_sent: true,
            accepted_special_promo: true,
            special_promo_offer: "mensal_19_99_first_2_months",
            selected_plan: "mensal",
            nivel_interesse: "muito_quente"
          }
        }
      },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.updateOrder).toHaveBeenNthCalledWith(
      1,
      order.id,
      expect.objectContaining({
        amount_cents: 1999,
        metadata: expect.objectContaining({
          special_promo_offer: "mensal_19_99_first_2_months",
          special_promo_price_cents: 1999
        })
      })
    );
    expect(mercadoPagoService.createPixPayment).toHaveBeenCalledWith({
      order: expect.objectContaining({ id: order.id, order_number: order.order_number, amount_cents: 1999 }),
      plan: { name: plan.name, slug: plan.slug },
      payer: { email: "pix-utv-20260704-000001@unitv.com.br" }
    });
    expect(result.reply).toContain("Perfeito");
    expect(result.reply).toContain("R$ 19,99");
    expect(result.reply).toContain("Pix Copia e Cola");
    expect(result.reply).toContain("000201-pix-copy-paste");
    expect(result.reply).not.toContain("67070222000151");
    expect(result.copyText).toBe("000201-pix-copy-paste");
  });

  it("creates a Mercado Pago Pix copy-paste when a promo lead asks for Pix without an open order", async () => {
    const { service, ordersService, mercadoPagoService } = createChatAgent();
    ordersService.findLatestOpenOrderByCustomerId.mockResolvedValueOnce(null);
    ordersService.createOrder.mockResolvedValueOnce({
      id: "33333333-3333-4333-8333-333333333333",
      order_number: "UTV-20260708-000019",
      customer_id: "44444444-4444-4444-8444-444444444444",
      plan_id: plan.id,
      amount_cents: 1999,
      currency: "BRL",
      metadata: {
        source: "whatsapp_agent",
        special_promo_offer: "mensal_19_99_first_2_months",
        special_promo_price_cents: 1999
      },
      plans: { name: plan.name, slug: plan.slug }
    });

    const result = await service.generateCommercialReply({
      message: "Pix",
      classification: { intent: "pix_payment", confidence: 1, summary: "pix", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444", email: null },
      conversation: {
        id: "55555555-5555-4555-8555-555555555555",
        metadata: {
          lead_profile: {
            accepted_special_promo: true,
            special_promo_offer: "mensal_19_99_first_2_months",
            selected_plan: "mensal",
            plano_interesse: "mensal",
            payment_method: "pix"
          }
        }
      },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        amount_cents: 1999,
        metadata: expect.objectContaining({
          special_promo_offer: "mensal_19_99_first_2_months",
          special_promo_price_cents: 1999
        })
      })
    );
    expect(mercadoPagoService.createPixPayment).toHaveBeenCalledWith({
      order: expect.objectContaining({ order_number: "UTV-20260708-000019", amount_cents: 1999 }),
      plan: { name: plan.name, slug: plan.slug },
      payer: { email: "pix-utv-20260708-000019@unitv.com.br" }
    });
    expect(result.reply).toContain("Pix Copia e Cola");
    expect(result.reply).toContain("000201-pix-copy-paste");
    expect(result.reply).not.toContain("67070222000151");
    expect(result.copyText).toBe("000201-pix-copy-paste");
  });

  it("does not let sales AI promise Pix without executing Mercado Pago", async () => {
    const salesResponseAIService = {
      generateResponse: vi.fn(async () => "Perfeito, vou gerar o Pix de R$ 19,99 pra você agora.")
    };
    const { service, ordersService, mercadoPagoService } = createChatAgent({ salesResponseAIService });
    ordersService.findLatestOpenOrderByCustomerId.mockResolvedValueOnce(null);
    ordersService.createOrder.mockResolvedValueOnce({
      id: "33333333-3333-4333-8333-333333333333",
      order_number: "UTV-20260708-000020",
      customer_id: "44444444-4444-4444-8444-444444444444",
      plan_id: plan.id,
      amount_cents: 1999,
      currency: "BRL",
      metadata: {
        source: "whatsapp_agent",
        special_promo_offer: "mensal_19_99_first_2_months",
        special_promo_price_cents: 1999
      },
      plans: { name: plan.name, slug: plan.slug }
    });

    const result = await service.generateCommercialReply({
      message: "sim",
      classification: { intent: "pix_payment", confidence: 0.96, summary: "Cliente quer pagar por Pix usando o contexto comercial atual.", suggested_reply: "" },
      customer: { id: "44444444-4444-4444-8444-444444444444", email: null },
      conversation: {
        id: "55555555-5555-4555-8555-555555555555",
        metadata: {
          lead_profile: {
            selected_plan: "mensal",
            plano_interesse: "mensal",
            special_promo_followup_sent: true,
            accepted_special_promo: true,
            special_promo_offer: "mensal_19_99_first_2_months",
            last_bot_question: "Vai ser no Pix?"
          }
        }
      },
      webhookEventId: "webhook-id"
    });

    expect(salesResponseAIService.generateResponse).not.toHaveBeenCalled();
    expect(ordersService.createOrder).toHaveBeenCalledWith(expect.objectContaining({ amount_cents: 1999 }));
    expect(mercadoPagoService.createPixPayment).toHaveBeenCalledWith({
      order: expect.objectContaining({ order_number: "UTV-20260708-000020", amount_cents: 1999 }),
      plan: { name: plan.name, slug: plan.slug },
      payer: { email: "pix-utv-20260708-000020@unitv.com.br" }
    });
    expect(result.reply).toContain("000201-pix-copy-paste");
    expect(result.copyText).toBe("000201-pix-copy-paste");
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
    expect(result.reply).toContain("existing-pix-copy-paste");
    expect(result.reply).not.toContain("67070222000151");
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
    expect(result.reply).toContain("preferencia por qual plano");
    expect(result.reply).not.toContain("R$ 25");
    expect(result.reply).not.toContain("R$ 70");
    expect(result.menu).toBeUndefined();
    expect(result.reply).not.toContain("Ver planos");
  });

  it("answers a direct purchase request consultively without a menu", async () => {
    const { service, ordersService } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "comprar plano",
      classification: { intent: "buy_plan", confidence: 0.95, summary: "compra", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(ordersService.createOrder).not.toHaveBeenCalled();
    expect(result.reply).toContain("preferencia por qual plano");
    expect(result.reply).not.toContain("R$ 25");
    expect(result.reply).not.toContain("R$ 70");
    expect(result.menu).toBeUndefined();
    expect(result.reply).not.toContain("Falar com especialista");
  });

  it("asks where to install without sending the installation menu", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "quero aprender a instalar",
      classification: { intent: "technical_support", confidence: 0.99, summary: "instalacao", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.menu).toBeUndefined();
    expect(result.reply).toContain("Eu te mando o caminho certo.");
    expect(result.reply).toContain("TV Box Android, Android TV, Fire Stick ou celular Android?");
    expect(result.reply).not.toContain("TV pelo Downloader");
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
    expect(result.reply).toContain("862585");
    expect(result.reply).not.toContain("8322904");
    expect(result.reply).toContain("https://www.youtube.com/watch?v=LBBAbs2-I0c");
  });

  it("sends the Android download link without the general menu", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "como baixar no celular?",
      classification: { intent: "technical_support", confidence: 0.99, summary: "download", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("UniTV_mobile_3.21.6.apk");
    expect(result.reply).toContain("https://www.youtube.com/watch?v=LBBAbs2-I0c");
    expect(result.reply.trim().endsWith("?")).toBe(true);
    expect(result.menu).toBeUndefined();
    expect(result.reply).not.toContain("Ver planos");
    expect(result.reply).not.toContain("Fazer teste grátis");
  });

  it.each([
    ["minha tv é samsung", "Play Store", "mediafire.com"],
    ["minha tv é lg", "Play Store", "mediafire.com"],
    ["tenho iphone", "TV Box", "mediafire.com"],
    ["tenho roku", "não tenho instalação compatível", "mediafire.com"]
  ])("blocks incompatible direct download for %s", async (message, expected, forbidden) => {
    const { service } = createChatAgent();
    const result = await service.generateCommercialReply({
      message,
      classification: { intent: "technical_support", confidence: 0.99, summary: "aparelho", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain(expected);
    expect(result.reply).not.toContain(forbidden);
    expect(result.menu).toBeUndefined();
  });

  it("does not resend installation when the lead profile says the app was already downloaded", async () => {
    const { service } = createChatAgent();
    const result = await service.generateCommercialReply({
      message: "manda o link de novo",
      classification: { intent: "technical_support", confidence: 0.99, summary: "download", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id", metadata: { lead_profile: { downloaded_app: true, device: "tvbox_android" } } },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("já baixou o app");
    expect(result.reply).toContain("teste grátis de 3 dias");
    expect(result.reply).not.toContain("mediafire.com");
    expect(result.reply).not.toContain("862585");
  });

  it("answers that the monthly plan covers up to three screens without asking the count again", async () => {
    const { service } = createChatAgent();

    const result = await service.generateCommercialReply({
      message: "quantas telas?",
      classification: { intent: "unknown", confidence: 0.95, summary: "telas", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: { id: "conversation-id" },
      webhookEventId: "webhook-id"
    });

    expect(result.reply).toContain("ate 3 telas");
    expect(result.reply.toLowerCase()).not.toContain("quantas telas");
    expect(result.reply).not.toContain("quais aparelhos");
    expect(result.menu).toBeUndefined();
    expect(result.leadProfilePatch).toMatchObject({ selected_plan: "mensal", stage: "plan_selected" });
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
    expect(result.reply.trim().endsWith("?")).toBe(true);
    expect(result.menu).toBeUndefined();
    expect(result.sendTextBeforeMenu).toBe(false);
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
        findByExternalConversationId: vi.fn(async () => ({
          id: "conversation-id",
          metadata: { lead_profile: { stage: "awaiting_payment", payment_status: "pending" } }
        })),
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

  it("adds a contextual question to an AI reply that needs customer input", () => {
    const { service } = createChatAgent();

    const reply = service.generateReply({
      message: "quero saber",
      classification: {
        intent: "ask_price",
        confidence: 0.8,
        summary: "preco",
        suggested_reply: "Temos planos mensais e planos maiores com melhor custo-benefício."
      }
    });

    expect(reply).toContain("Temos planos mensais");
    expect(reply).toContain("O plano mensal esta saindo por R$ 20,90. Voce tem interesse pra hoje?");
    expect(reply.trim().endsWith("?")).toBe(true);
  });

  it("does not add a question to final post-purchase messages", () => {
    const { service } = createChatAgent();

    const reply = service.generateReply({
      message: "codigo",
      classification: {
        intent: "unknown",
        confidence: 0.8,
        summary: "codigo enviado",
        suggested_reply: "✅ Agradecemos pela sua compra!\n\nSeu código de acesso: UNITV-001"
      }
    });

    expect(reply).toContain("código removido");
    expect(reply).not.toContain("Você quer ajuda");
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
      createMessage: vi.fn(async (data) => ({ id: "message-id", ...data })),
      listMessagesByConversationId: vi.fn(async () => [
        { role: "customer", content: "Nao consigo ativar", created_at: "2026-07-04T21:18:00.000Z" },
        { role: "assistant", content: "Vou verificar.", created_at: "2026-07-04T21:19:00.000Z" }
      ])
    };
    const specialistTrainingExamplesRepository = { createExample: vi.fn(async (data) => data) };
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
      {} as never,
      { createExample: vi.fn(async (data) => data) } as never
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
    expect(intentClassifier.classify).toHaveBeenCalledWith({ message: "pix", conversationId: "conversation-id" });
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

  it("interprets a clicked menu row but sends only contextual AI copy", async () => {
    contextualResponseGenerate.mockResolvedValueOnce("Posso te ajudar a escolher um plano. Voce procura algo mensal ou por mais tempo?");
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
      text: "Posso te ajudar a escolher um plano. Voce procura algo mensal ou por mais tempo?"
    });
    expect(evolutionService.sendButtonMessage).not.toHaveBeenCalled();
    expect(evolutionService.sendListMessage).not.toHaveBeenCalled();
    expect(conversationsRepository.updateConversationMetadata).not.toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({ last_menu_id: "main" })
    );
  });

  it("never sends the programmed directive when contextual AI is unavailable", async () => {
    contextualResponseGenerate.mockResolvedValueOnce(null);
    const evolutionService = { sendTextMessage: vi.fn(async () => ({ sent: true })) };
    const auditService = { createAuditLog: vi.fn(async () => ({})) };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id" })) } as never,
      {
        findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", metadata: {} })),
        createConversation: vi.fn(),
        updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
        touchConversation: vi.fn(async () => ({}))
      } as never,
      {
        findByExternalMessageId: vi.fn(async () => null),
        createMessage: vi.fn(async (data) => ({ id: "message-id", ...data }))
      } as never,
      { classify: vi.fn(async () => ({ intent: "greeting", confidence: 1, summary: "oi", suggested_reply: "" })) } as never,
      { generateCommercialReply: vi.fn(async () => ({ reply: "Oi, tudo bem? Voce ja usa o aplicativo?" })) } as never,
      evolutionService as never,
      auditService as never,
      {} as never,
      {} as never,
      {} as never
    );

    const result = await service.processIncomingMessage({
      webhookEventId: "webhook-no-ai",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "no-ai-id",
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

    expect(result.status).toBe("ignored");
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
    expect(auditService.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contextual_ai_response_unavailable",
        metadata: expect.objectContaining({ programmed_response_blocked: true })
      })
    );
  });

  it("sends the fixed initial greeting exactly without an OpenAI rewrite or menu", async () => {
    contextualResponseGenerate.mockClear();
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
      { generateCommercialReply: vi.fn(async () => ({ reply: INITIAL_UNITV_REPLY, responseRule: "fixed_initial_greeting" })) } as never,
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
      text: INITIAL_UNITV_REPLY
    });
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalledWith({
      phone: "5511999998888",
      text: MAIN_MENU.fallbackText
    });
    expect(evolutionService.sendButtonMessage).not.toHaveBeenCalled();
    expect(evolutionService.sendListMessage).not.toHaveBeenCalled();
    expect(contextualResponseGenerate).not.toHaveBeenCalled();
  });

  it("schedules welcome activation follow-up after the initial greeting", async () => {
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", metadata: {} })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const evolutionService = { sendTextMessage: vi.fn(async () => ({ sent: true })) };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id" })) } as never,
      conversationsRepository as never,
      {
        findByExternalMessageId: vi.fn(async () => null),
        createMessage: vi.fn(async (data) => ({ id: "message-id", ...data }))
      } as never,
      { classify: vi.fn(async () => ({ intent: "greeting", confidence: 1, summary: "olq", suggested_reply: "" })) } as never,
      { generateCommercialReply: vi.fn(async () => ({ reply: "Olá! Seja bem-vindo ao melhor aplicativo de filmes e canais 🧡. Meu nome é André.\n\nVocê quer ver os valores, fazer o teste grátis ou precisa de ajuda para instalar?" })) } as never,
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
        externalMessageId: "olq-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "Olq",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1,
        fromMe: false,
        isGroup: false
      }
    });

    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Você quer ver os valores") })
    );
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        followup_key: "welcome_activation",
        awaiting_customer_action: "answer_welcome_intent",
        followup_count: 0
      })
    );
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({ followup_due_at: expect.any(String) })
    );
  });

  it("schedules download follow-up after Android link even when the incoming classification is greeting", async () => {
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", metadata: {} })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const evolutionService = { sendTextMessage: vi.fn(async () => ({ sent: true })) };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id" })) } as never,
      conversationsRepository as never,
      {
        findByExternalMessageId: vi.fn(async () => null),
        listMessagesByConversationId: vi.fn(async () => []),
        createMessage: vi.fn(async (data) => ({ id: "message-id", ...data }))
      } as never,
      { classify: vi.fn(async () => ({ intent: "greeting", confidence: 1, summary: "confirmacao", suggested_reply: "" })) } as never,
      { generateCommercialReply: vi.fn(async () => ({
        reply: "No celular Android funciona sim.\n\nBaixe por aqui:\n\nhttps://www.mediafire.com/file_premium/e2jc97dcqr80tjw/UniTV_mobile_3.21.6.apk/file\n\nTutorial:\nhttps://www.youtube.com/watch?v=LBBAbs2-I0c\n\nSeu celular e Android?",
        leadProfilePatch: {
          device: "android_phone",
          stage: "download_instructions",
          download_status: "link_sent",
          install_status: "link_sent",
          last_download_url_sent: "https://www.mediafire.com/file_premium/e2jc97dcqr80tjw/UniTV_mobile_3.21.6.apk/file"
        }
      })) } as never,
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
        externalMessageId: "android-link-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "Celular Android",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1,
        fromMe: false,
        isGroup: false
      }
    });

    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        followup_key: "post_download_check_10min",
        followup_type: "post_download_check_10min",
        awaiting_customer_action: "confirm_download",
        conversation_stage: "instalacao",
        followup_due_at: expect.any(String)
      })
    );
    expect(conversationsRepository.updateConversationMetadata).not.toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({ followup_key: "welcome_activation" })
    );
  });

  it("does not duplicate an active post-download follow-up when another download message is sent", async () => {
    const existingDueAt = "2026-07-09T14:10:00.000Z";
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({
        id: "conversation-id",
        metadata: {
          followup_key: "post_download_check_10min",
          followup_type: "post_download_check_10min",
          followup_due_at: existingDueAt,
          followup_count: 0,
          last_followup_stage_id: "post_download_check_10min:existing",
          awaiting_customer_action: "confirm_download",
          conversation_stage: "instalacao",
          last_bot_download_message_at: "2026-07-09T14:00:00.000Z",
          lead_profile: { device: "android_phone", stage: "download_instructions" }
        }
      })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const evolutionService = { sendTextMessage: vi.fn(async () => ({ sent: true })) };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id" })) } as never,
      conversationsRepository as never,
      {
        findByExternalMessageId: vi.fn(async () => null),
        listMessagesByConversationId: vi.fn(async () => []),
        createMessage: vi.fn(async (data) => ({ id: "message-id", ...data }))
      } as never,
      { classify: vi.fn(async () => ({ intent: "technical_support", confidence: 1, summary: "download", suggested_reply: "" })) } as never,
      { generateCommercialReply: vi.fn(async () => ({
        reply: "Baixe por aqui:\nhttps://www.mediafire.com/app.apk\n\nVoce prefere instalar pelo link ou pelo Downloader?",
        leadProfilePatch: { device: "android_phone", stage: "download_instructions", download_status: "link_sent" }
      })) } as never,
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
        externalMessageId: "android-link-duplicate-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "Baixe por aqui:\nhttps://www.mediafire.com/app.apk\n\nVoce prefere instalar pelo link ou pelo Downloader?",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1,
        fromMe: true,
        isGroup: false
      }
    });

    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        followup_key: "post_download_check_10min",
        followup_due_at: existingDueAt,
        last_followup_stage_id: "post_download_check_10min:existing",
        followup_count: 0,
        awaiting_customer_action: "confirm_download"
      })
    );
  });

  it("schedules follow-ups after manual outbound download and welcome messages", async () => {
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", metadata: {} })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const messagesRepository = {
      findByExternalMessageId: vi.fn(async () => null),
      listMessagesByConversationId: vi.fn(async () => []),
      createMessage: vi.fn(async (data) => ({ id: "message-id", ...data }))
    };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id" })) } as never,
      conversationsRepository as never,
      messagesRepository as never,
      { classify: vi.fn() } as never,
      { generateCommercialReply: vi.fn() } as never,
      { sendTextMessage: vi.fn() } as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      {} as never,
      {} as never,
      {} as never,
      { createExample: vi.fn(async () => ({})) } as never,
      { analyzeSpecialistIntervention: vi.fn(async () => ({
        inferred_intent: "technical_support",
        inferred_stage: "instalacao",
        inferred_objection: null,
        inferred_customer_state: "aguardando_download",
        inferred_specialist_action: "enviou_link_download",
        why_specialist_intervened: "Mensagem manual de instalacao.",
        style_notes: "Curto e direto.",
        summary: "Especialista enviou download.",
        learned_pattern: "Cobrar se conseguiu baixar.",
        next_best_action: "perguntar se conseguiu baixar"
      })) } as never
    );

    await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "manual-download-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "No celular Android funciona sim.\n\nBaixe por aqui:\nhttps://www.mediafire.com/file_premium/e2jc97dcqr80tjw/UniTV_mobile_3.21.6.apk/file\n\nSeu celular é Android?",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1,
        fromMe: true,
        isGroup: false
      }
    });

    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        followup_key: "post_download_check_10min",
        followup_type: "post_download_check_10min",
        awaiting_customer_action: "confirm_download",
        last_bot_message_at: expect.any(String),
        last_bot_download_message_at: expect.any(String),
        requires_human: true,
        lead_profile: expect.objectContaining({
          last_bot_question: "Seu celular é Android?"
        })
      })
    );

    conversationsRepository.updateConversationMetadata.mockClear();

    await service.processIncomingMessage({
      webhookEventId: "webhook-id-2",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "manual-welcome-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "Olá! Seja bem-vindo ao melhor aplicativo de filmes e canais. Meu nome é André.\n\nClaro, eu te ajudo com a recarga. Você quer renovar um acesso que já tem ou ativar um novo plano?",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 2,
        fromMe: true,
        isGroup: false
      }
    });

    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        followup_key: "welcome_activation",
        awaiting_customer_action: "answer_welcome_intent",
        followup_count: 0,
        followup_due_at: expect.any(String)
      })
    );
  });

  it("executes a specialist manual Pix command and sends copy-paste plus QR code", async () => {
    vi.clearAllMocks();
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", metadata: {} })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const messagesRepository = {
      findByExternalMessageId: vi.fn(async () => null),
      listMessagesByConversationId: vi.fn(async () => [
        { role: "customer", content: "Quero fechar", created_at: "2026-07-08T18:00:00.000Z" }
      ]),
      createMessage: vi.fn(async (data) => ({ id: "message-id", ...data }))
    };
    const chatAgent = {
      generateCommercialReply: vi.fn(async () => ({
        reply: "Perfeito, gerei o Pix do mensal por R$ 19,99.",
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
      sendTextMessage: vi.fn(async (input) => input.text === "000201-pix-copy-paste"
        ? { key: { id: "pix-copy-message-id" } }
        : { sent: true }),
      sendMediaMessage: vi.fn(async () => ({ sent: true }))
    };
    const auditService = { createAuditLog: vi.fn(async () => ({})) };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id", email: null })) } as never,
      conversationsRepository as never,
      messagesRepository as never,
      { classify: vi.fn() } as never,
      chatAgent as never,
      evolutionService as never,
      auditService as never,
      {} as never,
      {} as never,
      {} as never
    );

    const result = await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "manual-pix-command-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "Gerar pix mensal 19,99",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1,
        fromMe: true,
        isGroup: false
      }
    });

    expect(chatAgent.generateCommercialReply).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "mensal pix",
        classification: expect.objectContaining({ intent: "pix_payment", confidence: 1 }),
        conversation: expect.objectContaining({
          metadata: expect.objectContaining({
            requires_human: false,
            lead_profile: expect.objectContaining({
              selected_plan: "mensal",
              manual_payment_amount_cents: 1999,
              manual_payment_requires_human_review: false,
              payment_method: "pix"
            })
          })
        })
      })
    );
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith({
      phone: "5511999998888",
      text: "000201-pix-copy-paste"
    });
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith({
      phone: "5511999998888",
      text: "Essa é a Chave Copia e Cola, é so voce copiar e colar no seu banco ⬆️",
      quotedMessageId: "pix-copy-message-id"
    });
    expect(evolutionService.sendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "5511999998888",
        mimetype: "image/png",
        base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
      })
    );
    expect(contextualResponseGenerate).not.toHaveBeenCalled();
    expect(auditService.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "protected_payment_delivery_used",
        metadata: expect.objectContaining({ avoided_openai_call: true, has_copy_text: true, has_media: true })
      })
    );
    expect(result.status).toBe("processed");
  });

  it("accepts a specialist Pix command with no plan and preserves its exact amount for review", async () => {
    vi.clearAllMocks();
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", metadata: {} })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const chatAgent = {
      generateCommercialReply: vi.fn(async () => ({
        reply: "O pedido foi aberto, mas nao consegui gerar o Pix agora. Tente novamente em instantes.",
        requiresHuman: true
      }))
    };
    const evolutionService = { sendTextMessage: vi.fn(async () => ({ sent: true })) };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id", email: null })) } as never,
      conversationsRepository as never,
      {
        findByExternalMessageId: vi.fn(async () => null),
        listMessagesByConversationId: vi.fn(async () => []),
        createMessage: vi.fn(async (data) => ({ id: "message-id", ...data }))
      } as never,
      { classify: vi.fn() } as never,
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
        externalMessageId: "manual-pix-20-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "pix 20",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1,
        fromMe: true,
        isGroup: false
      }
    });

    expect(chatAgent.generateCommercialReply).toHaveBeenCalledWith(expect.objectContaining({
      message: "manual pix",
      conversation: expect.objectContaining({
        metadata: expect.objectContaining({
          manual_payment_command: expect.objectContaining({ amount_cents: 2000, requires_human_review: true }),
          lead_profile: expect.objectContaining({
            manual_payment_amount_cents: 2000,
            manual_payment_requires_human_review: true
          })
        })
      })
    }));
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith({
      phone: "5511999998888",
      text: "O pedido foi aberto, mas nao consegui gerar o Pix agora. Tente novamente em instantes."
    });
    expect(contextualResponseGenerate).not.toHaveBeenCalled();
  });

  it("executes a specialist manual card command", async () => {
    const chatAgent = {
      generateCommercialReply: vi.fn(async () => ({
        reply: "PAGUE COM CARTÃO AQUI ABAIXO\nhttps://www.mercadopago.com.br/checkout/link"
      }))
    };
    const evolutionService = { sendTextMessage: vi.fn(async () => ({ sent: true })) };
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", metadata: {} })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id", email: null })) } as never,
      conversationsRepository as never,
      {
        findByExternalMessageId: vi.fn(async () => null),
        listMessagesByConversationId: vi.fn(async () => []),
        createMessage: vi.fn(async (data) => ({ id: "message-id", ...data }))
      } as never,
      { classify: vi.fn() } as never,
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
        externalMessageId: "manual-card-command-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "Gerar cartão mensal 25",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1,
        fromMe: true,
        isGroup: false
      }
    });

    expect(chatAgent.generateCommercialReply).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "mensal card",
        classification: expect.objectContaining({ intent: "card_payment", confidence: 1 }),
        conversation: expect.objectContaining({
          metadata: expect.objectContaining({
            lead_profile: expect.objectContaining({
              selected_plan: "mensal",
              manual_payment_amount_cents: 2500,
              payment_method: "card"
            })
          })
        })
      })
    );
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith({
      phone: "5511999998888",
      text: "PAGUE COM CARTÃO AQUI ABAIXO\nhttps://www.mercadopago.com.br/checkout/link"
    });
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
        text: expect.stringContaining("Um cliente pediu para falar com um especialista.")
      })
    );
  });

  it("notifies the owner for any human handoff, even when the classifier is not human_help", async () => {
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", metadata: {} })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const intentClassifier = { classify: vi.fn(async () => ({ intent: "unknown", confidence: 0.4, summary: "duvida", suggested_reply: "" })) };
    const chatAgent = {
      generateCommercialReply: vi.fn(async () => ({
        reply: "Vou encaminhar para atendimento humano para te ajudar melhor.",
        requiresHuman: true
      }))
    };
    const evolutionService = { sendTextMessage: vi.fn(async () => ({ sent: true })) };
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
        externalMessageId: "low-confidence-human-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente Teste",
        text: "preciso de ajuda",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1,
        fromMe: false,
        isGroup: false
      }
    });

    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "558699802602",
        text: expect.stringContaining("Responda lá no WhatsApp.")
      })
    );
  });

  it("notifies the owner again when a customer asks for a specialist during active human takeover", async () => {
    const intentClassifier = { classify: vi.fn() };
    const chatAgent = { generateCommercialReply: vi.fn() };
    const evolutionService = { sendTextMessage: vi.fn(async () => ({ sent: true })) };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id", name: "Cliente Teste", phone: "5511999998888" })) } as never,
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
        externalMessageId: "active-human-request-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente Teste",
        text: "quero falar com especialista",
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
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "558699802602",
        text: expect.stringContaining("Um cliente pediu para falar com um especialista.")
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

  it("keeps the bot quiet for 5 minutes after the specialist replies", async () => {
    const recentSpecialistMessageAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const intentClassifier = { classify: vi.fn() };
    const chatAgent = { generateCommercialReply: vi.fn() };
    const evolutionService = { sendTextMessage: vi.fn() };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id" })) } as never,
      {
        findByExternalConversationId: vi.fn(async () => ({
          id: "conversation-id",
          metadata: {
            requires_human: true,
            handoff_reason: "human_help",
            last_specialist_message_at: recentSpecialistMessageAt
          }
        })),
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
        externalMessageId: "recent-human-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "qual chave pix?",
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

  it("auto-resumes a human handoff after 5 minutes without specialist activity", async () => {
    const oldSpecialistMessageAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({
        id: "conversation-id",
        metadata: {
          requires_human: true,
          handoff_reason: "human_help",
          last_specialist_message_at: oldSpecialistMessageAt
        }
      })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const intentClassifier = { classify: vi.fn(async () => ({ intent: "payment_pix", confidence: 1, summary: "pix", suggested_reply: "" })) };
    const chatAgent = { generateCommercialReply: vi.fn(async () => ({ reply: "Aqui está a chave Pix." })) };
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
        externalMessageId: "timeout-human-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "qual chave pix?",
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
      expect.objectContaining({
        requires_human: false,
        handoff_reason: null,
        handoff_resolved_by: "human_handoff_timeout_auto_resume"
      })
    );
    expect(chatAgent.generateCommercialReply).toHaveBeenCalled();
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith({ phone: "5511999998888", text: "Aqui está a chave Pix." });
  });

  it("records specialist messages during handoff and renews the 5-minute timer", async () => {
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({
        id: "conversation-id",
        metadata: { requires_human: true, handoff_reason: "human_help", handoff_requested_at: "2026-07-04T21:16:00.000Z" }
      })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const messagesRepository = {
      findByExternalMessageId: vi.fn(async () => null),
      createMessage: vi.fn(async (data) => ({ id: "message-id", ...data })),
      listMessagesByConversationId: vi.fn(async () => [
        { role: "customer", content: "Nao consigo ativar", created_at: "2026-07-04T21:18:00.000Z" },
        { role: "assistant", content: "Vou verificar.", created_at: "2026-07-04T21:19:00.000Z" }
      ])
    };
    const specialistTrainingExamplesRepository = { createExample: vi.fn(async (data) => data) };
    const intentClassifier = { classify: vi.fn() };
    const chatAgent = { generateCommercialReply: vi.fn() };
    const evolutionService = { sendTextMessage: vi.fn() };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id" })) } as never,
      conversationsRepository as never,
      messagesRepository as never,
      intentClassifier as never,
      chatAgent as never,
      evolutionService as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      {} as never,
      {} as never,
      {} as never,
      specialistTrainingExamplesRepository as never
    );

    const result = await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "specialist-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "Estou verificando para você.",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1783200000,
        fromMe: true,
        isGroup: false
      }
    });

    expect(result.status).toBe("ignored");
    expect(messagesRepository.createMessage).toHaveBeenCalledWith(expect.objectContaining({ role: "human_agent" }));
    expect(specialistTrainingExamplesRepository.createExample).toHaveBeenCalledWith(
      expect.objectContaining({
        specialist_message: expect.any(String),
        reason: "correction",
        bot_response_was_overridden: true
      })
    );
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        requires_human: true,
        last_specialist_message_at: "2026-07-04T21:20:00.000Z"
      })
    );
    expect(intentClassifier.classify).not.toHaveBeenCalled();
    expect(chatAgent.generateCommercialReply).not.toHaveBeenCalled();
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
  });

  it("marks any manual from-me message as specialist takeover even without previous handoff", async () => {
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({
        id: "conversation-id",
        metadata: {}
      })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const messagesRepository = {
      findByExternalMessageId: vi.fn(async () => null),
      createMessage: vi.fn(async (data) => ({ id: "message-id", ...data })),
      listMessagesByConversationId: vi.fn(async () => [])
    };
    const specialistTrainingExamplesRepository = { createExample: vi.fn(async (data) => data) };
    const intentClassifier = { classify: vi.fn() };
    const chatAgent = { generateCommercialReply: vi.fn() };
    const evolutionService = { sendTextMessage: vi.fn() };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id" })) } as never,
      conversationsRepository as never,
      messagesRepository as never,
      intentClassifier as never,
      chatAgent as never,
      evolutionService as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      {} as never,
      {} as never,
      {} as never,
      specialistTrainingExamplesRepository as never
    );

    const result = await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "manual-specialist-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "Estou falando com você por aqui.",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1783200000,
        fromMe: true,
        isGroup: false
      }
    });

    expect(result.status).toBe("ignored");
    expect(messagesRepository.createMessage).toHaveBeenCalledWith(expect.objectContaining({ role: "human_agent" }));
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        requires_human: true,
        handoff_reason: "human_agent_reply",
        last_specialist_message_at: "2026-07-04T21:20:00.000Z"
      })
    );
    expect(intentClassifier.classify).not.toHaveBeenCalled();
    expect(chatAgent.generateCommercialReply).not.toHaveBeenCalled();
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
  });

  it("clears stale plan follow-up when specialist is closing sale or delivering access", async () => {
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({
        id: "conversation-id",
        metadata: {
          followup_key: "plan_choice",
          followup_due_at: "2026-07-04T21:25:00.000Z",
          conversation_stage: "plan_selected",
          lead_profile: { selected_plan: "mensal" }
        }
      })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const messagesRepository = {
      findByExternalMessageId: vi.fn(async () => null),
      createMessage: vi.fn(async (data) => ({ id: "message-id", ...data })),
      listMessagesByConversationId: vi.fn(async () => [
        { role: "customer", content: "👍", created_at: "2026-07-04T21:19:00.000Z" },
        { role: "human_agent", content: "Veja se tem algum botao ativar recarga", created_at: "2026-07-04T21:18:00.000Z" }
      ])
    };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id", phone: "5511999998888" })) } as never,
      conversationsRepository as never,
      messagesRepository as never,
      { classify: vi.fn() } as never,
      { generateCommercialReply: vi.fn() } as never,
      { sendTextMessage: vi.fn() } as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      {} as never,
      {} as never,
      {} as never,
      { createExample: vi.fn(async (data) => data) } as never
    );

    await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "manual-access-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "So aguardando o fornecedor responder. E ja lhe mando o acesso",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1783200000,
        fromMe: true,
        isGroup: false
      }
    });

    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        followup_key: null,
        followup_due_at: null,
        conversation_stage: "human_support_activation",
        lead_profile: expect.objectContaining({
          sale_closed_by_specialist: true,
          access_delivery_status: "human_handling",
          stage: "human_support_activation"
        })
      })
    );
  });

  it("classifies a matching from-me webhook as bot echo instead of specialist training", async () => {
    const sentAt = "2026-07-04T21:20:00.000Z";
    const messagesRepository = {
      findByExternalMessageId: vi.fn(async () => null),
      createMessage: vi.fn(),
      listMessagesByConversationId: vi.fn(async () => [
        {
          role: "assistant",
          content: "Mensagem automatica do bot",
          created_at: sentAt,
          metadata: { sender_type: "bot", sent_at: sentAt, provider_message_id: "bot-echo-id" }
        }
      ])
    };
    const specialistTrainingExamplesRepository = { createExample: vi.fn() };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id" })) } as never,
      {
        findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", metadata: {} })),
        createConversation: vi.fn(),
        updateConversationMetadata: vi.fn(),
        touchConversation: vi.fn()
      } as never,
      messagesRepository as never,
      { classify: vi.fn() } as never,
      { generateCommercialReply: vi.fn() } as never,
      { sendTextMessage: vi.fn() } as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      {} as never,
      {} as never,
      {} as never,
      specialistTrainingExamplesRepository as never
    );

    const result = await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "bot-echo-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "Eco com texto alterado pelo provedor",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: new Date(sentAt).getTime() / 1000,
        fromMe: true,
        isGroup: false
      }
    });

    expect(result.status).toBe("ignored");
    expect(messagesRepository.createMessage).not.toHaveBeenCalled();
    expect(specialistTrainingExamplesRepository.createExample).not.toHaveBeenCalled();
  });

  it("keeps the bot quiet after recent specialist activity even if requires_human is missing", async () => {
    const recentSpecialistMessageAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const intentClassifier = { classify: vi.fn() };
    const chatAgent = { generateCommercialReply: vi.fn() };
    const evolutionService = { sendTextMessage: vi.fn() };
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id" })) } as never,
      {
        findByExternalConversationId: vi.fn(async () => ({
          id: "conversation-id",
          metadata: { last_specialist_message_at: recentSpecialistMessageAt }
        })),
        createConversation: vi.fn(),
        updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
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
        externalMessageId: "recent-specialist-without-flag-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "qual chave pix?",
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

  it("auto-resumes stale free trial handoffs from the old flow", async () => {
    const conversationsRepository = {
      findByExternalConversationId: vi.fn(async () => ({
        id: "conversation-id",
        metadata: { requires_human: true, handoff_reason: "free_trial" }
      })),
      createConversation: vi.fn(),
      updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata })),
      touchConversation: vi.fn(async () => ({}))
    };
    const intentClassifier = { classify: vi.fn(async () => ({ intent: "greeting", confidence: 1, summary: "oi", suggested_reply: "" })) };
    const chatAgent = { generateCommercialReply: vi.fn(async () => ({ reply: "Bot ativo novamente." })) };
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
        externalMessageId: "stale-free-trial-id",
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

    expect(result.status).toBe("processed");
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        requires_human: false,
        handoff_reason: null,
        handoff_resolved_by: "stale_free_trial_handoff_auto_resume"
      })
    );
    expect(chatAgent.generateCommercialReply).toHaveBeenCalled();
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith({ phone: "5511999998888", text: "Bot ativo novamente." });
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
    expect(intentClassifier.classify).toHaveBeenCalledWith({ message: "reativar bot", conversationId: "conversation-id" });
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
