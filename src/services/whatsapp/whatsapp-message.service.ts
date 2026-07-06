import "server-only";
import { CustomersRepository } from "@/repositories/customers.repository";
import { ConversationsRepository } from "@/repositories/conversations.repository";
import { MessagesRepository } from "@/repositories/messages.repository";
import { AuditService } from "@/services/audit.service";
import { ChatAgentService } from "@/services/agent/chat-agent.service";
import { IntentClassifierService, type IntentClassification } from "@/services/agent/intent-classifier.service";
import { AgentActionsService } from "@/services/agent-actions.service";
import { EvolutionService } from "@/services/evolution/evolution.service";
import { OrdersService } from "@/services/orders.service";
import { ReceiptsService } from "@/services/receipts.service";
import type { IncomingEvolutionMessage } from "@/lib/evolution/client";
import { resolveMenuSelection, type WhatsAppMenu } from "@/lib/whatsapp/menus";
import {
  CUSTOMER_SAFE_FALLBACK,
  createCustomerMessageHash,
  sanitizeCustomerMessage,
  validateResponseAgainstLeadProfile
} from "@/lib/whatsapp/customer-message-safety";
import { SpecialistTrainingExamplesRepository } from "@/repositories/specialist-training-examples.repository";
import { buildMaskedConversationExcerpt, maskSpecialistTrainingText } from "@/lib/whatsapp/specialist-training-privacy";
import { SpecialistInterventionAnalysisService } from "@/services/agent/specialist-intervention-analysis.service";
import { AgentEventLogService } from "@/services/audit/agent-event-log.service";
import { HotLeadAlertService } from "@/services/leads/hot-lead-alert.service";
import {
  detectUnitvDevice,
  isUnitvInstallationRequest,
  UNITV_DEVICE_COMPATIBILITY
} from "@/lib/unitv/device-compatibility";

const HUMAN_NOTIFICATION_PHONE = "558699802602";
const HUMAN_HANDOFF_TIMEOUT_MS = 5 * 60 * 1000;
const CUSTOMER_FOLLOWUP_DELAY_MS = 5 * 60 * 1000;

type ProcessIncomingMessageInput = {
  webhookEventId: string;
  message: IncomingEvolutionMessage;
};

export class WhatsappMessageService {
  constructor(
    private readonly customersRepository = new CustomersRepository(),
    private readonly conversationsRepository = new ConversationsRepository(),
    private readonly messagesRepository = new MessagesRepository(),
    private readonly intentClassifier = new IntentClassifierService(),
    private readonly chatAgent = new ChatAgentService(),
    private readonly evolutionService = new EvolutionService(),
    private readonly auditService = new AuditService(),
    private readonly ordersService = new OrdersService(),
    private readonly receiptsService = new ReceiptsService(),
    private readonly agentActionsService = new AgentActionsService(),
    private readonly specialistTrainingExamplesRepository?: SpecialistTrainingExamplesRepository,
    private readonly specialistInterventionAnalysis = new SpecialistInterventionAnalysisService(),
    private readonly agentEventLogService?: AgentEventLogService,
    private readonly hotLeadAlertService?: HotLeadAlertService
  ) {}

