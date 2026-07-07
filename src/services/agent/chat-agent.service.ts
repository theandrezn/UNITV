import "server-only";
import type { IntentClassification } from "./intent-classifier.service";
import { sanitizeReply } from "@/lib/agent/reply-safety";
import { AppSettingsService } from "@/services/app-settings.service";
import { AgentActionsService } from "@/services/agent-actions.service";
import { AuditService } from "@/services/audit.service";
import { ActivationCodesService } from "@/services/activation-codes.service";
import { KnowledgeService } from "@/services/knowledge/knowledge.service";
import { OrdersService } from "@/services/orders.service";
import { MercadoPagoService } from "@/services/payments/mercadopago.service";
import { PlansService } from "@/services/plans.service";
import { buildNoAccessCodeAvailableMessage, buildPostPurchaseMessages } from "@/lib/unitv/post-purchase-messages";
import { findUnitvObjectionReply } from "@/lib/unitv/objection-map";
import { isWhatsAppMainMenuEnabled } from "@/lib/env";
import {
  buildPlansMenu,
  CONTINUATION_MENU,
  INSTALL_MENU,
  MAIN_MENU,
  PAYMENT_MENU,
  type WhatsAppMenu
} from "@/lib/whatsapp/menus";
import { SalesResponseAIService, shouldUseAIResponse } from "@/services/agent/sales-response-ai.service";
import { getUnitvInstallationGuidance, isUnitvInstallationRequest } from "@/lib/unitv/device-compatibility";

export const INITIAL_UNITV_REPLY =
  "Olá! Seja bem-vindo ao melhor aplicativo de filmes e canais 🧡. Meu nome é André.\n\n" +
  "Você quer ver os valores, fazer o teste grátis ou precisa de ajuda para instalar?";

const LOW_CONFIDENCE_REPLY =
  "Claro, eu te ajudo.\n\nMe confirma uma coisa: você quer comprar um plano, renovar um acesso ou precisa de ajuda com instalação?";

const PLANS_TEXT = ["Mensal — R$ 25", "3 meses — R$ 70", "6 meses — R$ 120", "Anual — R$ 200"].join("\n");
const PAYMENT_TEXT = "Você prefere pagar com Pix ou cartão?";

const SPECIAL_PROMO_OFFER_ID = "mensal_19_99_first_2_months";
const SPECIAL_PROMO_MONTHLY_PRICE_CENTS = 1999;

type CommercialReplyInput = {
  message: string;
  classification: IntentClassification;
  customer: { id: string; email?: string | null };
  conversation: { id: string; metadata?: Record<string, unknown> | null };
  webhookEventId: string;
  recentMessages?: Array<{ role?: string; content?: string | null }>;
  specialistExamples?: Array<{
    customer_last_message?: string | null;
    bot_previous_message?: string | null;
    specialist_message?: string | null;
  }>;
};

type CommercialReplyResult = {
  reply: string;
  responseSource?: "ai" | "local_rule";
  responseRule?: string;
  order?: Record<string, unknown>;
  requiresHuman?: boolean;
  notifyOwner?: boolean;
  ownerNotificationText?: string;
  followUpMessages?: string[];
  menu?: WhatsAppMenu;
  sendTextBeforeMenu?: boolean;
  copyText?: string;
  leadProfilePatch?: Record<string, unknown>;
  media?: {
    base64: string;
    mimetype: string;
    fileName: string;
    caption: string;
  };
};

export class ChatAgentService {
  constructor(
    private readonly plansService = new PlansService(),
    private readonly knowledgeService = new KnowledgeService(),
    private readonly ordersService = new OrdersService(),
    private readonly appSettingsService = new AppSettingsService(),
    private readonly agentActionsService = new AgentActionsService(),
    private readonly auditService = new AuditService(),
    private readonly mercadoPagoService = new MercadoPagoService(),
    private readonly activationCodesService = new ActivationCodesService(),
    private readonly salesResponseAIService = new SalesResponseAIService()
  ) {}

  generateReply(input: { message: string; classification: IntentClassification }) {
    const trimmed = input.message.trim();

    if (!trimmed) {
      return "";
    }

    if (input.classification.confidence < 0.55) {
      return LOW_CONFIDENCE_REPLY;
    }

    const suggestedReply = sanitizeReply(input.classification.suggested_reply);
    return ensureQuestionForContext(suggestedReply || INITIAL_UNITV_REPLY, input.classification.intent);
  }

