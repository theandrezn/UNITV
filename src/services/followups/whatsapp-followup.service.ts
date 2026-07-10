import "server-only";
import { randomUUID } from "node:crypto";
import { ConversationsRepository } from "@/repositories/conversations.repository";
import { MessagesRepository } from "@/repositories/messages.repository";
import { EvolutionService } from "@/services/evolution/evolution.service";
import { AuditService } from "@/services/audit.service";
import { AgentEventLogService } from "@/services/audit/agent-event-log.service";
import { SalesResponseAIService } from "@/services/agent/sales-response-ai.service";
import { OrdersService } from "@/services/orders.service";
import { AgentLearningMemoriesRepository } from "@/repositories/agent-learning-memories.repository";
import { validateFollowupWithConversationBrain } from "@/services/agent/conversation-brain.service";
import {
  buildFollowupContextHash,
  ContextualFollowupDecisionService,
  decideFollowupDeterministically,
  hashText,
  type FollowupContext,
  type FollowupContextMessage,
  type FollowupDecision
} from "@/services/followups/contextual-followup-decision.service";

const MAX_FOLLOWUP_COUNT_PER_STAGE = 1;
const MAX_LEAD_RECOVERY_FOLLOWUPS = 3;
const HUMAN_SILENCE_WINDOW_MS = 5 * 60 * 1000;
const UNANSWERED_BOT_FOLLOWUP_DELAY_MS = 5 * 60 * 1000;
const UNANSWERED_CUSTOMER_FOLLOWUP_DELAY_MS = 5 * 60 * 1000;
const RECENT_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const SPECIAL_PROMO_OFFER_ID = "mensal_19_99_first_2_months";
const MONTHLY_PROMO_FOLLOWUP_KEY = "monthly_promo_19_99_check";
const LEAD_RECOVERY_DELAYS_AFTER_SEND_MS = [
  2 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000
];

type ConversationRow = {
  id: string;
  customer_id?: string | null;
  external_conversation_id?: string | null;
  metadata?: Record<string, unknown> | null;
  customers?: { id?: string; phone?: string | null; name?: string | null } | null;
};

type FollowupResult = {
  checked: number;
  sent: number;
  skipped: number;
};

const inProcessDedupeKeys = new Set<string>();

export class WhatsappFollowupService {
  constructor(
    private readonly conversationsRepository = new ConversationsRepository(),
    private readonly messagesRepository = new MessagesRepository(),
    private readonly evolutionService = new EvolutionService(),
    private readonly auditService = new AuditService(),
    private readonly agentEventLogService?: AgentEventLogService,
    private readonly salesResponseAIService = new SalesResponseAIService(),
    private readonly ordersService = new OrdersService(),
    _contextualFollowupDecisionService = new ContextualFollowupDecisionService(),
    private readonly agentLearningMemoriesRepository?: AgentLearningMemoriesRepository
  ) {}

