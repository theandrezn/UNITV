import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildFollowupText,
  buildLeadRecoveryFollowupText,
  buildPromoRecoveryFollowupText,
  buildUnansweredCustomerFallbackText,
  getLeadRecoveryFollowup,
  shouldSendPromoRecoveryFollowup,
  shouldUseLeadRecoverySequence,
  WhatsappFollowupService
} from "@/services/followups/whatsapp-followup.service";

function createService(
  conversations: Array<Record<string, unknown>>,
  options: {
    recentMessages?: Array<Record<string, unknown>>;
    aiReply?: string | null;
    openOrder?: Record<string, unknown> | null;
    latestOrder?: Record<string, unknown> | null;
  } = {}
) {
  const conversationsRepository = {
    listOpenConversations: vi.fn(async () => conversations),
    updateConversationMetadata: vi.fn(async (_id, metadata) => {
      const conversation = conversations.find((item) => item.id === _id);
      if (conversation) {
        conversation.metadata = metadata;
      }
      return { id: _id, metadata };
    }),
    touchConversation: vi.fn(async () => ({}))
  };
  const messagesRepository = {
    createMessage: vi.fn(async (data) => ({ id: "message-id", ...data })),
    listMessagesByConversationId: vi.fn(async () => options.recentMessages || [])
  };
  const evolutionService = {
    sendTextMessage: vi.fn(async () => ({ sent: true }))
  };
  const auditService = {
    createAuditLog: vi.fn(async () => ({}))
  };
  const salesResponseAIService = {
    generateResponse: vi.fn(async () => options.aiReply === undefined ? "Mensagem contextual gerada pela IA." : options.aiReply)
  };
  const ordersService = {
    findLatestOpenOrderByCustomerId: vi.fn(async () => options.openOrder ?? null),
    findLatestOrderByCustomerId: vi.fn(async () => options.latestOrder ?? options.openOrder ?? null)
  };

  return {
    service: new WhatsappFollowupService(
      conversationsRepository as never,
      messagesRepository as never,
      evolutionService as never,
      auditService as never,
      undefined,
      salesResponseAIService as never,
      ordersService as never
    ),
    conversationsRepository,
    messagesRepository,
    evolutionService,
    auditService,
    salesResponseAIService,
    ordersService
  };
}