  async generateCommercialReply(input: CommercialReplyInput): Promise<CommercialReplyResult> {
    const message = input.message.trim();
    if (!message) {
      return { reply: "" };
    }

    const knowledge = await this.knowledgeService.searchKnowledge(message);
    const intent = input.classification.intent === "support" ? "technical_support" : input.classification.intent;
    const allowMenu = shouldUseMenu(message);
    const leadProfile = readLeadProfile(input.conversation.metadata);

    const contextualReply = getContextualCommercialReply(message, leadProfile);
    if (leadProfile.downloaded_app === true && intent === "technical_support" && isInstallationMessage(message)) {
      return {
        reply:
          "Perfeito. Como você já baixou o app, agora posso te ajudar com a ativação. " +
          "Você quer liberar o teste grátis de 3 dias ou já ativar o mensal de R$ 25?"
      };
    }
    const deterministicInstallationReply = intent === "technical_support" ? getInstallationReply(message) : null;
    if (deterministicInstallationReply) {
      return deterministicInstallationReply;
    }

    if (intent === "pix_payment" && isSpecialPromoAccepted(leadProfile)) {
      return this.generatePixPayment(input, knowledge);
    }

    if (shouldUseAIResponse({
      message,
      intent,
      leadProfile,
      recentMessages: input.recentMessages,
      specialistExamplesCount: input.specialistExamples?.length || 0
    })) {
      const aiReply = await this.salesResponseAIService.generateResponse({
        message,
        intent,
        leadProfile,
        recentMessages: input.recentMessages,
        specialistExamples: input.specialistExamples,
        fallbackReply: contextualReply?.reply || null,
        useStrongModel: shouldUseStrongSalesModel(message, leadProfile, input.recentMessages)
      });
      if (aiReply) {
        return { reply: aiReply, responseSource: "ai", responseRule: "sales_response_ai" };
      }
    }

    if (contextualReply) {
      return { ...contextualReply, responseSource: "local_rule", responseRule: "contextual_reply" };
    }

    const salesObjectionReply = findUnitvObjectionReply(message) || getSalesObjectionReply(message);
    if ((intent === "unknown" || intent === "technical_support") && salesObjectionReply) {
      return {
        reply: salesObjectionReply.reply,
        menu: allowMenu ? salesObjectionReply.menu : undefined,
        sendTextBeforeMenu: allowMenu && Boolean(salesObjectionReply.menu)
      };
    }

    const objectionCategory = getObjectionKnowledgeCategory(message);
    if (objectionCategory) {
      const objection = knowledge.find((article) => article.category === objectionCategory);
      if (objection?.content) {
        return {
          reply: objection.content,
          menu: allowMenu && (objectionCategory === "objecao_preco" || objectionCategory === "objecao_concorrencia")
            ? buildPlansMenu(await this.plansService.listActivePlans())
            : allowMenu
              ? CONTINUATION_MENU
              : undefined,
          sendTextBeforeMenu: allowMenu
        };
      }
    }

    if (input.classification.confidence < 0.45) {
      return this.handoffToHuman(input, "low_confidence", knowledge);
    }

    if (intent === "human_help") {
      const installationSupportReply = getInstallationReply(message);
      if (installationSupportReply?.requiresHuman) {
        return installationSupportReply;
      }

      return this.handoffToHuman(input, "customer_requested_human", knowledge);
    }

    if (intent === "activation_help") {
      await this.auditService.createAuditLog({
        actor_type: "ai_agent",
        action: "activation_code_auto_release_blocked",
        entity_type: "conversations",
        entity_id: input.conversation.id,
        metadata: { webhookEventId: input.webhookEventId }
      });
      return {
        reply:
          "Consigo te ajudar com a ativação, mas não libero código automaticamente. Se já pagou, envie o comprovante por aqui para conferência manual.",
        menu: allowMenu ? CONTINUATION_MENU : undefined,
        sendTextBeforeMenu: allowMenu
      };
    }

    if (intent === "free_trial" || isFreeTrialMessage(message)) {
      return {
        reply:
          "Claro. O teste grátis é de 3 dias.\n\n" +
          "Primeiro você instala o app no aparelho, depois seguimos com a liberação do teste.\n\n" +
          "Você vai usar em TV Box Android, Android TV, Fire Stick ou celular Android?",
        menu: allowMenu ? INSTALL_MENU : undefined,
        sendTextBeforeMenu: allowMenu
      };
    }

    if (intent === "ask_price") {
      const plans = await this.plansService.listActivePlans();
      const menu = allowMenu && plans.length ? buildPlansMenu(plans) : null;
      const objectionReply = salesObjectionReply?.reply;
      return {
        reply: objectionReply ||
          "O mensal fica R$ 25.\n\n" +
          "Também temos planos maiores:\n" +
          "3 meses — R$ 70\n" +
          "6 meses — R$ 120\n" +
          "Anual — R$ 200\n\n" +
          "O mensal é bom para começar, mas o anual é o melhor custo-benefício.\n\n" +
          "Você quer começar pelo mensal ou prefere um plano maior?",
        menu: menu || undefined,
        sendTextBeforeMenu: Boolean(menu)
      };
    }

    if (isPaymentDoneMessage(message)) {
      return this.checkPaymentAfterCustomerConfirmation(input);
    }

    if (intent === "pix_payment" || isPixPaymentMessage(message)) {
      return this.generatePixPayment(input, knowledge);
    }

    if (intent === "card_payment") {
      return this.generateCardPayment(input, knowledge);
    }

    if (intent === "ask_payment") {
      return {
        reply: "Claro. Você pode pagar com Pix ou cartão pelo Mercado Pago.\n\nSe já escolheu o plano, me diga qual é para eu gerar o pagamento certinho.",
        menu: allowMenu ? PAYMENT_MENU : undefined,
        sendTextBeforeMenu: allowMenu
      };
    }

    if (intent === "receipt_sent") {
      return {
        reply: "Perfeito. Pode me enviar a foto ou o PDF do comprovante aqui para eu encaminhar para validação?",
        menu: allowMenu ? CONTINUATION_MENU : undefined,
        sendTextBeforeMenu: allowMenu
      };
    }

    if (intent === "buy_plan" || intent === "renew_plan") {
      const { plan, plans } = await this.plansService.findPlanMentionedInText(message);

      await this.agentActionsService.createAgentAction({
        conversation_id: input.conversation.id,
        customer_id: input.customer.id,
        action_name: "purchase_intent_detected",
        status: "executed",
        input_payload: { message, intent, confidence: input.classification.confidence },
        output_payload: { plan_id: plan?.id || null },
        requires_human_approval: false
      });

      if (!plan) {
        const menu = allowMenu && plans.length ? buildPlansMenu(plans) : null;
        if (intent === "renew_plan" && isRenewalLeadMessage(message)) {
          return {
            reply:
              "Olá! Seja bem-vindo ao melhor aplicativo de filmes e canais 🧡. Meu nome é André.\n\n" +
              "Claro, eu te ajudo com a recarga. Você quer renovar um acesso que já tem ou ativar um novo plano?",
            menu: menu || undefined,
            sendTextBeforeMenu: Boolean(menu)
          };
        }

        return {
          reply:
            "Perfeito, eu te ajudo.\n\nHoje temos:\n" +
            PLANS_TEXT +
            "\n\nO mensal é bom para começar, e o anual é o melhor custo-benefício.\n\nQual você quer ativar?",
          menu: menu || undefined,
          sendTextBeforeMenu: Boolean(menu)
        };
      }

      if (Number(plan.price_cents) <= 0) {
        await this.agentActionsService.createAgentAction({
          conversation_id: input.conversation.id,
          customer_id: input.customer.id,
          action_name: "plan_price_missing_manual_review",
          status: "requested",
          input_payload: { plan_id: plan.id, plan_name: plan.name, intent },
          output_payload: {},
          requires_human_approval: true
        });

        return {
          requiresHuman: true,
          reply:
            "Encontrei esse plano, mas o valor ainda precisa ser confirmado no cadastro. Vou encaminhar para atendimento humano finalizar seu pedido com segurança."
        };
      }

      const order = await this.ordersService.createOrder({
        customer_id: input.customer.id,
        product_id: String(plan.product_id),
        plan_id: String(plan.id),
        status: "pending_payment",
        amount_cents: Number(plan.price_cents),
        currency: String(plan.currency || "BRL"),
        metadata: {
          source: "whatsapp_agent",
          webhookEventId: input.webhookEventId,
          intent
        }
      });

      await this.agentActionsService.createAgentAction({
        conversation_id: input.conversation.id,
        customer_id: input.customer.id,
        order_id: order.id,
        action_name: "create_order",
        status: "executed",
        input_payload: { plan_id: plan.id, intent },
        output_payload: { order_number: order.order_number },
        requires_human_approval: true
      });

      await this.auditService.createAuditLog({
        actor_type: "ai_agent",
        action: "order_created_from_whatsapp",
        entity_type: "orders",
        entity_id: order.id,
        metadata: {
          webhookEventId: input.webhookEventId,
          order_number: order.order_number,
          plan_id: plan.id
        }
      });

      return {
        order,
        reply: `Pedido criado: ${order.order_number}\nPlano: ${plan.name} - ${formatMoney(plan.price_cents, plan.currency)}\n\n${PAYMENT_TEXT}`,
        menu: allowMenu ? PAYMENT_MENU : undefined
      };
    }

    if (intent === "technical_support") {
      const installationReply = getInstallationReply(message);
      if (installationReply) {
        return installationReply;
      }

      const preferredCategory = getSupportKnowledgeCategory(message);
      const supportKnowledge =
        knowledge.find((article) => article.category === preferredCategory) ||
        knowledge.find((article) => article.category === "technical_support");
      if (isInstallationMessage(message)) {
        return {
          reply:
            "Eu te ajudo.\n\n" +
            "Você vai instalar onde: TV, TV Box ou celular Android?",
          menu: allowMenu ? INSTALL_MENU : undefined,
          sendTextBeforeMenu: allowMenu
        };
      }

      const supportReply =
        supportKnowledge?.content ||
        "Me diga qual aparelho/app você usa, o erro que aparece e se sua internet está funcionando. Assim eu te ajudo melhor.";
      return {
        reply: supportReply,
        menu: allowMenu ? CONTINUATION_MENU : undefined,
        sendTextBeforeMenu: allowMenu
      };
    }

    if (intent === "greeting") {
      return { reply: INITIAL_UNITV_REPLY, menu: allowMenu ? MAIN_MENU : undefined, sendTextBeforeMenu: allowMenu };
    }

    return { reply: this.generateReply(input) };
  }