  async processDueFollowups(now = new Date()): Promise<FollowupResult> {
    const conversations = (await this.conversationsRepository.listOpenConversations(200)) as ConversationRow[];
    let sent = 0;
    let skipped = 0;
    inProcessDedupeKeys.clear();
    const phonesSentThisRun = new Set<string>();

    for (const conversation of conversations) {
      const metadata = conversation.metadata || {};
      const unansweredCustomerFollowup = getUnansweredCustomerFollowup(metadata, now);
      const unansweredBotFollowup = getUnansweredBotFollowup(metadata, now);
      if (!isDue(metadata.followup_due_at, now) && !unansweredCustomerFollowup && !unansweredBotFollowup) {
        continue;
      }

      const skipReason = getSkipReason(metadata, now, {
        allowCustomerReplied: Boolean(unansweredCustomerFollowup),
        ignoreStageLimit: Boolean(unansweredCustomerFollowup)
      });
      if (skipReason) {
        skipped++;
        await this.auditService.createAuditLog({
          actor_type: "system",
          action: "whatsapp_followup_skipped",
          entity_type: "conversations",
          entity_id: conversation.id,
          metadata: { reason: skipReason, followup_due_at: metadata.followup_due_at }
        });
        continue;
      }

      const phone = readCustomerPhone(conversation);
      if (!phone) {
        skipped++;
        continue;
      }

      if (phonesSentThisRun.has(phone)) {
        skipped++;
        await this.conversationsRepository.updateConversationMetadata(
          conversation.id,
          buildCancelledFollowupMetadata(
            metadata,
            buildMinimalDuplicatePhoneContext(conversation, metadata, now, phone),
            {
              should_send_followup: false,
              followup_type: "none",
              reason: "Outra conversa aberta do mesmo WhatsApp ja recebeu follow-up nesta rodada.",
              conversation_summary: "Duplicidade de conversa aberta para o mesmo telefone.",
              evidence: [`phone=${phone}`],
              suggested_message: null,
              cancel_existing_followup: true,
              new_stage: null,
              new_followup_key: null,
              confidence: 1
            },
            "duplicate_phone_in_job",
            now
          )
        );
        await this.auditService.createAuditLog({
          actor_type: "system",
          action: "followup_decision",
          entity_type: "conversations",
          entity_id: conversation.id,
          metadata: {
            should_send_followup: false,
            reason: "duplicate_phone_in_job",
            duplicate_blocked: true,
            phone,
            previous_followup_key: metadata.followup_key
          }
        });
        continue;
      }

      const context = await this.buildFollowupContext(conversation, metadata, now, phone);
      const alreadyProcessedReason = getAlreadyProcessedFollowupReason(metadata, context);
      if (alreadyProcessedReason) {
        skipped++;
        await this.conversationsRepository.updateConversationMetadata(
          conversation.id,
          buildProcessedFollowupMetadata(metadata, context, now, alreadyProcessedReason, {
            unansweredCustomerFollowup,
            unansweredBotFollowup
          })
        );
        await this.auditService.createAuditLog({
          actor_type: "system",
          action: "followup_preflight_blocked",
          entity_type: "conversations",
          entity_id: conversation.id,
          metadata: {
            reason: alreadyProcessedReason,
            followup_key: metadata.followup_key || null,
            context_hash: context.last_followup_context_hash
          }
        });
        continue;
      }

      // Context, stage and idempotency decide whether an automatic action is allowed.
      // AI only composes wording after this guard has approved a new follow-up.
      const scheduledDecision = decideFollowupDeterministically(context);
      const validation = validateFollowupAgainstConversationContext(context, scheduledDecision);
      const decision = validation.correctedDecision || scheduledDecision;
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: validation.allowed ? "followup_context_validation_allowed" : "followup_context_validation_blocked",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: {
          contactId: phone,
          followupKey: metadata.followup_key,
          blockedFollowupKey: validation.allowed ? null : metadata.followup_key,
          detectedStage: validation.detectedStage,
          detectedIntent: validation.detectedIntent,
          reason: validation.reason,
          reasonBlocked: validation.allowed ? null : validation.reason,
          confidence: validation.confidence,
          replacementFollowupKey: validation.replacementFollowupKey || null,
          lastCustomerMessage: context.latest_customer_message?.content || null,
          lastHumanMessage: context.latest_human_message?.content || null,
          lastBotMessage: context.latest_bot_message?.content || null
        }
      });
      if (!validation.allowed && !validation.correctedDecision) {
        skipped++;
        await this.recordFollowupCancellation(conversation, phone, metadata, validation.reason);
        await this.conversationsRepository.updateConversationMetadata(
          conversation.id,
          buildProcessedFollowupMetadata(
            metadata,
            context,
            now,
            validation.reason,
            { unansweredCustomerFollowup, unansweredBotFollowup },
            {
              ...decision,
              cancel_existing_followup: true,
              new_stage: validation.detectedStage,
              new_followup_key: null
            }
          )
        );
        continue;
      }
      const policy = validateFollowupPolicy(context, decision, now);
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: "followup_decision",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: {
          should_send_followup: policy.shouldSend,
          followup_type: metadata.followup_type || decision.followup_type,
          scheduled_for: metadata.followup_due_at || null,
          device_detected: metadata.device || context.lead_profile.device || context.lead_profile.aparelho || null,
          reason: policy.reason || decision.reason,
          cancelled_reason: policy.shouldSend ? null : policy.reason || decision.reason,
          evidence: decision.evidence,
          cancel_reason: policy.shouldSend ? null : policy.reason || decision.reason,
          dedupe_key: policy.dedupeKey,
          duplicate_blocked: policy.duplicateBlocked,
          previous_followup_key: metadata.followup_key,
          new_followup_key: decision.new_followup_key,
          last_customer_message_at: context.latest_customer_message?.created_at || metadata.last_customer_message_at || null,
          last_bot_download_message_at: metadata.last_bot_download_message_at || null,
          last_customer_message_id: context.latest_customer_message?.id || context.latest_customer_message?.external_message_id || null,
          last_human_message_at: context.latest_human_message?.created_at || metadata.last_specialist_message_at || null,
          human_hold_active: context.human_hold_active,
          stage_before: metadata.conversation_stage || context.lead_profile.stage || null,
          stage_after: decision.new_stage,
          open_order_id: context.open_order?.id || null,
          payment_status: context.latest_order?.status || context.open_order?.status || context.lead_profile.payment_status || null,
          confidence: decision.confidence
        }
      });

      if (!policy.shouldSend) {
        skipped++;
        await this.recordFollowupCancellation(conversation, phone, metadata, policy.reason || decision.reason);
        await this.conversationsRepository.updateConversationMetadata(
          conversation.id,
          buildProcessedFollowupMetadata(
            metadata,
            context,
            now,
            policy.reason || decision.reason,
            { unansweredCustomerFollowup, unansweredBotFollowup },
            decision
          )
        );
        continue;
      }

      if (policy.dedupeKey) {
        inProcessDedupeKeys.add(policy.dedupeKey);
      }
      phonesSentThisRun.add(phone);

      const leadRecovery = decision.followup_type === "pre_sale_recharge_later" ? null : getLeadRecoveryFollowup(metadata);
      const stageId = unansweredCustomerFollowup
        ? unansweredCustomerFollowup.stageId
        : unansweredBotFollowup
        ? unansweredBotFollowup.stageId
        : leadRecovery
        ? leadRecovery.stageId
        : String(metadata.last_followup_stage_id || randomUUID());
      const promoRecovery = !leadRecovery && decision.followup_type !== "payment_check" && shouldSendPromoRecoveryFollowup(metadata);
      const fallbackFollowupText = policy.message || (unansweredCustomerFollowup
        ? buildUnansweredCustomerFallbackText(metadata, context.latest_customer_message?.content || "")
        : leadRecovery
        ? buildLeadRecoveryFollowupText(leadRecovery.step, metadata, conversation)
        : promoRecovery
          ? buildPromoRecoveryFollowupText(metadata, conversation)
          : buildFollowupText(metadata));
      const followupText = await this.buildContextualFollowupText({
        context,
        decision,
        fallbackText: fallbackFollowupText,
        reason: unansweredCustomerFollowup
          ? "ultima_mensagem_do_cliente_sem_resposta"
          : leadRecovery
          ? `recuperacao_de_lead_etapa_${leadRecovery.step}`
          : promoRecovery
            ? "recuperacao_promocional"
            : "followup_contextual"
      });
      if (!followupText) {
        skipped++;
        await this.recordFollowupCancellation(conversation, phone, metadata, "contextual_ai_reply_unavailable");
        await this.conversationsRepository.updateConversationMetadata(
          conversation.id,
          buildContextualAiUnavailableMetadata(metadata, context, decision, now)
        );
        await this.auditService.createAuditLog({
          actor_type: "system",
          action: "whatsapp_followup_skipped",
          entity_type: "conversations",
          entity_id: conversation.id,
          metadata: {
            reason: "contextual_ai_reply_unavailable",
            followup_key: metadata.followup_key,
            stageId,
            decision_reason: decision.reason,
            retry_due_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString()
          }
        });
        continue;
      }
      if (isOnlyQuestionMark(followupText)) {
        skipped++;
        await this.recordFollowupCancellation(conversation, phone, metadata, "unsafe_question_mark_followup");
        await this.conversationsRepository.updateConversationMetadata(
          conversation.id,
          buildProcessedFollowupMetadata(
            metadata,
            context,
            now,
            "unsafe_question_mark_followup",
            { unansweredCustomerFollowup, unansweredBotFollowup },
            decision
          )
        );
        await this.auditService.createAuditLog({
          actor_type: "system",
          action: "whatsapp_followup_skipped",
          entity_type: "conversations",
          entity_id: conversation.id,
          metadata: {
            reason: "unsafe_question_mark_followup",
            followup_key: metadata.followup_key,
            stageId,
            decision_reason: decision.reason
          }
        });
        continue;
      }
      const followupTextHash = hashText(followupText);
      const sendResult = await this.evolutionService.sendTextMessage({ phone, text: followupText });
      const leadProfile = readLeadProfile(metadata);
      const nextLeadRecoveryDueAt = leadRecovery ? getNextLeadRecoveryDueAt(leadRecovery.step, now) : null;
      const sentSpecialOffer = promoRecovery || decision.new_followup_key === MONTHLY_PROMO_FOLLOWUP_KEY;
      const nextMetadata = {
        ...metadata,
        followup_due_at: nextLeadRecoveryDueAt,
        followup_retry_due_at: null,
        followup_rescheduled_for_context: Boolean(nextLeadRecoveryDueAt),
        followup_sent_at: now.toISOString(),
        followup_sent_stage_id: stageId,
        last_followup_sent_at: now.toISOString(),
        last_followup_key_sent: decision.new_followup_key || metadata.followup_key || null,
        last_followup_base_message_id: context.latest_customer_message?.id || context.latest_customer_message?.external_message_id || context.latest_bot_message?.id || context.latest_bot_message?.external_message_id || null,
        last_followup_text_hash: followupTextHash,
        followup_dedupe_key: policy.dedupeKey,
        followup_context_hash: context.last_followup_context_hash,
        followup_count: Number(metadata.followup_count || 0) + 1,
        last_followup_stage_id: leadRecovery && nextLeadRecoveryDueAt
          ? `${leadRecovery.baseStageId}:recovery:${leadRecovery.step + 1}`
          : stageId,
        last_bot_message_at: now.toISOString(),
        ...(unansweredCustomerFollowup
          ? {
              unanswered_customer_followup_sent_at: now.toISOString(),
              unanswered_customer_followup_stage_id: stageId,
              unanswered_customer_followup_for_message_at: unansweredCustomerFollowup.customerMessageAt
            }
          : {}),
        ...(unansweredBotFollowup
          ? {
              unanswered_bot_followup_sent_at: now.toISOString(),
              unanswered_bot_followup_stage_id: stageId,
              unanswered_bot_followup_for_message_at: unansweredBotFollowup.botMessageAt
            }
          : {}),
        ...(leadRecovery
          ? {
              lead_recovery_followup_step: leadRecovery.step,
              lead_recovery_followup_last_sent_at: now.toISOString(),
              lead_recovery_followup_completed: leadRecovery.step >= MAX_LEAD_RECOVERY_FOLLOWUPS,
              lead_recovery_followup_base_stage_id: leadRecovery.baseStageId
            }
          : {}),
        ...(sentSpecialOffer
          ? {
              promo_followup_sent_at: now.toISOString(),
              promo_followup_stage_id: stageId,
              lead_profile: {
                ...leadProfile,
                special_promo_followup_sent: true,
                special_promo_followup_sent_at: now.toISOString(),
                special_promo_offer: SPECIAL_PROMO_OFFER_ID,
                special_promo_price_cents: 1999,
                original_price_cents: 2500,
                stage: "special_promo_offered",
                commercial_stage: "special_promo_offered",
                next_expected_reply: "promo_confirmation",
                last_bot_question: "Quer aproveitar essa condicao?",
                next_best_action: "cliente_confirmar_promocao_para_receber_pix",
                proxima_acao: "cliente confirmar promocao para receber Pix"
              }
            }
          : {
              lead_profile: {
                ...leadProfile,
                ...(decision.new_stage ? { stage: decision.new_stage, commercial_stage: decision.new_stage } : {}),
                ...(decision.new_followup_key === "reseller_check" || decision.new_stage === "reseller_flow" || decision.new_stage === "human_support_reseller"
                  ? { reseller_intent: true }
                  : {}),
                updated_at: now.toISOString()
              }
            })
      };

      await this.messagesRepository.createMessage({
        conversation_id: conversation.id,
        customer_id: conversation.customer_id || conversation.customers?.id || null,
        role: "assistant",
        content: followupText,
        content_type: "text",
        external_message_id: `followup:${conversation.id}:${stageId}`,
        metadata: {
          sendResult,
          followup_key: metadata.followup_key,
          stageId,
          followup_decision: decision,
          followup_dedupe_key: policy.dedupeKey,
          followup_text_hash: followupTextHash,
          promo_recovery: promoRecovery,
          unanswered_bot_followup: Boolean(unansweredBotFollowup),
          unanswered_customer_followup: Boolean(unansweredCustomerFollowup),
          lead_recovery_step: leadRecovery?.step || null
        }
      });
      await this.conversationsRepository.updateConversationMetadata(conversation.id, nextMetadata);
      await this.conversationsRepository.touchConversation(conversation.id, now.toISOString());
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: "whatsapp_followup_sent",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: {
          contactId: phone,
          followup_key: metadata.followup_key,
          stageId,
          sendResult,
          reason: decision.reason,
          confidence: decision.confidence,
          detectedStage: decision.new_stage || context.lead_profile.stage || context.metadata.conversation_stage || null,
          detectedIntent: decision.followup_type,
          lastCustomerMessage: context.latest_customer_message?.content || null,
          lastHumanMessage: context.latest_human_message?.content || null,
          lastBotMessage: context.latest_bot_message?.content || null,
          dedupe_key: policy.dedupeKey,
          promo_recovery: promoRecovery,
          unanswered_bot_followup: Boolean(unansweredBotFollowup),
          lead_recovery_step: leadRecovery?.step || null
        }
      });
      await this.safeCreateAgentEvent({
        conversation_id: conversation.id,
        customer_phone: phone,
        event_type: "followup_sent",
        event_source: "followup_job",
        stage: typeof metadata.conversation_stage === "string" ? metadata.conversation_stage : null,
        device: typeof metadata.device === "string" ? metadata.device : null,
        plan_interest: typeof metadata.plan_interest === "string" ? metadata.plan_interest : null,
        message_id: `followup:${conversation.id}:${stageId}`,
        metadata: {
          followup_key: metadata.followup_key,
          followup_count: nextMetadata.followup_count,
          stageId,
          reason: decision.reason,
          confidence: decision.confidence,
          dedupe_key: policy.dedupeKey,
          promo_recovery: promoRecovery,
          unanswered_bot_followup: Boolean(unansweredBotFollowup),
          unanswered_customer_followup: Boolean(unansweredCustomerFollowup),
          lead_recovery_step: leadRecovery?.step || null
        }
      });

      sent++;
    }

    return { checked: conversations.length, sent, skipped };
  }

  private async buildUnansweredCustomerFollowupText(conversation: ConversationRow, metadata: Record<string, unknown>) {
    const recentMessages = await this.listRecentMessages(conversation.id);
    const latestCustomerMessage = [...recentMessages].reverse().find((item) => item.role === "customer");
    const fallbackReply = buildUnansweredCustomerFallbackText(metadata, latestCustomerMessage?.content || "");
    const leadProfile = readLeadProfile(metadata);
    const aiReply = await this.salesResponseAIService.generateResponse({
      message: latestCustomerMessage?.content || String(leadProfile.last_customer_answer || ""),
      intent: String(leadProfile.ultima_intencao || metadata.conversation_stage || "unknown"),
      leadProfile: {
        ...leadProfile,
        followup_reason: "ultima_mensagem_do_cliente_sem_resposta"
      },
      recentMessages,
      fallbackReply,
      conversationId: conversation.id,
      useStrongModel: false
    });

    return aiReply;
  }

  private async buildContextualFollowupText(input: {
    context: FollowupContext;
    decision: FollowupDecision;
    fallbackText: string;
    reason: string;
  }): Promise<string | null> {
    const leadProfile = input.context.lead_profile || {};
    const latestCustomerMessage = input.context.latest_customer_message?.content || String(leadProfile.last_customer_answer || "");
    const learningMemories = await this.listRelevantLearningMemories(input.context);
    const aiReply = await this.salesResponseAIService.generateResponse({
      message: [
        latestCustomerMessage,
        "",
        `Contexto do follow-up: ${input.reason}.`,
        `Resumo da decisao: ${input.decision.conversation_summary}.`,
        `Motivo: ${input.decision.reason}.`,
        "Escreva uma unica mensagem curta, natural e contextual.",
        "Nao copie texto pronto nem repita mensagem recente.",
        "Use o historico completo para decidir o proximo passo.",
        input.decision.followup_type === "pre_sale_recharge_later"
          ? "Este e um follow-up de pre-venda: o cliente disse que faria depois. Peca permissao para mandar a chave Pix, com baixa pressao, sem reiniciar saudacao, sem tabela completa e sem inventar nome."
          : "",
        input.decision.new_followup_key === MONTHLY_PROMO_FOLLOWUP_KEY
          ? "Esta condicao foi autorizada pelo sistema: mensal por R$ 19,99. Mencione exatamente esse valor, componha uma frase nova e faca uma unica pergunta de interesse. Nao cite outro preco nem gere Pix."
          : "",
        "Nao invente Pix, preco, codigo, pagamento confirmado ou compatibilidade."
      ].join("\n"),
      intent: input.decision.followup_type,
      leadProfile: {
        ...leadProfile,
        followup_type: input.decision.followup_type,
        followup_reason: input.reason,
        followup_evidence: input.decision.evidence
      },
      recentMessages: input.context.recent_messages.map((message) => ({
        role: message.role || undefined,
        content: message.content || null
      })),
      learningMemories,
      fallbackReply: input.fallbackText,
      conversationId: input.context.conversation_id,
      // Safety and stage are already decided locally. A mini model is enough for one natural sentence.
      useStrongModel: false
    });

    if (aiReply) {
      return aiReply;
    }
    return null;
  }

  private async listRecentMessages(conversationId: string) {
    const listMessages = (this.messagesRepository as unknown as {
      listMessagesByConversationId?: (conversationId: string, limit?: number) => Promise<Array<Record<string, unknown>>>;
    }).listMessagesByConversationId;
    if (!listMessages) {
      return [];
    }

    try {
      const messages = await listMessages.call(this.messagesRepository, conversationId, 12);
      return messages.map((item) => ({
        id: typeof item.id === "string" ? item.id : null,
        role: typeof item.role === "string" ? item.role : undefined,
        content: typeof item.content === "string" ? item.content : null,
        created_at: typeof item.created_at === "string" ? item.created_at : null,
        external_message_id: typeof item.external_message_id === "string" ? item.external_message_id : null
      }));
    } catch {
      return [];
    }
  }

  private async buildFollowupContext(
    conversation: ConversationRow,
    metadata: Record<string, unknown>,
    now: Date,
    phone: string
  ): Promise<FollowupContext> {
    const recentMessages = (await this.listRecentMessages(conversation.id) as FollowupContextMessage[])
      .slice(-12)
      .map(compactFollowupMessage);
    const leadProfile = compactFollowupLeadProfile(readLeadProfile(metadata));
    const latestCustomerMessage = findLatestMessageByRole(recentMessages, "customer");
    const latestBotMessage = findLatestMessageByRole(recentMessages, "assistant");
    const latestHumanMessage = findLatestMessageByRole(recentMessages, "human_agent");
    const lastMessage = recentMessages[recentMessages.length - 1] || null;
    const customerId = conversation.customer_id || conversation.customers?.id || null;
    const openOrder = customerId ? await this.safeFindLatestOpenOrder(customerId) : null;
    const latestOrder = customerId ? await this.safeFindLatestOrder(customerId) : null;
    const contextBase = {
      conversation_id: conversation.id,
      followup_key: metadata.followup_key || null,
      latest_customer_message_id: latestCustomerMessage?.id || latestCustomerMessage?.external_message_id || null,
      latest_bot_message_id: latestBotMessage?.id || latestBotMessage?.external_message_id || null,
      latest_human_message_id: latestHumanMessage?.id || latestHumanMessage?.external_message_id || null,
      stage: metadata.conversation_stage || leadProfile.stage || null,
      open_order_id: openOrder?.id || null,
      open_order_status: openOrder?.status || null,
      last_messages: recentMessages.slice(-8).map((message) => `${message.role}:${message.content}`)
    };

    return {
      conversation_id: conversation.id,
      customer_id: customerId,
      phone,
      now: now.toISOString(),
      metadata: compactFollowupMetadata(metadata),
      lead_profile: leadProfile,
      recent_messages: recentMessages,
      latest_customer_message: latestCustomerMessage,
      latest_bot_message: latestBotMessage,
      latest_human_message: latestHumanMessage,
      last_speaker: typeof lastMessage?.role === "string" ? lastMessage.role : null,
      last_customer_was_answered: !isAfter(latestCustomerMessage?.created_at || metadata.last_customer_message_at, latestBotMessage?.created_at || metadata.last_bot_message_at),
      last_bot_question: extractLastQuestionFromMessage(latestBotMessage?.content || String(leadProfile.last_bot_question || "")),
      last_human_question: extractLastQuestionFromMessage(latestHumanMessage?.content || ""),
      open_order: sanitizeOrder(openOrder),
      latest_order: sanitizeOrder(latestOrder),
      human_hold_active: Boolean(metadata.human_hold_until && isFutureDate(metadata.human_hold_until, now)) ||
        Boolean(metadata.requires_human && isRecentDate(metadata.last_specialist_message_at, now, HUMAN_SILENCE_WINDOW_MS)),
      followup_key: typeof metadata.followup_key === "string" ? metadata.followup_key : null,
      followup_due_at: typeof metadata.followup_due_at === "string" ? metadata.followup_due_at : null,
      last_followup_text_hash: typeof metadata.last_followup_text_hash === "string" ? metadata.last_followup_text_hash : null,
      last_followup_context_hash: buildFollowupContextHash(contextBase)
    };
  }

  private async safeFindLatestOpenOrder(customerId: string) {
    try {
      return await this.ordersService.findLatestOpenOrderByCustomerId(customerId) as Record<string, unknown> | null;
    } catch {
      return null;
    }
  }

  private async safeFindLatestOrder(customerId: string) {
    try {
      return await this.ordersService.findLatestOrderByCustomerId(customerId) as Record<string, unknown> | null;
    } catch {
      return null;
    }
  }

  private safeCreateAgentEvent(input: Parameters<AgentEventLogService["safeCreateEvent"]>[0]) {
    try {
      return (this.agentEventLogService || new AgentEventLogService()).safeCreateEvent(input);
    } catch {
      return null;
    }
  }

  private async listRelevantLearningMemories(context: FollowupContext) {
    try {
      const repository = this.agentLearningMemoriesRepository || new AgentLearningMemoriesRepository();
      return await repository.getRelevantMemories({
        intent: String(context.lead_profile.ultima_intencao || context.metadata.conversation_stage || "followup"),
        stage: String(context.lead_profile.stage || context.lead_profile.commercial_stage || context.metadata.conversation_stage || ""),
        customerMessage: context.latest_customer_message?.content || null,
        recentContext: context.recent_messages.slice(-12).map((message) => `${message.role || "unknown"}: ${message.content || ""}`).join("\n"),
        limit: 4
      });
    } catch {
      return [];
    }
  }

  private async recordFollowupCancellation(
    conversation: ConversationRow,
    phone: string,
    metadata: Record<string, unknown>,
    reason: string
  ) {
    await this.safeCreateAgentEvent({
      conversation_id: conversation.id,
      customer_phone: phone,
      event_type: "followup_cancelled",
      event_source: "followup_job",
      stage: typeof metadata.conversation_stage === "string" ? metadata.conversation_stage : null,
      device: typeof metadata.device === "string" ? metadata.device : null,
      plan_interest: typeof metadata.plan_interest === "string" ? metadata.plan_interest : null,
      message_id: `followup-cancelled:${conversation.id}:${String(metadata.last_followup_stage_id || "unknown")}`,
      metadata: {
        followup_key: metadata.followup_key || null,
        reason
      }
    });
  }
}

