import "server-only";
import { CustomersRepository } from "@/repositories/customers.repository";
import { ConversationsRepository } from "@/repositories/conversations.repository";
import { MessagesRepository } from "@/repositories/messages.repository";
import { AuditService } from "@/services/audit.service";
import { ChatAgentService, INITIAL_UNITV_REPLY } from "@/services/agent/chat-agent.service";
import {
  OFFICIAL_ALL_PLAN_PRICES_TEXT,
  OFFICIAL_MONTHLY_MAX_SCREENS,
  OFFICIAL_MONTHLY_OFFER_TEXT
} from "@/lib/unitv/official-catalog";
import { IntentClassifierService, type IntentClassification } from "@/services/agent/intent-classifier.service";
import { AgentActionsService } from "@/services/agent-actions.service";
import { EvolutionService } from "@/services/evolution/evolution.service";
import { OrdersService } from "@/services/orders.service";
import { ReceiptsService } from "@/services/receipts.service";
import { isIncomingAudioMessage, type IncomingEvolutionMessage } from "@/lib/evolution/client";
import { resolveMenuSelection, type WhatsAppMenu } from "@/lib/whatsapp/menus";
import {
  classifyCustomerFacingResponseIntent,
  createCustomerMessageHash,
  sanitizeCustomerMessage,
  validateResponseAgainstLeadProfile
} from "@/lib/whatsapp/customer-message-safety";
import { SpecialistTrainingExamplesRepository } from "@/repositories/specialist-training-examples.repository";
import { AgentLearningMemoriesRepository } from "@/repositories/agent-learning-memories.repository";
import { buildMaskedConversationExcerpt, maskSpecialistTrainingText } from "@/lib/whatsapp/specialist-training-privacy";
import { SpecialistInterventionAnalysisService } from "@/services/agent/specialist-intervention-analysis.service";
import { AgentEventLogService } from "@/services/audit/agent-event-log.service";
import { CustomerMessageBurstService } from "@/services/whatsapp/customer-message-burst.service";
import {
  ContextualIntelligenceService,
  type CommercialContext,
  type ContextualDecision
} from "@/services/agent/contextual-intelligence.service";
import {
  ConversationBrainService,
  type AgentBackendArtifact
} from "@/services/agent/conversation-brain.service";
import { ContextualResponseAIService } from "@/services/agent/contextual-response-ai.service";
import { buildSpecialistLearningGuidance, type SpecialistLearningGuidance } from "@/services/agent/specialist-learning-guidance";
import {
  AudioTranscriptionService,
  readAudioTranscriptionErrorCode,
  type AudioTranscriptionResult
} from "@/services/audio/audio-transcription.service";
import {
  detectUnitvDevice,
  isUnitvInstallationRequest,
  UNITV_DEVICE_COMPATIBILITY
} from "@/lib/unitv/device-compatibility";
import { resolveConversationState, withCanonicalConversationState } from "@/lib/conversation-state";
import {
  GREETING_FIRST_FOLLOWUP_DELAY_MS,
  GREETING_FOLLOWUP_POLICY_VERSION
} from "@/lib/greeting-followup-policy";
import { ShadowDecisionService } from "@/services/agent/shadow-decision.service";