  private async generateCardPayment(
    input: CommercialReplyInput,
    knowledge: Array<{ category?: string; content?: string }>
  ): Promise<CommercialReplyResult> {
    const order = await this.ordersService.findLatestOpenOrderByCustomerId(input.customer.id);
    if (!order) {
      const plans = await this.plansService.listActivePlans();
      const menu = shouldUseMenu(input.message) && plans.length ? buildPlansMenu(plans) : null;
      return {
        reply: "Ainda não encontrei um pedido aberto. Qual plano você quer ativar: mensal, 3 meses, 6 meses ou anual?",
        menu: menu || undefined
      };
    }

    const metadata = readOrderMetadata(order);
    const checkoutUrl = readOrderCheckoutUrl(order);
    if (checkoutUrl) {
      return { order, reply: formatCardReply(checkoutUrl) };
    }

    if (!order.plan_id) {
      return this.handoffToHuman(
        input,
        "card_order_plan_missing",
        knowledge,
        "Encontrei seu pedido, mas não consegui identificar o plano para gerar o link do cartão. Vou encaminhar para atendimento humano."
      );
    }

    try {
      const preference = await this.mercadoPagoService.createOrderPreference({
        order: {
          id: String(order.id),
          order_number: String(order.order_number),
          customer_id: String(order.customer_id),
          plan_id: String(order.plan_id),
          amount_cents: Number(order.amount_cents),
          currency: String(order.currency || "BRL")
        },
        plan: readOrderPlan(order)
      });

      await this.ordersService.updateOrder(String(order.id), {
        payment_provider: "mercado_pago",
        payment_reference: preference.id,
        metadata: {
          ...metadata,
          mercado_pago_preference_id: preference.id,
          mercado_pago_checkout_url: preference.checkoutUrl
        }
      });

      return { order, reply: formatCardReply(preference.checkoutUrl) };
    } catch (error) {
      await this.auditService.createAuditLog({
        actor_type: "ai_agent",
        action: "mercado_pago_preference_creation_failed",
        entity_type: "orders",
        entity_id: String(order.id),
        metadata: {
          webhookEventId: input.webhookEventId,
          error: error instanceof Error ? error.message : "unknown_error"
        }
      });
      return this.handoffToHuman(
        input,
        "mercado_pago_preference_creation_failed",
        knowledge,
        `Seu pedido ${String(order.order_number)} está aberto, mas não consegui gerar o link do cartão agora. Vou encaminhar para atendimento humano.`
      );
    }
  }

  private async checkPaymentAfterCustomerConfirmation(input: CommercialReplyInput): Promise<CommercialReplyResult> {
    let order = await this.ordersService.findLatestOrderByCustomerId(input.customer.id);
    if (!order) {
      const plans = await this.plansService.listActivePlans();
      const menu = shouldUseMenu(input.message) && plans.length ? buildPlansMenu(plans) : null;
      return {
        reply:
          "FEITO. Ainda não encontrei um pedido seu aqui. Escolha o plano para eu gerar o pagamento corretamente.",
        menu: menu || undefined
      };
    }

    order = await this.refreshOrderPaymentFromMercadoPago(order, input.webhookEventId);
    const orderNumber = String(order.order_number || "seu pedido");
    const status = String(order.status || "");

    if (status === "paid" || status === "code_reserved") {
      return this.releaseActivationCodeForPaidOrder(order, input);
    }

    if (status === "code_sent") {
      return {
        order,
        reply:
          `Pagamento confirmado para o pedido ${orderNumber}. O acesso já foi liberado para esse pedido.`
      };
    }

    if (status === "manual_review" || status === "receipt_under_review") {
      return {
        order,
        reply:
          `FEITO. Seu pedido ${orderNumber} está em conferência.\n\n` +
          "Assim que a validação terminar, eu sigo com a liberação do acesso."
      };
    }

    if (status === "refunded" || status === "cancelled" || status === "failed") {
      return {
        order,
        reply:
          `Encontrei o pedido ${orderNumber}, mas ele não está como pagamento aprovado.\n\n` +
          "Escolha uma forma de pagamento novamente ou fale com especialista para conferir."
      };
    }

    return {
      order,
      reply:
        `FEITO. Ainda não consta pagamento aprovado para o pedido ${orderNumber}.\n\n` +
        "O pedido está aguardando a confirmação automática do Mercado Pago. Assim que o webhook confirmar, eu sigo para a liberação do acesso."
    };
  }