function validateFollowupPolicy(context: FollowupContext, decision: FollowupDecision, now: Date) {
  const message = decision.suggested_message?.trim() || "";
  const textHash = message ? hashText(message) : null;
  const baseMessageId =
    context.latest_customer_message?.id ||
    context.latest_customer_message?.external_message_id ||
    context.latest_bot_message?.id ||
    context.latest_bot_message?.external_message_id ||
    "no-base-message";
  const dedupeKey = `${context.conversation_id}:${decision.new_followup_key || context.followup_key || "none"}:${baseMessageId}:${context.last_followup_context_hash}`;

  if (!decision.should_send_followup || !message) {
    return { shouldSend: false, message: null, dedupeKey, reason: decision.reason, duplicateBlocked: false };
  }

  if (context.human_hold_active) {
    return { shouldSend: false, message: null, dedupeKey, reason: "human_hold_active", duplicateBlocked: false };
  }

  const baseMessageAt = context.metadata.last_bot_download_message_at || context.metadata.last_bot_message_at;
  const brainFollowupValidation = validateFollowupWithConversationBrain({
    stage: String(context.lead_profile.stage || context.lead_profile.commercial_stage || context.metadata.conversation_stage || ""),
    followupKey: decision.new_followup_key || context.followup_key,
    humanHoldActive: context.human_hold_active,
    lastBotMessage: context.latest_bot_message?.content,
    customerRepliedAfterBaseMessage: isAfter(context.latest_customer_message?.created_at || context.metadata.last_customer_message_at, baseMessageAt),
    humanRepliedAfterBaseMessage: isAfter(context.latest_human_message?.created_at || context.metadata.last_specialist_message_at, baseMessageAt)
  });
  if (!brainFollowupValidation.allowed) {
    return { shouldSend: false, message: null, dedupeKey, reason: brainFollowupValidation.reason, duplicateBlocked: false };
  }

  if ((decision.new_followup_key || context.followup_key) === "post_download_check_10min") {
    const postDownloadValidation = validatePostDownloadFollowupContext(context);
    if (!postDownloadValidation.valid) {
      return { shouldSend: false, message: null, dedupeKey, reason: postDownloadValidation.reason, duplicateBlocked: false };
    }
  }

  if (inProcessDedupeKeys.has(dedupeKey) || context.metadata.followup_dedupe_key === dedupeKey) {
    return { shouldSend: false, message: null, dedupeKey, reason: "duplicate_dedupe_key", duplicateBlocked: true };
  }

  if (textHash && context.last_followup_text_hash === textHash && isRecentDate(context.metadata.last_followup_sent_at, now, RECENT_DUPLICATE_WINDOW_MS)) {
    return { shouldSend: false, message: null, dedupeKey, reason: "duplicate_recent_text", duplicateBlocked: true };
  }

  if (isRecentDate(context.metadata.last_followup_sent_at || context.metadata.followup_sent_at, now, RECENT_DUPLICATE_WINDOW_MS)) {
    return { shouldSend: false, message: null, dedupeKey, reason: "recent_followup_sent", duplicateBlocked: true };
  }

  if (context.last_followup_context_hash && context.metadata.followup_context_hash === context.last_followup_context_hash) {
    return { shouldSend: false, message: null, dedupeKey, reason: "duplicate_context_hash", duplicateBlocked: true };
  }

  if ((decision.followup_type === "payment_check" || context.followup_key === "pix") && !hasPendingPaymentOrder(context)) {
    return { shouldSend: false, message: null, dedupeKey, reason: "payment_followup_without_pending_order", duplicateBlocked: false };
  }

  if (isPaidContext(context)) {
    return { shouldSend: false, message: null, dedupeKey, reason: "payment_already_confirmed", duplicateBlocked: false };
  }

  if (isFinalCustomerMessageResolved(context)) {
    return { shouldSend: false, message: null, dedupeKey, reason: "customer_resolved_or_self_monitoring", duplicateBlocked: false };
  }

  if (isResellerMetadata(context) && !decision.followup_type.includes("reseller")) {
    return { shouldSend: false, message: null, dedupeKey, reason: "reseller_flow_blocks_customer_followup", duplicateBlocked: false };
  }

  return { shouldSend: true, message, dedupeKey, reason: null, duplicateBlocked: false };
}

