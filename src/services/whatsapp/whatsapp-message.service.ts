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

    if (isReceiptMessage(message)) {
      const reply = await this.handleReceiptMessage({ webhookEventId, message, customer, conversation });
      return this.sendAndStoreAssistantReply({ webhookEventId, message, customer, conversation, reply, classification: { intent: "receipt_sent" } });
    }

    let currentCustomer = customer;
    let effectiveMessage = message.text;
    let classification: IntentClassification;
    if (conversation.metadata?.awaiting_pix_email) {
      const email = extractEmail(message.text);
      if (!email) {
        return this.sendAndStoreAssistantReply({
          webhookEventId,
          message,
          customer,
          conversation,
          reply: "Envie um e-mail valido para eu gerar seu Pix Copia e Cola.",
          classification: { intent: "pix_payment", confidence: 1, summary: "invalid_payer_email" }
        });
      }

      currentCustomer = await this.customersRepository.updateCustomer(customer.id, { email });
      await this.conversationsRepository.updateConversationMetadata(conversation.id, {
        ...(conversation.metadata || {}),
        awaiting_pix_email: false,
        awaiting_pix_order_id: null
      });
      classification = {
        intent: "pix_payment" as const,
        confidence: 1,
        summary: "E-mail recebido para gerar Pix.",
        suggested_reply: ""
      };
    } else {
      const selection = resolveMenuSelection(message.text, conversation.metadata);
      if (selection) {
        effectiveMessage = selection.message;
        classification = {
          intent: selection.intent,
          confidence: 1,
          summary: `Selecao direta do menu: ${message.text}`,
          suggested_reply: ""
        };
      } else {
        classification = await this.intentClassifier.classify({ message: message.text });
      }
    }
    const commercialReply = await this.chatAgent.generateCommercialReply({
      message: effectiveMessage,
      classification,
      customer: currentCustomer,
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
      await this.conversationsRepository.updateConversationMetadata(conversation.id, {
        ...(conversation.metadata || {}),
        requires_human: true,
        handoff_reason: classification.intent,
        handoff_requested_at: new Date().toISOString()
      });
    }

    if (commercialReply.awaitingPixEmail) {
      await this.conversationsRepository.updateConversationMetadata(conversation.id, {
        ...(conversation.metadata || {}),
        awaiting_pix_email: true,
        awaiting_pix_order_id: commercialReply.order?.id || null,
        awaiting_pix_requested_at: new Date().toISOString()
      });
    }

    if (commercialReply.menu) {
      await this.conversationsRepository.updateConversationMetadata(conversation.id, {
        ...(conversation.metadata || {}),
        last_menu_id: commercialReply.menu.id,
        last_menu_sent_at: new Date().toISOString()
      });
    }

    return this.sendAndStoreAssistantReply({
      webhookEventId,
      message,
      customer: currentCustomer,
      conversation,
      reply,
      classification,
      media: commercialReply.media,
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
    menu,
    sendTextBeforeMenu
  }: {
    webhookEventId: string;
    message: IncomingEvolutionMessage;
    customer: { id: string };
    conversation: { id: string };
    reply: string;
    classification: Record<string, unknown>;
    media?: { base64: string; mimetype: string; fileName: string; caption: string };
    menu?: WhatsAppMenu;
    sendTextBeforeMenu?: boolean;
  }) {
    let sendResult: unknown;
    if (menu) {
      if (sendTextBeforeMenu) {
        sendResult = await this.evolutionService.sendTextMessage({ phone: message.phone, text: reply });
      }

      try {
        const listResult = await this.evolutionService.sendListMessage({
          phone: message.phone,
          title: menu.title,
          description: menu.description,
          buttonText: menu.buttonText,
          footerText: menu.footerText,
          sections: menu.sections
        });
        sendResult = sendTextBeforeMenu ? { text: sendResult, list: listResult } : listResult;
      } catch (error) {
        const fallbackResult = await this.evolutionService.sendTextMessage({
          phone: message.phone,
          text: sendTextBeforeMenu ? menu.fallbackText : reply
        });
        sendResult = sendTextBeforeMenu ? { text: sendResult, fallback: fallbackResult } : fallbackResult;
        await this.auditService.createAuditLog({
          actor_type: "system",
          action: "evolution_interactive_menu_fallback",
          entity_type: "conversations",
          entity_id: conversation.id,
          metadata: { webhookEventId, menu_id: menu.id, error: error instanceof Error ? error.message : "unknown_error" }
        });
      }
    } else {
      sendResult = await this.evolutionService.sendTextMessage({ phone: message.phone, text: reply });
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
        mediaSendResult,
        media: media ? { mimetype: media.mimetype, fileName: media.fileName, caption: media.caption } : null,
        menu: menu ? { id: menu.id, title: menu.title } : null
      }
    });

    await this.conversationsRepository.touchConversation(conversation.id);
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
  const text = message.text.toLowerCase();
  const receiptText = /\b(comprovante|paguei|pagamento feito|pix enviado|transferencia|transferência)\b/.test(text);
  const receiptMedia = message.hasMedia && ["imageMessage", "documentMessage"].includes(message.messageType);

  return receiptText || receiptMedia;
}

function extractEmail(message: string) {
  const match = message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0].toLowerCase() || null;
}