  private async refreshOrderPaymentFromMercadoPago(order: Record<string, unknown>, webhookEventId: string) {
    if (String(order.status || "") !== "pending_payment") {
      return order;
    }

    const metadata = readOrderMetadata(order);
    const paymentId = readMetadataString(metadata, "mercado_pago_pix_payment_id") || readPixPaymentReference(order);
    if (!paymentId) {
      return order;
    }

    try {
      const payment = await this.mercadoPagoService.getPayment(paymentId);
      await this.auditService.createAuditLog({
        actor_type: "ai_agent",
        action: "mercado_pago_payment_checked_from_whatsapp",
        entity_type: "orders",
        entity_id: String(order.id),
        metadata: { webhookEventId, payment_id: payment.id, provider_status: payment.status }
      });

      if (payment.status !== "approved") {
        return order;
      }

      const valuesMatch = Number(order.amount_cents) === payment.amountCents && String(order.currency || "BRL") === payment.currency;
      if (!valuesMatch) {
        const reviewed = await this.ordersService.transitionStatus(
          String(order.id),
          ["pending_payment", "receipt_under_review", "manual_review"],
          "manual_review",
          { payment_provider: "mercado_pago", payment_reference: payment.id }
        );
        return reviewed || order;
      }

      const paid = await this.ordersService.transitionToPaid(
        String(order.id),
        payment.approvedAt || new Date().toISOString(),
        payment.id
      );
      return paid || { ...order, status: "paid", payment_reference: payment.id };
    } catch (error) {
      await this.auditService.createAuditLog({
        actor_type: "ai_agent",
        action: "mercado_pago_payment_check_failed_from_whatsapp",
        entity_type: "orders",
        entity_id: String(order.id),
        metadata: { webhookEventId, error: error instanceof Error ? error.message : "unknown_error" }
      });
      return order;
    }
  }

  private async releaseActivationCodeForPaidOrder(
    order: Record<string, unknown>,
    input: CommercialReplyInput
  ): Promise<CommercialReplyResult> {
    const orderNumber = String(order.order_number || "seu pedido");
    const existingCodeId = typeof order.code_id === "string" && order.code_id ? order.code_id : null;

    if (String(order.status || "") === "code_reserved" && existingCodeId) {
      return {
        order,
        reply:
          `Pagamento confirmado para o pedido ${orderNumber}.\n\n` +
          "O acesso já está reservado. Se ele não aparecer na conversa, fale com especialista para reenviar com segurança."
      };
    }

    const productId = typeof order.product_id === "string" ? order.product_id : null;
    if (!productId) {
      return {
        order,
        reply:
          `Pagamento confirmado para o pedido ${orderNumber}.\n\n` +
          "Não consegui identificar o produto para separar o código automaticamente. Vou encaminhar para o atendimento finalizar."
      };
    }

    const planId = typeof order.plan_id === "string" ? order.plan_id : null;
    const availableCode = await this.activationCodesService.findAvailableCode(productId, planId);
    if (!availableCode) {
      await this.ordersService.transitionStatus(String(order.id), ["paid", "code_reserved"], "waiting_stock");
      return {
        order,
        requiresHuman: true,
        notifyOwner: true,
        ownerNotificationText:
          "⚠️ Pagamento confirmado sem código disponível.\n\n" +
          `Pedido: ${orderNumber}\n` +
          `Cliente: ${input.customer.id}\n\n` +
          "Cadastre/libere um código válido no banco para o cliente receber o acesso.",
        reply: buildNoAccessCodeAvailableMessage(orderNumber)
      };
    }

    const reservedCode = await this.activationCodesService.reserveCode(String(availableCode.id), String(order.id), input.customer.id);
    if (!reservedCode) {
      return {
        order,
        reply:
          `Pagamento confirmado para o pedido ${orderNumber}.\n\n` +
          "O estoque acabou de ser atualizado por outro atendimento. Vou tentar liberar novamente em instantes."
      };
    }

    await this.ordersService.updateOrder(String(order.id), { code_id: String(reservedCode.id), status: "code_reserved" });
    await this.activationCodesService.markCodeAsSent(String(reservedCode.id));
    const sentOrder = await this.ordersService.updateOrder(String(order.id), { code_id: String(reservedCode.id), status: "code_sent" });

    await this.auditService.createAuditLog({
      actor_type: "ai_agent",
      action: "activation_code_sent_after_payment_confirmation",
      entity_type: "orders",
      entity_id: String(order.id),
      metadata: { webhookEventId: input.webhookEventId, code_id: reservedCode.id }
    });

    const postPurchaseMessages = buildPostPurchaseMessages(String(reservedCode.code));
    return {
      order: sentOrder,
      reply: postPurchaseMessages[0],
      followUpMessages: [postPurchaseMessages[1]]
    };
  }