function validatePostDownloadFollowupContext(context: FollowupContext) {
  const latestBotText = normalizeFollowupText(context.latest_bot_message?.content || "");
  const stage = normalizeFollowupText([
    context.metadata.conversation_stage,
    context.lead_profile.stage,
    context.lead_profile.commercial_stage,
    context.lead_profile.payment_status,
    context.open_order?.status,
    context.latest_order?.status
  ].join(" "));
  const lastBotDownloadAt = context.metadata.last_bot_download_message_at || context.metadata.last_bot_message_at;

  if (!/\b(mediafire|apk|download|baixar|baixe|downloader|862585|tutorial|youtube|instalar|instalacao)\b/.test(latestBotText)) {
    return { valid: false, reason: "last_bot_message_not_download" };
  }

  if (isAfter(context.latest_customer_message?.created_at || context.metadata.last_customer_message_at, lastBotDownloadAt)) {
    return { valid: false, reason: "customer_replied_after_download" };
  }

  if (isAfter(context.latest_human_message?.created_at || context.metadata.last_specialist_message_at, lastBotDownloadAt)) {
    return { valid: false, reason: "human_replied_after_download" };
  }

  if (/(^|[\s_-])(pagamento|payment|pix|aguardando_pix|paid|approved|approved_by_human|codigo|ativacao|human_support|humano|sale_closed|venda)(?=$|[\s_-])/.test(stage)) {
    return { valid: false, reason: "stage_changed_after_download" };
  }

  return { valid: true, reason: null };
}