  async processIncomingMessage({ webhookEventId, message }: ProcessIncomingMessageInput) {
    const existingMessage = await this.messagesRepository.findByExternalMessageId(message.externalMessageId);
    if (existingMessage) {
      await this.auditService.createAuditLog({
        actor_type: "webhook",
        action: "evolution_duplicate_message_ignored",
        entity_type: "messages",
        entity_id: existingMessage.id,
        metadata: { webhookEventId, externalMessageId: message.externalMessageId }
      });
      return { status: "duplicate" as const };
    }

    const customer = await this.customersRepository.upsertCustomerByPhone({
      phone: message.phone,
      name: message.contactName || null,
      external_channel: "whatsapp",
      external_user_id: message.remoteJid,
      status: "active",
      metadata: {
        remoteJid: message.remoteJid,
        lastEvolutionInstance: message.instance
      }
    });

    const externalConversationId = message.remoteJid;
    const existingConversation = await this.conversationsRepository.findByExternalConversationId(externalConversationId);
    const conversation =
      existingConversation ||
      (await this.conversationsRepository.createConversation({
        customer_id: customer.id,
        channel: "whatsapp",
        external_conversation_id: externalConversationId,
        status: "open",
        last_message_at: new Date().toISOString(),
        metadata: { instance: message.instance }
      }));

    if (message.fromMe) {
      const messageAt = getMessageDate(message).toISOString();
      if (await this.isBotEcho(conversation.id, message)) {
        await this.auditService.createAuditLog({
          actor_type: "webhook",
          action: "bot_echo_message_ignored",
          entity_type: "conversations",
          entity_id: conversation.id,
          metadata: { webhookEventId, externalMessageId: message.externalMessageId }
        });
        return { status: "ignored" as const };
      }

      await this.messagesRepository.createMessage({
        conversation_id: conversation.id,
        customer_id: customer.id,
        role: "human_agent",
        content: message.text,
        content_type: message.messageType,
        external_message_id: message.externalMessageId,
        metadata: {
          remoteJid: message.remoteJid,
          media: message.media,
          hasMedia: message.hasMedia,
          timestamp: message.timestamp,
          webhookEventId,
          fromMe: true,
          sender_type: "specialist",
          sent_by_system: false
        }
      });
      await this.safeCreateAgentEvent({
        conversation_id: conversation.id,
        customer_phone: message.phone,
        event_type: "specialist_message",
        event_source: "webhook",
        message_id: message.externalMessageId,
        metadata: { webhookEventId, text: message.text }
      });

      const existingLeadProfile = readLeadProfile(conversation.metadata);
      const pausedMetadata = {
        ...(conversation.metadata || {}),
        requires_human: true,
        human_intervention_detected: true,
        handoff_reason: conversation.metadata?.handoff_reason || "human_agent_reply",
        handoff_requested_at: conversation.metadata?.handoff_requested_at || messageAt,
        last_specialist_message_at: messageAt,
        lead_profile: {
          ...existingLeadProfile,
          last_specialist_message_at: messageAt,
          specialist_intervention_count: Number(existingLeadProfile.specialist_intervention_count || 0) + 1,
          learned_from_specialist: true
        }
      };
      await this.conversationsRepository.updateConversationMetadata(conversation.id, pausedMetadata);
      conversation.metadata = pausedMetadata;
      await this.conversationsRepository.touchConversation(conversation.id, messageAt);
      await this.auditService.createAuditLog({
        actor_type: "human_admin",
        action: "human_agent_message_recorded",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: { webhookEventId, externalMessageId: message.externalMessageId, lastSpecialistMessageAt: messageAt }
      });
      await this.safeCreateAgentEvent({
        conversation_id: conversation.id,
        customer_phone: message.phone,
        event_type: "human_intervention",
        event_source: "specialist_training",
        message_id: message.externalMessageId,
        metadata: { webhookEventId, reason: "manual_specialist_message" }
      });
      const learned = await this.recordSpecialistTrainingExample({
        webhookEventId,
        conversation,
        customer,
        message,
        messageAt
      });
      if (learned) {
        const leadProfile = readLeadProfile(conversation.metadata);
        const learnedMetadata = {
          ...(conversation.metadata || {}),
          lead_profile: {
            ...leadProfile,
            last_specialist_summary: learned.summary,
            bot_response_was_overridden: learned.botResponseWasOverridden,
            stage: learned.analysis.inferred_stage,
            next_best_action: learned.analysis.next_best_action,
            learned_pattern: learned.analysis.learned_pattern,
            learned_from_specialist: true
          }
        };
        await this.conversationsRepository.updateConversationMetadata(conversation.id, learnedMetadata);
        conversation.metadata = learnedMetadata;
      }

      return { status: "ignored" as const };
    }

    await this.messagesRepository.createMessage({
      conversation_id: conversation.id,
      customer_id: customer.id,
      role: "customer",
      content: message.text,
      content_type: message.messageType,
      external_message_id: message.externalMessageId,
      metadata: {
        remoteJid: message.remoteJid,
        media: message.media,
        hasMedia: message.hasMedia,
        timestamp: message.timestamp,
        webhookEventId
      }
    });
    await this.safeCreateAgentEvent({
      conversation_id: conversation.id,
      customer_phone: message.phone,
      event_type: "customer_message",
      event_source: "webhook",
      message_id: message.externalMessageId,
      metadata: { webhookEventId, text: message.text, messageType: message.messageType }
    });
    await this.updateSpecialistExampleSuccessSignal(conversation.id, message.text, conversation.metadata);
      const customerMessageAt = getMessageDate(message).toISOString();
    conversation.metadata = {
      ...(conversation.metadata || {}),
      last_customer_message_at: customerMessageAt,
      followup_due_at: null,
      awaiting_customer_action: null
    };
    await this.conversationsRepository.updateConversationMetadata(conversation.id, conversation.metadata);

    const resumeBot = conversation.metadata?.requires_human && isBotResumeRequest(message.text);
    const staleFreeTrialHandoff = conversation.metadata?.requires_human && isStaleFreeTrialHandoff(conversation.metadata);
    const timedOutHumanHandoff = conversation.metadata?.requires_human && isHumanHandoffTimeoutExpired(conversation.metadata);
    if (resumeBot || staleFreeTrialHandoff || timedOutHumanHandoff) {
      const handoffResolvedBy = resumeBot
        ? "whatsapp_resume_command"
        : staleFreeTrialHandoff
          ? "stale_free_trial_handoff_auto_resume"
          : "human_handoff_timeout_auto_resume";
      await this.conversationsRepository.updateConversationMetadata(conversation.id, {
        ...(conversation.metadata || {}),
        requires_human: false,
        handoff_resolved_at: new Date().toISOString(),
        handoff_resolved_by: handoffResolvedBy,
        handoff_reason: null
      });
      conversation.metadata = {
        ...(conversation.metadata || {}),
        requires_human: false,
        handoff_reason: null
      };
      await this.safeCreateAgentEvent({
        conversation_id: conversation.id,
        customer_phone: message.phone,
        event_type: "handoff_resumed",
        event_source: "webhook",
        message_id: message.externalMessageId,
        metadata: { webhookEventId, resolved_by: handoffResolvedBy }
      });
    }

    if (conversation.metadata?.requires_human) {
      if (isReceiptMessage(message)) {
        const recentMessages = await this.listRecentConversationMessages(conversation.id);
        await this.safeNotifyHotLead({
          conversation,
          customer,
          message,
          intent: "receipt_sent",
          recentMessages
        });
      }

      if (isHumanHandoffRequest(message.text)) {
        await this.notifyHumanOwner({
          webhookEventId,
          customer,
          conversationId: conversation.id,
          message
        });
      }

      await this.auditService.createAuditLog({
        actor_type: "ai_agent",
        action: "human_takeover_active_auto_reply_skipped",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: { webhookEventId, externalMessageId: message.externalMessageId }
      });
      return { status: "ignored" as const };
    }

    if (isRecentSpecialistActivity(conversation.metadata)) {
      if (isReceiptMessage(message)) {
        const recentMessages = await this.listRecentConversationMessages(conversation.id);
        await this.safeNotifyHotLead({
          conversation,
          customer,
          message,
          intent: "receipt_sent",
          recentMessages
        });
      }

      await this.auditService.createAuditLog({
        actor_type: "ai_agent",
        action: "recent_human_activity_auto_reply_skipped",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: {
          webhookEventId,
          externalMessageId: message.externalMessageId,
          lastSpecialistMessageAt: conversation.metadata?.last_specialist_message_at
        }
      });
      return { status: "ignored" as const };
    }

    if (isReceiptMessage(message)) {
      await this.safeCreateAgentEvent({
        conversation_id: conversation.id,
        customer_phone: message.phone,
        event_type: "proof_sent",
        event_source: "webhook",
        message_id: message.externalMessageId,
        metadata: { webhookEventId, hasMedia: message.hasMedia }
      });
      const recentMessages = await this.listRecentConversationMessages(conversation.id);
      await this.safeNotifyHotLead({
        conversation,
        customer,
        message,
        intent: "receipt_sent",
        recentMessages
      });
      const reply = await this.handleReceiptMessage({ webhookEventId, message, customer, conversation });
      return this.sendAndStoreAssistantReply({ webhookEventId, message, customer, conversation, reply, classification: { intent: "receipt_sent" } });
    }

    let effectiveMessage = message.text;
    let classification: IntentClassification;
    const directHumanRequest = isHumanHandoffRequest(message.text);
    const selection = directHumanRequest ? null : resolveMenuSelection(message.text, conversation.metadata);
    if (selection) {
      effectiveMessage = selection.message;
      classification = {
        intent: selection.intent,
        confidence: 1,
        summary: `Selecao direta do menu: ${message.text}`,
        suggested_reply: ""
      };
    } else if (directHumanRequest) {
      classification = {
        intent: "human_help",
        confidence: 1,
        summary: "Cliente pediu atendimento humano.",
        suggested_reply: ""
      };
    } else {
      classification = await this.intentClassifier.classify({ message: message.text });
    }

    const leadProfilePatch = buildLeadProfilePatch(message.text, classification.intent, conversation.metadata);
    if (Object.keys(leadProfilePatch).length) {
      const currentLeadProfile = readLeadProfile(conversation.metadata);
      const nextMetadata = {
        ...(conversation.metadata || {}),
        lead_profile: {
          ...currentLeadProfile,
          ...leadProfilePatch,
          updated_at: new Date().toISOString()
        }
      };
      await this.conversationsRepository.updateConversationMetadata(conversation.id, nextMetadata);
      conversation.metadata = nextMetadata;
    }
    for (const eventType of inferCustomerAgentEvents(message.text, classification.intent, leadProfilePatch)) {
      await this.safeCreateAgentEvent({
        conversation_id: conversation.id,
        customer_phone: message.phone,
        event_type: eventType,
        event_source: "webhook",
        intent: classification.intent,
        stage: typeof leadProfilePatch.stage === "string" ? leadProfilePatch.stage : null,
        objection: typeof leadProfilePatch.main_objection === "string" ? leadProfilePatch.main_objection : null,
        device: typeof leadProfilePatch.device === "string" ? leadProfilePatch.device : null,
        plan_interest: typeof leadProfilePatch.selected_plan === "string" ? leadProfilePatch.selected_plan : null,
        message_id: message.externalMessageId,
        metadata: { webhookEventId }
      });
    }

    const recentMessages = await this.listRecentConversationMessages(conversation.id);
    const specialistExamples = await this.listRelevantSpecialistExamples(conversation.metadata, message.text);
    const commercialReply = await this.chatAgent.generateCommercialReply({
      message: effectiveMessage,
      classification,
      customer,
      conversation,
      webhookEventId,
      recentMessages,
      specialistExamples
    });
    await this.safeCreateAgentEvent({
      conversation_id: conversation.id,
      customer_phone: message.phone,
      event_type: commercialReply.responseSource === "ai" ? "ai_called" : "local_rule_used",
      event_source: "chat_agent",
      intent: classification.intent,
      stage: String(readLeadProfile(conversation.metadata).stage || readLeadProfile(conversation.metadata).etapa_atual || ""),
      objection: String(readLeadProfile(conversation.metadata).main_objection || readLeadProfile(conversation.metadata).objecao_principal || ""),
      device: String(readLeadProfile(conversation.metadata).device || ""),
      plan_interest: String(readLeadProfile(conversation.metadata).selected_plan || readLeadProfile(conversation.metadata).plano_interesse || ""),
      message_id: message.externalMessageId,
      metadata: {
        webhookEventId,
        rule: commercialReply.responseRule || "deterministic_reply",
        confidence: classification.confidence
      }
    });
    if (commercialReply.leadProfilePatch) {
      const currentLeadProfile = readLeadProfile(conversation.metadata);
      const nextMetadata = {
        ...(conversation.metadata || {}),
        lead_profile: {
          ...currentLeadProfile,
          downloaded_app: currentLeadProfile.downloaded_app ?? false,
          installed_app: currentLeadProfile.installed_app ?? false,
          last_download_url_sent: currentLeadProfile.last_download_url_sent ?? null,
          ...commercialReply.leadProfilePatch,
          updated_at: new Date().toISOString()
        }
      };
      await this.conversationsRepository.updateConversationMetadata(conversation.id, nextMetadata);
      conversation.metadata = nextMetadata;
    }
    await this.safeNotifyHotLead({
      conversation,
      customer,
      message,
      intent: classification.intent,
      recentMessages,
      leadProfile: readLeadProfile(conversation.metadata)
    });
    const reply = commercialReply.reply;

    if (!reply) {
      await this.auditService.createAuditLog({
        actor_type: "ai_agent",
        action: "evolution_empty_reply_skipped",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: { webhookEventId, classification }
      });
      return { status: "ignored" as const };
    }

    if (commercialReply.requiresHuman) {
      const handoffMetadata = {
        ...(conversation.metadata || {}),
        requires_human: true,
        handoff_reason: classification.intent,
        handoff_requested_at: new Date().toISOString()
      };
      await this.conversationsRepository.updateConversationMetadata(conversation.id, handoffMetadata);
      await this.safeCreateAgentEvent({
        conversation_id: conversation.id,
        customer_phone: message.phone,
        event_type: "handoff_started",
        event_source: "chat_agent",
        intent: classification.intent,
        message_id: message.externalMessageId,
        metadata: { webhookEventId, reason: classification.intent }
      });
      await this.safeCreateAgentEvent({
        conversation_id: conversation.id,
        customer_phone: message.phone,
        event_type: "support_requested",
        event_source: "chat_agent",
        intent: classification.intent,
        message_id: message.externalMessageId,
        metadata: { webhookEventId }
      });
      await this.notifyHumanOwner({
        webhookEventId,
        customer,
        conversationId: conversation.id,
        message,
        notificationText: commercialReply.ownerNotificationText
      });
    }

    if (commercialReply.menu) {
      conversation.metadata = {
        ...(conversation.metadata || {}),
        last_menu_id: commercialReply.menu.id,
        last_menu_sent_at: new Date().toISOString()
      };
      await this.conversationsRepository.updateConversationMetadata(conversation.id, conversation.metadata);
    }

    return this.sendAndStoreAssistantReply({
      webhookEventId,
      message,
      customer,
      conversation,
      reply,
      classification,
      media: commercialReply.media,
      copyText: commercialReply.copyText,
      followUpMessages: commercialReply.followUpMessages,
      menu: commercialReply.menu,
      sendTextBeforeMenu: commercialReply.sendTextBeforeMenu
    });
  }