  private async generatePixPayment(
    input: CommercialReplyInput,
    knowledge: Array<{ category?: string; content?: string }>
  ): Promise<CommercialReplyResult> {
    const leadProfile = readLeadProfile(input.conversation.metadata);
    const promoAccepted = isSpecialPromoAccepted(leadProfile);
    let order = await this.ordersService.findLatestOpenOrderByCustomerId(input.customer.id);
    if (!order) {
      const plans = await this.plansService.listActivePlans();
      const selectedPlan = promoAccepted ? findMonthlyPlan(plans) : findPlanFromLeadProfile(plans, leadProfile);
      if (selectedPlan) {
        const amountCents = promoAccepted ? SPECIAL_PROMO_MONTHLY_PRICE_CENTS : Number(selectedPlan.price_cents);
        order = await this.ordersService.createOrder({
          customer_id: input.customer.id,
          product_id: String(selectedPlan.product_id),
          plan_id: String(selectedPlan.id),
          status: "pending_payment",
          amount_cents: amountCents,
          currency: String(selectedPlan.currency || "BRL"),
          metadata: {
            source: "whatsapp_agent",
            webhookEventId: input.webhookEventId,
            created_from_context: true,
            selected_plan_from_lead_profile: leadProfile.selected_plan || leadProfile.plano_interesse || null,
            ...(promoAccepted
              ? {
                  special_promo_offer: SPECIAL_PROMO_OFFER_ID,
                  special_promo_price_cents: SPECIAL_PROMO_MONTHLY_PRICE_CENTS,
                  original_price_cents: Number(selectedPlan.price_cents)
                }
              : {})
          }
        } as never);
      }
    }
    if (!order) {
      const plans = await this.plansService.listActivePlans();
      const menu = shouldUseMenu(input.message) && plans.length ? buildPlansMenu(plans) : null;
      return {
        reply: "Perfeito. Qual plano você quer ativar: mensal, trimestral ou anual?",
        menu: menu || undefined,
        leadProfilePatch: {
          commercial_stage: "qualified",
          stage: "qualified",
          payment_method: "pix",
          last_customer_intent: "request_pix",
          next_expected_reply: "plan_choice"
        }
      };
    }

    const metadata = readOrderMetadata(order);
    const existingQrCode = readMetadataString(metadata, "mercado_pago_pix_qr_code");
    const existingTicketUrl = readMetadataString(metadata, "mercado_pago_pix_ticket_url");
    const existingQrCodeMatchesPromo = metadata.special_promo_offer === SPECIAL_PROMO_OFFER_ID;
    if (existingQrCode && (!promoAccepted || existingQrCodeMatchesPromo)) {
      return {
        order,
        reply: formatPixReply(order, existingQrCode, existingTicketUrl, promoAccepted),
        copyText: existingQrCode,
        leadProfilePatch: {
          commercial_stage: "awaiting_payment",
          stage: "awaiting_payment",
          payment_method: "pix",
          payment_status: "pending",
          last_customer_intent: "request_pix",
          next_expected_reply: "payment_proof",
          selected_plan: leadProfile.selected_plan || leadProfile.plano_interesse || null,
          plano_interesse: leadProfile.plano_interesse || leadProfile.selected_plan || null
        }
      };
    }

    const plan = readOrderPlan(order);
    if (!order.plan_id) {
      return this.handoffToHuman(
        input,
        "pix_order_plan_missing",
        knowledge,
        "Encontrei seu pedido, mas não consegui identificar o plano para gerar o Pix. Vou encaminhar para atendimento humano."
      );
    }

    try {
      const needsPromoOrderUpdate = promoAccepted &&
        (Number(order.amount_cents) !== SPECIAL_PROMO_MONTHLY_PRICE_CENTS || metadata.special_promo_offer !== SPECIAL_PROMO_OFFER_ID);
      const paymentOrder = needsPromoOrderUpdate
        ? await this.ordersService.updateOrder(String(order.id), {
            amount_cents: SPECIAL_PROMO_MONTHLY_PRICE_CENTS,
            metadata: {
              ...metadata,
              special_promo_offer: SPECIAL_PROMO_OFFER_ID,
              special_promo_price_cents: SPECIAL_PROMO_MONTHLY_PRICE_CENTS,
              original_price_cents: metadata.original_price_cents || Number(order.amount_cents)
            }
          })
        : order;
      const paymentOrderMetadata = readOrderMetadata(paymentOrder);
      const pix = await this.mercadoPagoService.createPixPayment({
        order: {
          id: String(paymentOrder.id),
          order_number: String(paymentOrder.order_number),
          customer_id: String(paymentOrder.customer_id),
          plan_id: String(paymentOrder.plan_id),
          amount_cents: Number(paymentOrder.amount_cents),
          currency: String(paymentOrder.currency || "BRL")
        },
        plan,
        payer: { email: buildMercadoPagoPixEmail(order, input.customer.id) }
      });

      await this.ordersService.updateOrder(String(order.id), {
        payment_provider: "mercado_pago",
        payment_reference: pix.id,
        metadata: {
          ...paymentOrderMetadata,
          mercado_pago_pix_payment_id: pix.id,
          mercado_pago_pix_qr_code: pix.qrCode,
          mercado_pago_pix_ticket_url: pix.ticketUrl,
          mercado_pago_pix_expires_at: pix.expiresAt
        }
      });
      await this.auditService.createAuditLog({
        actor_type: "ai_agent",
        action: "mercado_pago_pix_created",
        entity_type: "orders",
        entity_id: String(order.id),
        metadata: { payment_id: pix.id, webhookEventId: input.webhookEventId }
      });

      return {
        order,
        reply: formatPixReply(paymentOrder, pix.qrCode, pix.ticketUrl, promoAccepted),
        copyText: pix.qrCode,
        leadProfilePatch: {
          commercial_stage: "awaiting_payment",
          stage: "awaiting_payment",
          payment_method: "pix",
          payment_status: "pending",
          last_customer_intent: "request_pix",
          next_expected_reply: "payment_proof",
          selected_plan: leadProfile.selected_plan || leadProfile.plano_interesse || null,
          plano_interesse: leadProfile.plano_interesse || leadProfile.selected_plan || null
        },
        media: {
          base64: pix.qrCodeBase64,
          mimetype: "image/png",
          fileName: `pix-${String(paymentOrder.order_number)}.png`,
          caption: `QR Code Pix do pedido ${String(paymentOrder.order_number)}`
        }
      };
    } catch (error) {
      await this.auditService.createAuditLog({
        actor_type: "ai_agent",
        action: "mercado_pago_pix_creation_failed",
        entity_type: "orders",
        entity_id: String(order.id),
        metadata: {
          webhookEventId: input.webhookEventId,
          error: error instanceof Error ? error.message : "unknown_error"
        }
      });
      return this.handoffToHuman(
        input,
        "mercado_pago_pix_creation_failed",
        knowledge,
        `Seu pedido ${String(order.order_number)} está aberto, mas não consegui gerar o Pix agora. Vou encaminhar para atendimento humano.`
      );
    }
  }

  private async handoffToHuman(
    input: CommercialReplyInput,
    reason: string,
    knowledge: Array<{ category?: string; content?: string }> = [],
    reply = "Vou encaminhar para atendimento humano para te ajudar melhor. Enquanto isso, pode me mandar mais detalhes por aqui."
  ): Promise<CommercialReplyResult> {
    await this.agentActionsService.createAgentAction({
      conversation_id: input.conversation.id,
      customer_id: input.customer.id,
      action_name: "handoff_to_human",
      status: "requested",
      input_payload: { reason, message: input.message, knowledge_categories: knowledge.map((article) => article.category) },
      output_payload: {},
      requires_human_approval: true
    });

    await this.auditService.createAuditLog({
      actor_type: "ai_agent",
      action: "handoff_to_human",
      entity_type: "conversations",
      entity_id: input.conversation.id,
      metadata: { reason, webhookEventId: input.webhookEventId }
    });

    return {
      requiresHuman: true,
      reply
    };
  }
}

function readLeadProfile(metadata: Record<string, unknown> | null | undefined) {
  const profile = metadata?.lead_profile;
  return profile && typeof profile === "object" && !Array.isArray(profile) ? profile as Record<string, unknown> : {};
}

