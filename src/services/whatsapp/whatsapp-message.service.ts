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
    private readonly agentActionsService = new AgentActionsService()
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
          fromMe: true
        }
      });

      await this.conversationsRepository.updateConversationMetadata(conversation.id, {
        ...(conversation.metadata || {}),
        requires_human: true,
        handoff_reason: conversation.metadata?.handoff_reason || "human_agent_reply",
        handoff_requested_at: conversation.metadata?.handoff_requested_at || messageAt,
        last_specialist_message_at: messageAt
      });
      await this.conversationsRepository.touchConversation(conversation.id, messageAt);
      await this.auditService.createAuditLog({
        actor_type: "human_admin",
        action: "human_agent_message_recorded",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: { webhookEventId, externalMessageId: message.externalMessageId, lastSpecialistMessageAt: messageAt }
      });

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

    if (isReceiptMessage(message)) {
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

    const commercialReply = await this.chatAgent.generateCommercialReply({
      message: effectiveMessage,
      classification,
      customer,
      conversation,
      webhookEventId
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
    let sendResult: unknown;
    if (menu) {
      if (sendTextBeforeMenu) {
        const replyResult = await this.evolutionService.sendTextMessage({ phone: message.phone, text: reply });
        const menuResult = await this.evolutionService.sendTextMessage({ phone: message.phone, text: menu.fallbackText });
        sendResult = { text: replyResult, menu: menuResult };
      } else {
        sendResult = await this.evolutionService.sendTextMessage({ phone: message.phone, text: reply });
      }
    } else {
      sendResult = await this.evolutionService.sendTextMessage({ phone: message.phone, text: reply });
    }
    let copyTextSendResult: unknown = null;
    if (copyText) {
      copyTextSendResult = await this.evolutionService.sendTextMessage({ phone: message.phone, text: copyText });
    }

    const followUpSendResults = [];
    for (const followUpMessage of followUpMessages || []) {
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
      content: reply,
      content_type: "text",
      external_message_id: `assistant:${message.externalMessageId}`,
      metadata: {
        webhookEventId,
        classification,
        sendResult,
        copyTextSendResult,
        followUpSendResults,
        mediaSendResult,
        media: media ? { mimetype: media.mimetype, fileName: media.fileName, caption: media.caption } : null,
        menu: menu ? { id: menu.id, title: menu.title } : null
      }
    });

    const now = new Date();
    const followupState = buildFollowupState({ reply, classification, menu, copyText, followUpMessages, media }, conversation.metadata, now);
    const nextMetadata = {
      ...(conversation.metadata || {}),
      last_bot_message_at: now.toISOString(),
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

    return { status: "processed" as const, reply };
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
      ? (metadata.lead_profile as Record<string, unknown>).aparelho || metadata.device || null
      : metadata?.device || null
  };
}

function inferFollowupKey(
  output: { reply: string; classification: Record<string, unknown>; menu?: WhatsAppMenu; copyText?: string; media?: unknown },
  intent: string
) {
  const reply = output.reply.toLowerCase();
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
    etapa_atual: mapIntentToStage(intent)
  };

  if (!existing.intencao_inicial) {
    patch.intencao_inicial = intent;
  }

  const plan = detectPlanInterest(normalized);
  if (plan) {
    patch.plano_interesse = plan;
    patch.nivel_interesse = "quente";
  }

  const device = detectDevice(normalized);
  if (device) {
    patch.aparelho = device;
  }

  if (/\b(download|baixar|apk|downloader|instalar|instalacao)\b/.test(normalized)) {
    patch.pediu_download = true;
  }
  if (/\b(teste|gratis|gratuito|free trial)\b/.test(normalized)) {
    patch.pediu_teste_gratis = true;
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
    if (existing.objecao_principal && existing.objecao_principal !== objection) {
      patch.segunda_objecao = objection;
    }
  }

  patch.resumo_curto = buildShortConversationSummary(patch, existing);
  patch.proxima_acao = suggestNextAction(patch, existing);

  return patch;
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

function detectDevice(normalized: string) {
  if (/\btv box|android tv|televisao android\b/.test(normalized)) return "TV Box / Android TV";
  if (/\bsmart tv|tv\b/.test(normalized)) return "TV";
  if (/\bcelular|android|mobile\b/.test(normalized)) return "Celular Android";
  if (/\biphone|ios\b/.test(normalized)) return "iPhone";
  if (/\bcomputador|pc|notebook\b/.test(normalized)) return "Computador";
  return null;
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