  private async sendAndStoreAssistantReply({
    webhookEventId,
    message,
    customer,
    conversation,
    reply,
    classification,
    media,
    copyText,
    followUpMessages,
    menu,
    sendTextBeforeMenu
  }: {
    webhookEventId: string;
    message: IncomingEvolutionMessage;
    customer: { id: string };
    conversation: { id: string; metadata?: Record<string, unknown> | null };
    reply: string;
    classification: Record<string, unknown>;
    media?: { base64: string; mimetype: string; fileName: string; caption: string };
    copyText?: string;
    followUpMessages?: string[];
    menu?: WhatsAppMenu;
    sendTextBeforeMenu?: boolean;
  }) {
    const safeReply = await this.sanitizeAndValidateCustomerText({
      text: reply,
      conversation,
      webhookEventId,
      leadProfile: readLeadProfile(conversation.metadata)
    });
    const safeFollowUpMessages = [];
    for (const followUpMessage of followUpMessages || []) {
      safeFollowUpMessages.push(
        await this.sanitizeAndValidateCustomerText({
          text: followUpMessage,
          conversation,
          webhookEventId,
          leadProfile: readLeadProfile(conversation.metadata)
        })
      );
    }

    let sendResult: unknown;
    if (menu) {
      if (sendTextBeforeMenu) {
        const replyResult = await this.evolutionService.sendTextMessage({ phone: message.phone, text: safeReply });
        const menuResult = await this.evolutionService.sendTextMessage({ phone: message.phone, text: menu.fallbackText });
        sendResult = { text: replyResult, menu: menuResult };
      } else {
        sendResult = await this.evolutionService.sendTextMessage({ phone: message.phone, text: safeReply });
      }
    } else {
      sendResult = await this.evolutionService.sendTextMessage({ phone: message.phone, text: safeReply });
    }
    let copyTextSendResult: unknown = null;
    if (copyText) {
      copyTextSendResult = await this.evolutionService.sendTextMessage({ phone: message.phone, text: copyText });
    }

    const followUpSendResults = [];
    for (const followUpMessage of safeFollowUpMessages) {
      followUpSendResults.push(await this.evolutionService.sendTextMessage({ phone: message.phone, text: followUpMessage }));
    }

    let mediaSendResult: unknown = null;
    if (media) {
      try {
        mediaSendResult = await this.evolutionService.sendMediaMessage({ phone: message.phone, ...media });
      } catch (error) {
        await this.auditService.createAuditLog({
          actor_type: "system",
          action: "evolution_pix_qr_send_failed",
          entity_type: "conversations",
          entity_id: conversation.id,
          metadata: { webhookEventId, error: error instanceof Error ? error.message : "unknown_error" }
        });
      }
    }

    await this.messagesRepository.createMessage({
      conversation_id: conversation.id,
      customer_id: customer.id,
      role: "assistant",
      content: safeReply,
      content_type: "text",
      external_message_id: `assistant:${message.externalMessageId}`,
      metadata: {
        webhookEventId,
        classification,
        sender_type: "bot",
        content_hash: createCustomerMessageHash(safeReply),
        sent_at: new Date().toISOString(),
        sent_by_system: true,
        provider_message_id: extractEvolutionProviderMessageId(sendResult),
        sendResult,
        copyTextSendResult,
        followUpSendResults,
        mediaSendResult,
        media: media ? { mimetype: media.mimetype, fileName: media.fileName, caption: media.caption } : null,
        menu: menu ? { id: menu.id, title: menu.title } : null
      }
    });
    await this.safeCreateAgentEvent({
      conversation_id: conversation.id,
      customer_phone: message.phone,
      event_type: "bot_message",
      event_source: "chat_agent",
      intent: typeof classification.intent === "string" ? classification.intent : null,
      stage: String(readLeadProfile(conversation.metadata).stage || readLeadProfile(conversation.metadata).etapa_atual || ""),
      message_id: `assistant:${message.externalMessageId}`,
      metadata: { webhookEventId, reply: safeReply }
    });

    const now = new Date();
    const followupState = buildFollowupState({ reply: safeReply, classification, menu, copyText, followUpMessages: safeFollowUpMessages, media }, conversation.metadata, now);
    const currentLeadProfile = readLeadProfile(conversation.metadata);
    const lastBotQuestion = extractLastQuestion(safeReply);
    const nextMetadata = {
      ...(conversation.metadata || {}),
      last_bot_message_at: now.toISOString(),
      lead_profile: {
        ...currentLeadProfile,
        last_bot_question: lastBotQuestion || currentLeadProfile.last_bot_question,
        updated_at: now.toISOString()
      },
      ...followupState
    };
    await this.conversationsRepository.updateConversationMetadata(conversation.id, nextMetadata);
    await this.conversationsRepository.touchConversation(conversation.id, now.toISOString());
    await this.auditService.createAuditLog({
      actor_type: "ai_agent",
      action: "evolution_reply_sent",
      entity_type: "conversations",
      entity_id: conversation.id,
      metadata: {
        webhookEventId,
        externalMessageId: message.externalMessageId,
        intent: classification.intent,
        confidence: classification.confidence
      }
    });

    return { status: "processed" as const, reply: safeReply };
  }