function getContextualCommercialReply(message: string, leadProfile: Record<string, unknown>): CommercialReplyResult | null {
  const normalized = normalizeContextMessage(message);
  const selectedPlan = leadProfile.selected_plan || leadProfile.plano_interesse;
  const lastBotQuestion = normalizeContextMessage(String(leadProfile.last_bot_question || ""));
  const confirmedDownload =
    /\b(ja baixei|baixei|download feito|fiz o download|ja instalei|instalei)\b/.test(normalized) ||
    (/^(sim|s|ja|ok|feito|consegui)$/.test(normalized) && /\b(baixou|download|instalou)\b/.test(lastBotQuestion));

  if (leadProfile.saudacao_enviada === true && /^(oi|ola|olá|bom dia|boa tarde|boa noite|tudo bem)\b/.test(normalized)) {
    return {
      reply: "Oi, estou aqui 👍 Você quer seguir com recarga, ativação ou teste grátis?"
    };
  }

  if (/\b(nao paguei|ainda nao paguei|nao fiz o pagamento|nem paguei|n paguei)\b/.test(normalized)) {
    return {
      reply: "Sem problema. Voc\u00ea quer seguir com o mensal de R$ 25 ou prefere fazer o teste gr\u00e1tis de 3 dias primeiro?"
    };
  }

  if (/\b(e unitv mesmo|eh unitv mesmo|e unitv|eh unitv|esse e o unitv|esse eh o unitv|e o aplicativo mesmo|eh o aplicativo mesmo)\b/.test(normalized)) {
    return {
      reply: "Sim, é UNITV mesmo 👍 Consigo te ajudar com recarga, ativação ou teste grátis."
    };
  }

  if (isFreeTrialContextMessage(normalized, lastBotQuestion)) {
    if (/\b(aparelho|celular android|tv box|android tv|google tv|fire stick|firestick)\b/.test(lastBotQuestion)) {
      return {
        reply: "Perfeito 👍 Só me confirma qual aparelho você vai usar pra eu liberar certinho: celular Android, TV Box, Android TV, Google TV ou Fire Stick?"
      };
    }

    return {
      reply: "Claro 👍 Pra eu liberar seu teste grátis de 3 dias, me diz só em qual aparelho você vai usar: celular Android, TV Box, Android TV, Google TV ou Fire Stick?"
    };
  }

  if (confirmedDownload) {
    return {
      reply:
        "Perfeito. Como voc\u00ea j\u00e1 baixou o app, agora posso te ajudar com a ativa\u00e7\u00e3o. " +
        "Voc\u00ea quer liberar o teste gr\u00e1tis de 3 dias ou j\u00e1 ativar o mensal de R$ 25?"
    };
  }

  if (/\b(ja usei|ja tenho|ja conheco|uso o app|uso unitv)\b/.test(normalized)) {
    return {
      reply: selectedPlan === "mensal"
        ? "\u00d3timo, ent\u00e3o voc\u00ea j\u00e1 conhece o app. Quer seguir com o mensal de R$ 25 agora?"
        : "\u00d3timo, ent\u00e3o voc\u00ea j\u00e1 conhece o app. Voc\u00ea quer renovar o acesso ou ativar um novo plano?"
    };
  }

  if (/^(ativar|ativacao|ativa|liberar)$/i.test(normalized)) {
    return {
      reply: "Claro. Voc\u00ea quer ativar o mensal de R$ 25 ou fazer o teste gr\u00e1tis de 3 dias primeiro?"
    };
  }

  if (/^(mensal|plano mensal)$/i.test(normalized)) {
    return {
      reply: "Perfeito, o mensal fica R$ 25. Voc\u00ea prefere pagar por Pix ou cart\u00e3o?"
    };
  }

  return null;
}

function isFreeTrialContextMessage(normalized: string, lastBotQuestion: string) {
  const shortContextAnswer = /^(pode ser|pode|quero|sim|ok|isso)$/.test(normalized) &&
    /\b(teste|gratis|gratuito|3 dias|aparelho|celular android|tv box|android tv|google tv|fire stick|firestick)\b/.test(lastBotQuestion);

  return (
    /\b(quero|queria|libera|liberar|fazer|pegar|testar|teste)\b.*\b(teste|gratis|gratuito|3 dias)\b/.test(normalized) ||
    /\b(quero testar|quero logo um teste|libera o teste|teste gratis|teste gratuito)\b/.test(normalized) ||
    shortContextAnswer
  );
}

function normalizeContextMessage(message: string) {
  return message
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function shouldUseStrongSalesModel(
  message: string,
  leadProfile: Record<string, unknown>,
  recentMessages: Array<{ role?: string; content?: string | null }> | undefined
) {
  const normalized = normalizeContextMessage(message);
  return (
    /\b(pagar|pagamento|paguei|comprovante|irritado|reclamacao|reclamação)\b/.test(normalized) ||
    leadProfile.nivel_interesse === "quente" ||
    (recentMessages || []).some((item) => item.role === "human_agent")
  );
}

function formatMoney(priceCents: number, currency = "BRL") {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency
  }).format(priceCents / 100);
}

function formatPlan(plan: { name: string; price_cents: number; currency?: string; duration_days?: number | null }) {
  const duration = plan.duration_days ? ` (${plan.duration_days} dias)` : "";
  const price = Number(plan.price_cents) > 0 ? formatMoney(plan.price_cents, plan.currency) : "grátis";
  return `- ${plan.name}${duration}: ${price}`;
}

function isFreeTrialMessage(message: string) {
  return /\b(teste|gratis|gratuito|free trial)\b/i.test(message);
}

function isRenewalLeadMessage(message: string) {
  const normalized = message
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return /\b(recarga|renovar|renovacao|codigo unitv)\b/.test(normalized) && !/\b(mensal|3 meses|6 meses|anual|trimestral|semestral)\b/.test(normalized);
}

function isPixPaymentMessage(message: string) {
  return /\b(pix|chave pix|copia e cola|qr code)\b/i.test(message);
}

function isPaymentDoneMessage(message: string) {
  const normalized = message
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return (
    /^(feito|paguei|pago|ja paguei|ja fiz|ja fiz o pagamento|feito o pagamento|pagamento feito|fiz o pagamento|acabei de pagar)$/i.test(normalized) ||
    /\b(ja|acabei de|terminei de|conclui|fiz|realizei)\b.*\b(paguei|pagar|pagamento|pix)\b/i.test(normalized) ||
    /\b(pagamento|pix)\b.*\b(feito|pago|realizado|concluido|enviado)\b/i.test(normalized)
  );
}

function isInstallationMessage(message: string) {
  return isUnitvInstallationRequest(message);
}