const HUMAN_NOTIFICATION_PHONE = "558699802602";
const HUMAN_HANDOFF_TIMEOUT_MS = 5 * 60 * 1000;
const CUSTOMER_FOLLOWUP_DELAY_MS = 5 * 60 * 1000;
const POST_DOWNLOAD_FOLLOWUP_DELAY_MS = 10 * 60 * 1000;
const RESPONSE_INTENT_LOCK_MS = 30 * 60 * 1000;
const PRE_SALE_RECHARGE_LATER_FOLLOWUP_KEY = "pre_sale_recharge_later_4h";
const PRE_SALE_RECHARGE_LATER_DELAY_MS = 4 * 60 * 60 * 1000;
const PIX_COPY_PASTE_GUIDANCE = "Essa é a Chave Copia e Cola, é so voce copiar e colar no seu banco ⬆️";

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
    _removedAutomaticAdminAlertService?: unknown,
    private readonly contextualIntelligenceService = new ContextualIntelligenceService(),
    private readonly conversationBrainService = new ConversationBrainService(),
    private readonly agentLearningMemoriesRepository?: AgentLearningMemoriesRepository,
    private readonly customerMessageBurstService = new CustomerMessageBurstService(
      process.env.NODE_ENV === "test" ? 0 : undefined
    ),
    private readonly contextualResponseAIService = new ContextualResponseAIService(),
    private readonly audioTranscriptionService?: AudioTranscriptionService,
    private readonly shadowDecisionService?: ShadowDecisionService
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
    const metaReferralPatch = buildMetaReferralConversationPatch(message.metaReferral);
    const existingConversation = await this.conversationsRepository.findByExternalConversationId(externalConversationId);
    const conversation =
      existingConversation ||
      (await this.conversationsRepository.createConversation({
        customer_id: customer.id,
        channel: "whatsapp",
        external_conversation_id: externalConversationId,
        status: "open",
        last_message_at: new Date().toISOString(),
        metadata: { instance: message.instance, ...metaReferralPatch }
      }));

    let audioTranscription: AudioTranscriptionResult | null = null;
    if (!message.fromMe && isIncomingAudioMessage(message)) {
      try {
        audioTranscription = await (this.audioTranscriptionService || new AudioTranscriptionService()).transcribeWhatsAppAudio({
          externalMessageId: message.externalMessageId,
          conversationId: conversation.id,
          declaredMimeType: message.media.mimeType,
          declaredFileName: message.media.fileName
        });
        message = { ...message, text: audioTranscription.text };
        await this.auditService.createAuditLog({
          actor_type: "ai_agent",
          action: "audio_transcription_completed",
          entity_type: "conversations",
          entity_id: conversation.id,
          metadata: {
            webhookEventId,
            model: audioTranscription.model,
            bytes: audioTranscription.bytes,
            transcript_characters: audioTranscription.text.length,
            truncated: audioTranscription.truncated
          }
        });
      } catch (error) {
        return this.handleAudioTranscriptionFailure({
          webhookEventId,
          message,
          customer,
          conversation,
          errorCode: readAudioTranscriptionErrorCode(error)
        });
      }
    }

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
          metaReferral: message.metaReferral || null,
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
      const manualPaymentCommand = parseManualPaymentCommand(message.text);
      if (manualPaymentCommand) {
        const hasPlanAlreadySelected = Boolean(
          extractManualPaymentPlan(
            normalizeCommandText(String(existingLeadProfile.selected_plan || existingLeadProfile.plano_interesse || "")),
            null
          )
        );
        const manualPaymentRequiresHumanReview =
          manualPaymentCommand.method === "pix" && !manualPaymentCommand.plan && !hasPlanAlreadySelected;
        const commandMetadata = {
          ...(conversation.metadata || {}),
          requires_human: false,
          handoff_reason: null,
          handoff_resolved_at: messageAt,
          handoff_resolved_by: "manual_payment_command",
          manual_payment_command: {
            method: manualPaymentCommand.method,
            plan: manualPaymentCommand.plan,
            amount_cents: manualPaymentCommand.amountCents,
            requires_human_review: manualPaymentRequiresHumanReview,
            message_id: message.externalMessageId,
            created_at: messageAt
          },
          lead_profile: {
            ...existingLeadProfile,
            ...manualPaymentCommand.leadProfilePatch,
            manual_payment_requires_human_review: manualPaymentRequiresHumanReview,
            manual_payment_command_message_id: message.externalMessageId,
            last_specialist_message_at: messageAt,
            learned_from_specialist: true,
            updated_at: messageAt
          }
        };
        await this.conversationsRepository.updateConversationMetadata(conversation.id, commandMetadata);
        conversation.metadata = commandMetadata;
        await this.conversationsRepository.touchConversation(conversation.id, messageAt);

        const recentMessages = await this.listRecentConversationMessages(conversation.id);
        const commercialReply = await this.chatAgent.generateCommercialReply({
          message: manualPaymentCommand.effectiveMessage,
          classification: {
            intent: manualPaymentCommand.intent,
            confidence: 1,
            summary: manualPaymentCommand.summary,
            suggested_reply: ""
          },
          customer,
          conversation,
          webhookEventId,
          recentMessages,
          deferResponseWritingToContextualAI: true
        });
        await this.auditService.createAuditLog({
          actor_type: "human_admin",
          action: "manual_payment_command_executed",
          entity_type: "conversations",
          entity_id: conversation.id,
          metadata: {
            webhookEventId,
            externalMessageId: message.externalMessageId,
            method: manualPaymentCommand.method,
            plan: manualPaymentCommand.plan,
            amount_cents: manualPaymentCommand.amountCents,
            requires_human_review: manualPaymentRequiresHumanReview
          }
        });

        return this.sendAndStoreAssistantReply({
          webhookEventId,
          message,
          customer,
          conversation,
          reply: commercialReply.reply,
          classification: {
            intent: manualPaymentCommand.intent,
            confidence: 1,
            summary: manualPaymentCommand.summary
          },
          media: commercialReply.media,
          copyText: commercialReply.copyText,
          followUpMessages: commercialReply.followUpMessages,
          menu: commercialReply.menu,
          sendTextBeforeMenu: commercialReply.sendTextBeforeMenu,
          protectedOperationalReply: manualPaymentCommand.method === "pix"
        });
      }

      const manualFollowupState = buildManualOutboundFollowupState(message.text, conversation.metadata, new Date(messageAt));
      const manualLeadProfilePatch = buildManualOutboundLeadProfilePatch(message.text, messageAt);
      const manualLastQuestion = extractLastQuestion(message.text);
      const pausedMetadata = {
        ...(conversation.metadata || {}),
        ...manualFollowupState,
        requires_human: true,
        human_intervention_detected: true,
        handoff_reason: conversation.metadata?.handoff_reason || "human_agent_reply",
        handoff_requested_at: conversation.metadata?.handoff_requested_at || messageAt,
        last_specialist_message_at: messageAt,
        last_bot_message_at: messageAt,
        human_hold_until: new Date(new Date(messageAt).getTime() + HUMAN_HANDOFF_TIMEOUT_MS).toISOString(),
        lead_profile: {
          ...existingLeadProfile,
          ...manualLeadProfilePatch,
          last_bot_question: manualLastQuestion || existingLeadProfile.last_bot_question,
          last_specialist_message_at: messageAt,
          human_hold_until: new Date(new Date(messageAt).getTime() + HUMAN_HANDOFF_TIMEOUT_MS).toISOString(),
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
        media: audioTranscription
          ? { mimeType: message.media.mimeType || audioTranscription.mimeType, fileName: message.media.fileName || null }
          : message.media,
        metaReferral: message.metaReferral || null,
        hasMedia: message.hasMedia,
        timestamp: message.timestamp,
        webhookEventId,
        ...(audioTranscription
          ? {
              audio_transcription: {
                status: "completed",
                model: audioTranscription.model,
                bytes: audioTranscription.bytes,
                truncated: audioTranscription.truncated
              }
            }
          : {})
      }
    });
    await this.safeCreateAgentEvent({
      conversation_id: conversation.id,
      customer_phone: message.phone,
      event_type: "customer_message",
      event_source: "webhook",
      message_id: message.externalMessageId,
      metadata: {
        webhookEventId,
        text: message.text,
        messageType: message.messageType,
        transcribed_audio: Boolean(audioTranscription)
      }
    });
    await this.updateSpecialistExampleSuccessSignal(conversation.id, message.text, conversation.metadata);
      const customerMessageAt = getMessageDate(message).toISOString();
    conversation.metadata = {
      ...(conversation.metadata || {}),
      ...metaReferralPatch,
      last_customer_message_at: customerMessageAt,
      last_customer_message_id: message.externalMessageId,
      followup_due_at: null,
      response_due_at: null,
      awaiting_customer_action: null,
      lead_profile: {
        ...readLeadProfile(conversation.metadata),
        ...(metaReferralPatch.meta_ctwa_clid
          ? {
              meta_ctwa_clid: metaReferralPatch.meta_ctwa_clid,
              meta_ad_source_id: metaReferralPatch.meta_ad_source_id || null,
              meta_ad_source_url: metaReferralPatch.meta_ad_source_url || null,
              meta_entry_point: metaReferralPatch.meta_entry_point || null
            }
          : {})
      }
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

    if (isReceiptMessage(message, conversation.metadata)) {
      await this.safeCreateAgentEvent({
        conversation_id: conversation.id,
        customer_phone: message.phone,
        event_type: "proof_sent",
        event_source: "webhook",
        message_id: message.externalMessageId,
        metadata: { webhookEventId, hasMedia: message.hasMedia }
      });
      const reply = await this.handleReceiptMessage({ webhookEventId, message, customer, conversation });
      return this.sendAndStoreAssistantReply({ webhookEventId, message, customer, conversation, reply, classification: { intent: "receipt_sent" } });
    }

    if (!await this.customerMessageBurstService.isLatestMessageInBurst(conversation.id)) {
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: "customer_message_burst_coalesced",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: { webhookEventId, externalMessageId: message.externalMessageId }
      });
      return { status: "ignored" as const };
    }

    const responseRecoveryDueAt = new Date(new Date(customerMessageAt).getTime() + 5 * 60 * 1000).toISOString();
    conversation.metadata = {
      ...(conversation.metadata || {}),
      response_due_at: responseRecoveryDueAt,
      response_recovery_reason: "customer_message_waiting_for_agent_reply"
    };
    await this.conversationsRepository.updateConversationMetadata(conversation.id, conversation.metadata);

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
      classification = await this.intentClassifier.classify({ message: message.text, conversationId: conversation.id });
    }

    const leadProfilePatch = buildLeadProfilePatch(message.text, classification.intent, conversation.metadata);
    if (leadProfilePatch.accepted_special_promo) {
      effectiveMessage = "mensal pix promocao";
      classification = {
        intent: "pix_payment",
        confidence: 1,
        summary: "Cliente aceitou a promocao de recuperacao e pediu Pix.",
        suggested_reply: ""
      };
      leadProfilePatch.ultima_intencao = classification.intent;
      leadProfilePatch.etapa_atual = mapIntentToStage(classification.intent);
      leadProfilePatch.stage = mapIntentToStage(classification.intent);
    }
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
    const contextSnapshot = await this.buildCommercialContext({
      message,
      conversation,
      recentMessages
    });
    const [specialistExamples, learningMemories] = await Promise.all([
      this.listRelevantSpecialistExamples(conversation.metadata, message.text, recentMessages),
      this.listRelevantLearningMemories(conversation.metadata, message.text, recentMessages)
    ]);
    const specialistLearning = buildSpecialistLearningGuidance(specialistExamples, learningMemories);
    const contextualDecision = await this.contextualIntelligenceService.extract({
      context: contextSnapshot,
      useStrongModel: false,
      specialistLearning
    });
    if (await this.isCustomerMessageSuperseded(conversation.id, message.externalMessageId)) {
      await this.auditSupersededCustomerReply(conversation.id, webhookEventId, message.externalMessageId, "after_context_read");
      return { status: "ignored" as const };
    }
    const conversationBrainDecision = this.conversationBrainService.decide({
      context: contextSnapshot,
      contextualDecision,
      classificationIntent: classification.intent,
      directHumanRequest
    });
    const contextualPatch = buildContextualLeadProfilePatch(contextualDecision);
    if (Object.keys(contextualPatch).length) {
      const currentLeadProfile = readLeadProfile(conversation.metadata);
      const nextMetadata = {
        ...(conversation.metadata || {}),
        lead_profile: {
          ...currentLeadProfile,
          ...contextualPatch,
          updated_at: new Date().toISOString()
        }
      };
      // Keep the decision available to the current turn, but do not advance
      // the durable commercial state until its reply is actually delivered.
      conversation.metadata = nextMetadata;
    }
    const policy = applyContextualPolicy({
      decision: contextualDecision,
      classification,
      effectiveMessage
    });
    classification = policy.classification;
    effectiveMessage = policy.effectiveMessage;
    await this.auditService.createAuditLog({
      actor_type: "ai_agent",
      action: "conversation_brain_decision",
      entity_type: "conversations",
      entity_id: conversation.id,
      metadata: {
        webhookEventId,
        decision_source: contextualDecision.source || "unknown",
        detected_intent: contextualDecision.intent,
        contextual_detected_intent: contextualDecision.detected_intent,
        next_action: contextualDecision.next_action,
        should_reply: contextualDecision.should_reply,
        should_handoff: contextualDecision.should_handoff,
        should_clarify: contextualDecision.should_clarify,
        reason: contextualDecision.reason,
        previous_stage: contextSnapshot.lead_profile.stage || contextSnapshot.lead_profile.etapa_atual || null,
        new_stage: contextualDecision.stage,
        selected_plan: contextualDecision.selected_plan,
        open_order_id: contextSnapshot.open_order?.id || null,
        should_create_order: contextualDecision.should_create_order,
        should_generate_pix: contextualDecision.should_generate_pix,
        confidence: contextualDecision.confidence,
        human_hold_active: contextSnapshot.human_hold_active,
        followup_key: contextSnapshot.followup_key,
        followup_due_at: contextSnapshot.followup_due_at,
        brain_stage: conversationBrainDecision.stage,
        brain_context_active: conversationBrainDecision.contextActive,
        brain_response_rule: conversationBrainDecision.responseRule,
        brain_direct_reply: Boolean(conversationBrainDecision.directReply),
        brain_allows_initial_greeting: conversationBrainDecision.allowInitialGreeting,
        brain_allows_human_handoff: conversationBrainDecision.allowHumanHandoff,
        brain_allows_followup: conversationBrainDecision.allowFollowup,
        brain_evidence: conversationBrainDecision.evidence
      }
    });
    const preSaleFollowupState = buildPreSaleRechargeLaterFollowupState({
      text: message.text,
      metadata: conversation.metadata,
      recentMessages,
      now: new Date(customerMessageAt),
      customerName: message.contactName || customer.name || null,
      customerMessageAt
    });
    if (preSaleFollowupState) {
      const nextMetadata = mergePreSaleRechargeLaterFollowupState(conversation.metadata, preSaleFollowupState);
      await this.conversationsRepository.updateConversationMetadata(conversation.id, nextMetadata);
      conversation.metadata = nextMetadata;
      await this.auditService.createAuditLog({
        actor_type: "ai_agent",
        action: "[PreSaleFollowup] Detected recharge later intent",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: {
          webhookEventId,
          followup_key: PRE_SALE_RECHARGE_LATER_FOLLOWUP_KEY,
          followup_due_at: preSaleFollowupState.followup_due_at,
          detected_intent: "wants_to_recharge_later"
        }
      });
      await this.auditService.createAuditLog({
        actor_type: "ai_agent",
        action: "[PreSaleFollowup] Scheduled 4h followup",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: {
          webhookEventId,
          followup_key: PRE_SALE_RECHARGE_LATER_FOLLOWUP_KEY,
          followup_due_at: preSaleFollowupState.followup_due_at
        }
      });
      await this.safeCreateAgentEvent({
        conversation_id: conversation.id,
        customer_phone: message.phone,
        event_type: "followup_scheduled",
        event_source: "pre_sale_followup",
        intent: "wants_to_recharge_later",
        stage: "pre_sale_recharge_intent",
        message_id: message.externalMessageId,
        metadata: {
          webhookEventId,
          followup_key: PRE_SALE_RECHARGE_LATER_FOLLOWUP_KEY,
          followup_due_at: preSaleFollowupState.followup_due_at
        }
      });
    }
    const commercialReply = await this.chatAgent.generateCommercialReply({
      message: effectiveMessage,
      classification,
      customer,
      conversation,
      webhookEventId,
      recentMessages,
      contextualDecision,
      conversationBrainDecision,
      specialistExamples,
      learningMemories,
      deferResponseWritingToContextualAI: true
    });
    const legacyCandidate = {
      ...commercialReply,
      leadProfilePatch: { ...(commercialReply.leadProfilePatch || {}) }
    };
    const finalAgentAction = this.conversationBrainService.finalize({
      preliminary: conversationBrainDecision,
      contextualDecision,
      candidate: commercialReply
    });
    commercialReply.reply = finalAgentAction.reply || "";
    commercialReply.requiresHuman = finalAgentAction.action === "handoff";
    commercialReply.responseRule = finalAgentAction.response_rule;
    commercialReply.leadProfilePatch = {
      ...(commercialReply.leadProfilePatch || {}),
      conversation_state: finalAgentAction.next_state,
      stage: finalAgentAction.next_state,
      commercial_stage: finalAgentAction.next_state,
      final_agent_action: finalAgentAction.action,
      final_agent_action_reason: finalAgentAction.reason
    };
    await this.auditService.createAuditLog({
      actor_type: "system",
      action: "agent_action_finalized",
      entity_type: "conversations",
      entity_id: conversation.id,
      metadata: {
        webhookEventId,
        action: finalAgentAction.action,
        next_state: finalAgentAction.next_state,
        reason: finalAgentAction.reason,
        response_rule: finalAgentAction.response_rule,
        followup_action: finalAgentAction.followup_action,
        backend_artifact: finalAgentAction.backend_artifact,
        has_reply: Boolean(finalAgentAction.reply)
      }
    });
    if (this.shadowDecisionService || process.env.NODE_ENV !== "test") {
      try {
        const shadowDecisionService = this.shadowDecisionService || new ShadowDecisionService();
        await shadowDecisionService.compareReply({
          conversationId: conversation.id,
          messageId: message.externalMessageId,
          currentState: String(contextSnapshot.lead_profile.conversation_state || contextSnapshot.lead_profile.stage || "new_lead"),
          legacyCandidate,
          unifiedAction: finalAgentAction
        });
      } catch {
        // Shadow telemetry must never block the customer turn.
      }
    }
    if (commercialReply.responseRule === "conversation_brain_blocks_greeting_restart") {
      await this.safeCreateAgentEvent({
        conversation_id: conversation.id,
        customer_phone: message.phone,
        event_type: "greeting_blocked",
        event_source: "chat_agent",
        intent: classification.intent,
        stage: conversationBrainDecision.stage,
        message_id: message.externalMessageId,
        metadata: {
          rule: commercialReply.responseRule,
          reason: "active_conversation_context",
          context_active: true
        }
      });
    }
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
      // A state produced by a reply must only become durable after Evolution
      // accepts that reply. Silent/wait/handoff decisions have no delivery to
      // wait for and must still persist their context immediately.
      if (["silent", "wait", "handoff"].includes(finalAgentAction.action)) {
        await this.conversationsRepository.updateConversationMetadata(conversation.id, nextMetadata);
      }
      conversation.metadata = nextMetadata;
    }
    const reply = finalAgentAction.reply || "";

    if (!reply) {
      if (commercialReply.requiresHuman) {
        const handoffMetadata = {
          ...(conversation.metadata || {}),
          requires_human: true,
          handoff_reason: commercialReply.responseRule || classification.intent,
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
          metadata: {
            webhookEventId,
            reason: commercialReply.responseRule || classification.intent,
            silent_customer_message: true
          }
        });
        await this.notifyHumanOwner({
          webhookEventId,
          customer,
          conversationId: conversation.id,
          message,
          notificationText: commercialReply.ownerNotificationText
        });
      }
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
      sendTextBeforeMenu: commercialReply.sendTextBeforeMenu,
      responseGeneratedByAI: commercialReply.responseSource === "ai",
      responseRule: finalAgentAction.response_rule,
      specialistLearning,
      backendArtifact: finalAgentAction.backend_artifact,
      protectedOperationalReply:
        classification.intent === "pix_payment" &&
        (Boolean(commercialReply.copyText) || commercialReply.requiresHuman === true)
    });
  }

  private async handleAudioTranscriptionFailure({
    webhookEventId,
    message,
    customer,
    conversation,
    errorCode
  }: {
    webhookEventId: string;
    message: IncomingEvolutionMessage;
    customer: { id: string };
    conversation: { id: string; metadata?: Record<string, unknown> | null };
    errorCode: string;
  }) {
    const reply = "Nao consegui entender esse audio. Pode enviar novamente ou escrever a mensagem para eu continuar de onde paramos?";
    const customerMessageAt = getMessageDate(message).toISOString();
    const sentAt = new Date().toISOString();

    await this.messagesRepository.createMessage({
      conversation_id: conversation.id,
      customer_id: customer.id,
      role: "customer",
      content: null,
      content_type: message.messageType,
      external_message_id: message.externalMessageId,
      metadata: {
        remoteJid: message.remoteJid,
        media: { mimeType: message.media.mimeType || null, fileName: message.media.fileName || null },
        hasMedia: true,
        timestamp: message.timestamp,
        webhookEventId,
        audio_transcription: { status: "failed", error_code: errorCode }
      }
    });
    await this.safeCreateAgentEvent({
      conversation_id: conversation.id,
      customer_phone: message.phone,
      event_type: "customer_message",
      event_source: "webhook",
      message_id: message.externalMessageId,
      metadata: { webhookEventId, messageType: message.messageType, transcribed_audio: false, error_code: errorCode }
    });
    await this.auditService.createAuditLog({
      actor_type: "ai_agent",
      action: "audio_transcription_failed",
      entity_type: "conversations",
      entity_id: conversation.id,
      metadata: { webhookEventId, error_code: errorCode }
    });

    const sendResult: unknown = await this.evolutionService.sendTextMessage({ phone: message.phone, text: reply });
    await this.messagesRepository.createMessage({
      conversation_id: conversation.id,
      customer_id: customer.id,
      role: "assistant",
      content: reply,
      content_type: "text",
      external_message_id: `assistant:${message.externalMessageId}`,
      metadata: {
        webhookEventId,
        response_source: "audio_transcription_fallback",
        sender_type: "bot",
        content_hash: createCustomerMessageHash(reply),
        sent_at: sentAt,
        sent_by_system: true,
        provider_message_id: extractEvolutionProviderMessageId(sendResult),
        sendResult
      }
    });
    await this.safeCreateAgentEvent({
      conversation_id: conversation.id,
      customer_phone: message.phone,
      event_type: "bot_message",
      event_source: "system",
      message_id: `assistant:${message.externalMessageId}`,
      metadata: { webhookEventId, response_source: "audio_transcription_fallback" }
    });

    const leadProfile = readLeadProfile(conversation.metadata);
    const nextMetadata = {
      ...(conversation.metadata || {}),
      last_customer_message_at: customerMessageAt,
      last_customer_message_id: message.externalMessageId,
      last_bot_message_at: sentAt,
      followup_due_at: null,
      response_due_at: null,
      awaiting_customer_action: null,
      lead_profile: {
        ...leadProfile,
        last_bot_question: reply,
        updated_at: sentAt
      }
    };
    await this.conversationsRepository.updateConversationMetadata(conversation.id, nextMetadata);
    await this.conversationsRepository.touchConversation(conversation.id, sentAt);
    await this.auditService.createAuditLog({
      actor_type: "system",
      action: "audio_transcription_fallback_sent",
      entity_type: "conversations",
      entity_id: conversation.id,
      metadata: { webhookEventId, error_code: errorCode }
    });

    return { status: "processed" as const, reply };
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
    sendTextBeforeMenu,
    responseGeneratedByAI,
    responseRule,
    specialistLearning,
    backendArtifact,
    protectedOperationalReply
  }: {
    webhookEventId: string;
    message: IncomingEvolutionMessage;
    customer: { id: string };
    conversation: {
      id: string;
      customer_id?: string | null;
      conversation_state?: string | null;
      metadata?: Record<string, unknown> | null;
    };
    reply: string;
    classification: Record<string, unknown>;
    media?: { base64: string; mimetype: string; fileName: string; caption: string };
    copyText?: string;
    followUpMessages?: string[];
    menu?: WhatsAppMenu;
    sendTextBeforeMenu?: boolean;
    responseGeneratedByAI?: boolean;
    responseRule?: string;
    specialistLearning?: SpecialistLearningGuidance | null;
    backendArtifact?: AgentBackendArtifact | null;
    protectedOperationalReply?: boolean;
  }) {
    const rawResponseDirective = [reply, ...(followUpMessages || [])].filter(Boolean).join("\n\n");
    const responseDirective = copyText
      ? rawResponseDirective.split(copyText).join("[dados de pagamento enviados em mensagem separada]")
      : rawResponseDirective;
    const intent = typeof classification.intent === "string" ? classification.intent : "unknown";
    const useFixedInitialGreeting = reply.trim() === INITIAL_UNITV_REPLY;
    const useProtectedBackendArtifact =
      backendArtifact?.present === true && backendArtifact.type !== "menu";
    const useProtectedOperationalReply =
      (protectedOperationalReply === true && intent === "pix_payment") ||
      useProtectedBackendArtifact ||
      useFixedInitialGreeting;
    const recentMessages = useProtectedOperationalReply ? [] : await this.listRecentConversationMessages(conversation.id);
    const reuseUpstreamAIReply = canReuseUpstreamAIReply({
      responseGeneratedByAI,
      intent,
      reply,
      hasMedia: Boolean(media),
      hasCopyText: Boolean(copyText),
      hasFollowUpMessages: Boolean(followUpMessages?.length),
      hasMenu: Boolean(menu)
    });
    const useAuthoritativeLocalReply = canDeliverAuthoritativeLocalReply({
      responseGeneratedByAI,
      responseRule,
      reply
    });
    const contextualReply = useProtectedOperationalReply
      ? reply
      : reuseUpstreamAIReply
      ? reply
      : useAuthoritativeLocalReply
      ? reply
      : await this.contextualResponseAIService.generateResponse({
        currentMessage: message.text,
        intent,
        leadProfile: readLeadProfile(conversation.metadata),
        recentMessages,
        responseDirective,
        operationalContext: {
          has_media: Boolean(media),
          has_payment_copy_payload: Boolean(copyText),
          planned_menu_removed: Boolean(menu),
          planned_followup_messages_merged: (followUpMessages || []).length,
          stage: readLeadProfile(conversation.metadata).stage || readLeadProfile(conversation.metadata).commercial_stage || null,
          specialist_pattern: specialistLearning?.pattern || null,
          specialist_action: specialistLearning?.action || null,
          specialist_style: specialistLearning?.style || null,
          specialist_avoid: specialistLearning?.avoid || null
        },
        conversationId: conversation.id,
        useStrongModel: false
      });
    if (!contextualReply) {
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: "contextual_ai_response_unavailable",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: {
          webhookEventId,
          intent: classification.intent,
          programmed_response_blocked: true
        }
      });
      return { status: "ignored" as const };
    }

    const responseSource = useFixedInitialGreeting
      ? "fixed_initial_greeting"
      : useProtectedBackendArtifact
      ? `protected_${backendArtifact?.type || "operational"}_backend`
      : useProtectedOperationalReply
      ? "protected_payment_backend"
      : reuseUpstreamAIReply
        ? "upstream_contextual_ai_reused"
        : useAuthoritativeLocalReply
          ? "authoritative_local_rule"
        : "contextual_ai";
    if (useProtectedBackendArtifact) {
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: "protected_backend_artifact_delivery_used",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: {
          webhookEventId,
          intent,
          artifact_type: backendArtifact?.type || null,
          avoided_openai_call: true
        }
      });
    } else if (useProtectedOperationalReply) {
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: "protected_payment_delivery_used",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: {
          webhookEventId,
          intent,
          avoided_openai_call: true,
          has_copy_text: Boolean(copyText),
          has_media: Boolean(media)
        }
      });
    } else if (reuseUpstreamAIReply) {
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: "contextual_ai_response_reused",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: { webhookEventId, intent, avoided_duplicate_ai_call: true }
      });
    } else if (useAuthoritativeLocalReply) {
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: "authoritative_local_response_used",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: { webhookEventId, intent, response_rule: responseRule || null, avoided_openai_call: true }
      });
    }

    reply = contextualReply;
    followUpMessages = [];
    menu = undefined;
    sendTextBeforeMenu = false;
    if (media) {
      media = { ...media, caption: "" };
    }

    const safeReply = useProtectedOperationalReply
      ? sanitizeCustomerMessage(reply).text
      : await this.sanitizeAndValidateCustomerText({
          text: reply,
          conversation,
          webhookEventId,
          leadProfile: readLeadProfile(conversation.metadata)
        });
    if (!safeReply) {
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: "evolution_reply_blocked_empty_after_safety",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: { webhookEventId }
      });
      return { status: "ignored" as const };
    }
    if (
      (!useProtectedOperationalReply || useFixedInitialGreeting) &&
      await this.isCustomerMessageSuperseded(conversation.id, message.externalMessageId)
    ) {
      await this.auditSupersededCustomerReply(conversation.id, webhookEventId, message.externalMessageId, "before_whatsapp_send");
      return { status: "ignored" as const };
    }
    const safeFollowUpMessages: string[] = [];

    if (useFixedInitialGreeting) {
      const latestMessages = await this.listRecentConversationMessages(conversation.id);
      const greetingAlreadyExists = latestMessages.some((item) => item.role === "assistant" || item.role === "human_agent");
      const greetingAlreadyMarked = readLeadProfile(conversation.metadata).saudacao_enviada === true;
      if (greetingAlreadyExists || greetingAlreadyMarked) {
        await this.auditService.createAuditLog({
          actor_type: "system",
          action: "fixed_initial_greeting_blocked_before_send",
          entity_type: "conversations",
          entity_id: conversation.id,
          metadata: {
            webhookEventId,
            reason: greetingAlreadyMarked ? "greeting_marker_already_set" : "prior_agent_message_exists"
          }
        });
        await this.safeCreateAgentEvent({
          conversation_id: conversation.id,
          customer_phone: message.phone,
          event_type: "greeting_blocked",
          event_source: "system",
          message_id: message.externalMessageId,
          metadata: { webhookEventId, checkpoint: "pre_send_guard", reason: "initial_greeting_already_delivered" }
        });
        return { status: "ignored" as const };
      }
    }

    const sendResult: unknown = await this.evolutionService.sendTextMessage({ phone: message.phone, text: safeReply });
    if (useFixedInitialGreeting) {
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: "fixed_initial_greeting_sent_without_ai",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: { webhookEventId, intent, avoided_openai_call: true }
      });
    }
    let copyTextSendResult: unknown = null;
    if (copyText) {
      copyTextSendResult = await this.evolutionService.sendTextMessage({ phone: message.phone, text: copyText });
    }
    const copyTextQuotedMessageId = extractEvolutionProviderMessageId(copyTextSendResult);
    let copyTextGuidanceSendResult: unknown = null;
    const sendCopyTextGuidance = async () => {
      try {
        copyTextGuidanceSendResult = await this.evolutionService.sendTextMessage({
          phone: message.phone,
          text: PIX_COPY_PASTE_GUIDANCE,
          ...(copyTextQuotedMessageId ? { quotedMessageId: copyTextQuotedMessageId } : {})
        });
      } catch (error) {
        await this.auditService.createAuditLog({
          actor_type: "system",
          action: "evolution_pix_copy_guidance_send_failed",
          entity_type: "conversations",
          entity_id: conversation.id,
          metadata: { webhookEventId, error: error instanceof Error ? error.message : "unknown_error" }
        });
      }
    };

    // Without a provider id there is no safe way to quote the payload, so keep
    // the guidance immediately below it and before the QR code.
    if (copyText && !copyTextQuotedMessageId) {
      await sendCopyTextGuidance();
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

    if (copyText && copyTextQuotedMessageId) {
      await sendCopyTextGuidance();
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
        response_source: responseSource,
        knowledge_grounded: true,
        sender_type: "bot",
        content_hash: createCustomerMessageHash(safeReply),
        sent_at: new Date().toISOString(),
        sent_by_system: true,
        provider_message_id: extractEvolutionProviderMessageId(sendResult),
        sendResult,
        copyTextSendResult,
        copyTextGuidanceSendResult,
        followUpSendResults,
        mediaSendResult,
        media: media ? { mimetype: media.mimetype, fileName: media.fileName, caption: media.caption } : null,
        menu: null
      }
    });
    await this.safeCreateAgentEvent({
      conversation_id: conversation.id,
      customer_phone: message.phone,
      event_type: useProtectedOperationalReply ? "local_rule_used" : "ai_called",
      event_source: "chat_agent",
      intent: typeof classification.intent === "string" ? classification.intent : null,
      stage: String(readLeadProfile(conversation.metadata).stage || readLeadProfile(conversation.metadata).etapa_atual || ""),
      message_id: `assistant:${message.externalMessageId}`,
      metadata: {
        webhookEventId,
        reply: safeReply,
        knowledge_grounded: true,
        response_source: responseSource,
        avoided_openai_call: useProtectedOperationalReply
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
      metadata: { webhookEventId, reply: safeReply, response_source: responseSource }
    });

    const now = new Date();
    const followupState = buildFollowupState({ reply: safeReply, classification, menu, copyText, followUpMessages: safeFollowUpMessages, media }, conversation.metadata, now);
    const finalFollowupState = preservePendingPreSaleFollowupState(followupState, conversation.metadata);
    const currentLeadProfile = readLeadProfile(conversation.metadata);
    const lastBotQuestion = extractLastQuestion(safeReply);
    const responseIntent = classifyCustomerFacingResponseIntent(safeReply);
    const operationalMarkers = buildOperationalMarkerPatch(responseIntent, currentLeadProfile, now);
    const nextMetadata = {
      ...(conversation.metadata || {}),
      last_bot_message_at: now.toISOString(),
      response_due_at: null,
      response_recovery_reason: null,
      lead_profile: {
        ...currentLeadProfile,
        last_bot_question: lastBotQuestion || currentLeadProfile.last_bot_question,
        ...operationalMarkers,
        updated_at: now.toISOString()
      },
      ...finalFollowupState
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
      safeText = "";
      blockedReason = profileValidation.reason;
    }

    const responseIntent = classifyCustomerFacingResponseIntent(safeText);
    const lockValidation = validateResponseIntentLock(responseIntent, leadProfile, new Date());
    if (!lockValidation.valid) {
      safeText = "";
      blockedReason = lockValidation.reason;
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

  private async buildCommercialContext({
    message,
    conversation,
    recentMessages
  }: {
    message: IncomingEvolutionMessage;
    conversation: {
      id: string;
      customer_id?: string | null;
      conversation_state?: string | null;
      metadata?: Record<string, unknown> | null;
    };
    recentMessages: Array<{ role?: string; content?: string | null }>;
  }): Promise<CommercialContext> {
    const rawLeadProfile = readLeadProfile(conversation.metadata);
    const conversationState = resolveConversationState({
      conversationState: conversation.conversation_state,
      metadata: conversation.metadata,
      leadProfile: rawLeadProfile
    });
    const leadProfile = withCanonicalConversationState(rawLeadProfile, conversationState);
    const customerId = typeof conversation.customer_id === "string" ? conversation.customer_id : "";
    const [openOrder, latestOrder] = await Promise.all([
      this.safeFindLatestOpenOrderByCustomerId(customerId),
      this.safeFindLatestOrderByConversationCustomer(conversation)
    ]);
    const lastBotQuestion = typeof leadProfile.last_bot_question === "string"
      ? leadProfile.last_bot_question
      : null;

    return {
      conversation_id: conversation.id,
      current_message: message.text,
      recent_messages: recentMessages,
      lead_profile: leadProfile,
      open_order: sanitizeOrderForContext(openOrder),
      latest_order: sanitizeOrderForContext(latestOrder),
      last_bot_question: lastBotQuestion,
      last_bot_message_at: typeof conversation.metadata?.last_bot_message_at === "string" ? conversation.metadata.last_bot_message_at : null,
      last_specialist_message_at: typeof conversation.metadata?.last_specialist_message_at === "string" ? conversation.metadata.last_specialist_message_at : null,
      followup_key: typeof conversation.metadata?.followup_key === "string" ? conversation.metadata.followup_key : null,
      followup_due_at: typeof conversation.metadata?.followup_due_at === "string" ? conversation.metadata.followup_due_at : null,
      human_hold_active: isRecentSpecialistActivity(conversation.metadata)
    };
  }

  private async safeFindLatestOrderByConversationCustomer(conversation: { customer_id?: string | null; metadata?: Record<string, unknown> | null }) {
    const customerId = typeof conversation.customer_id === "string" ? conversation.customer_id : null;
    if (!customerId) {
      return null;
    }
    try {
      return await this.ordersService.findLatestOrderByCustomerId(customerId) as Record<string, unknown> | null;
    } catch {
      return null;
    }
  }

  private async safeFindLatestOpenOrderByCustomerId(customerId: string) {
    if (!customerId) {
      return null;
    }
    try {
      return await this.ordersService.findLatestOpenOrderByCustomerId(customerId) as Record<string, unknown> | null;
    } catch {
      return null;
    }
  }

  private async listRelevantSpecialistExamples(
    metadata: Record<string, unknown> | null | undefined,
    customerMessage: string,
    recentMessages: Array<{ role?: string; content?: string | null }> = []
  ) {
    const leadProfile = readLeadProfile(metadata);
    try {
      const repository = this.specialistTrainingExamplesRepository || new SpecialistTrainingExamplesRepository();
      return await repository.getRelevantSpecialistExamples({
        intent: typeof leadProfile.ultima_intencao === "string" ? leadProfile.ultima_intencao : null,
        stage: typeof leadProfile.stage === "string" ? leadProfile.stage : null,
        objection: typeof leadProfile.main_objection === "string" ? leadProfile.main_objection : null,
        device: typeof leadProfile.device === "string" ? leadProfile.device : null,
        customerMessage,
        recentContext: buildSpecialistExampleLookupContext(recentMessages),
        limit: 3
      });
    } catch {
      return [];
    }
  }

  private async listRelevantLearningMemories(
    metadata: Record<string, unknown> | null | undefined,
    customerMessage: string,
    recentMessages: Array<{ role?: string; content?: string | null }> = []
  ) {
    const leadProfile = readLeadProfile(metadata);
    try {
      const repository = this.agentLearningMemoriesRepository || new AgentLearningMemoriesRepository();
      return await repository.getRelevantMemories({
        intent: typeof leadProfile.ultima_intencao === "string" ? leadProfile.ultima_intencao : null,
        stage: typeof leadProfile.stage === "string" ? leadProfile.stage : null,
        customerMessage,
        recentContext: buildSpecialistExampleLookupContext(recentMessages),
        limit: 4
      });
    } catch {
      return [];
    }
  }

  private async isCustomerMessageSuperseded(conversationId: string, externalMessageId: string) {
    const listMessages = (this.messagesRepository as unknown as {
      listMessagesByConversationId?: (conversationId: string, limit?: number) => Promise<Array<Record<string, unknown>>>;
    }).listMessagesByConversationId;
    if (!listMessages) return false;

    try {
      const messages = await listMessages.call(this.messagesRepository, conversationId, 20);
      return isCustomerMessageSuperseded(messages, externalMessageId);
    } catch {
      return false;
    }
  }

  private async auditSupersededCustomerReply(
    conversationId: string,
    webhookEventId: string,
    externalMessageId: string,
    checkpoint: string
  ) {
    await this.auditService.createAuditLog({
      actor_type: "system",
      action: "superseded_customer_reply_suppressed",
      entity_type: "conversations",
      entity_id: conversationId,
      metadata: { webhookEventId, externalMessageId, checkpoint }
    });
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
        conversationId: conversation.id,
        customerLastMessage: maskedCustomerMessage,
        botPreviousMessage: maskedBotMessage,
        specialistMessage: maskedSpecialistMessage,
        conversationExcerpt,
        leadProfile
      });

      const repository = this.specialistTrainingExamplesRepository || new SpecialistTrainingExamplesRepository();
      const quickLearning = buildQuickSpecialistLearningSignals(message.text, botWasOverridden);
      const tags = buildSpecialistLearningTags({
        customerLastMessage: customerLastText,
        botPreviousMessage: botPreviousText,
        specialistMessage: message.text,
        analysis
      });
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
        style_notes: mergeStyleNotes(analysis.style_notes, quickLearning.styleNotes),
        should_copy_style: true,
        reason: botWasOverridden ? "correction" : "human_takeover",
        bot_response_was_overridden: botWasOverridden,
        human_intervention_detected: true,
        success_signal: quickLearning.successSignal,
        metadata: {
          webhookEventId,
          externalMessageId: message.externalMessageId,
          device: leadProfile.device || leadProfile.aparelho || null,
          summary: analysis.summary,
          learned_pattern: analysis.learned_pattern,
          next_best_action: analysis.next_best_action,
          fast_learning: true,
          global_reusable_example: true,
          human_style: quickLearning.humanStyle,
          max_reply_sentences: quickLearning.maxReplySentences,
          specialist_message_words: quickLearning.wordCount,
          specialist_message_is_short: quickLearning.isShort,
          tags,
          review_status: "pending_review",
          suggestedFutureBehavior: analysis.next_best_action,
          learnedPattern: analysis.learned_pattern,
          specialistAction: analysis.inferred_specialist_action,
          customerStage: analysis.inferred_stage,
          customerIntent: analysis.inferred_intent,
          customerLastMessage: maskedCustomerMessage,
          botPreviousMistake: maskedBotMessage,
          specialistMessage: maskedSpecialistMessage
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

export function isReceiptMessage(message: IncomingEvolutionMessage, metadata?: Record<string, unknown> | null) {
  const text = message.text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const receiptText = /\b(comprovante|recibo|print do pagamento|transferencia)\b/.test(text);
  const profile = readLeadProfile(metadata);
  const stage = normalizeFreeText(String(profile.stage || profile.etapa_atual || metadata?.conversation_stage || ""));
  const paymentContext = /(^|_)(pix|payment|pagamento|checkout|awaiting_payment|comprovante)(_|$)/.test(stage) ||
    Boolean(profile.pediu_pix || profile.enviou_comprovante || profile.payment_method || profile.payment_status === "pending");
  const receiptMedia = message.hasMedia && ["imageMessage", "documentMessage"].includes(message.messageType) && paymentContext;

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

function buildOperationalMarkerPatch(intentKey: string, currentLeadProfile: Record<string, unknown>, now: Date) {
  const locks = readResponseIntentLocks(currentLeadProfile);
  const nextLocks = {
    ...locks,
    [intentKey]: now.toISOString()
  };
  const patch: Record<string, unknown> = {
    response_intent_locks: nextLocks,
    ultima_intencao_bot: intentKey
  };

  if (intentKey === "saudacao_inicial") patch.saudacao_enviada = true;
  if (intentKey === "valores_enviados") patch.valores_enviados = true;
  if (intentKey === "pergunta_aparelho_teste" || intentKey === "confirmacao_aparelho_teste") {
    patch.pergunta_aparelho_enviada = true;
  }
  if (intentKey === "pix_enviado") patch.pix_enviado = true;
  if (intentKey === "convite_teste" || intentKey === "pergunta_aparelho_teste" || intentKey === "confirmacao_aparelho_teste") {
    patch.teste_solicitado = true;
  }

  return patch;
}

function validateResponseIntentLock(intentKey: string, leadProfile: Record<string, unknown>, now: Date) {
  if (intentKey === "resposta_geral") {
    return { valid: true };
  }

  const locks = readResponseIntentLocks(leadProfile);
  const lockedAt = locks[intentKey];
  if (!lockedAt) {
    return { valid: true };
  }

  const lockedDate = new Date(lockedAt);
  if (Number.isNaN(lockedDate.getTime())) {
    return { valid: true };
  }

  if (now.getTime() - lockedDate.getTime() < RESPONSE_INTENT_LOCK_MS) {
    return { valid: false, reason: `response_intent_lock:${intentKey}` };
  }

  return { valid: true };
}

function readResponseIntentLocks(leadProfile: Record<string, unknown>) {
  const locks = leadProfile.response_intent_locks;
  return locks && typeof locks === "object" && !Array.isArray(locks)
    ? (locks as Record<string, string>)
    : {};
}

function buildContextualLeadProfilePatch(decision: ContextualDecision) {
  const patch: Record<string, unknown> = {
    commercial_stage: decision.stage,
    stage: decision.stage,
    last_customer_intent: decision.intent,
    contextual_detected_intent: decision.detected_intent,
    contextual_next_action: decision.next_action,
    contextual_reason: decision.reason,
    contextual_should_reply: decision.should_reply,
    contextual_should_handoff: decision.should_handoff,
    contextual_should_clarify: decision.should_clarify,
    next_expected_reply: decision.next_expected_reply,
    contextual_confidence: decision.confidence,
    contextual_meaning: decision.customer_message_meaning,
    should_create_order: decision.should_create_order,
    should_generate_pix: decision.should_generate_pix
  };

  if (decision.selected_plan) {
    patch.selected_plan = decision.selected_plan;
    patch.plano_interesse = decision.selected_plan;
    patch.nivel_interesse = "quente";
  }
  if (decision.payment_method) {
    patch.payment_method = decision.payment_method;
    if (decision.payment_method === "pix") {
      patch.pediu_pix = true;
    }
  }
  if (decision.install_status) {
    patch.install_status = decision.install_status;
    patch.download_status = decision.install_status;
    if (decision.install_status === "downloaded" || decision.install_status === "installed") {
      patch.downloaded_app = true;
    }
    if (decision.install_status === "installed") {
      patch.installed_app = true;
    }
  }

  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

const AUTHORITATIVE_LOCAL_RESPONSE_RULES = new Set([
  "contextual_understanding_generic_price_monthly",
  "contextual_understanding_monthly_screen_coverage",
  "channel_catalog_overview"
]);

export function canDeliverAuthoritativeLocalReply(input: {
  responseGeneratedByAI?: boolean;
  responseRule?: string;
  reply: string;
}) {
  if (input.responseGeneratedByAI || !input.reply.trim()) return false;
  const reply = input.reply.trim();
  const responseRule = String(input.responseRule || "");
  if (reply === OFFICIAL_MONTHLY_OFFER_TEXT || reply === OFFICIAL_ALL_PLAN_PRICES_TEXT) return true;
  if (reply === `O plano mensal cobre ate ${OFFICIAL_MONTHLY_MAX_SCREENS} telas.`) return true;
  if (AUTHORITATIVE_LOCAL_RESPONSE_RULES.has(responseRule)) return true;
  return /^authoritative_(?:espn|premiere|spanish_catalog)(?:_|$)/.test(responseRule);
}

export function canReuseUpstreamAIReply(input: {
  responseGeneratedByAI?: boolean;
  intent: string;
  reply: string;
  hasMedia?: boolean;
  hasCopyText?: boolean;
  hasFollowUpMessages?: boolean;
  hasMenu?: boolean;
}) {
  if (!input.responseGeneratedByAI || !input.reply.trim()) return false;
  if (input.hasMedia || input.hasCopyText || input.hasFollowUpMessages || input.hasMenu) return false;
  if (/(pix|payment|pagamento|card|cartao|receipt|comprovante|activation|ativacao|code|codigo)/i.test(input.intent)) return false;
  if (/(R\$\s*\d|https?:\/\/|pix|copia e cola|qr\s*code|pagamento|comprovante|c[oó]digo de acesso|\bUTV-|\b862585\b)/i.test(input.reply)) return false;
  return true;
}

type ManualPaymentCommand = {
  method: "pix" | "card";
  intent: "pix_payment" | "card_payment";
  plan: "mensal" | "trimestral" | "semestral" | "anual" | null;
  amountCents: number | null;
  effectiveMessage: string;
  summary: string;
  leadProfilePatch: Record<string, unknown>;
};

function parseManualPaymentCommand(text: string): ManualPaymentCommand | null {
  const normalized = normalizeCommandText(text);
  const match = normalized.match(/^(?:gerar\s+)?(pix|cartao)\b/);
  if (!match) {
    return null;
  }

  const method = match[1] === "pix" ? "pix" : "card";
  const amountCents = extractManualPaymentAmountCents(normalized);
  const plan = extractManualPaymentPlan(normalized, amountCents);
  if ((method === "pix" && amountCents === null) || (method === "card" && !plan)) {
    return null;
  }

  const effectiveMessage = plan ? `${plan} ${method}` : `manual ${method}`;
  const paymentMethod = method === "pix" ? "pix" : "card";

  return {
    method,
    intent: method === "pix" ? "pix_payment" : "card_payment",
    plan,
    amountCents,
    effectiveMessage,
    summary: `Comando manual do especialista para gerar ${method === "pix" ? "Pix" : "cartao"}${plan ? ` do plano ${plan}` : " com valor livre"}.`,
    leadProfilePatch: {
      ...(plan ? { selected_plan: plan, plano_interesse: plan } : {}),
      payment_method: paymentMethod,
      last_customer_intent: method === "pix" ? "request_pix" : "request_card_payment",
      next_expected_reply: "payment_proof",
      commercial_stage: "checkout",
      stage: "checkout",
      manual_payment_command: true,
      manual_payment_amount_cents: amountCents,
      manual_payment_requires_human_review: method === "pix" && !plan
    }
  };
}

function extractManualPaymentPlan(normalized: string, amountCents: number | null) {
  if (/\b(anual|12 meses|1 ano)\b/.test(normalized)) return "anual" as const;
  if (/\b(semestral|6 meses|seis meses)\b/.test(normalized)) return "semestral" as const;
  if (/\b(trimestral|3 meses|tres meses)\b/.test(normalized)) return "trimestral" as const;
  if (/\b(mensal|1 mes|mes)\b/.test(normalized)) return "mensal" as const;
  if (amountCents === 1999 || amountCents === 2090 || amountCents === 2500) return "mensal" as const;
  if (amountCents === 7000) return "trimestral" as const;
  if (amountCents === 12000) return "semestral" as const;
  if (amountCents === 20000) return "anual" as const;
  return null;
}

function extractManualPaymentAmountCents(normalized: string) {
  const commandValue = normalized.replace(/^(?:gerar\s+)?(?:pix|cartao)\b\s*/, "");
  const matches = [...commandValue.matchAll(/(?:r\$\s*)?(\d{1,6})(?:[,.](\d{1,2}))?\b/g)];
  for (const match of matches) {
    const integer = Number(match[1]);
    const decimal = match[2] ? Number(match[2].padEnd(2, "0").slice(0, 2)) : 0;
    const amountCents = integer * 100 + decimal;
    if (!Number.isFinite(integer) || amountCents < 1 || amountCents > 99_999_999) {
      continue;
    }
    return amountCents;
  }
  return null;
}

function normalizeCommandText(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N},.$\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeOrderForContext(order: Record<string, unknown> | null) {
  if (!order) {
    return null;
  }

  return {
    id: order.id,
    order_number: order.order_number,
    status: order.status,
    plan_id: order.plan_id,
    amount_cents: order.amount_cents,
    currency: order.currency,
    payment_provider: order.payment_provider,
    has_payment_reference: Boolean(order.payment_reference),
    has_pix_qr_code: Boolean(readOrderMetadataForContext(order).mercado_pago_pix_qr_code),
    plans: order.plans
  };
}

function readOrderMetadataForContext(order: Record<string, unknown>) {
  const metadata = order.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

function applyContextualPolicy({
  decision,
  classification,
  effectiveMessage
}: {
  decision: ContextualDecision;
  classification: IntentClassification;
  effectiveMessage: string;
}) {
  if (decision.confidence < 0.55) {
    return { classification, effectiveMessage };
  }

  if (decision.next_action === "ask_device_for_trial" || decision.detected_intent === "FREE_TRIAL_REQUEST") {
    return {
      effectiveMessage,
      classification: {
        intent: "free_trial",
        confidence: decision.confidence,
        summary: decision.customer_message_meaning,
        suggested_reply: decision.recommended_response || ""
      } satisfies IntentClassification
    };
  }

  if (decision.intent === "request_pix" || decision.should_generate_pix) {
    return {
      effectiveMessage: "pix",
      classification: {
        intent: "pix_payment",
        confidence: decision.confidence,
        summary: decision.customer_message_meaning,
        suggested_reply: ""
      } satisfies IntentClassification
    };
  }

  if (decision.intent === "request_card") {
    return {
      effectiveMessage: "cartao",
      classification: {
        intent: "card_payment",
        confidence: decision.confidence,
        summary: decision.customer_message_meaning,
        suggested_reply: ""
      } satisfies IntentClassification
    };
  }

  if (decision.intent === "receipt_sent") {
    return {
      effectiveMessage,
      classification: {
        intent: "receipt_sent",
        confidence: decision.confidence,
        summary: decision.customer_message_meaning,
        suggested_reply: ""
      } satisfies IntentClassification
    };
  }

  if (decision.intent === "download_issue") {
    return {
      effectiveMessage,
      classification: {
        intent: "technical_support",
        confidence: decision.confidence,
        summary: decision.customer_message_meaning,
        suggested_reply: ""
      } satisfies IntentClassification
    };
  }

  return { classification, effectiveMessage };
}

function shouldUseStrongContextModel(message: string, context: CommercialContext) {
  const normalized = normalizeFreeText(message);
  return (
    /\b(paguei|pagamento|comprovante|erro|nao consegui|n[aã]o consegui|irritado|reclamacao|reclama[cç][aã]o)\b/.test(normalized) ||
    Boolean(context.human_hold_active) ||
    (context.recent_messages || []).some((item) => item.role === "human_agent")
  );
}

function isHardDuplicateSafetyReason(reason: string | undefined) {
  return [
    "repeats_welcome",
    "repeats_device_question",
    "repeats_values",
    "similar_to_recent_bot_message",
    "asks_device_again",
    "asks_download_again",
    "asks_plan_again"
  ].includes(String(reason || ""));
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

  if (
    key === "post_download_check_10min" &&
    metadata?.followup_key === "post_download_check_10min" &&
    typeof metadata.followup_due_at === "string"
  ) {
    return {
      followup_key: "post_download_check_10min",
      followup_due_at: metadata.followup_due_at,
      followup_sent_at: metadata.followup_sent_at || null,
      followup_sent_stage_id: metadata.followup_sent_stage_id || null,
      followup_count: Number(metadata.followup_count || 0),
      last_followup_stage_id: metadata.last_followup_stage_id || `post_download_check_10min:${now.getTime()}`,
      awaiting_customer_action: metadata.awaiting_customer_action || "confirm_download",
      conversation_stage: metadata.conversation_stage || "instalacao",
      followup_type: "post_download_check_10min",
      context_stage: metadata.context_stage || "download_sent",
      created_reason: metadata.created_reason || "download instructions sent",
      last_bot_download_message_at: metadata.last_bot_download_message_at || now.toISOString(),
      plan_interest: metadata.plan_interest || null,
      device: metadata.device || (metadata.lead_profile && typeof metadata.lead_profile === "object"
        ? (metadata.lead_profile as Record<string, unknown>).device || (metadata.lead_profile as Record<string, unknown>).aparelho || null
        : null)
    };
  }

  const stageId = `${intent || "conversation"}:${key}:${now.getTime()}`;
  const isPostDownload = key === "post_download_check_10min";
  const isGreetingRecovery = key === "welcome_activation";
  return {
    followup_key: key,
    followup_due_at: new Date(now.getTime() + (
      isPostDownload
        ? POST_DOWNLOAD_FOLLOWUP_DELAY_MS
        : isGreetingRecovery
          ? GREETING_FIRST_FOLLOWUP_DELAY_MS
          : CUSTOMER_FOLLOWUP_DELAY_MS
    )).toISOString(),
    followup_sent_at: null,
    followup_sent_stage_id: null,
    followup_count: 0,
    last_followup_stage_id: stageId,
    awaiting_customer_action: inferAwaitingAction(key),
    conversation_stage: inferConversationStage(intent, key),
    ...(isGreetingRecovery ? {
      followup_policy_version: GREETING_FOLLOWUP_POLICY_VERSION,
      greeting_recovery_scheduled_at: now.toISOString()
    } : {}),
    ...(isPostDownload ? {
      followup_type: "post_download_check_10min",
      context_stage: "download_sent",
      created_reason: "download instructions sent",
      last_bot_download_message_at: now.toISOString()
    } : {}),
    plan_interest: metadata?.lead_profile && typeof metadata.lead_profile === "object"
      ? (metadata.lead_profile as Record<string, unknown>).plano_interesse || metadata.plan_interest || null
      : metadata?.plan_interest || null,
    device: metadata?.lead_profile && typeof metadata.lead_profile === "object"
      ? (metadata.lead_profile as Record<string, unknown>).device || (metadata.lead_profile as Record<string, unknown>).aparelho || metadata.device || null
      : metadata?.device || null
  };
}

function preservePendingPreSaleFollowupState(
  generatedState: Record<string, unknown>,
  metadata: Record<string, unknown> | null | undefined
) {
  if (
    generatedState.followup_key ||
    metadata?.followup_key !== PRE_SALE_RECHARGE_LATER_FOLLOWUP_KEY ||
    typeof metadata.followup_due_at !== "string"
  ) {
    return generatedState;
  }

  return {
    ...generatedState,
    followup_key: PRE_SALE_RECHARGE_LATER_FOLLOWUP_KEY,
    followup_due_at: metadata.followup_due_at,
    followup_sent_at: null,
    followup_sent_stage_id: null,
    followup_count: Number(metadata.followup_count || 0),
    last_followup_stage_id: metadata.last_followup_stage_id || `${PRE_SALE_RECHARGE_LATER_FOLLOWUP_KEY}:${Date.now()}`,
    awaiting_customer_action: "pix_permission",
    conversation_stage: "pre_sale_recharge_intent",
    customer_stage: "pre_sale_recharge_intent",
    payment_intent_status: "later",
    last_detected_intent: "wants_to_recharge_later"
  };
}

function buildPreSaleRechargeLaterFollowupState(input: {
  text: string;
  metadata: Record<string, unknown> | null | undefined;
  recentMessages: Array<{ role?: string; content?: string | null }>;
  now: Date;
  customerName?: string | null;
  customerMessageAt: string;
}) {
  const leadProfile = readLeadProfile(input.metadata);
  const textWindow = normalizeFreeText(
    [...input.recentMessages.map((message) => message.content || ""), input.text].join("\n")
  );
  const normalized = normalizeFreeText(input.text);
  if (!isRechargeLaterIntent(normalized) || !hasRealPreSaleRechargeInterest(textWindow, leadProfile)) {
    return null;
  }

  const dueAt = new Date(input.now.getTime() + PRE_SALE_RECHARGE_LATER_DELAY_MS).toISOString();
  const captured = extractPreSaleContext(textWindow, leadProfile, input.customerName);
  return {
    followup_key: PRE_SALE_RECHARGE_LATER_FOLLOWUP_KEY,
    followup_due_at: dueAt,
    followup_sent_at: null,
    followup_sent_stage_id: null,
    followup_count: 0,
    last_followup_stage_id: `${PRE_SALE_RECHARGE_LATER_FOLLOWUP_KEY}:${input.now.getTime()}`,
    awaiting_customer_action: "pix_permission",
    conversation_stage: "pre_sale_recharge_intent",
    customer_stage: "pre_sale_recharge_intent",
    payment_intent_status: "later",
    last_detected_intent: "wants_to_recharge_later",
    pre_sale_followup_scheduled_at: input.now.toISOString(),
    pre_sale_followup_base_customer_message_at: input.customerMessageAt,
    pre_sale_followup_reason: "customer_wants_recharge_later",
    conversation_version: buildConversationVersion(input.metadata, input.now),
    last_message_id: null,
    detected_stage_at_schedule_time: "pre_sale_recharge_intent",
    reason_for_schedule: "customer_wants_recharge_later",
    pre_sale_followup_context: {
      customer_last_message: input.text,
      plan: captured.plan || null,
      screens: captured.screens || null,
      negotiated_price_cents: captured.negotiatedPriceCents || null,
      quoted_price_cents: captured.quotedPriceCents || null
    },
    lead_profile: {
      ...leadProfile,
      nome: captured.name || leadProfile.nome || null,
      selected_plan: captured.plan || leadProfile.selected_plan || leadProfile.plano_interesse || null,
      plano_interesse: captured.plan || leadProfile.plano_interesse || null,
      requested_screens: captured.screens || leadProfile.requested_screens || null,
      negotiated_price_cents: captured.negotiatedPriceCents || leadProfile.negotiated_price_cents || null,
      quoted_price_cents: captured.quotedPriceCents || leadProfile.quoted_price_cents || null,
      wants_recharge: true,
      nivel_interesse: "muito_quente",
      customer_stage: "pre_sale_recharge_intent",
      commercial_stage: "pre_sale_recharge_intent",
      stage: "pre_sale_recharge_intent",
      payment_intent_status: "later",
      last_detected_intent: "wants_to_recharge_later",
      last_customer_answer: input.text,
      next_best_action: "follow_up_4h_pedir_permissao_pix",
      proxima_acao: "voltar em 4h pedindo permissao para enviar Pix",
      updated_at: input.now.toISOString()
    }
  };
}

function mergePreSaleRechargeLaterFollowupState(
  metadata: Record<string, unknown> | null | undefined,
  state: Record<string, unknown>
) {
  const currentLeadProfile = readLeadProfile(metadata);
  const stateLeadProfile = readLeadProfile(state);
  return {
    ...(metadata || {}),
    ...state,
    lead_profile: {
      ...currentLeadProfile,
      ...stateLeadProfile
    }
  };
}

function isRechargeLaterIntent(normalized: string) {
  return (
    /\b(mais tarde|depois|daqui a pouco|logo mais|quando eu chegar)\b.{0,50}\b(faco|fazer|pago|pagar|recarga|recarrego|recarregar|fecho|fechar|realizo|realizar)\b/.test(normalized) ||
    /\b(vou|vou querer|quero)\b.{0,35}\b(fazer|pagar|realizar|fechar|recarregar)\b.{0,50}\b(mais tarde|depois|daqui a pouco|logo mais|quando eu chegar)\b/.test(normalized) ||
    /\b(vou realizar a recarga|vou fazer a recarga|vou fechar depois|beleza.*mais tarde.*pago)\b/.test(normalized)
  );
}

function hasRealPreSaleRechargeInterest(textWindow: string, leadProfile: Record<string, unknown>) {
  return Boolean(
    leadProfile.selected_plan ||
    leadProfile.plano_interesse ||
    leadProfile.wants_recharge ||
    leadProfile.asked_price ||
    leadProfile.asked_screens ||
    leadProfile.negotiated_price_cents ||
    /\b(valor|preco|quanto|30 dias|mensal|recarga|recarregar|telas?|pix|plano)\b/.test(textWindow)
  );
}

function extractPreSaleContext(textWindow: string, leadProfile: Record<string, unknown>, customerName?: string | null) {
  return {
    name: readFirstName(customerName || leadProfile.nome),
    plan: leadProfile.selected_plan || leadProfile.plano_interesse || (/\b(30 dias|mensal|mes)\b/.test(textWindow) ? "mensal" : null),
    screens: Number(leadProfile.requested_screens || leadProfile.telas || extractScreensCount(textWindow)) || null,
    negotiatedPriceCents: Number(leadProfile.negotiated_price_cents || extractPriceCents(textWindow, /(\d{1,3})(?:[,.](\d{1,2}))?\s*(?:por\s*)?(?:3|tres|duas|2)?\s*telas?/)) || null,
    quotedPriceCents: Number(leadProfile.quoted_price_cents || extractPriceCents(textWindow, /(?:r\$\s*)?(\d{1,3})(?:[,.](\d{1,2}))?/)) || null
  };
}

function extractScreensCount(text: string) {
  const numeric = text.match(/\b(\d{1,2})\s*telas?\b/);
  if (numeric) return Number(numeric[1]);
  if (/\bduas\s+telas?\b/.test(text)) return 2;
  if (/\btres\s+telas?\b/.test(text)) return 3;
  if (/\buma\s+tela\b/.test(text)) return 1;
  return null;
}

function extractPriceCents(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  if (!match) return null;
  const reais = Number(match[1]);
  const centavos = match[2] ? Number(match[2].padEnd(2, "0").slice(0, 2)) : 0;
  if (!Number.isFinite(reais)) return null;
  return reais * 100 + (Number.isFinite(centavos) ? centavos : 0);
}

function readFirstName(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().split(/\s+/)[0]?.replace(/[^\p{L}'-]/gu, "") || "";
}

function buildManualOutboundFollowupState(
  text: string,
  metadata: Record<string, unknown> | null | undefined,
  now: Date
) {
  if (isManualPreSaleNegotiationContext(text) || isManualContactSavedContext(text, metadata)) {
    return {
      followup_key: PRE_SALE_RECHARGE_LATER_FOLLOWUP_KEY,
      followup_due_at: new Date(now.getTime() + PRE_SALE_RECHARGE_LATER_DELAY_MS).toISOString(),
      followup_sent_at: null,
      followup_sent_stage_id: null,
      followup_count: 0,
      last_followup_stage_id: `${PRE_SALE_RECHARGE_LATER_FOLLOWUP_KEY}:manual:${now.getTime()}`,
      awaiting_customer_action: "pix_permission",
      conversation_stage: "pre_sale_recharge_intent",
      customer_stage: "pre_sale_recharge_intent",
      payment_intent_status: "later",
      last_detected_intent: "pre_sale_commitment_pending_payment",
      detected_stage_at_schedule_time: "pre_sale_recharge_intent",
      reason_for_schedule: "manual_pre_sale_negotiation",
      conversation_version: buildConversationVersion(metadata, now),
      last_message_id: null,
      last_customer_message_at: metadata?.last_customer_message_at || null,
      pre_sale_followup_scheduled_at: now.toISOString(),
      pre_sale_followup_reason: "manual_offer_or_contact_saved"
    };
  }

  if (isManualAccessDeliveryContext(text)) {
    return {
      followup_key: null,
      followup_due_at: null,
      awaiting_customer_action: null,
      conversation_stage: "human_support_activation",
      followup_cancel_reason: "specialist_closing_sale_or_access"
    };
  }

  const intent = inferManualOutboundIntent(text);
  if (!intent) {
    return {};
  }

  const state = buildFollowupState({
    reply: text,
    classification: { intent }
  }, metadata, now);

  return state.followup_key ? state : {};
}

function isManualPreSaleNegotiationContext(text: string) {
  const normalized = normalizeFreeText(text);
  return /\b(condicao especial|condi[cç]ao especial|adquirir novos clientes|fechar pra voce|17[,.]90|17[,.]9|3 telas|tres telas|o que voce acha)\b/.test(normalized);
}

function isManualContactSavedContext(text: string, metadata: Record<string, unknown> | null | undefined) {
  const normalized = normalizeFreeText(text);
  const profile = readLeadProfile(metadata);
  return /\b(contato salvo|vou deixar seu contato|deixar seu contato salvo|prazer.*andre)\b/.test(normalized) &&
    (metadata?.followup_key === PRE_SALE_RECHARGE_LATER_FOLLOWUP_KEY || profile.stage === "pre_sale_recharge_intent");
}

function buildConversationVersion(metadata: Record<string, unknown> | null | undefined, now: Date) {
  return Number(metadata?.conversation_version || 0) + 1 || now.getTime();
}

function buildManualOutboundLeadProfilePatch(text: string, messageAt: string) {
  const normalized = normalizeFreeText(text);
  const patch: Record<string, unknown> = {
    last_specialist_message_at: messageAt,
    learned_from_specialist: true
  };

  if (/\b(mediafire\.com|apk|download|baixar|baixe|downloader|862585|tutorial|instalar|instalacao)\b/.test(normalized)) {
    patch.commercial_stage = "download_support";
    patch.stage = "download_support";
    patch.install_status = "link_sent";
    patch.download_status = "link_sent";
    patch.next_expected_reply = "download_confirmation";
    patch.followup_reason = "manual_download_link_sent";
  }

  if (/\b(seja bem vindo|seja bem-vindo|meu nome e andre|meu nome é andre|recarga|renovar|ativar)\b/.test(normalized)) {
    patch.commercial_stage = patch.commercial_stage || "qualified";
    patch.stage = patch.stage || "qualified";
    patch.next_expected_reply = patch.next_expected_reply || "activation_or_renewal";
    patch.followup_reason = patch.followup_reason || "manual_welcome_or_activation";
  }

  if (/\b(mensal|3 meses|6 meses|anual|r\$ ?20[,.]90|r\$ ?25|r\$ ?70|r\$ ?120|r\$ ?200)\b/.test(normalized)) {
    patch.commercial_stage = "plan_selected";
    patch.stage = "plan_selected";
    patch.next_expected_reply = "payment_method";
    patch.followup_reason = "manual_plan_offer_sent";
  }

  if (/\b(condicao especial|condi[cç]ao especial|adquirir novos clientes|fechar pra voce|17[,.]90|17[,.]9|3 telas|tres telas)\b/.test(normalized)) {
    patch.commercial_stage = "pre_sale_recharge_intent";
    patch.stage = "pre_sale_recharge_intent";
    patch.inferred_specialist_action = "ofereceu_condicao_especial_baixa_pressao";
    patch.learned_pattern = "cliente_faz_depois_pedir_permissao_pix_4h";
    patch.next_best_action = "aguardar_cliente_ou_followup_pedindo_permissao_pix";
    patch.followup_reason = "manual_pre_sale_negotiation";
    patch.special_promo_followup_sent = true;
    patch.special_promo_offer = "manual_pre_sale_special_offer";
    patch.negotiated_price_cents = extractPriceCents(normalized, /(\d{1,3})(?:[,.](\d{1,2}))?/) || patch.negotiated_price_cents;
    patch.requested_screens = extractScreensCount(normalized) || patch.requested_screens;
  }

  if (/\b(pix|copia e cola|qr code|chave)\b/.test(normalized)) {
    patch.commercial_stage = "awaiting_payment";
    patch.stage = "awaiting_payment";
    patch.payment_method = "pix";
    patch.next_expected_reply = "payment_proof";
    patch.followup_reason = "manual_payment_instruction_sent";
  }

  if (isManualAccessDeliveryContext(text)) {
    patch.commercial_stage = "human_support_activation";
    patch.stage = "human_support_activation";
    patch.sale_closed_by_specialist = true;
    patch.access_delivery_status = "human_handling";
    patch.next_expected_reply = "access_delivery_or_screen_photo";
    patch.followup_reason = "specialist_closing_sale_or_access";
    patch.self_monitoring = true;
  }

  return patch;
}

function isManualAccessDeliveryContext(text: string) {
  const normalized = normalizeFreeText(text);
  return (
    /\b(mando|mandar|envio|enviar|libero|liberar|entrego|entregar)\b.{0,35}\b(acesso|codigo|c[oó]digo|recarga)\b/.test(normalized) ||
    /\b(aguardando|esperando)\b.{0,35}\b(fornecedor|responder|retornar)\b/.test(normalized) ||
    /\b(fornecedor)\b.{0,35}\b(acesso|responder|retornar)\b/.test(normalized) ||
    /\b(mande|envie|manda|envia)\b.{0,35}\b(foto|print|tela)\b/.test(normalized) ||
    /\b(instruir|mostrar|orientar)\b.{0,35}\b(onde entrar|entrar|tela)\b/.test(normalized) ||
    /\b(botao ativar recarga|centro de resgate|entrar nesse mesmo local)\b/.test(normalized)
  );
}

function inferManualOutboundIntent(text: string) {
  const normalized = normalizeFreeText(text);

  if (
    /\b(mediafire\.com|apk|download|baixar|baixe|downloader|862585|tutorial|instalar|instalacao)\b/.test(normalized)
  ) {
    return "technical_support";
  }

  if (/\b(seja bem vindo|seja bem-vindo|meu nome e andre|meu nome é andre)\b/.test(normalized)) {
    return "greeting";
  }

  if (/\b(renovar|recarga|recarregar|codigo unitv|código unitv)\b/.test(normalized)) {
    return "renew_plan";
  }

  if (/\b(teste gratis|teste gratuito|3 dias)\b/.test(normalized)) {
    return "free_trial";
  }

  if (/\b(mensal|3 meses|6 meses|anual|valores|quanto custa|r\$ ?20[,.]90|r\$ ?25|r\$ ?70|r\$ ?120|r\$ ?200)\b/.test(normalized)) {
    return "ask_price";
  }

  if (/\b(pix|cartao|cartão|pagamento|comprovante)\b/.test(normalized)) {
    return "pix_payment";
  }

  return null;
}

function inferFollowupKey(
  output: { reply: string; classification: Record<string, unknown>; menu?: WhatsAppMenu; copyText?: string; media?: unknown },
  intent: string
) {
  const reply = output.reply.toLowerCase();
  if (/mediafire\.com|baixe por aqui|download|baixar|apk|downloader|tutorial|youtube\.com|voce prefere instalar pelo link ou pelo downloader|você prefere instalar pelo link ou pelo downloader/i.test(output.reply)) {
    return "post_download_check_10min";
  }
  if (intent === "greeting") return "welcome_activation";
  if (output.copyText || output.media) return "pix";
  if (intent === "pix_payment") {
    if (/qual plano|mensal|3 meses|6 meses|anual/i.test(output.reply)) return "plan_choice";
    return "payment_choice";
  }
  if (intent === "receipt_sent" || /\bcomprovante\b/i.test(reply)) return "proof";
  if (intent === "ask_price") return "values";
  if (intent === "buy_plan" || intent === "renew_plan") {
    if (output.menu?.id === "plans" || /qual .*ativar|qual plano|hoje temos/i.test(output.reply)) return "plan_choice";
    if (/pix ou cart[aã]o|prefere pagar/i.test(output.reply)) return "payment_choice";
    return "plan_choice";
  }
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
    payment_choice: "choose_payment_method",
    download: "confirm_download",
    post_download_check_10min: "confirm_download",
    monthly_promo_19_99_check: "confirm_monthly_offer",
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
  if (key === "payment_choice") return "pagamento";
  if (key === "welcome_activation") return "boas_vindas";
  if (key === "proof") return "aguardando_comprovante";
  if (key === "download" || key === "install" || key === "post_download_check_10min") return "instalacao";
  if (key === "monthly_promo_19_99_check") return "monthly_offer_pending";
  if (key === "test") return "teste";
  if (key === "values" || key === "plan_choice") return "valores";
  if (intent === "human_help") return "humano";
  return "qualificacao";
}

function readLeadProfile(metadata: Record<string, unknown> | null | undefined) {
  const profile = metadata?.lead_profile;
  const leadProfile = profile && typeof profile === "object" && !Array.isArray(profile)
    ? (profile as Record<string, unknown>)
    : {};
  const state = resolveConversationState({ metadata, leadProfile });
  return withCanonicalConversationState(leadProfile, state);
}

function buildMetaReferralConversationPatch(metaReferral: IncomingEvolutionMessage["metaReferral"] | null | undefined) {
  if (!metaReferral?.ctwaClid) {
    return {};
  }

  return {
    meta_referral: metaReferral,
    meta_ctwa_clid: metaReferral.ctwaClid,
    meta_ad_source_id: metaReferral.sourceId || null,
    meta_ad_source_url: metaReferral.sourceUrl || null,
    meta_ad_source_type: metaReferral.sourceType || null,
    meta_entry_point: metaReferral.entryPointConversionSource || null
  };
}

function buildSpecialistExampleLookupContext(recentMessages: Array<{ role?: string; content?: string | null }>) {
  return recentMessages
    .slice(-12)
    .map((item) => `${item.role || "unknown"}: ${item.content || ""}`)
    .join("\n")
    .slice(-4000);
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
    const requestedScreens = extractScreensCount(normalized);
    if (requestedScreens) patch.requested_screens = requestedScreens;
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
  if (isSpecialPromoAcceptance(normalized, existing)) {
    patch.accepted_special_promo = true;
    patch.special_promo_accepted_at = new Date().toISOString();
    patch.special_promo_offer = existing.special_promo_offer || "mensal_19_99_first_2_months";
    patch.selected_plan = existing.selected_plan || "mensal";
    patch.plano_interesse = existing.plano_interesse || "mensal";
    patch.pediu_pix = true;
    patch.nivel_interesse = "muito_quente";
    patch.payment_status = existing.payment_status || "not_paid";
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

function isSpecialPromoAcceptance(normalized: string, existing: Record<string, unknown>) {
  if (!existing.special_promo_followup_sent || existing.accepted_special_promo) {
    return false;
  }
  return (
    /^(sim|s|quero|ok|pode|pode mandar|manda|manda pix|manda o pix|vou querer|fechado|bora|aceito)$/.test(normalized) ||
    /\b(quero aproveitar|pode mandar|manda o pix|manda pix|vou querer|aceito|fechado)\b/.test(normalized)
  );
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
  if (/\b(errado|nao entendeu|nao e isso|nao quero|desisto|cancelar|nao consegui|nao deu|nao funcionou|continua com erro|nao chegou)\b/.test(normalized)) {
    return "negative";
  }
  if (/^(sim|ok|pode|quero|mensal|anual|pix|cartao|paguei|feito|consegui)(\b|[!. ]*$)/.test(normalized) ||
      /\b(deu certo|funcionou|muito obrigado|obrigada|consegui agora)\b/.test(normalized)) {
    return "positive";
  }
  return "neutral";
}

function buildQuickSpecialistLearningSignals(message: string, _botWasOverridden: boolean) {
  const normalized = normalizeFreeText(message);
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const isShort = wordCount > 0 && wordCount <= 22;

  return {
    successSignal: "unknown" as const,
    humanStyle: isShort ? "curto_direto_uma_acao" : "direto_contextual",
    styleNotes: isShort
      ? "Especialista usa frase curta, direta e contextual. Manter 1 ou 2 frases, sem textao e com no maximo uma pergunta."
      : "Especialista conduz pelo contexto real. Resumir, nao alongar, e avancar para uma acao clara.",
    maxReplySentences: isShort ? 2 : 3,
    wordCount,
    isShort
  };
}

function mergeStyleNotes(...notes: Array<string | null | undefined>) {
  return notes
    .map((note) => String(note || "").trim())
    .filter(Boolean)
    .filter((note, index, list) => list.indexOf(note) === index)
    .join(" ");
}

export function isCustomerMessageSuperseded(
  messages: Array<Record<string, unknown>>,
  externalMessageId: string
) {
  const latestCustomerMessage = [...messages]
    .reverse()
    .find((item) => item.role === "customer");
  if (!latestCustomerMessage) return false;
  return typeof latestCustomerMessage.external_message_id === "string" &&
    latestCustomerMessage.external_message_id !== externalMessageId;
}

function buildSpecialistLearningTags(input: {
  customerLastMessage: string | null;
  botPreviousMessage: string | null;
  specialistMessage: string;
  analysis: { inferred_intent?: string; learned_pattern?: string; inferred_specialist_action?: string };
}) {
  const text = normalizeFreeText([
    input.customerLastMessage || "",
    input.botPreviousMessage || "",
    input.specialistMessage || "",
    input.analysis.inferred_intent || "",
    input.analysis.learned_pattern || "",
    input.analysis.inferred_specialist_action || ""
  ].join(" "));
  const tags = new Set<string>();

  if (/\b(pre.?sale|pre venda|pre_venda|mais tarde|depois|faco|fa[cç]o|pago|recarga)\b/.test(text)) tags.add("PRE_SALE");
  if (/\b(mais tarde|depois|faco|fa[cç]o|vou fazer|vou pagar|recharge_later|recarga_later)\b/.test(text)) tags.add("RECHARGE_LATER");
  if (/\b(pix|pagamento|pagar|pago|payment)\b/.test(text)) tags.add("PAYMENT_INTENT");
  if (/\b(posso.*pix|mandar.*pix|chave pix|pix_permission)\b/.test(text)) tags.add("PIX_PERMISSION");
  if (/\b(condicao especial|condi[cç]ao especial|17[,.]90|negoci|novos clientes)\b/.test(text)) tags.add("HUMAN_NEGOTIATION");
  if (/\b(caro|15|desconto|barato|condicao|condi[cç]ao)\b/.test(text)) tags.add("PRICE_OBJECTION");
  if (/\b(condicao especial|promo|17[,.]90|oferta)\b/.test(text)) tags.add("SPECIAL_OFFER");
  if (/\b(repetiu|saudacao|seja bem vindo|ja usa|primeira vez)\b/.test(text)) tags.add("DO_NOT_REPEAT_GREETING");

  return [...tags];
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