  private safeCreateAgentEvent(input: Parameters<AgentEventLogService["safeCreateEvent"]>[0]) {
    try {
      return (this.agentEventLogService || new AgentEventLogService()).safeCreateEvent(input);
    } catch {
      return null;
    }
  }

  private safeNotifyHotLead(input: Parameters<HotLeadAlertService["maybeNotifyHotLead"]>[0]) {
    try {
      return (this.hotLeadAlertService || new HotLeadAlertService()).maybeNotifyHotLead(input);
    } catch {
      return null;
    }
  }

  private async sanitizeAndValidateCustomerText({
    text,
    conversation,
    webhookEventId,
    leadProfile
  }: {
    text: string;
    conversation: { id: string };
    webhookEventId: string;
    leadProfile: Record<string, unknown>;
  }) {
    const sanitized = sanitizeCustomerMessage(text);
    let safeText = sanitized.text;
    let blockedReason = sanitized.reason;

    const recentMessages = await this.listRecentConversationMessages(conversation.id);
    const recentBotMessages = recentMessages
      .filter((item) => item.role === "assistant" && typeof item.content === "string")
      .slice(-5)
      .map((item) => item.content as string);
    const profileValidation = validateResponseAgainstLeadProfile(safeText, leadProfile, recentBotMessages);
    if (!profileValidation.valid) {
      safeText = CUSTOMER_SAFE_FALLBACK;
      blockedReason = profileValidation.reason;
    }

    if (sanitized.blocked || blockedReason) {
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: "customer_message_safety_blocked",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: { webhookEventId, reason: blockedReason || sanitized.reason, originalText: text }
      });
      await this.safeCreateAgentEvent({
        conversation_id: conversation.id,
        event_type: blockedReason === "similar_to_recent_bot_message" || blockedReason === "asks_device_again" || blockedReason === "asks_download_again"
          ? "repetition_blocked"
          : sanitized.reason === "internal_debug"
            ? "debug_blocked"
            : "response_sanitized",
        event_source: "system",
        metadata: { webhookEventId, reason: blockedReason || sanitized.reason, proposed_response_excerpt: text }
      });
    }

    return safeText;
  }

  private async listRecentConversationMessages(conversationId: string) {
    const listMessages = (this.messagesRepository as unknown as {
      listMessagesByConversationId?: (conversationId: string, limit?: number) => Promise<Array<Record<string, unknown>>>;
    }).listMessagesByConversationId;
    if (!listMessages) {
      return [];
    }

    try {
      const messages = await listMessages.call(this.messagesRepository, conversationId, 12);
      return messages.map((item) => ({
        role: typeof item.role === "string" ? item.role : undefined,
        content: typeof item.content === "string" ? item.content : null
      }));
    } catch {
      return [];
    }
  }

  private async listRelevantSpecialistExamples(metadata: Record<string, unknown> | null | undefined, customerMessage: string) {
    const leadProfile = readLeadProfile(metadata);
    try {
      const repository = this.specialistTrainingExamplesRepository || new SpecialistTrainingExamplesRepository();
      return await repository.getRelevantSpecialistExamples({
        intent: typeof leadProfile.ultima_intencao === "string" ? leadProfile.ultima_intencao : null,
        stage: typeof leadProfile.stage === "string" ? leadProfile.stage : null,
        objection: typeof leadProfile.main_objection === "string" ? leadProfile.main_objection : null,
        device: typeof leadProfile.device === "string" ? leadProfile.device : null,
        customerMessage,
        limit: 3
      });
    } catch {
      return [];
    }
  }

  private async isBotEcho(conversationId: string, message: IncomingEvolutionMessage) {
    const listMessages = (this.messagesRepository as unknown as {
      listMessagesByConversationId?: (conversationId: string, limit?: number) => Promise<Array<Record<string, unknown>>>;
    }).listMessagesByConversationId;

    if (!listMessages) {
      return false;
    }

    const recentMessages = await listMessages.call(this.messagesRepository, conversationId, 12);
    const messageHash = createCustomerMessageHash(message.text);
    const messageDate = getMessageDate(message).getTime();

    return recentMessages.some((recent) => {
      if (recent.role !== "assistant") {
        return false;
      }

      const metadata = recent.metadata && typeof recent.metadata === "object" ? recent.metadata as Record<string, unknown> : {};
      if (metadata.provider_message_id === message.externalMessageId) {
        return true;
      }
      const content = typeof recent.content === "string" ? recent.content : "";
      const sameContent = createCustomerMessageHash(content) === messageHash || metadata.content_hash === messageHash;
      if (!sameContent) {
        return false;
      }

      const sentAt = typeof metadata.sent_at === "string" ? new Date(metadata.sent_at).getTime() : null;
      if (!sentAt || Number.isNaN(sentAt)) {
        return true;
      }

      return Math.abs(messageDate - sentAt) <= 90_000;
    });
  }

  private async recordSpecialistTrainingExample({
    webhookEventId,
    conversation,
    customer,
    message,
    messageAt
  }: {
    webhookEventId: string;
    conversation: { id: string; metadata?: Record<string, unknown> | null };
    customer: { id: string; phone?: string | null };
    message: IncomingEvolutionMessage;
    messageAt: string;
  }) {
    try {
      const listMessages = (this.messagesRepository as unknown as {
        listMessagesByConversationId?: (conversationId: string, limit?: number) => Promise<Array<Record<string, unknown>>>;
      }).listMessagesByConversationId;
      const allRecentMessages = listMessages ? await listMessages.call(this.messagesRepository, conversation.id, 20) : [];
      const recentMessages = allRecentMessages
        .filter((item) => item.external_message_id !== message.externalMessageId)
        .slice(-8);
      const customerLastMessage = [...recentMessages].reverse().find((item) => item.role === "customer");
      const botPreviousMessage = [...recentMessages].reverse().find((item) => item.role === "assistant");
      const botCreatedAt = typeof botPreviousMessage?.created_at === "string" ? new Date(botPreviousMessage.created_at).getTime() : null;
      const specialistAt = new Date(messageAt).getTime();
      const botWasOverridden = Boolean(
        botCreatedAt && specialistAt >= botCreatedAt && specialistAt - botCreatedAt <= 10 * 60 * 1000
      );
      const leadProfile = readLeadProfile(conversation.metadata);
      const customerLastText = typeof customerLastMessage?.content === "string" ? customerLastMessage.content : null;
      const botPreviousText = typeof botPreviousMessage?.content === "string" ? botPreviousMessage.content : null;
      const conversationExcerpt = buildMaskedConversationExcerpt(recentMessages, message.text);
      const maskedCustomerMessage = maskSpecialistTrainingText(customerLastText);
      const maskedBotMessage = maskSpecialistTrainingText(botPreviousText);
      const maskedSpecialistMessage = maskSpecialistTrainingText(message.text) || "";
      const analysis = await this.specialistInterventionAnalysis.analyzeSpecialistIntervention({
        customerLastMessage: maskedCustomerMessage,
        botPreviousMessage: maskedBotMessage,
        specialistMessage: maskedSpecialistMessage,
        conversationExcerpt,
        leadProfile
      });

      const repository = this.specialistTrainingExamplesRepository || new SpecialistTrainingExamplesRepository();
      await repository.createExample({
        conversation_id: conversation.id,
        customer_id: customer.id,
        customer_phone: customer.phone || message.phone,
        source: "whatsapp",
        customer_last_message: maskedCustomerMessage,
        bot_previous_message: maskedBotMessage,
        specialist_message: maskedSpecialistMessage,
        conversation_excerpt: conversationExcerpt,
        inferred_intent: analysis.inferred_intent,
        inferred_stage: analysis.inferred_stage,
        inferred_objection: analysis.inferred_objection,
        inferred_customer_state: analysis.inferred_customer_state,
        inferred_specialist_action: analysis.inferred_specialist_action,
        why_specialist_intervened: analysis.why_specialist_intervened,
        style_notes: analysis.style_notes,
        should_copy_style: true,
        reason: botWasOverridden ? "correction" : "human_takeover",
        bot_response_was_overridden: botWasOverridden,
        human_intervention_detected: true,
        success_signal: "unknown",
        metadata: {
          webhookEventId,
          externalMessageId: message.externalMessageId,
          device: leadProfile.device || leadProfile.aparelho || null,
          summary: analysis.summary,
          learned_pattern: analysis.learned_pattern,
          next_best_action: analysis.next_best_action
        }
      });
      return { analysis, summary: analysis.summary, botResponseWasOverridden: botWasOverridden };
    } catch (error) {
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: "specialist_training_example_failed",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: { webhookEventId, error: error instanceof Error ? error.message : "unknown_error" }
      });
      return null;
    }
  }

  private async updateSpecialistExampleSuccessSignal(
    conversationId: string,
    customerMessage: string,
    metadata: Record<string, unknown> | null | undefined
  ) {
    if (!readLeadProfile(metadata).learned_from_specialist) {
      return;
    }

    const signal = inferSpecialistExampleSuccessSignal(customerMessage);
    try {
      const repository = this.specialistTrainingExamplesRepository || new SpecialistTrainingExamplesRepository();
      await repository.markLatestConversationExampleSignal(conversationId, signal);
    } catch {
      // Training telemetry must never interrupt customer service.
    }
  }

  private async notifyHumanOwner({
    webhookEventId,
    customer,
    conversationId,
    message,
    notificationText
  }: {
    webhookEventId: string;
    customer: { id: string; name?: string | null; phone?: string | null };
    conversationId: string;
    message: IncomingEvolutionMessage;
    notificationText?: string;
  }) {
    const customerName = message.contactName || customer.name || "Cliente";
    const customerPhone = message.phone || customer.phone || "sem telefone";
    const notification = notificationText || [
      "Um cliente pediu para falar com um especialista.",
      "Responda lá no WhatsApp.",
      "",
      `Cliente: ${customerName}`,
      `WhatsApp: +${customerPhone}`,
      `Mensagem: ${message.text || "(sem texto)"}`,
      `Conversa: ${conversationId}`
    ].join("\n");

    try {
      const notificationResult = await this.evolutionService.sendTextMessage({ phone: HUMAN_NOTIFICATION_PHONE, text: notification });
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: "human_handoff_owner_notified",
        entity_type: "conversations",
        entity_id: conversationId,
        metadata: { webhookEventId, ownerPhone: HUMAN_NOTIFICATION_PHONE, notificationResult }
      });
    } catch (error) {
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: "human_handoff_owner_notification_failed",
        entity_type: "conversations",
        entity_id: conversationId,
        metadata: { webhookEventId, error: error instanceof Error ? error.message : "unknown_error" }
      });
    }
  }

  private async handleReceiptMessage({
    webhookEventId,
    message,
    customer,
    conversation
  }: {
    webhookEventId: string;
    message: IncomingEvolutionMessage;
    customer: { id: string };
    conversation: { id: string };
  }) {
    const latestOrder = await this.ordersService.findLatestOpenOrderByCustomerId(customer.id);

    if (latestOrder) {
      const updatedOrder = await this.ordersService.updateOrder(latestOrder.id, {
        status: "receipt_under_review",
        metadata: {
          ...(latestOrder.metadata || {}),
          receiptMessageId: message.externalMessageId,
          receiptReceivedAt: new Date().toISOString(),
          webhookEventId
        }
      });

      await this.receiptsService.createReceipt({
        order_id: updatedOrder.id,
        customer_id: customer.id,
        file_url: message.media.url || null,
        file_path: null,
        mime_type: message.media.mimeType || null,
        status: "manual_review",
        ai_raw_response: {
          source: "whatsapp",
          externalMessageId: message.externalMessageId,
          messageType: message.messageType,
          text: message.text,
          media: message.media
        }
      });

      await this.agentActionsService.createAgentAction({
        conversation_id: conversation.id,
        customer_id: customer.id,
        order_id: updatedOrder.id,
        action_name: "receipt_under_review",
        status: "requested",
        input_payload: { externalMessageId: message.externalMessageId, media: message.media, text: message.text },
        output_payload: { order_number: updatedOrder.order_number },
        requires_human_approval: true
      });

      await this.auditService.createAuditLog({
        actor_type: "ai_agent",
        action: "receipt_received_manual_review",
        entity_type: "orders",
        entity_id: updatedOrder.id,
        metadata: { webhookEventId, externalMessageId: message.externalMessageId }
      });
    } else {
      await this.agentActionsService.createAgentAction({
        conversation_id: conversation.id,
        customer_id: customer.id,
        action_name: "receipt_received_without_order",
        status: "requested",
        input_payload: { externalMessageId: message.externalMessageId, media: message.media, text: message.text },
        output_payload: {},
        requires_human_approval: true
      });
    }

    return "Recebi o comprovante ✅ Vou enviar para conferência e te retorno assim que for validado.";
  }
}