export function validateFollowupAgainstConversationContext(context: FollowupContext, scheduledFollowup: FollowupDecision): {
  allowed: boolean;
  correctedFollowupType: FollowupDecision["followup_type"] | null;
  correctedDecision: FollowupDecision | null;
  replacementFollowupKey: string | null;
  reason: string;
  detectedStage: string;
  detectedIntent: string;
  confidence: number;
} {
  const detected = detectCurrentConversationStage(context);
  const key = String(context.followup_key || scheduledFollowup.new_followup_key || "");
  const isInitialFunnelFollowup =
    key === "welcome_activation" ||
    key === "test" ||
    scheduledFollowup.followup_type === "trial_check";

  if (detected.intent === "payment_intent_delayed" || detected.intent === "pre_sale_commitment_pending_payment") {
    if (scheduledFollowup.followup_type === "pre_sale_recharge_later" || key === "pre_sale_recharge_later_4h") {
      return {
        allowed: true,
        correctedFollowupType: null,
        correctedDecision: null,
        replacementFollowupKey: null,
        reason: "scheduled_followup_matches_current_pre_sale_context",
        detectedStage: detected.stage,
        detectedIntent: detected.intent,
        confidence: detected.confidence
      };
    }

    if (isInitialFunnelFollowup) {
      return {
        allowed: true,
        correctedFollowupType: "pre_sale_recharge_later",
        correctedDecision: buildPreSaleReplacementDecision(context, detected),
        replacementFollowupKey: "pre_sale_recharge_later_4h",
        reason: "replaced_stale_initial_followup_with_payment_intent_followup",
        detectedStage: detected.stage,
        detectedIntent: detected.intent,
        confidence: detected.confidence
      };
    }
  }

  if (detected.stage !== "initial_qualification" && isInitialFunnelFollowup) {
    return {
      allowed: false,
      correctedFollowupType: null,
      correctedDecision: null,
      replacementFollowupKey: null,
      reason: "blocked_initial_funnel_regression",
      detectedStage: detected.stage,
      detectedIntent: detected.intent,
      confidence: detected.confidence
    };
  }

  return {
    allowed: true,
    correctedFollowupType: null,
    correctedDecision: null,
    replacementFollowupKey: null,
    reason: "followup_matches_context",
    detectedStage: detected.stage,
    detectedIntent: detected.intent,
    confidence: detected.confidence
  };
}

function buildPreSaleReplacementDecision(context: FollowupContext, detected: { stage: string; intent: string; confidence: number }): FollowupDecision {
  const firstName = readFirstName(context.lead_profile.nome);
  const prefix = firstName ? `Boa tarde, ${firstName}.` : "Boa tarde.";
  return {
    should_send_followup: true,
    followup_type: "pre_sale_recharge_later",
    reason: "Follow-up antigo de qualificacao substituido por fechamento de pre-venda.",
    conversation_summary: "Conversa evoluiu para preco/oferta/aceite e intencao de pagamento futura.",
    evidence: collectContextEvidence(context),
    suggested_message: `${prefix} Posso te mandar a chave Pix para deixar sua recarga UNITV separada?`,
    cancel_existing_followup: false,
    new_stage: detected.stage,
    new_followup_key: "pre_sale_recharge_later_4h",
    confidence: detected.confidence
  };
}

function detectCurrentConversationStage(context: FollowupContext) {
  const profile = context.lead_profile || {};
  const text = normalizeText(context.recent_messages.slice(-20).map((message) => message.content || "").join("\n"));
  const hasCommercialCommitment = Boolean(
    profile.selected_plan ||
    profile.plano_interesse ||
    profile.requested_screens ||
    profile.negotiated_price_cents ||
    profile.quoted_price_cents ||
    profile.accepted_special_promo ||
    profile.payment_intent_status === "later" ||
    profile.last_detected_intent === "wants_to_recharge_later" ||
    /\b(duas telas|2 telas|3 telas|tres telas|r\$\s*\d+|\b17[,.]90\b|\b25\b|mensal|30 dias|recarga|chave pix|pix)\b/.test(text) ||
    (/\b(ok|beleza|pode ser|fechado)\b/.test(text) && /\b(condicao|fechar|plano|telas|17[,.]90|pix|recarga)\b/.test(text))
  );
  const delayedPayment = Boolean(
    profile.payment_intent_status === "later" ||
    profile.last_detected_intent === "wants_to_recharge_later" ||
    /\b(mais tarde|depois|daqui a pouco|logo mais|quando eu chegar)\b.{0,50}\b(faco|fazer|pago|pagar|recarga|recarrego|recarregar|fecho|fechar|realizo|realizar)\b/.test(text) ||
    /\b(vou realizar a recarga|vou pagar|vou fazer a recarga|vou fechar depois)\b/.test(text)
  );

  if (delayedPayment && hasCommercialCommitment) {
    return { stage: "payment_intent_delayed", intent: "payment_intent_delayed", confidence: 0.96 };
  }

  if (hasCommercialCommitment) {
    return { stage: "pre_sale_commitment_pending_payment", intent: "pre_sale_commitment_pending_payment", confidence: 0.91 };
  }

  return { stage: "initial_qualification", intent: "qualification", confidence: 0.82 };
}

function collectContextEvidence(context: FollowupContext) {
  return context.recent_messages
    .slice(-8)
    .map((message) => `${message.role || "unknown"}: ${String(message.content || "").slice(0, 140)}`);
}

function isOnlyQuestionMark(value: string) {
  return /^[?\s!.,]*$/.test(value.trim());
}

function buildCancelledFollowupMetadata(
  metadata: Record<string, unknown>,
  context: FollowupContext,
  decision: FollowupDecision & { new_followup_due_at?: string | null },
  reason: string,
  now: Date
) {
  const leadProfile = readLeadProfile(metadata);
  const newStage = decision.new_stage || inferCancelledStage(context, reason);
  const keepRescheduledFollowup = Boolean(decision.new_followup_due_at);
  const newFollowupKey = keepRescheduledFollowup ? decision.new_followup_key || null : null;
  return {
    ...metadata,
    followup_key: newFollowupKey,
    followup_due_at: keepRescheduledFollowup ? decision.new_followup_due_at || null : null,
    followup_retry_due_at: null,
    followup_rescheduled_for_context: keepRescheduledFollowup,
    followup_cancelled_at: now.toISOString(),
    followup_cancel_reason: reason,
    followup_context_hash: context.last_followup_context_hash,
    conversation_stage: newStage || metadata.conversation_stage || null,
    lead_profile: {
      ...leadProfile,
      ...(newStage ? { stage: newStage, commercial_stage: newStage } : {}),
      ...(reason.includes("reseller") || newStage === "reseller_flow" || newStage === "human_support_reseller" ? { reseller_intent: true } : {}),
      ...(reason.includes("resolved") || reason.includes("self_monitoring") || newStage === "active" ? { download_status: "resolved", install_status: "resolved" } : {}),
      ...(newStage === "active_trial" ? { trial_status: "testing", self_monitoring: true } : {}),
      last_followup_decision_reason: reason,
      updated_at: now.toISOString()
    }
  };
}