describe("WhatsappFollowupService", () => {
  it("builds human commercial follow-up text", () => {
    const valuesFollowup = buildFollowupText({ followup_key: "values", plan_interest: "mensal" });
    expect(valuesFollowup).toBe("Voce teria interesse no mensal mesmo?");
    expect(valuesFollowup).not.toContain("pagamento");
    expect(valuesFollowup).not.toContain("comprovante");
    expect(valuesFollowup).not.toContain("Ver planos");
    expect(valuesFollowup).not.toContain("Fazer teste");
    expect(valuesFollowup).not.toContain("Comprar agora");
    expect(buildFollowupText({ followup_key: "welcome_activation" })).toBe(
      "Voce prefere fazer o teste gratis ou quer ativar o mensal?"
    );
    const downloadFollowup = buildFollowupText({ followup_key: "download", device: "TV Box / Android TV" });
    expect(downloadFollowup).toContain("Conseguiu instalar na TV Box");
    expect(downloadFollowup.trim().endsWith(".")).toBe(true);
    expect(buildFollowupText({ followup_key: "download", device: "android_tv_google_tv" })).toContain("Play Store");
    expect(buildFollowupText({ followup_key: "download", device: "android_phone" })).toContain("celular Android");
    expect(buildFollowupText({ followup_key: "download", device: "firestick" })).toContain("862585");
    expect(buildFollowupText({ followup_key: "install", device: "unknown" })).toContain("Android ou Play Store?");
    expect(buildUnansweredCustomerFallbackText({ followup_key: "download", conversation_stage: "instalacao" }, "Ok")).toBe("Conseguiu avancar?");
  });

  it("uses renewal wording after values when the customer wants recarga", () => {
    const renewalFollowup = buildFollowupText({
      followup_key: "values",
      conversation_stage: "recarga",
      lead_profile: { wants_recharge: true, ultima_intencao: "renew_plan" }
    });

    expect(renewalFollowup).toBe("Voce quer renovar no mensal mesmo ou prefere outro periodo?");
    expect(renewalFollowup).not.toContain("pagamento");
    expect(renewalFollowup).not.toContain("comprovante");
  });

  it("sends a due follow-up once for the current stage", async () => {
    const now = new Date("2026-07-06T12:00:00.000Z");
    const { service, evolutionService, messagesRepository, conversationsRepository } = createService([
      {
        id: "conversation-id",
        customer_id: "customer-id",
        external_conversation_id: "5511999998888@s.whatsapp.net",
        customers: { id: "customer-id", phone: "5511999998888" },
        metadata: {
          followup_key: "values",
          followup_due_at: "2026-07-06T11:59:00.000Z",
          last_bot_message_at: "2026-07-06T11:54:00.000Z",
          last_customer_message_at: "2026-07-06T11:53:00.000Z",
          last_followup_stage_id: "ask_price:values:1",
          followup_count: 0
        }
      }
    ]);

    const result = await service.processDueFollowups(now);

    expect(result).toEqual({ checked: 1, sent: 1, skipped: 0 });
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ phone: "5511999998888", text: "Mensagem contextual gerada pela IA." })
    );
    expect(messagesRepository.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", external_message_id: "followup:conversation-id:ask_price:values:1" })
    );
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        followup_due_at: null,
        followup_sent_stage_id: "ask_price:values:1",
        followup_count: 1
      })
    );
  });

  it("runs progressive lead recovery after the first unanswered agent message", async () => {
    const now = new Date("2026-07-06T12:00:00.000Z");
    const { service, evolutionService, messagesRepository, conversationsRepository } = createService([
      {
        id: "conversation-id",
        customer_id: "customer-id",
        customers: { id: "customer-id", phone: "5511999998888", name: "João Cliente" },
        metadata: {
          followup_key: "welcome_activation",
          followup_due_at: "2026-07-06T11:59:00.000Z",
          last_bot_message_at: "2026-07-06T11:54:00.000Z",
          last_customer_message_at: "2026-07-06T11:53:00.000Z",
          last_followup_stage_id: "greeting:welcome_activation:1",
          followup_count: 0,
          lead_profile: { intencao_inicial: "greeting" }
        }
      }
    ]);

    const result = await service.processDueFollowups(now);

    expect(result.sent).toBe(1);
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Mensagem contextual gerada pela IA." })
    );
    expect(messagesRepository.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        external_message_id: "followup:conversation-id:greeting:welcome_activation:1:recovery:1",
        metadata: expect.objectContaining({ lead_recovery_step: 1 })
      })
    );
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        followup_due_at: "2026-07-06T14:00:00.000Z",
        followup_count: 1,
        lead_recovery_followup_step: 1,
        lead_recovery_followup_completed: false,
        last_followup_stage_id: "greeting:welcome_activation:1:recovery:2"
      })
    );
  });

  it("recovers unanswered bot messages after 5 minutes even when followup_due_at is missing", async () => {
    const now = new Date("2026-07-06T12:35:00.000Z");
    const { service, evolutionService, messagesRepository, conversationsRepository } = createService([
      {
        id: "conversation-id",
        customer_id: "customer-id",
        customers: { id: "customer-id", phone: "5511999998888" },
        metadata: {
          followup_key: "welcome_activation",
          followup_due_at: null,
          last_bot_message_at: "2026-07-06T12:29:00.000Z",
          last_customer_message_at: "2026-07-06T12:28:00.000Z",
          last_followup_stage_id: "greeting:welcome_activation:1",
          followup_count: 0,
          lead_profile: {
            intencao_inicial: "greeting",
            last_bot_question: "Voce quer renovar um acesso que ja tem ou ativar um novo plano?"
          }
        }
      }
    ]);

    const result = await service.processDueFollowups(now);

    expect(result).toEqual({ checked: 1, sent: 1, skipped: 0 });
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Mensagem contextual gerada pela IA."
      })
    );
    expect(messagesRepository.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        external_message_id: "followup:conversation-id:greeting:welcome_activation:1",
        metadata: expect.objectContaining({ unanswered_bot_followup: true })
      })
    );
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        unanswered_bot_followup_for_message_at: "2026-07-06T12:29:00.000Z",
        lead_recovery_followup_step: 1,
        followup_due_at: "2026-07-06T14:35:00.000Z"
      })
    );
  });

  it("sends the second contextual recovery and schedules the final one for 6 hours later", async () => {
    const now = new Date("2026-07-06T13:00:00.000Z");
    const { service, evolutionService, conversationsRepository } = createService([
      {
        id: "conversation-id",
        customer_id: "customer-id",
        customers: { id: "customer-id", phone: "5511999998888" },
        metadata: {
          followup_key: "welcome_activation",
          followup_due_at: "2026-07-06T13:00:00.000Z",
          last_bot_message_at: "2026-07-06T12:00:00.000Z",
          last_customer_message_at: "2026-07-06T11:53:00.000Z",
          last_followup_stage_id: "greeting:welcome_activation:1:recovery:2",
          lead_recovery_followup_base_stage_id: "greeting:welcome_activation:1",
          lead_recovery_followup_step: 1,
          followup_count: 1,
          lead_profile: { intencao_inicial: "greeting" }
        }
      }
    ]);

    const result = await service.processDueFollowups(now);

    expect(result.sent).toBe(1);
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Mensagem contextual gerada pela IA." })
    );
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        followup_due_at: "2026-07-06T19:00:00.000Z",
        lead_recovery_followup_step: 2,
        followup_count: 2,
        last_followup_stage_id: "greeting:welcome_activation:1:recovery:3"
      })
    );
  });

  it("finishes lead recovery after the third follow-up without payment language", () => {
    expect(shouldUseLeadRecoverySequence({
      followup_key: "welcome_activation",
      lead_recovery_followup_step: 2,
      lead_profile: { intencao_inicial: "greeting" }
    })).toBe(true);
    expect(getLeadRecoveryFollowup({
      followup_key: "welcome_activation",
      last_followup_stage_id: "greeting:welcome_activation:1:recovery:3",
      lead_recovery_followup_base_stage_id: "greeting:welcome_activation:1",
      lead_recovery_followup_step: 2,
      lead_profile: { intencao_inicial: "greeting" }
    })).toEqual({
      step: 3,
      baseStageId: "greeting:welcome_activation:1",
      stageId: "greeting:welcome_activation:1:recovery:3"
    });
    expect(getLeadRecoveryFollowup({
      followup_key: "welcome_activation",
      lead_recovery_followup_step: 3,
      lead_profile: { intencao_inicial: "greeting" }
    })).toBeNull();

    const lastCall = buildLeadRecoveryFollowupText(3, { lead_profile: { nome: "Maria" } });
    expect(lastCall).toContain("Se fizer sentido pra voce, posso te explicar o proximo passo.");
    expect(lastCall).not.toContain("pagamento");
    expect(lastCall).not.toContain("comprovante");
    expect(lastCall).not.toContain("hoje");
    expect(buildLeadRecoveryFollowupText(1, { lead_profile: {} })).toContain("Voce ja usou o UNITV?");
    expect(buildLeadRecoveryFollowupText(2, { lead_profile: {} }).startsWith("Consigo uma condicao melhor")).toBe(true);
  });

  it("sends a one-time promotional recovery follow-up for hot leads before payment", async () => {
    const now = new Date("2026-07-06T12:00:00.000Z");
    const { service, evolutionService, conversationsRepository } = createService(
      [
        {
          id: "conversation-id",
          customer_id: "customer-id",
          customers: { id: "customer-id", phone: "5511999998888", name: "Maria Cliente" },
          metadata: {
            followup_key: "payment_choice",
            followup_due_at: "2026-07-06T11:59:00.000Z",
            last_bot_message_at: "2026-07-06T11:54:00.000Z",
            last_customer_message_at: "2026-07-06T11:53:00.000Z",
            last_followup_stage_id: "buy_plan:payment_choice:1",
            followup_count: 0,
            lead_profile: {
              selected_plan: "mensal",
              nivel_interesse: "quente",
              payment_status: "not_paid",
              payment_method: "pix"
            }
          }
        }
      ],
      { openOrder: { id: "order-id", status: "pending_payment", payment_method: "pix" } }
    );

    const result = await service.processDueFollowups(now);

    expect(result.sent).toBe(1);
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Mensagem contextual gerada pela IA."
      })
    );
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        last_followup_key_sent: "pix",
        followup_dedupe_key: expect.any(String),
        lead_profile: expect.objectContaining({ stage: "awaiting_payment" })
      })
    );
  });

  it("does not offer the promotional recovery twice or to cold leads", () => {
    expect(shouldSendPromoRecoveryFollowup({
      followup_key: "payment_choice",
      lead_profile: { selected_plan: "mensal", special_promo_followup_sent: true }
    })).toBe(false);
    expect(shouldSendPromoRecoveryFollowup({
      followup_key: "values",
      lead_profile: { selected_plan: "mensal", nivel_interesse: "quente" }
    })).toBe(false);
    expect(shouldSendPromoRecoveryFollowup({
      followup_key: "pix",
      lead_profile: { selected_plan: "mensal", pediu_pix: true, nivel_interesse: "quente" }
    })).toBe(false);
    expect(shouldSendPromoRecoveryFollowup({
      followup_key: "welcome_activation",
      lead_profile: { nivel_interesse: "frio" }
    })).toBe(false);
    expect(buildPromoRecoveryFollowupText({ lead_profile: {} })).toContain("condi");
  });

  it("uses stage-specific copy for payment choice and sent Pix follow-ups", () => {
    const paymentChoice = buildFollowupText({ followup_key: "payment_choice" });
    expect(paymentChoice).toContain("Voce prefere seguir pelo Pix ou pelo cartao?");
    expect(paymentChoice).not.toContain("chave PIX");
    expect(paymentChoice).not.toContain("Conseguiu fazer o pagamento?");

    const pixFollowup = buildFollowupText({ followup_key: "pix" });
    expect(pixFollowup).toContain("Conseguiu fazer o pagamento pelo Pix?");
    expect(pixFollowup).toContain("Mercado Pago confirmar");
  });

  it("does not send an unanswered-customer follow-up before the silence delay", async () => {
    const { service, evolutionService } = createService([
      {
        id: "conversation-id",
        customers: { phone: "5511999998888" },
        metadata: {
          followup_key: "pix",
          followup_due_at: "2026-07-06T11:54:30.000Z",
          last_bot_message_at: "2026-07-06T11:54:00.000Z",
          last_customer_message_at: "2026-07-06T11:55:00.000Z"
        }
      }
    ]);

    const result = await service.processDueFollowups(new Date("2026-07-06T11:56:00.000Z"));

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
  });

  it("sends an intelligent follow-up when the last message is from the customer", async () => {
    const now = new Date("2026-07-06T12:01:00.000Z");
    const { service, evolutionService, messagesRepository, conversationsRepository, salesResponseAIService } = createService(
      [
        {
          id: "conversation-id",
          customer_id: "customer-id",
          customers: { id: "customer-id", phone: "5511999998888" },
          metadata: {
            requires_human: true,
            followup_key: "download",
            followup_due_at: null,
            conversation_stage: "instalacao",
            last_specialist_message_at: "2026-07-06T11:45:00.000Z",
            last_bot_message_at: "2026-07-06T11:50:00.000Z",
            last_customer_message_at: "2026-07-06T11:55:00.000Z",
            lead_profile: { device: "tvbox_android", last_bot_question: "Se preferir, eu também te passo o passo a passo." }
          }
        }
      ],
      {
        recentMessages: [
          { role: "assistant", content: "Se preferir, eu também te passo o passo a passo pelo celular para instalar mais rápido." },
          { role: "customer", content: "Ok" }
        ],
        aiReply: "Conseguiu chegar na tela de login por aí?"
      }
    );

    const result = await service.processDueFollowups(now);

    expect(result).toEqual({ checked: 1, sent: 1, skipped: 0 });
    expect(salesResponseAIService.generateResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackReply: "Conseguiu abrir o app e chegar na tela de login?",
        intent: "download_check",
        message: expect.stringContaining("Use o historico completo")
      })
    );
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith({
      phone: "5511999998888",
      text: "Conseguiu chegar na tela de login por aí?"
    });
    expect(messagesRepository.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        external_message_id: "followup:conversation-id:customer_unanswered:2026-07-06T11:55:00.000Z",
        metadata: expect.objectContaining({ unanswered_customer_followup: true })
      })
    );
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        unanswered_customer_followup_for_message_at: "2026-07-06T11:55:00.000Z",
        unanswered_customer_followup_stage_id: "customer_unanswered:2026-07-06T11:55:00.000Z",
        last_bot_message_at: now.toISOString()
      })
    );
  });

  it("does not duplicate unanswered-customer follow-up for the same customer message", async () => {
    const { service, evolutionService } = createService([
      {
        id: "conversation-id",
        customers: { phone: "5511999998888" },
        metadata: {
          followup_key: "download",
          last_bot_message_at: "2026-07-06T11:50:00.000Z",
          last_customer_message_at: "2026-07-06T11:55:00.000Z",
          unanswered_customer_followup_for_message_at: "2026-07-06T11:55:00.000Z"
        }
      }
    ]);

    const result = await service.processDueFollowups(new Date("2026-07-06T12:01:00.000Z"));

    expect(result.sent).toBe(0);
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
  });

  it("does not send while a specialist is active in the last 5 minutes", async () => {
    const { service, evolutionService } = createService([
      {
        id: "conversation-id",
        customers: { phone: "5511999998888" },
        metadata: {
          requires_human: true,
          followup_key: "support",
          followup_due_at: "2026-07-06T11:59:00.000Z",
          last_specialist_message_at: "2026-07-06T11:58:00.000Z"
        }
      }
    ]);

    const result = await service.processDueFollowups(new Date("2026-07-06T12:00:00.000Z"));

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
  });

  it("does not duplicate a follow-up for the same stage", async () => {
    const { service, evolutionService } = createService([
      {
        id: "conversation-id",
        customers: { phone: "5511999998888" },
        metadata: {
          followup_key: "test",
          followup_due_at: "2026-07-06T11:59:00.000Z",
          followup_sent_at: "2026-07-06T11:59:20.000Z",
          followup_sent_stage_id: "free_trial:test:1",
          last_followup_stage_id: "free_trial:test:1",
          followup_count: 1
        }
      }
    ]);

    const result = await service.processDueFollowups(new Date("2026-07-06T12:00:00.000Z"));

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
  });

  it("does not duplicate the same contextual follow-up when the job runs twice", async () => {
    const now = new Date("2026-07-06T12:00:00.000Z");
    const { service, evolutionService } = createService([
      {
        id: "conversation-id",
        customer_id: "customer-id",
        customers: { id: "customer-id", phone: "5511999998888" },
        metadata: {
          followup_key: "values",
          followup_due_at: "2026-07-06T11:59:00.000Z",
          last_bot_message_at: "2026-07-06T11:54:00.000Z",
          last_customer_message_at: "2026-07-06T11:53:00.000Z",
          last_followup_stage_id: "ask_price:values:dedupe",
          followup_count: 0
        }
      }
    ]);

    const first = await service.processDueFollowups(now);
    const second = await service.processDueFollowups(new Date("2026-07-06T12:01:00.000Z"));

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(evolutionService.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("sends only one follow-up when duplicate open conversations share the same phone", async () => {
    const now = new Date("2026-07-06T12:00:00.000Z");
    const { service, evolutionService, conversationsRepository } = createService([
      {
        id: "conversation-id-a",
        customer_id: "customer-id-a",
        external_conversation_id: "5511999998888@s.whatsapp.net",
        customers: { id: "customer-id-a", phone: "5511999998888" },
        metadata: {
          followup_key: "values",
          followup_due_at: "2026-07-06T11:59:00.000Z",
          last_bot_message_at: "2026-07-06T11:54:00.000Z",
          last_customer_message_at: "2026-07-06T11:53:00.000Z",
          last_followup_stage_id: "ask_price:values:a",
          followup_count: 0
        }
      },
      {
        id: "conversation-id-b",
        customer_id: "customer-id-b",
        external_conversation_id: "5511999998888@s.whatsapp.net",
        customers: { id: "customer-id-b", phone: "5511999998888" },
        metadata: {
          followup_key: "values",
          followup_due_at: "2026-07-06T11:59:00.000Z",
          last_bot_message_at: "2026-07-06T11:54:00.000Z",
          last_customer_message_at: "2026-07-06T11:53:00.000Z",
          last_followup_stage_id: "ask_price:values:b",
          followup_count: 0
        }
      }
    ]);

    const result = await service.processDueFollowups(now);

    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(1);
    expect(evolutionService.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id-b",
      expect.objectContaining({ followup_cancel_reason: "duplicate_phone_in_job" })
    );
  });

  it("cancels download follow-up when the customer started testing and said they would report problems", async () => {
    const { service, evolutionService, conversationsRepository } = createService(
      [
        {
          id: "conversation-id",
          customer_id: "customer-id",
          customers: { id: "customer-id", phone: "5511999998888" },
          metadata: {
            followup_key: "download",
            followup_due_at: "2026-07-06T11:59:00.000Z",
            conversation_stage: "instalacao",
            last_bot_message_at: "2026-07-06T11:54:00.000Z",
            last_customer_message_at: "2026-07-06T11:53:00.000Z"
          }
        }
      ],
      {
        recentMessages: [
          { id: "m1", role: "customer", content: "Ta pedindo senha", created_at: "2026-07-06T11:50:00.000Z" },
          { id: "m2", role: "human_agent", content: "Coloca so numero", created_at: "2026-07-06T11:51:00.000Z" },
          { id: "m3", role: "human_agent", content: "Deu certo?", created_at: "2026-07-06T11:52:00.000Z" },
          { id: "m4", role: "customer", content: "Vou comecar a testar agora", created_at: "2026-07-06T11:53:00.000Z" },
          { id: "m5", role: "customer", content: "Qualquer problema que der eu te aviso beleza", created_at: "2026-07-06T11:54:00.000Z" }
        ]
      }
    );

    const result = await service.processDueFollowups(new Date("2026-07-06T12:00:00.000Z"));

    expect(result.sent).toBe(0);
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        followup_key: "trial_check",
        conversation_stage: "active_trial",
        lead_profile: expect.objectContaining({ trial_status: "testing", self_monitoring: true })
      })
    );
  });

  it("cancels install follow-up when the customer already downloaded or installed", async () => {
    const { service, evolutionService, conversationsRepository } = createService(
      [
        {
          id: "conversation-id",
          customer_id: "customer-id",
          customers: { id: "customer-id", phone: "5511999998888" },
          metadata: {
            followup_key: "install",
            followup_due_at: "2026-07-06T11:59:00.000Z",
            conversation_stage: "instalacao",
            last_bot_message_at: "2026-07-06T11:54:00.000Z",
            last_customer_message_at: "2026-07-06T11:53:00.000Z"
          }
        }
      ],
      {
        recentMessages: [
          { id: "m1", role: "customer", content: "ja baixei", created_at: "2026-07-06T11:53:00.000Z" },
          { id: "m2", role: "customer", content: "consegui instalar", created_at: "2026-07-06T11:54:00.000Z" }
        ]
      }
    );

    const result = await service.processDueFollowups(new Date("2026-07-06T12:00:00.000Z"));

    expect(result.sent).toBe(0);
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        followup_key: null,
        lead_profile: expect.objectContaining({ install_status: "resolved" })
      })
    );
  });

  it("does not send Pix follow-up without a pending order", async () => {
    const { service, evolutionService, conversationsRepository } = createService([
      {
        id: "conversation-id",
        customer_id: "customer-id",
        customers: { id: "customer-id", phone: "5511999998888" },
        metadata: {
          followup_key: "pix",
          followup_due_at: "2026-07-06T11:59:00.000Z",
          last_bot_message_at: "2026-07-06T11:54:00.000Z",
          last_customer_message_at: "2026-07-06T11:53:00.000Z"
        }
      }
    ]);

    const result = await service.processDueFollowups(new Date("2026-07-06T12:00:00.000Z"));

    expect(result.sent).toBe(0);
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({ followup_cancel_reason: "Nao existe pedido/Pix pendente para cobrar." })
    );
  });

  it("sends Pix follow-up once when there is a pending Pix order", async () => {
    const { service, evolutionService } = createService(
      [
        {
          id: "conversation-id",
          customer_id: "customer-id",
          customers: { id: "customer-id", phone: "5511999998888" },
          metadata: {
            followup_key: "pix",
            followup_due_at: "2026-07-06T11:59:00.000Z",
            last_bot_message_at: "2026-07-06T11:54:00.000Z",
            last_customer_message_at: "2026-07-06T11:53:00.000Z",
            lead_profile: { payment_method: "pix" }
          }
        }
      ],
      { openOrder: { id: "order-id", status: "pending_payment", payment_method: "pix" } }
    );

    const result = await service.processDueFollowups(new Date("2026-07-06T12:00:00.000Z"));

    expect(result.sent).toBe(1);
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Mensagem contextual gerada pela IA." })
    );
  });

  it("uses contextual decision message when final follow-up AI text is unavailable", async () => {
    const now = new Date("2026-07-06T12:00:00.000Z");
    const { service, evolutionService, messagesRepository, conversationsRepository, auditService } = createService(
      [
        {
          id: "conversation-id",
          customer_id: "customer-id",
          customers: { id: "customer-id", phone: "5511999998888" },
          metadata: {
            followup_key: "values",
            followup_due_at: "2026-07-06T11:59:00.000Z",
            last_bot_message_at: "2026-07-06T11:54:00.000Z",
            last_customer_message_at: "2026-07-06T11:53:00.000Z",
            last_followup_stage_id: "ask_price:values:no-ai",
            followup_count: 0
          }
        }
      ],
      { aiReply: null }
    );

    const result = await service.processDueFollowups(now);

    expect(result).toEqual({ checked: 1, sent: 1, skipped: 0 });
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith({
      phone: "5511999998888",
      text: "Te ajudo a escolher o melhor plano. Voce quer mensal, trimestral ou anual?"
    });
    expect(messagesRepository.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "assistant",
        content: "Te ajudo a escolher o melhor plano. Voce quer mensal, trimestral ou anual?"
      })
    );
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        followup_due_at: null,
        followup_sent_stage_id: "ask_price:values:no-ai",
        followup_count: 1
      })
    );
    expect(auditService.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "whatsapp_followup_sent",
        metadata: expect.objectContaining({ followup_key: "values" })
      })
    );
  });

  it("cancels Pix follow-up after payment confirmation", async () => {
    const { service, evolutionService, conversationsRepository } = createService(
      [
        {
          id: "conversation-id",
          customer_id: "customer-id",
          customers: { id: "customer-id", phone: "5511999998888" },
          metadata: {
            followup_key: "pix",
            followup_due_at: "2026-07-06T11:59:00.000Z",
            last_bot_message_at: "2026-07-06T11:54:00.000Z",
            last_customer_message_at: "2026-07-06T11:53:00.000Z"
          }
        }
      ],
      { latestOrder: { id: "order-id", status: "paid" } }
    );

    const result = await service.processDueFollowups(new Date("2026-07-06T12:00:00.000Z"));

    expect(result.sent).toBe(0);
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({ conversation_stage: "paid" })
    );
  });

  it("detects reseller flow and blocks final-customer follow-ups", async () => {
    const { service, evolutionService, conversationsRepository } = createService(
      [
        {
          id: "conversation-id",
          customer_id: "customer-id",
          customers: { id: "customer-id", phone: "553387040799" },
          metadata: {
            followup_key: "pix",
            followup_due_at: "2026-07-06T12:43:00.000Z",
            last_bot_message_at: "2026-07-06T12:40:00.000Z",
            last_customer_message_at: "2026-07-06T12:39:00.000Z"
          }
        }
      ],
      {
        recentMessages: [
          { id: "m1", role: "customer", content: "Nao tem revenda?", created_at: "2026-07-06T15:43:00.000Z" },
          { id: "m2", role: "customer", content: "Gostaria de ser revendedor", created_at: "2026-07-06T15:43:30.000Z" },
          { id: "m3", role: "human_agent", content: "Entendo, gostaria de comecar com quantos rounds?", created_at: "2026-07-06T15:47:00.000Z" },
          { id: "m4", role: "human_agent", content: "Qual valor voce fazia?", created_at: "2026-07-06T15:50:00.000Z" }
        ],
        openOrder: { id: "order-id", status: "pending_payment", payment_method: "pix" }
      }
    );

    const result = await service.processDueFollowups(new Date("2026-07-06T16:00:00.000Z"));

    expect(result.sent).toBe(0);
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        conversation_stage: "human_support_reseller",
        lead_profile: expect.objectContaining({ reseller_intent: true })
      })
    );
  });

  it("blocks duplicate text recently sent even with a different key", async () => {
    const textHash = "cfa3d71fa127a3fe8cc97f2581da5103e0eafbd5d9d4a1a722d85d1f0e94372f";
    const { service, evolutionService } = createService([
      {
        id: "conversation-id",
        customer_id: "customer-id",
        customers: { id: "customer-id", phone: "5511999998888" },
        metadata: {
          followup_key: "values",
          followup_due_at: "2026-07-06T11:59:00.000Z",
          last_followup_text_hash: textHash,
          last_followup_sent_at: "2026-07-06T11:58:00.000Z",
          last_bot_message_at: "2026-07-06T11:54:00.000Z",
          last_customer_message_at: "2026-07-06T11:53:00.000Z"
        }
      }
    ]);

    const result = await service.processDueFollowups(new Date("2026-07-06T12:00:00.000Z"));

    expect(result.sent).toBe(0);
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
  });

  it("cancels generic plan follow-up when specialist already closed sale and is delivering access", async () => {
    const now = new Date("2026-07-06T15:02:00.000Z");
    const { service, evolutionService, conversationsRepository } = createService(
      [
        {
          id: "conversation-id",
          customer_id: "customer-id",
          customers: { id: "customer-id", phone: "5511999998888" },
          metadata: {
            followup_key: "plan_choice",
            followup_due_at: "2026-07-06T15:01:00.000Z",
            last_bot_message_at: "2026-07-06T14:40:00.000Z",
            last_customer_message_at: "2026-07-06T14:57:00.000Z",
            last_specialist_message_at: "2026-07-06T14:57:00.000Z",
            last_followup_stage_id: "ask_price:plan_choice:1",
            followup_count: 0
          }
        }
      ],
      {
        recentMessages: [
          { role: "human_agent", content: "Entre nesse mesmo local", created_at: "2026-07-06T14:51:00.000Z" },
          { role: "human_agent", content: "E me mande uma foto", created_at: "2026-07-06T14:51:00.000Z" },
          { role: "human_agent", content: "Pra lhe instruir onde entrar", created_at: "2026-07-06T14:51:00.000Z" },
          { role: "customer", content: "[foto da tela de recarga]", created_at: "2026-07-06T14:52:00.000Z" },
          { role: "human_agent", content: "Veja se voce ver se tem algum botao ativar recarga", created_at: "2026-07-06T14:53:00.000Z" },
          { role: "customer", content: "[foto centro de resgate]", created_at: "2026-07-06T14:54:00.000Z" },
          { role: "human_agent", content: "Pronto ai mesmo, ja lhe mando.", created_at: "2026-07-06T14:54:00.000Z" },
          { role: "human_agent", content: "So aguardando o fornecedor responder", created_at: "2026-07-06T14:57:00.000Z" },
          { role: "human_agent", content: "E ja lhe mando o acesso", created_at: "2026-07-06T14:57:00.000Z" },
          { role: "customer", content: "👍", created_at: "2026-07-06T14:57:00.000Z" }
        ]
      }
    );

    const result = await service.processDueFollowups(now);

    expect(result.sent).toBe(0);
    expect(evolutionService.sendTextMessage).not.toHaveBeenCalled();
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        followup_key: null,
        followup_cancel_reason: expect.stringMatching(/specialist|customer_resolved|self_monitoring/),
        conversation_stage: "human_support_activation"
      })
    );
  });
});