function isReceiptMessage(message: IncomingEvolutionMessage) {
  const text = message.text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const receiptText = /\b(comprovante|recibo|print do pagamento|transferencia)\b/.test(text);
  const receiptMedia = message.hasMedia && ["imageMessage", "documentMessage"].includes(message.messageType);

  return receiptText || receiptMedia;
}

function isStaleFreeTrialHandoff(metadata: Record<string, unknown> | null | undefined) {
  const reason = metadata?.handoff_reason;
  return reason === "free_trial" || reason === "free_trial_activation";
}

function isHumanHandoffTimeoutExpired(metadata: Record<string, unknown> | null | undefined, now = new Date()) {
  const referenceDate = firstValidMetadataDate(metadata?.last_specialist_message_at, metadata?.handoff_requested_at);
  if (!referenceDate) {
    return false;
  }

  return now.getTime() - referenceDate.getTime() >= HUMAN_HANDOFF_TIMEOUT_MS;
}

function isRecentSpecialistActivity(metadata: Record<string, unknown> | null | undefined, now = new Date()) {
  const specialistMessageAt = firstValidMetadataDate(metadata?.last_specialist_message_at);
  if (!specialistMessageAt) {
    return false;
  }

  return now.getTime() - specialistMessageAt.getTime() < HUMAN_HANDOFF_TIMEOUT_MS;
}