function buildProcessedFollowupMetadata(
  metadata: Record<string, unknown>,
  context: FollowupContext,
  now: Date,
  reason: string,
  pending: { unansweredCustomerFollowup: { customerMessageAt: string } | null; unansweredBotFollowup: { botMessageAt: string } | null },
  decision: (FollowupDecision & { new_followup_due_at?: string | null }) = {
    should_send_followup: false,
    followup_type: "none",
    reason,
    conversation_summary: "Follow-up ja foi resolvido para o contexto atual.",
    evidence: [],
    suggested_message: null,
    cancel_existing_followup: true,
    new_stage: null,
    new_followup_key: null,
    confidence: 1
  }
) {
  const next = buildCancelledFollowupMetadata(metadata, context, decision, reason, now);
  const rescheduled = Boolean(decision.new_followup_due_at);
  return {
    ...next,
    ...(rescheduled ? {} : {
      followup_key: null,
      followup_due_at: null,
      ...(pending.unansweredCustomerFollowup
        ? { unanswered_customer_followup_for_message_at: pending.unansweredCustomerFollowup.customerMessageAt }
        : {}),
      ...(pending.unansweredBotFollowup
        ? { unanswered_bot_followup_for_message_at: pending.unansweredBotFollowup.botMessageAt }
        : {})
    })
  };
}

function getAlreadyProcessedFollowupReason(metadata: Record<string, unknown>, context: FollowupContext) {
  if (metadata.followup_context_hash !== context.last_followup_context_hash) {
    return null;
  }
  if (metadata.followup_rescheduled_for_context === true && isDue(metadata.followup_due_at, new Date(context.now))) {
    return null;
  }
  if (metadata.followup_cancel_reason === "contextual_ai_reply_unavailable") {
    return null;
  }
  if (metadata.followup_sent_at || metadata.followup_cancelled_at) {
    return "followup_context_already_processed";
  }
  return null;
}

function buildContextualAiUnavailableMetadata(
  metadata: Record<string, unknown>,
  context: FollowupContext,
  decision: FollowupDecision,
  now: Date
) {
  const retryDueAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  const leadProfile = readLeadProfile(metadata);
  return {
    ...metadata,
    followup_due_at: retryDueAt,
    followup_retry_due_at: retryDueAt,
    followup_cancelled_at: now.toISOString(),
    followup_cancel_reason: "contextual_ai_reply_unavailable",
    followup_context_hash: context.last_followup_context_hash,
    last_followup_decision_reason: decision.reason,
    lead_profile: {
      ...leadProfile,
      ...(decision.new_stage ? { stage: decision.new_stage, commercial_stage: decision.new_stage } : {}),
      last_followup_decision_reason: decision.reason,
      last_followup_block_reason: "contextual_ai_reply_unavailable",
      updated_at: now.toISOString()
    }
  };
}

function buildMinimalDuplicatePhoneContext(
  conversation: ConversationRow,
  metadata: Record<string, unknown>,
  now: Date,
  phone: string
): FollowupContext {
  const leadProfile = readLeadProfile(metadata);
  return {
    conversation_id: conversation.id,
    customer_id: conversation.customer_id || conversation.customers?.id || null,
    phone,
    now: now.toISOString(),
    metadata,
    lead_profile: leadProfile,
    recent_messages: [],
    latest_customer_message: null,
    latest_bot_message: null,
    latest_human_message: null,
    last_speaker: null,
    last_customer_was_answered: true,
    last_bot_question: null,
    last_human_question: null,
    open_order: null,
    latest_order: null,
    human_hold_active: false,
    followup_key: typeof metadata.followup_key === "string" ? metadata.followup_key : null,
    followup_due_at: typeof metadata.followup_due_at === "string" ? metadata.followup_due_at : null,
    last_followup_text_hash: typeof metadata.last_followup_text_hash === "string" ? metadata.last_followup_text_hash : null,
    last_followup_context_hash: buildFollowupContextHash({
      conversation_id: conversation.id,
      phone,
      followup_key: metadata.followup_key || null,
      duplicate_phone_in_job: true
    })
  };
}

function findLatestMessageByRole(messages: FollowupContextMessage[], role: string) {
  return [...messages].reverse().find((message) => message.role === role) || null;
}

function sanitizeOrder(order: Record<string, unknown> | null) {
  if (!order) {
    return null;
  }

  return {
    id: order.id,
    status: order.status,
    total_cents: order.total_cents,
    payment_method: order.payment_method,
    payment_provider: order.payment_provider,
    payment_reference: order.payment_reference,
    paid_at: order.paid_at,
    created_at: order.created_at,
    plans: order.plans
  };
}

function extractLastQuestionFromMessage(value: string) {
  const questions = value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith("?"));
  return questions[questions.length - 1] || null;
}

function hasPendingPaymentOrder(context: FollowupContext) {
  const order = context.open_order;
  if (!order) {
    return false;
  }

  const status = String(order.status || "");
  return ["draft", "pending_payment", "manual_review", "receipt_under_review"].includes(status);
}

function isPaidContext(context: FollowupContext) {
  const profile = context.lead_profile || {};
  const status = String(context.latest_order?.status || context.open_order?.status || profile.payment_status || "");
  return ["paid", "confirmed", "code_reserved", "code_sent"].includes(status) || profile.codigo_enviado === true;
}

function isFinalCustomerMessageResolved(context: FollowupContext) {
  const text = normalizeText(context.recent_messages.slice(-12).map((message) => message.content || "").join("\n"));
  const profile = context.lead_profile || {};
  return (
    /\b(vou comecar a testar|qualquer problema.*aviso|te aviso|ja baixei|ja instalei|consegui instalar|deu certo|funcionou)\b/.test(text) ||
    Boolean(profile.sale_closed_by_specialist || profile.access_delivery_status === "human_handling" || profile.stage === "human_support_activation") ||
    /\b(mando|mandar|envio|enviar|libero|liberar|entrego|entregar)\b.{0,35}\b(acesso|codigo|recarga)\b/.test(text) ||
    /\b(aguardando|esperando)\b.{0,35}\b(fornecedor|responder|retornar)\b/.test(text) ||
    /\b(mande|envie|manda|envia)\b.{0,35}\b(foto|print|tela)\b/.test(text) ||
    /\b(botao ativar recarga|centro de resgate|entrar nesse mesmo local)\b/.test(text)
  );
}

function isResellerMetadata(context: FollowupContext) {
  const profile = context.lead_profile || {};
  const text = normalizeText(context.recent_messages.slice(-20).map((message) => message.content || "").join("\n"));
  return Boolean(profile.reseller_intent || profile.stage === "reseller_flow" || /\b(revenda|revendedor|revender|rounds|creditos|recarga com revendedor|valor que fazia)\b/.test(text));
}