function getInstallationReply(message: string): CommercialReplyResult | null {
  const normalized = message
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (/\b(suporte|atendente|humano|especialista)\b/.test(normalized) && /\b(instalacao|instalar|apk|download)\b/.test(normalized)) {
    return {
      requiresHuman: true,
      reply:
        "Claro ✅\n\n" +
        "Vou te encaminhar para o suporte.\n\n" +
        "Para agilizar, me envie:\n\n" +
        "1️⃣ Seu nome\n" +
        "2️⃣ Qual aparelho você está usando\n" +
        "3️⃣ Em qual etapa você travou"
    };
  }
  const guidance = getUnitvInstallationGuidance(message);
  return guidance ? { reply: guidance.reply, leadProfilePatch: guidance.leadProfilePatch } : null;
}

function shouldUseMenu(message: string) {
  if (isWhatsAppMainMenuEnabled()) {
    return true;
  }

  const normalized = message
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return /\b(menu|opcoes|opcao|lista de opcoes|me manda as opcoes|manda menu|quais opcoes)\b/.test(normalized);
}

function ensureQuestionForContext(reply: string, intent: IntentClassification["intent"]) {
  const trimmed = reply.trim();
  if (!trimmed || trimmed.includes("?") || isFinalNonInteractiveReply(trimmed)) {
    return trimmed;
  }

  const questions: Partial<Record<IntentClassification["intent"], string>> = {
    greeting: "Você quer ver os valores, fazer o teste grátis ou precisa de ajuda para instalar?",
    ask_price: "Você quer começar pelo mensal ou prefere o melhor custo-benefício?",
    buy_plan: "Qual plano você quer ativar?",
    renew_plan: "Você quer renovar um acesso que já tem ou ativar um novo plano?",
    free_trial: "Você vai usar em TV Box Android, Android TV, Fire Stick ou celular Android?",
    technical_support: "Você vai instalar em TV Box Android, Android TV, Fire Stick ou celular Android?",
    pix_payment: "Qual plano você quer ativar?",
    receipt_sent: "Pode me enviar o comprovante por aqui?",
    support: "Qual aparelho você está usando?",
    human_help: "Pode me mandar mais detalhes por aqui?"
  };

  const question = questions[intent] || "Você quer ajuda com valores, teste grátis ou instalação?";
  return `${trimmed}\n\n${question}`;
}

function isFinalNonInteractiveReply(reply: string) {
  const normalized = reply
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return (
    /\b(seu codigo de acesso|codigo de acesso|comunidade oficial|pagamento confirmado|agradecemos pela sua compra)\b/.test(normalized) ||
    /\b(aviso|alerta|administrador|cadastre\/libere|sem codigo disponivel)\b/.test(normalized)
  );
}

function getObjectionKnowledgeCategory(message: string) {
  if (/\b(caro|cara|desconto|promo[cç][aã]o)\b/i.test(message)) {
    return "objecao_preco";
  }
  if (/\b(mais barato|vi barato|concorrente)\b/i.test(message)) {
    return "objecao_concorrencia";
  }
  if (/\b(vou pensar|quero pensar|depois eu vejo|decidir depois)\b/i.test(message)) {
    return "objecao_indecisao";
  }
  if (/\b(funciona mesmo|trava|travar|travamento|cai muito)\b/i.test(message)) {
    return "objecao_estabilidade";
  }
  return null;
}

function getSalesObjectionReply(message: string): { reply: string; menu?: WhatsAppMenu } | null {
  const normalized = message
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (/\b(quantas telas|2 telas|duas telas|telas?)\b/.test(normalized)) {
    return {
      reply:
        "Depende do tipo de acesso e da configuração.\n\n" +
        "Para eu te orientar certo, você quer usar em quantos aparelhos e quais seriam eles?\n\n" +
        "Não quero te passar informação errada sobre telas.",
      menu: CONTINUATION_MENU
    };
  }

  if (/\b(qual valor|valor|preco|preço|quanto custa|planos?)\b/.test(normalized)) {
    return {
      reply:
        "O mensal fica R$ 25.\n\n" +
        "Também temos:\n" +
        PLANS_TEXT +
        "\n\nO mensal é uma boa opção para começar. Se você quiser economizar mais, o anual sai melhor no custo-benefício.\n\n" +
        "Você quer começar pelo mensal ou prefere um plano maior?"
    };
  }

  if (/\b(caro|ta caro|tá caro)\b/.test(normalized)) {
    return {
      reply:
        "Entendo.\n\n" +
        "O mensal fica R$ 25, que é o valor mais baixo para começar.\n\n" +
        "Agora, se você pensa em usar por mais tempo, os planos maiores compensam mais:\n" +
        "3 meses — R$ 70\n" +
        "6 meses — R$ 120\n" +
        "Anual — R$ 200\n\n" +
        "Você quer começar com o mensal para testar ou prefere economizar no plano maior?"
    };
  }

  if (/\b(desconto|promo[cç]ao|promoção)\b/.test(normalized)) {
    return {
      reply:
        "Os valores atuais já estão fechados:\n\n" +
        PLANS_TEXT +
        "\n\nO desconto real fica nos planos maiores, principalmente no anual.\n\nQuer que eu te passe o melhor custo-benefício?"
    };
  }

  if (/\b(mais barato|vi barato|concorrente)\b/.test(normalized)) {
    return {
      reply:
        "Entendo.\n\n" +
        "A diferença aqui é que você tem suporte para instalação, orientação na ativação e atendimento caso precise de ajuda.\n\n" +
        "Se quiser começar sem compromisso alto, o mensal é R$ 25.\n\nQuer começar pelo mensal ou fazer o teste grátis primeiro?"
    };
  }

  if (/\b(funciona mesmo|funciona|e bom|é bom)\b/.test(normalized)) {
    return {
      reply:
        "Funciona em aparelhos compatíveis, sim.\n\n" +
        "A qualidade depende também da internet e do aparelho, mas a UNITV tem suporte para te ajudar na instalação.\n\n" +
        "Você quer testar grátis por 3 dias antes de contratar?",
      menu: CONTINUATION_MENU
    };
  }

  if (/\b(trava|travar|travando|travamento|cai muito)\b/.test(normalized)) {
    return {
      reply:
        "Boa pergunta.\n\n" +
        "Travamento normalmente depende da internet, do aparelho ou da instalação. Por isso eu te oriento certinho.\n\n" +
        "O ideal é você fazer o teste grátis de 3 dias no seu aparelho e ver como fica.\n\nVocê vai usar na TV ou no celular?",
      menu: CONTINUATION_MENU
    };
  }

  if (/\b(futebol|jogo|canais?)\b/.test(normalized)) {
    return {
      reply:
        "A UNITV reúne canais ao vivo, filmes e séries no app.\n\n" +
        "A disponibilidade pode variar, mas você pode testar grátis por 3 dias e conferir no seu aparelho.\n\nQuer fazer o teste?",
      menu: CONTINUATION_MENU
    };
  }

  if (/\b(filmes|series|séries)\b/.test(normalized)) {
    return {
      reply:
        "Tem sim. A UNITV reúne filmes, séries e canais ao vivo no mesmo app.\n\nVocê quer testar grátis ou já quer ver os planos?",
      menu: CONTINUATION_MENU
    };
  }

  if (/\b(iphone|ios)\b/.test(normalized)) {
    return {
      reply:
        "No iPhone eu não tenho instalação Android para enviar.\n\nVocê teria uma TV Box, Android TV, Fire Stick ou celular Android para usar?",
      menu: CONTINUATION_MENU
    };
  }

  if (/\b(golpe|confiavel|confiável|medo)\b/.test(normalized)) {
    return {
      reply:
        "Entendo totalmente.\n\n" +
        "Por isso o atendimento é feito por aqui, com suporte, orientação de instalação e ativação após confirmação.\n\n" +
        "Se preferir, você pode começar pelo teste grátis de 3 dias antes de contratar.",
      menu: CONTINUATION_MENU
    };
  }

  if (/\b(vou pensar|depois eu vejo|pensar)\b/.test(normalized)) {
    return {
      reply:
        "Sem problema.\n\nPara facilitar, os planos são:\n\n" +
        PLANS_TEXT +
        "\n\nVocê também pode testar grátis por 3 dias antes de decidir.",
      menu: CONTINUATION_MENU
    };
  }

  return null;
}