function firstValidMetadataDate(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }

    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return null;
}

function getMessageDate(message: IncomingEvolutionMessage) {
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    const milliseconds = message.timestamp > 10_000_000_000 ? message.timestamp : message.timestamp * 1000;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return new Date();
}

function extractLastQuestion(text: string) {
  const questions = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith("?"));

  return questions.at(-1) || null;
}

function isHumanHandoffRequest(text: string) {
  return /\b(falar|fala|conversar|chamar|atendente|humano|pessoa|especialista|suporte humano|vendedor|consultor|responsavel)\b/i.test(text) &&
    /\b(humano|atendente|especialista|pessoa|alguem|algu[eé]m|vendedor|consultor|responsavel)\b/i.test(text);
}

function isBotResumeRequest(text: string) {
  return /\b(ativar|reativar|voltar|retomar|liberar|reiniciar)\b/i.test(text) &&
    /\b(bot|agente|automatico|autom[aá]tico|atendimento automatico|atendimento autom[aá]tico)\b/i.test(text);
}

function buildFollowupState(
  output: {
    reply: string;
    classification: Record<string, unknown>;
    menu?: WhatsAppMenu;
    copyText?: string;
    followUpMessages?: string[];
    media?: unknown;
  },
  metadata: Record<string, unknown> | null | undefined,
  now: Date
) {
  const intent = String(output.classification.intent || "");
  const key = inferFollowupKey(output, intent);
  if (!key) {
    return {
      followup_key: null,
      followup_due_at: null,
      awaiting_customer_action: null
    };
  }

  const stageId = `${intent || "conversation"}:${key}:${now.getTime()}`;
  return {
    followup_key: key,
    followup_due_at: new Date(now.getTime() + CUSTOMER_FOLLOWUP_DELAY_MS).toISOString(),
    followup_sent_at: null,
    followup_sent_stage_id: null,
    followup_count: 0,
    last_followup_stage_id: stageId,
    awaiting_customer_action: inferAwaitingAction(key),
    conversation_stage: inferConversationStage(intent, key),
    plan_interest: metadata?.lead_profile && typeof metadata.lead_profile === "object"
      ? (metadata.lead_profile as Record<string, unknown>).plano_interesse || metadata.plan_interest || null
      : metadata?.plan_interest || null,
    device: metadata?.lead_profile && typeof metadata.lead_profile === "object"
      ? (metadata.lead_profile as Record<string, unknown>).device || (metadata.lead_profile as Record<string, unknown>).aparelho || metadata.device || null
      : metadata?.device || null
  };
}

