import "server-only";
import { randomUUID } from "node:crypto";
import { ConversationsRepository } from "@/repositories/conversations.repository";
import { MessagesRepository } from "@/repositories/messages.repository";
import { EvolutionService } from "@/services/evolution/evolution.service";
import { AuditService } from "@/services/audit.service";
import { AgentEventLogService } from "@/services/audit/agent-event-log.service";
import { SalesResponseAIService } from "@/services/agent/sales-response-ai.service";
import { OrdersService } from "@/services/orders.service";
import {
  buildFollowupContextHash,
  ContextualFollowupDecisionService,
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
    private readonly contextualFollowupDecisionService = new ContextualFollowupDecisionService()
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
      const decision = await this.contextualFollowupDecisionService.decide(context);
      const policy = validateFollowupPolicy(context, decision, now);
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: "followup_decision",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: {
          should_send_followup: policy.shouldSend,
          followup_type: decision.followup_type,
          reason: policy.reason || decision.reason,
          evidence: decision.evidence,
          cancel_reason: policy.shouldSend ? null : policy.reason || decision.reason,
          dedupe_key: policy.dedupeKey,
          duplicate_blocked: policy.duplicateBlocked,
          previous_followup_key: metadata.followup_key,
          new_followup_key: decision.new_followup_key,
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
        await this.conversationsRepository.updateConversationMetadata(
          conversation.id,
          buildCancelledFollowupMetadata(metadata, context, decision, policy.reason || decision.reason, now)
        );
        continue;
      }

      if (policy.dedupeKey) {
        inProcessDedupeKeys.add(policy.dedupeKey);
      }
      phonesSentThisRun.add(phone);

      const leadRecovery = getLeadRecoveryFollowup(metadata);
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
      const followupTextHash = hashText(followupText);
      const sendResult = await this.evolutionService.sendTextMessage({ phone, text: followupText });
      const leadProfile = readLeadProfile(metadata);
      const nextLeadRecoveryDueAt = leadRecovery ? getNextLeadRecoveryDueAt(leadRecovery.step, now) : null;
      const sentSpecialOffer = promoRecovery;
      const nextMetadata = {
        ...metadata,
        followup_due_at: nextLeadRecoveryDueAt,
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
          followup_key: metadata.followup_key,
          stageId,
          sendResult,
          reason: decision.reason,
          confidence: decision.confidence,
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
      fallbackReply
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
      fallbackReply: input.fallbackText,
      useStrongModel: shouldUseStrongFollowupTextModel(input.context, input.decision)
    });

    if (aiReply) {
      return aiReply;
    }

    return input.decision.suggested_message?.trim() || null;
  }

  private async listRecentMessages(conversationId: string) {
    const listMessages = (this.messagesRepository as unknown as {
      listMessagesByConversationId?: (conversationId: string, limit?: number) => Promise<Array<Record<string, unknown>>>;
    }).listMessagesByConversationId;
    if (!listMessages) {
      return [];
    }

    try {
      const messages = await listMessages.call(this.messagesRepository, conversationId, 50);
      return messages.map((item) => ({
        id: typeof item.id === "string" ? item.id : null,
        role: typeof item.role === "string" ? item.role : undefined,
        content: typeof item.content === "string" ? item.content : null,
        created_at: typeof item.created_at === "string" ? item.created_at : null,
        external_message_id: typeof item.external_message_id === "string" ? item.external_message_id : null,
        metadata: item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
          ? item.metadata as Record<string, unknown>
          : null
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
    const recentMessages = await this.listRecentMessages(conversation.id) as FollowupContextMessage[];
    const leadProfile = readLeadProfile(metadata);
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
      metadata,
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

function buildCancelledFollowupMetadata(
  metadata: Record<string, unknown>,
  context: FollowupContext,
  decision: FollowupDecision & { new_followup_due_at?: string | null },
  reason: string,
  now: Date
) {
  const leadProfile = readLeadProfile(metadata);
  const newStage = decision.new_stage || inferCancelledStage(context, reason);
  const newFollowupKey = decision.new_followup_key || null;
  return {
    ...metadata,
    followup_key: newFollowupKey,
    followup_due_at: decision.new_followup_due_at || null,
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
    return "Voce teria interesse no mensal mesmo?";
  }

  if (key === "plan_choice") {
    return "Voce prefere seguir no mensal ou em um plano maior?";
  }

  if (key === "payment_choice") {
    return "Voce prefere seguir pelo Pix ou pelo cartao?";
  }

  if (key === "download" || key === "install") {
    if (/android_phone|celular/i.test(device)) {
      return "Conseguiu baixar no celular Android? Se aparecer aviso de seguranca, me fala que eu te oriento.";
    }
    if (/tvbox_android|tv box/i.test(device)) {
      return "Conseguiu instalar na TV Box? Se travou, me diga se foi no link APK ou no Downloader.";
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
  const normalized = latestCustomerMessage
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (key === "download" || key === "install" || stage === "instalacao") {
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

  return {
    customerMessageAt: metadata.last_customer_message_at,
    stageId: `customer_unanswered:${metadata.last_customer_message_at}`
  };
}

function getUnansweredBotFollowup(metadata: Record<string, unknown>, now: Date) {
  if (!hasFollowupIntent(metadata)) {
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

function shouldUseStrongFollowupTextModel(context: FollowupContext, decision: FollowupDecision) {
  const text = normalizeText(context.recent_messages.map((message) => message.content || "").join("\n"));
  return (
    decision.confidence < 0.82 ||
    /\b(revenda|revendedor|pix|comprovante|pagamento|senha|erro|reclama|cancelar|humano)\b/.test(text) ||
    Boolean(context.latest_human_message)
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