function inferCancelledStage(context: FollowupContext, reason: string) {
  if (reason.includes("reseller")) return "human_support_reseller";
  if (reason.includes("payment_already")) return "paid";
  if (reason.includes("resolved") || reason.includes("self_monitoring")) return "active_trial";
  return context.lead_profile.stage || context.metadata.conversation_stage || null;
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function getLeadRecoveryFollowup(metadata: Record<string, unknown>) {
  if (!shouldUseLeadRecoverySequence(metadata)) {
    return null;
  }

  const nextStep = Number(metadata.lead_recovery_followup_step || 0) + 1;
  if (nextStep < 1 || nextStep > MAX_LEAD_RECOVERY_FOLLOWUPS) {
    return null;
  }

  const baseStageId = String(metadata.lead_recovery_followup_base_stage_id || metadata.last_followup_stage_id || randomUUID());
  return {
    step: nextStep,
    baseStageId,
    stageId: `${baseStageId}:recovery:${nextStep}`
  };
}

export function shouldUseLeadRecoverySequence(metadata: Record<string, unknown>) {
  const key = String(metadata.followup_key || "");
  if (!["welcome_activation", "plan_choice"].includes(key)) {
    return false;
  }

  if (metadata.lead_recovery_followup_completed) {
    return false;
  }

  const profile = readLeadProfile(metadata);
  if (
    profile.selected_plan ||
    profile.plano_interesse ||
    metadata.plan_interest ||
    profile.pediu_pix ||
    profile.payment_status === "paid" ||
    profile.payment_status === "confirmed" ||
    profile.codigo_enviado === true
  ) {
    return false;
  }

  return true;
}

export function buildLeadRecoveryFollowupText(
  step: number,
  metadata: Record<string, unknown>,
  conversation?: Pick<ConversationRow, "customers">
) {
  const firstName = readFirstName(conversation?.customers?.name || readLeadProfile(metadata).nome);
  const namePrefix = firstName ? `${firstName}, ` : "";

  if (step === 1) {
    return [
      firstName ? `${namePrefix}voce ja usou o UNITV?` : "Voce ja usou o UNITV?",
      "Se nao, posso te enviar 3 dias gratis para testar.",
      "Qual aparelho voce quer testar: TV Box, Android TV, celular Android ou Fire Stick?"
    ].join("\n\n");
  }

  if (step === 2) {
    return [
      firstName ? `${namePrefix}consigo uma condicao melhor pra sua primeira recarga.` : "Consigo uma condicao melhor pra sua primeira recarga.",
      "O mensal e R$ 25, mas pra voce comecar consigo deixar por R$ 19,99.",
      "Voce tem interesse?"
    ].join("\n\n");
  }

  if (step === 3) {
    return [
      "Com a UNITV voce fica com filmes, series e canais em um so lugar.",
      "A ativacao e rapida e eu te ajudo por aqui mesmo.",
      "Se fizer sentido pra voce, posso te explicar o proximo passo."
    ].join("\n\n");
  }

  return [
    firstName ? `Oi, ${firstName}` : "Oi",
    "Ainda quer ver a condicao especial da UNITV?",
    "Consigo deixar o mensal por R$ 19,99 pra voce comecar. Se fizer sentido pra voce, eu te explico o proximo passo."
  ].join("\n\n");
}

export function shouldSendPromoRecoveryFollowup(metadata: Record<string, unknown>) {
  const key = String(metadata.followup_key || "");
  if (key !== "payment_choice") {
    return false;
  }

  const profile = readLeadProfile(metadata);
  if (metadata.promo_followup_sent_at || profile.special_promo_followup_sent) {
    return false;
  }

  if (
    profile.payment_status === "confirmed" ||
    profile.payment_status === "paid" ||
    profile.order_status === "paid" ||
    profile.codigo_enviado === true ||
    profile.converted === true
  ) {
    return false;
  }

  return Boolean(
    profile.nivel_interesse === "quente" ||
      profile.nivel_interesse === "muito_quente" ||
      profile.pediu_pix ||
      profile.wants_activation ||
      profile.wants_recharge ||
      profile.selected_plan ||
      profile.plano_interesse ||
      metadata.plan_interest
  );
}

export function buildPromoRecoveryFollowupText(
  metadata: Record<string, unknown>,
  conversation?: Pick<ConversationRow, "customers">
) {
  const firstName = readFirstName(conversation?.customers?.name || readLeadProfile(metadata).nome);
  const prefix = firstName ? `${firstName}, consigo` : "Consigo";
  return [
    `${prefix} uma condicao melhor pra voce comecar.`,
    "O mensal e R$ 25, mas consigo deixar por R$ 19,99 na primeira recarga.",
    "Voce tem interesse?"
  ].join("\n\n");
}

export function buildFollowupText(metadata: Record<string, unknown>) {
  const key = String(metadata.followup_key || "generic");
  const device = String(metadata.device || "");
  const profile = readLeadProfile(metadata);

  if (key === "welcome_activation") {
    return "Voce prefere fazer o teste gratis ou quer ativar o mensal?";
  }

  if (key === "values") {
    if (isRenewalFollowup(metadata, profile)) {
      return "Voce quer renovar no mensal mesmo ou prefere outro periodo?";
    }
    return "Voce tem interesse em algum plano especifico: mensal, trimestral, semestral ou anual?";
  }

  if (key === "plan_choice") {
    return "Voce prefere seguir no mensal ou em um plano maior?";
  }

  if (key === "payment_choice") {
    return "Voce prefere seguir pelo Pix ou pelo cartao?";
  }

  if (key === MONTHLY_PROMO_FOLLOWUP_KEY) {
    return "Consigo deixar o mensal por R$ 19,99 hoje. Quer aproveitar essa condicao?";
  }

  if (key === "pre_sale_recharge_later_4h") {
    const profile = readLeadProfile(metadata);
    const firstName = readFirstName(profile.nome);
    const prefix = firstName ? `Boa tarde, ${firstName}.` : "Boa tarde.";
    return `${prefix} Posso te mandar a chave Pix pra deixar sua recarga pronta?`;
  }

  if (key === "post_download_check_10min") {
    if (/android_phone|celular/i.test(device)) {
      return "Voce conseguiu realizar o download no celular Android?";
    }
    if (/tvbox_android|tv box/i.test(device)) {
      return "Voce conseguiu realizar o download na TV Box?";
    }
    return "Voce conseguiu realizar o download?";
  }

  if (key === "download" || key === "install") {
    if (/android_phone|celular/i.test(device)) {
      return "Voce conseguiu baixar no celular Android?";
    }
    if (/tvbox_android|tv box/i.test(device)) {
      return "Voce conseguiu baixar na TV Box?";
    }
    if (/android_tv_google_tv|android tv|google tv/i.test(device)) {
      return "Conseguiu encontrar o Downloader na Play Store da TV?";
    }
    if (/firestick|fire stick/i.test(device)) {
      return "Conseguiu abrir o Downloader no Fire Stick e digitar o codigo 862585?";
    }
    return "Conseguiu confirmar se seu aparelho tem Android ou Play Store?";
  }

  if (key === "test") {
    return "Conseguiu abrir o app para eu liberar o teste de 3 dias?";
  }

  if (key === "pix") {
    return "Conseguiu fazer o pagamento pelo Pix? Quando o Mercado Pago confirmar, eu libero a recarga por aqui.";
  }

  if (key === "proof") {
    return "Pode me enviar o comprovante por aqui? Assim consigo encaminhar para validacao.";
  }

  if (key === "screens") {
    return "Voce quer usar em quantos aparelhos ao mesmo tempo?";
  }

  if (key === "support") {
    return "Ainda precisa de ajuda? Me mande o erro ou o aparelho que esta usando.";
  }

  return "Quer que eu continue te ajudando por aqui?";
}

export function buildUnansweredCustomerFallbackText(metadata: Record<string, unknown>, latestCustomerMessage = "") {
  const key = String(metadata.followup_key || "");
  const stage = String(metadata.conversation_stage || readLeadProfile(metadata).stage || "");
  const leadProfile = readLeadProfile(metadata);
  const normalized = latestCustomerMessage
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (key === "download" || key === "install" || key === "post_download_check_10min" || stage === "instalacao") {
    const lastQuestion = normalizeFollowupText(String(leadProfile.last_bot_question || metadata.last_bot_question || ""));
    if (/\b(downloader|aftvnews|after news|play store|playstore)\b/.test(lastQuestion)) {
      return "Conseguiu baixar o Downloader na Play Store?";
    }
    if (/\b862585\b/.test(lastQuestion)) {
      return "Conseguiu abrir o Downloader e colocar o codigo 862585?";
    }
    if (/\b(tela de login|abrir o app|login)\b/.test(lastQuestion)) {
      return "Conseguiu abrir o app e chegar na tela de login?";
    }
    if (/^(ok|sim|certo|ta|t[aá]|beleza|blz)$/.test(normalized)) {
      return "Conseguiu avancar?";
    }
    return "Conseguiu avancar na instalacao? Se travou em alguma etapa, me fala que eu te oriento.";
  }

  if (key === "pix" || stage === "aguardando_pix" || stage === "pagamento_pix") {
    return "Conseguiu fazer o Pix? Se precisar, eu te envio novamente.";
  }

  if (key === "payment_choice" || stage === "pagamento") {
    return "Voce prefere seguir pelo Pix ou pelo cartao?";
  }

  if (key === "welcome_activation" || key === "plan_choice") {
    return "Me confirma qual caminho voce prefere: teste gratis ou ativacao do mensal?";
  }

  return "Quer que eu continue te ajudando por aqui?";
}

function normalizeFollowupText(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isDue(value: unknown, now: Date) {
  if (typeof value !== "string" || !value) {
    return false;
  }
  const dueAt = new Date(value);
  return !Number.isNaN(dueAt.getTime()) && dueAt.getTime() <= now.getTime();
}

function getSkipReason(
  metadata: Record<string, unknown>,
  now: Date,
  options: { allowCustomerReplied?: boolean; ignoreStageLimit?: boolean } = {}
) {
  if (metadata.requires_human && isRecentDate(metadata.last_specialist_message_at, now, HUMAN_SILENCE_WINDOW_MS)) {
    return "human_takeover_recent";
  }

  if (!options.allowCustomerReplied && isAfter(metadata.last_customer_message_at, metadata.last_bot_message_at)) {
    return "customer_replied";
  }

  if (!options.ignoreStageLimit && metadata.followup_sent_at && metadata.followup_sent_stage_id === metadata.last_followup_stage_id) {
    return "already_sent_for_stage";
  }

  const maxFollowups = shouldUseLeadRecoverySequence(metadata) ? MAX_LEAD_RECOVERY_FOLLOWUPS : MAX_FOLLOWUP_COUNT_PER_STAGE;
  if (!options.ignoreStageLimit && Number(metadata.followup_count || 0) >= maxFollowups) {
    return "followup_limit_reached";
  }

  return null;
}

function getUnansweredCustomerFollowup(metadata: Record<string, unknown>, now: Date) {
  if (!isAfter(metadata.last_customer_message_at, metadata.last_bot_message_at)) {
    return null;
  }

  if (typeof metadata.last_customer_message_at !== "string") {
    return null;
  }

  const customerMessageAt = new Date(metadata.last_customer_message_at);
  if (Number.isNaN(customerMessageAt.getTime())) {
    return null;
  }

  if (now.getTime() - customerMessageAt.getTime() < UNANSWERED_CUSTOMER_FOLLOWUP_DELAY_MS) {
    return null;
  }

  if (metadata.unanswered_customer_followup_for_message_at === metadata.last_customer_message_at) {
    return null;
  }

  if (isFutureDate(metadata.followup_retry_due_at, now)) {
    return null;
  }

  return {
    customerMessageAt: metadata.last_customer_message_at,
    stageId: `customer_unanswered:${metadata.last_customer_message_at}`
  };
}

function getUnansweredBotFollowup(metadata: Record<string, unknown>, now: Date) {
  if (!hasFollowupIntent(metadata)) {
    return null;
  }

  if (metadata.followup_key === "post_download_check_10min") {
    return null;
  }

  if (isAfter(metadata.last_customer_message_at, metadata.last_bot_message_at)) {
    return null;
  }

  if (typeof metadata.last_bot_message_at !== "string") {
    return null;
  }

  if (isDue(metadata.followup_due_at, now)) {
    return null;
  }

  const botMessageAt = new Date(metadata.last_bot_message_at);
  if (Number.isNaN(botMessageAt.getTime())) {
    return null;
  }

  if (now.getTime() - botMessageAt.getTime() < UNANSWERED_BOT_FOLLOWUP_DELAY_MS) {
    return null;
  }

  if (metadata.unanswered_bot_followup_for_message_at === metadata.last_bot_message_at) {
    return null;
  }

  return {
    botMessageAt: metadata.last_bot_message_at,
    stageId: String(metadata.last_followup_stage_id || `bot_unanswered:${metadata.last_bot_message_at}`)
  };
}

function hasFollowupIntent(metadata: Record<string, unknown>) {
  const key = String(metadata.followup_key || "");
  return Boolean(key && key !== "null" && key !== "undefined");
}

function readCustomerPhone(conversation: ConversationRow) {
  const phone = conversation.customers?.phone || conversation.external_conversation_id || "";
  return phone.split("@")[0]?.replace(/\D/g, "") || null;
}

function getNextLeadRecoveryDueAt(step: number, now: Date) {
  const delay = LEAD_RECOVERY_DELAYS_AFTER_SEND_MS[step - 1];
  if (!delay) {
    return null;
  }
  return new Date(now.getTime() + delay).toISOString();
}

function readLeadProfile(metadata: Record<string, unknown> | null | undefined) {
  const profile = metadata?.lead_profile;
  return profile && typeof profile === "object" && !Array.isArray(profile) ? (profile as Record<string, unknown>) : {};
}

const FOLLOWUP_METADATA_KEYS = [
  "awaiting_customer_action",
  "conversation_stage",
  "device",
  "device_detected",
  "followup_context_hash",
  "followup_dedupe_key",
  "followup_due_at",
  "followup_key",
  "followup_sent_at",
  "followup_sent_stage_id",
  "followup_type",
  "human_hold_until",
  "last_bot_download_message_at",
  "last_bot_message_at",
  "last_bot_monthly_offer_at",
  "last_bot_question",
  "last_customer_message_at",
  "last_followup_sent_at",
  "last_followup_stage_id",
  "last_followup_text_hash",
  "last_specialist_message_at",
  "lead_recovery_followup_base_stage_id",
  "lead_recovery_followup_completed",
  "lead_recovery_followup_step",
  "plan_interest",
  "pre_sale_followup_scheduled_at",
  "promo_followup_sent_at",
  "requires_human"
] as const;

const FOLLOWUP_LEAD_PROFILE_KEYS = [
  "accepted_special_promo",
  "access_delivery_status",
  "aparelho",
  "codigo_enviado",
  "commercial_stage",
  "converted",
  "device",
  "last_detected_intent",
  "negotiated_price_cents",
  "nivel_interesse",
  "nome",
  "order_status",
  "payment_intent_status",
  "payment_method",
  "payment_status",
  "pediu_pix",
  "pix_code",
  "plano_interesse",
  "quoted_price_cents",
  "renovacao",
  "requested_screens",
  "reseller_intent",
  "sale_closed_by_specialist",
  "selected_plan",
  "special_promo_followup_sent",
  "special_promo_offer",
  "stage",
  "ultima_intencao",
  "wants_activation",
  "wants_recharge",
  "wants_renewal"
] as const;

function compactFollowupMetadata(metadata: Record<string, unknown>) {
  return pickKnownFields(metadata, FOLLOWUP_METADATA_KEYS);
}

function compactFollowupLeadProfile(leadProfile: Record<string, unknown>) {
  return pickKnownFields(leadProfile, FOLLOWUP_LEAD_PROFILE_KEYS);
}

function compactFollowupMessage(message: FollowupContextMessage): FollowupContextMessage {
  return {
    id: message.id || null,
    role: message.role || null,
    content: typeof message.content === "string" ? message.content.slice(-1200) : null,
    created_at: message.created_at || null,
    external_message_id: message.external_message_id || null
  };
}

function pickKnownFields(source: Record<string, unknown>, keys: readonly string[]) {
  return keys.reduce<Record<string, unknown>>((result, key) => {
    if (source[key] !== undefined) {
      result[key] = source[key];
    }
    return result;
  }, {});
}

function isRenewalFollowup(metadata: Record<string, unknown>, profile: Record<string, unknown>) {
  return Boolean(
    profile.wants_recharge ||
      profile.wants_renewal ||
      profile.renovacao ||
      profile.ultima_intencao === "renew_plan" ||
      metadata.conversation_stage === "recarga" ||
      metadata.awaiting_customer_action === "renew_plan"
  );
}

function readFirstName(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  const firstName = value.trim().split(/\s+/)[0] || "";
  return firstName.replace(/[^\p{L}'-]/gu, "");
}

function isRecentDate(value: unknown, now: Date, windowMs: number) {
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && now.getTime() - date.getTime() < windowMs;
}

function isFutureDate(value: unknown, now: Date) {
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getTime() > now.getTime();
}

function isAfter(left: unknown, right: unknown) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const leftDate = new Date(left);
  const rightDate = new Date(right);
  return !Number.isNaN(leftDate.getTime()) && !Number.isNaN(rightDate.getTime()) && leftDate > rightDate;
}