function inferFollowupKey(
  output: { reply: string; classification: Record<string, unknown>; menu?: WhatsAppMenu; copyText?: string; media?: unknown },
  intent: string
) {
  const reply = output.reply.toLowerCase();
  if (intent === "greeting") return "welcome_activation";
  if (output.copyText || output.media || intent === "pix_payment") return "pix";
  if (intent === "receipt_sent" || /\bcomprovante\b/i.test(reply)) return "proof";
  if (intent === "ask_price") return "values";
  if (intent === "buy_plan" || intent === "renew_plan") return output.menu?.id === "plans" ? "plan_choice" : "pix";
  if (intent === "free_trial") return "test";
  if (intent === "technical_support") {
    if (/download|baixar|apk/i.test(reply)) return "download";
    return "install";
  }
  if (/telas?|aparelhos ao mesmo tempo/i.test(reply)) return "screens";
  if (intent === "human_help") return "support";
  if (output.menu?.id === "plans") return "plan_choice";
  if (output.menu?.id === "install") return "download";
  return null;
}

function inferAwaitingAction(key: string) {
  const actions: Record<string, string> = {
    values: "choose_plan",
    welcome_activation: "answer_welcome_intent",
    plan_choice: "choose_plan",
    download: "confirm_download",
    install: "install_app",
    test: "confirm_test",
    pix: "send_proof",
    proof: "send_proof",
    screens: "answer_screens",
    support: "human_support",
    generic: "none"
  };
  return actions[key] || "none";
}

function inferConversationStage(intent: string, key: string) {
  if (key === "pix") return "aguardando_pix";
  if (key === "welcome_activation") return "boas_vindas";
  if (key === "proof") return "aguardando_comprovante";
  if (key === "download" || key === "install") return "instalacao";
  if (key === "test") return "teste";
  if (key === "values" || key === "plan_choice") return "valores";
  if (intent === "human_help") return "humano";
  return "qualificacao";
}

function readLeadProfile(metadata: Record<string, unknown> | null | undefined) {
  const profile = metadata?.lead_profile;
  return profile && typeof profile === "object" && !Array.isArray(profile) ? (profile as Record<string, unknown>) : {};
}

function buildLeadProfilePatch(text: string, intent: string, metadata: Record<string, unknown> | null | undefined) {
  const normalized = text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const existing = readLeadProfile(metadata);
  const patch: Record<string, unknown> = {
    ultima_intencao: intent,
    etapa_atual: mapIntentToStage(intent),
    stage: mapIntentToStage(intent),
    last_customer_answer: text
  };

  if (!existing.intencao_inicial) {
    patch.intencao_inicial = intent;
  }

  const plan = detectPlanInterest(normalized);
  if (plan) {
    patch.plano_interesse = plan;
    patch.selected_plan = normalizePlanId(plan);
    patch.nivel_interesse = "quente";
  }

  if (isUnitvInstallationRequest(text)) {
    const device = detectUnitvDevice(text);
    const deviceConfig = UNITV_DEVICE_COMPATIBILITY[device];
    patch.aparelho = deviceConfig.label;
    patch.device = device;
    patch.device_compatible = deviceConfig.compatible;
  }

  const lastBotQuestion = typeof existing.last_bot_question === "string" ? normalizeFreeText(existing.last_bot_question) : "";
  if (/\b(ativar|ativacao|liberar acesso|codigo|c[oó]digo)\b/.test(normalized)) {
    patch.wants_activation = true;
  }
  if (/\b(renovar|renovacao|recarga|recarregar)\b/.test(normalized)) {
    patch.wants_recharge = true;
  }
  if (/\b(nao paguei|nao fiz o pagamento|ainda nao paguei|n paguei|nem paguei)\b/.test(normalized)) {
    patch.has_paid = false;
    patch.payment_status = "not_paid";
    patch.enviou_comprovante = false;
    patch.nivel_interesse = "quente";
  }
  if (/\b(ja paguei|paguei|fiz o pagamento|feito o pagamento|pagamento feito|acabei de pagar)\b/.test(normalized)) {
    patch.has_paid = true;
    patch.payment_status = "paid_unverified";
    patch.nivel_interesse = "quente";
  }
  if (/\b(ja baixei|baixei|download feito|fiz o download)\b/.test(normalized) ||
      (/^(sim|s|ja|já|ok|feito|consegui)$/.test(normalized) && /\b(baixou|download|instalou|instalar)\b/.test(lastBotQuestion))) {
    patch.downloaded_app = true;
    patch.pediu_download = true;
    patch.nivel_interesse = "quente";
  }
  if (/\b(ja instalei|instalei|instalado|app instalado)\b/.test(normalized)) {
    patch.downloaded_app = true;
    patch.installed_app = true;
    patch.pediu_download = true;
    patch.nivel_interesse = "quente";
  }
  if (/\b(ja usei|ja tenho|uso|ja conheco|ja conheço)\b/.test(normalized)) {
    patch.used_app_before = true;
    patch.nivel_interesse = "quente";
  }
  if (/\b(preco|preco|valor|valores|quanto custa|planos?)\b/.test(normalized)) {
    patch.asked_price = true;
  }
  if (/\b(telas?|aparelhos ao mesmo tempo)\b/.test(normalized)) {
    patch.asked_screens = true;
  }
  if (/\b(download|baixar|apk|downloader|instalar|instalacao)\b/.test(normalized)) {
    patch.pediu_download = true;
  }
  if (/\b(teste|gratis|gratuito|free trial)\b/.test(normalized)) {
    patch.pediu_teste_gratis = true;
    patch.wants_test = true;
    patch.nivel_interesse = "morno";
  }
  if (/\bpix\b/.test(normalized)) {
    patch.pediu_pix = true;
    patch.nivel_interesse = "quente";
  }
  if (/\b(comprovante|recibo|print do pagamento|paguei|ja paguei|fiz o pagamento)\b/.test(normalized)) {
    patch.enviou_comprovante = true;
    patch.nivel_interesse = "quente";
  }
  if (/\b(humano|especialista|atendente|suporte humano)\b/.test(normalized)) {
    patch.precisou_humano = true;
  }

  const objection = detectMainObjection(normalized);
  if (objection) {
    patch.objecao_principal = existing.objecao_principal || objection;
    patch.main_objection = existing.main_objection || objection;
    if (existing.objecao_principal && existing.objecao_principal !== objection) {
      patch.segunda_objecao = objection;
    }
  }

  patch.resumo_curto = buildShortConversationSummary(patch, existing);
  patch.proxima_acao = suggestNextAction(patch, existing);
  patch.next_best_action = patch.proxima_acao;

  return patch;
}