function getSupportKnowledgeCategory(message: string) {
  if (/\b(video|vídeo|tutorial)\b/i.test(message)) {
    return "tutorial";
  }

  if (/\b(codigo|código)\b/i.test(message) && /\b(downloader|instalacao|instalação)\b/i.test(message)) {
    return "codigo_instalacao";
  }

  if (/\b(instalar|instalacao|instalação|downloader)\b/i.test(message)) {
    return "instalacao";
  }

  return "technical_support";
}

function readOrderMetadata(order: Record<string, unknown> | null) {
  if (!order?.metadata || typeof order.metadata !== "object" || Array.isArray(order.metadata)) {
    return {};
  }

  return order.metadata as Record<string, unknown>;
}

function readOrderCheckoutUrl(order: Record<string, unknown> | null) {
  const checkoutUrl = readOrderMetadata(order).mercado_pago_checkout_url;
  return typeof checkoutUrl === "string" && checkoutUrl ? checkoutUrl : undefined;
}

function readPixPaymentReference(order: Record<string, unknown>) {
  const reference = order.payment_reference;
  if (typeof reference !== "string" || !/^\d+$/.test(reference)) {
    return null;
  }

  return reference;
}

function readMetadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" && value ? value : null;
}

function readOrderPlan(order: Record<string, unknown>) {
  const plan = order.plans;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    const orderNumber = typeof order.order_number === "string" && order.order_number.trim()
      ? order.order_number.trim()
      : "Pedido UNiTV";
    return { name: orderNumber, slug: "unitv" };
  }

  const name = (plan as { name?: unknown }).name;
  const slug = (plan as { slug?: unknown }).slug;
  if (typeof name === "string" && name && typeof slug === "string" && slug) {
    return { name, slug };
  }

  return { name: "Plano UNiTV", slug: "unitv" };
}

function formatPixReply(order: Record<string, unknown>, _qrCode: string, _ticketUrl: string | null, promoAccepted = false) {
  if (promoAccepted) {
    return [
      "Perfeito ✅",
      "Vou te passar a chave PIX agora.",
      "Assim que fizer o pagamento, me manda o comprovante por aqui que eu já libero seu acesso.",
      "Condição especial aplicada: R$ 19,99 nos 2 primeiros meses.",
      `PIX do pedido ${String(order.order_number)}`,
      "Vou enviar o Pix Copia e Cola na próxima mensagem para facilitar a cópia.",
      "Toque e segure na próxima mensagem e escolha copiar.",
      "A confirmação é automática pelo Mercado Pago. Não precisa enviar comprovante."
    ].join("\n\n");
  }

  return [
    `PIX do pedido ${String(order.order_number)}`,
    "Vou enviar o Pix Copia e Cola na próxima mensagem para facilitar a cópia.",
    "Toque e segure na próxima mensagem e escolha copiar.",
    "A confirmação é automática pelo Mercado Pago. Não precisa enviar comprovante."
  ].join("\n\n");
}

function formatCardReply(checkoutUrl: string) {
  return `PAGUE COM CARTÃO AQUI ABAIXO\n${checkoutUrl}`;
}

function buildMercadoPagoPixEmail(order: Record<string, unknown>, customerId: string) {
  const reference = String(order.order_number || order.id || customerId).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `pix-${reference}@unitv.com.br`;
}

function isSpecialPromoAccepted(leadProfile: Record<string, unknown>) {
  return leadProfile.accepted_special_promo === true && leadProfile.special_promo_offer === SPECIAL_PROMO_OFFER_ID;
}

function findMonthlyPlan(plans: Array<Record<string, unknown>>) {
  return plans.find((plan) => {
    const slug = String(plan.slug || "").toLowerCase();
    const name = String(plan.name || "").toLowerCase();
    return slug.includes("mensal") || name.includes("mensal") || Number(plan.duration_days) === 30;
  }) || null;
}

function findPlanFromLeadProfile(plans: Array<Record<string, unknown>>, leadProfile: Record<string, unknown>) {
  const selectedPlan = normalizePlanKey(String(leadProfile.selected_plan || leadProfile.plano_interesse || ""));
  if (!selectedPlan) {
    return null;
  }

  return plans.find((plan) => {
    const slug = normalizePlanKey(String(plan.slug || ""));
    const name = normalizePlanKey(String(plan.name || ""));
    const durationDays = Number(plan.duration_days || 0);

    if (selectedPlan === "mensal") {
      return slug.includes("mensal") || name.includes("mensal") || durationDays === 30;
    }
    if (selectedPlan === "3_meses" || selectedPlan === "trimestral") {
      return slug.includes("3") || name.includes("3_meses") || name.includes("trimestral") || durationDays === 90;
    }
    if (selectedPlan === "6_meses" || selectedPlan === "semestral") {
      return slug.includes("6") || name.includes("6_meses") || name.includes("semestral") || durationDays === 180;
    }
    if (selectedPlan === "anual") {
      return slug.includes("anual") || name.includes("anual") || durationDays === 365;
    }

    return slug === selectedPlan || name === selectedPlan;
  }) || null;
}

function normalizePlanKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_");
}
