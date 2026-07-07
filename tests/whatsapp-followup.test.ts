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
  } = {}
) {
  const conversationsRepository = {
    listOpenConversations: vi.fn(async () => conversations),
    updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: _id, metadata })),
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
    generateResponse: vi.fn(async () => options.aiReply ?? null)
  };

  return {
    service: new WhatsappFollowupService(
      conversationsRepository as never,
      messagesRepository as never,
      evolutionService as never,
      auditService as never,
      undefined,
      salesResponseAIService as never
    ),
    conversationsRepository,
    messagesRepository,
    evolutionService,
    auditService,
    salesResponseAIService
  };
}

describe("WhatsappFollowupService", () => {
  it("builds human commercial follow-up text", () => {
    const valuesFollowup = buildFollowupText({ followup_key: "values", plan_interest: "mensal" });
    expect(valuesFollowup).toBe("Você se interessou pelos valores? Posso te indicar o melhor plano pra começar ✅");
    expect(valuesFollowup).not.toContain("pagamento");
    expect(valuesFollowup).not.toContain("comprovante");
    expect(valuesFollowup).not.toContain("Ver planos");
    expect(valuesFollowup).not.toContain("Fazer teste grátis");
    expect(valuesFollowup).not.toContain("Comprar agora");
    expect(buildFollowupText({ followup_key: "welcome_activation" })).toBe(
      "Você quer que eu te passe os valores ou prefere fazer o teste grátis de 3 dias?"
    );
    const downloadFollowup = buildFollowupText({ followup_key: "download", device: "TV Box / Android TV" });
    expect(downloadFollowup).toContain("Conseguiu instalar na TV Box");
    expect(downloadFollowup.trim().endsWith("?")).toBe(true);
    expect(buildFollowupText({ followup_key: "download", device: "android_tv_google_tv" })).toContain("Play Store");
    expect(buildFollowupText({ followup_key: "download", device: "android_phone" })).toContain("celular Android");
    expect(buildFollowupText({ followup_key: "download", device: "firestick" })).toContain("8322904");
    expect(buildFollowupText({ followup_key: "install", device: "unknown" })).toContain("Android ou Play Store?");
    expect(buildUnansweredCustomerFallbackText({ followup_key: "download", conversation_stage: "instalacao" }, "Ok")).toBe("Você conseguiu?");
  });

  it("uses renewal wording after values when the customer wants recarga", () => {
    const renewalFollowup = buildFollowupText({
      followup_key: "values",
      conversation_stage: "recarga",
      lead_profile: { wants_recharge: true, ultima_intencao: "renew_plan" }
    });

    expect(renewalFollowup).toBe("Você se interessou pelos valores? Posso te indicar o melhor plano pra renovar ✅");
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
      expect.objectContaining({ phone: "5511999998888", text: expect.stringContaining("valores") })
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
      expect.objectContaining({
        text: "João, voce ja usou o UNITV?\n\nSe nao, posso te enviar 3 dias gratis para testar.\n\nQual aparelho voce quer testar: TV Box, Android TV, celular Android ou Fire Stick?"
      })
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
        followup_due_at: "2026-07-06T12:45:00.000Z",
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
        text: expect.stringContaining("Voce ja usou o UNITV?")
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
        followup_due_at: "2026-07-06T13:20:00.000Z"
      })
    );
  });

  it("marks the lead recovery promotion and schedules the next recovery step", async () => {
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
      expect.objectContaining({
        text: expect.stringContaining("O mensal é R$ 25, mas pra você começar agora consigo liberar por R$ 19,99.")
      })
    );
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        followup_due_at: "2026-07-06T17:00:00.000Z",
        lead_recovery_followup_step: 2,
        promo_followup_sent_at: now.toISOString(),
        lead_profile: expect.objectContaining({
          special_promo_followup_sent: true,
          special_promo_offer: "mensal_19_99_first_2_months"
        })
      })
    );
  });

  it("finishes lead recovery after the fourth follow-up without payment language", () => {
    expect(shouldUseLeadRecoverySequence({
      followup_key: "welcome_activation",
      lead_recovery_followup_step: 3,
      lead_profile: { intencao_inicial: "greeting" }
    })).toBe(true);
    expect(getLeadRecoveryFollowup({
      followup_key: "welcome_activation",
      last_followup_stage_id: "greeting:welcome_activation:1:recovery:4",
      lead_recovery_followup_base_stage_id: "greeting:welcome_activation:1",
      lead_recovery_followup_step: 3,
      lead_profile: { intencao_inicial: "greeting" }
    })).toEqual({
      step: 4,
      baseStageId: "greeting:welcome_activation:1",
      stageId: "greeting:welcome_activation:1:recovery:4"
    });

    const lastCall = buildLeadRecoveryFollowupText(4, { lead_profile: { nome: "Maria" } });
    expect(lastCall).toContain("Oi, Maria");
    expect(lastCall).toContain("R$ 19,99");
    expect(lastCall).not.toContain("pagamento");
    expect(lastCall).not.toContain("comprovante");
    expect(buildLeadRecoveryFollowupText(1, { lead_profile: {} })).toContain("Voce ja usou o UNITV?");
    expect(buildLeadRecoveryFollowupText(2, { lead_profile: {} }).startsWith("Consigo uma condição especial")).toBe(true);
  });

  it("sends a one-time promotional recovery follow-up for hot leads before payment", async () => {
    const now = new Date("2026-07-06T12:00:00.000Z");
    const { service, evolutionService, conversationsRepository } = createService([
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
            payment_status: "not_paid"
          }
        }
      }
    ]);

    const result = await service.processDueFollowups(now);

    expect(result.sent).toBe(1);
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Maria, consigo fazer uma condi")
      })
    );
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("R$ 19,99")
      })
    );
    expect(conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith(
      "conversation-id",
      expect.objectContaining({
        promo_followup_sent_at: now.toISOString(),
        lead_profile: expect.objectContaining({
          special_promo_followup_sent: true,
          special_promo_offer: "mensal_19_99_first_2_months"
        })
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
    expect(paymentChoice).toContain("Vou te passar a chave PIX agora");
    expect(paymentChoice).not.toContain("Conseguiu fazer o pagamento?");

    const pixFollowup = buildFollowupText({ followup_key: "pix" });
    expect(pixFollowup).toContain("Conseguiu fazer o pagamento?");
    expect(pixFollowup).toContain("comprovante");
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
        aiReply: "Você conseguiu?"
      }
    );

    const result = await service.processDueFollowups(now);

    expect(result).toEqual({ checked: 1, sent: 1, skipped: 0 });
    expect(salesResponseAIService.generateResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Ok",
        recentMessages: expect.arrayContaining([expect.objectContaining({ role: "customer", content: "Ok" })]),
        fallbackReply: "Você conseguiu?"
      })
    );
    expect(evolutionService.sendTextMessage).toHaveBeenCalledWith({
      phone: "5511999998888",
      text: "Você conseguiu?"
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
});