function normalizeFreeText(text: string) {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function mapIntentToStage(intent: string) {
  const stages: Record<string, string> = {
    greeting: "inicio",
    ask_price: "avaliando_planos",
    buy_plan: "escolha_plano",
    renew_plan: "recarga",
    free_trial: "teste_gratis",
    technical_support: "instalacao",
    pix_payment: "pagamento_pix",
    card_payment: "pagamento_cartao",
    receipt_sent: "comprovante",
    human_help: "atendimento_humano"
  };
  return stages[intent] || "conversa";
}

function detectPlanInterest(normalized: string) {
  if (/\banual|1 ano|365\b/.test(normalized)) return "anual";
  if (/\b6 meses|semestral|180\b/.test(normalized)) return "6 meses";
  if (/\b3 meses|trimestral|90\b/.test(normalized)) return "3 meses";
  if (/\bmensal|30 dias|mes\b/.test(normalized)) return "mensal";
  return null;
}

function normalizePlanId(plan: string) {
  if (plan === "3 meses") return "3_meses";
  if (plan === "6 meses") return "6_meses";
  return plan;
}

function detectMainObjection(normalized: string) {
  if (/\bcaro|desconto|promo|mais barato|barato\b/.test(normalized)) return "preco";
  if (/\btrava|travando|cai|funciona mesmo\b/.test(normalized)) return "estabilidade";
  if (/\bgolpe|confiavel|medo\b/.test(normalized)) return "confianca";
  if (/\bnao sei instalar|instalar|download|apk\b/.test(normalized)) return "download_instalacao";
  if (/\btelas?\b/.test(normalized)) return "telas";
  return null;
}

function buildShortConversationSummary(patch: Record<string, unknown>, existing: Record<string, unknown>) {
  const plan = patch.plano_interesse || existing.plano_interesse || "sem plano definido";
  const device = patch.aparelho || existing.aparelho || "aparelho não informado";
  const stage = patch.etapa_atual || existing.etapa_atual || "conversa";
  return `Cliente em ${stage}, plano: ${plan}, aparelho: ${device}.`;
}

function suggestNextAction(patch: Record<string, unknown>, existing: Record<string, unknown>) {
  const stage = String(patch.etapa_atual || existing.etapa_atual || "");
  if (patch.pediu_pix) return "gerar Pix após confirmar o plano";
  if (stage === "instalacao") return "enviar orientação correta de instalação";
  if (stage === "teste_gratis") return "confirmar aparelho e liberar teste";
  if (stage === "escolha_plano" || stage === "recarga") return "confirmar plano e forma de pagamento";
  if (patch.precisou_humano) return "aguardar especialista";
  return "responder dúvida e conduzir ao próximo passo";
}

function inferSpecialistExampleSuccessSignal(message: string): "positive" | "neutral" | "negative" {
  const normalized = normalizeFreeText(message);
  if (/\b(errado|nao entendeu|nao e isso|nao quero|desisto|cancelar)\b/.test(normalized)) {
    return "negative";
  }
  if (/\b(sim|ok|pode|quero|mensal|anual|pix|cartao|paguei|feito|consegui)\b/.test(normalized)) {
    return "positive";
  }
  return "neutral";
}

function inferCustomerAgentEvents(text: string, intent: string, leadProfilePatch: Record<string, unknown>) {
  const normalized = normalizeFreeText(text);
  const events = new Set<Parameters<AgentEventLogService["safeCreateEvent"]>[0]["event_type"]>();

  if (intent === "ask_price" || leadProfilePatch.asked_price) events.add("price_asked");
  if (intent === "free_trial" || leadProfilePatch.wants_test || leadProfilePatch.pediu_teste_gratis) events.add("test_asked");
  if (intent === "pix_payment" || leadProfilePatch.pediu_pix) events.add("pix_asked");
  if (intent === "receipt_sent" || leadProfilePatch.enviou_comprovante) events.add("proof_sent");
  if (intent === "human_help" || leadProfilePatch.precisou_humano) events.add("support_requested");
  if (leadProfilePatch.selected_plan || leadProfilePatch.plano_interesse) events.add("plan_selected");
  if (/\b(download|baixar|apk|link)\b/.test(normalized) || leadProfilePatch.pediu_download) events.add("download_asked");
  if (/\b(instalar|instalacao|downloader|play store)\b/.test(normalized)) events.add("installation_asked");
  if (/\b(erro|nao consigo|nao baixa|nao abre|travou|nao instala|link nao funciona)\b/.test(normalized)) events.add("install_stuck");

  return [...events];
}

function extractEvolutionProviderMessageId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["id", "messageId", "message_id", "provider_message_id"]) {
    if (typeof record[key] === "string" && record[key]) {
      return record[key];
    }
  }

  for (const key of ["key", "data", "message", "text", "menu"]) {
    const nested = extractEvolutionProviderMessageId(record[key]);
    if (nested) {
      return nested;
    }
  }

  return null;
}
