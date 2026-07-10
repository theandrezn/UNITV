import "server-only";
import type { IntentClassification } from "./intent-classifier.service";
import type { ContextualDecision } from "./contextual-intelligence.service";
import type { ConversationBrainDecision } from "./conversation-brain.service";
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
import { getPlanCodeAllocation } from "@/lib/activation-codes/plan-code-allocation";
import { validateResponseAgainstLeadProfile } from "@/lib/whatsapp/customer-message-safety";

export const INITIAL_UNITV_REPLY =
  "Oi, tudo bem? Você já usa o aplicativo UNITV ou seria sua primeira vez?";

const LOW_CONFIDENCE_REPLY =
  "Claro, eu te ajudo.\n\nMe confirma uma coisa: você quer comprar um plano, renovar um acesso ou precisa de ajuda com instalação?";

const PLANS_TEXT = ["Mensal — R$ 25", "3 meses — R$ 70", "6 meses — R$ 120", "Anual — R$ 200"].join("\n");
const PAYMENT_TEXT = "Você prefere pagar com Pix ou cartão?";
const PLAN_PREFERENCE_QUESTION = "Boa. Voce tem preferencia por qual plano: mensal, trimestral, semestral ou anual?";
const MONTHLY_INTEREST_QUESTION = "Voce teria interesse no mensal mesmo?";
const MONTHLY_OFFER_QUESTION = "Voce teria interesse em seguir hoje?";
const BROAD_PRICE_QUALIFICATION_QUESTION =
  "Claro, te explico sim.\n\n" +
  "Voce tem interesse em algum plano especifico: mensal, trimestral, semestral ou anual?\n\n" +
  "E seria para usar em quantas telas?";
const CURRENT_RECHARGE_PRICE_QUESTION = "Voce ja faz a recarga? Se sim, faz a quanto?";
const TRAFFIC_RECHARGE_WELCOME =
  "Ol\u00e1! Seja bem-vindo ao melhor aplicativo de filmes e canais \u{1F9E1}. Meu nome \u00e9 Andr\u00e9.\n\n" +
  "Voce ja faz o uso do app? Ou e a primeira vez?";
const RENEWAL_CONTEXT_QUESTION = "Perfeito. Voce ja usa o UNITV e quer so renovar o codigo, ou seria sua primeira vez usando?";
const FIRST_TIME_ACTIVATION_QUESTION =
  "Perfeito, entao e sua primeira vez. Voce prefere fazer o teste gratis de 3 dias primeiro ou quer ver os planos?";
const FIRST_TIME_CLARIFICATION_QUESTION =
  "Sem problema. Como e sua primeira vez, posso te orientar pelo teste gratis de 3 dias ou te mostrar os planos. Voce prefere comecar pelo teste?";
const FIRST_TIME_ASK_DEVICE_FOR_TEST_REPLY =
  "Entendi, entao seria sua primeira vez usando o UNITV. Qual aparelho voce quer baixar para fazer seu teste de 3 dias? Pode ser celular Android, TV Box, Android TV/Google TV ou Fire Stick.";
const ASK_DEVICE_AGAIN_WITH_OPTIONS_REPLY =
  "Sem problema. Voce quer testar em qual aparelho? Celular Android, TV Box, Android TV/Google TV ou Fire Stick?";
const CONTEXTUAL_TRIAL_DEVICE_REPLY =
  "Perfeito! Como e sua primeira vez, voce consegue fazer o teste gratis de 3 dias sim.\n\n" +
  "Me fala so qual aparelho voce vai usar: celular Android, TV Box, Android TV/Google TV ou Fire Stick?";
const ANDROID_PHONE_CONFIRMATION_REPLY = "So me confirma: esse celular e Android?";
const DOWNLOAD_PROBLEM_CONTEXT_REPLY = "Tudo bem, me fala onde travou: no link, no Downloader ou na instalacao?";

const SPECIAL_PROMO_OFFER_ID = "mensal_19_99_first_2_months";
const SPECIAL_PROMO_MONTHLY_PRICE_CENTS = 1999;

type CommercialReplyInput = {
  message: string;
  classification: IntentClassification;
  customer: { id: string; email?: string | null };
  conversation: { id: string; metadata?: Record<string, unknown> | null };
  webhookEventId: string;
  recentMessages?: Array<{ role?: string; content?: string | null }>;
  contextualDecision?: ContextualDecision | null;
  conversationBrainDecision?: ConversationBrainDecision | null;
  specialistExamples?: Array<{
    customer_last_message?: string | null;
    bot_previous_message?: string | null;
    specialist_message?: string | null;
  }>;
  learningMemories?: Array<{
    intent?: string | null;
    stage?: string | null;
    rule?: string | null;
    style_directive?: string | null;
    avoid?: string[] | null;
    confidence?: number | null;
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

    const conversationBrainDecision = input.conversationBrainDecision;
    if (conversationBrainDecision && !conversationBrainDecision.shouldReply) {
      return {
        reply: "",
        responseSource: "local_rule",
        responseRule: conversationBrainDecision.responseRule,
        leadProfilePatch: conversationBrainDecision.leadProfilePatch
      };
    }
    if (conversationBrainDecision?.directReply) {
      return {
        reply: conversationBrainDecision.directReply,
        responseSource: "local_rule",
        responseRule: conversationBrainDecision.responseRule,
        leadProfilePatch: conversationBrainDecision.leadProfilePatch
      };
    }

    const knowledge = await this.knowledgeService.searchKnowledge(message);
    const intent = input.classification.intent === "support" ? "technical_support" : input.classification.intent;
    const allowMenu = shouldUseMenu(message);
    const leadProfile = readLeadProfile(input.conversation.metadata);

    if (isTrafficRechargeOpener(message) && conversationBrainDecision?.allowInitialGreeting !== false) {
      return buildTrafficRechargeWelcomeReply();
    }

    const conversationIntelligence = buildConversationIntelligenceLayer({
      message,
      intent,
      leadProfile,
      recentMessages: input.recentMessages,
      confidence: input.classification.confidence
    });
    const activeDownloadReply = getActiveDownloadFlowReply(message, conversationIntelligence);
    if (activeDownloadReply) {
      return {
        ...activeDownloadReply,
        responseSource: "local_rule",
        responseRule: "active_download_flow"
      };
    }

    const contextualUnderstandingReply = buildContextualUnderstandingReply(input.contextualDecision, conversationIntelligence);
    if (contextualUnderstandingReply) {
      return {
        ...contextualUnderstandingReply,
        responseSource: "local_rule"
      };
    }

    const expectedDeviceReply = getExpectedDeviceAnswerReply(message, conversationIntelligence);
    if (expectedDeviceReply) {
      return {
        ...expectedDeviceReply,
        responseSource: "local_rule",
        responseRule: "expected_device_answer"
      };
    }

    const contextualReply = getContextualCommercialReply(message, leadProfile);
    const contextualAiReply = await this.generateContextualCommercialAIReply(input, message, intent, leadProfile, contextualReply?.reply || null);
    if (contextualAiReply) {
      return contextualAiReply;
    }

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

    if (isPaymentDoneMessage(message)) {
      return this.checkPaymentAfterCustomerConfirmation(input);
    }

    if (intent === "pix_payment" || isPixPaymentMessage(message)) {
      return this.generatePixPayment(input, knowledge);
    }

    if (intent === "card_payment") {
      return this.generateCardPayment(input, knowledge);
    }

    if (shouldUseAIResponse({
      message,
      intent,
      leadProfile,
      recentMessages: input.recentMessages,
      specialistExamplesCount: input.specialistExamples?.length || 0,
      learningMemoriesCount: input.learningMemories?.length || 0
    })) {
      const aiReply = await this.salesResponseAIService.generateResponse({
        message,
        intent,
        leadProfile,
        recentMessages: input.recentMessages,
        specialistExamples: input.specialistExamples,
        learningMemories: input.learningMemories,
        fallbackReply: contextualReply?.reply || null,
        conversationId: input.conversation.id,
        useStrongModel: false
      });
      if (aiReply) {
        if (isSafeAICommercialReply(aiReply, leadProfile, input.recentMessages)) {
          return { reply: aiReply, responseSource: "ai", responseRule: "sales_response_ai" };
        }
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

    const humanHandoffGuard = shouldBlockHumanHandoff(conversationIntelligence);
    const blockHumanHandoff = conversationBrainDecision?.allowHumanHandoff === false || humanHandoffGuard.block;
    if (input.classification.confidence < 0.45 && (conversationIntelligence.risk === "low" || blockHumanHandoff)) {
      return {
        reply: buildLowRiskRecoveryReply(conversationIntelligence),
        responseSource: "local_rule",
        responseRule: blockHumanHandoff
          ? "blocked_low_risk_handoff_awaiting_customer"
          : "conversation_intelligence_low_risk_recovery",
        leadProfilePatch: {
          ...buildLowRiskRecoveryPatch(conversationIntelligence),
          ...(blockHumanHandoff ? {
            handoff_blocked_reason: conversationBrainDecision?.allowHumanHandoff === false
              ? "conversation_brain_active_context"
              : humanHandoffGuard.reason
          } : {})
        }
      };
    }

    if (input.classification.confidence < 0.45) {
      return this.handoffToHuman(input, "low_confidence", knowledge);
    }

    if (intent === "human_help" && conversationBrainDecision?.allowHumanHandoff !== false) {
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
      if (isActiveInstallationSupportContext(leadProfile, input.recentMessages)) {
        return this.generateContextualInstallTrialReply(input, message, intent, leadProfile);
      }

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
      const { plan } = await this.plansService.findPlanMentionedInText(message);
      if (plan && !isAllPricesRequested(message)) {
        if (getCommercialPlanLabel(plan) === "mensal") {
          return {
            reply: buildMonthlyPriceComparisonReply(leadProfile),
            leadProfilePatch: {
              selected_plan: "mensal",
              plano_interesse: "mensal",
              commercial_stage: "monthly_offer_pending",
              stage: "monthly_offer_pending",
              last_customer_intent: "ask_monthly_price",
              next_expected_reply: "monthly_offer_interest",
              last_bot_question: MONTHLY_OFFER_QUESTION
            }
          };
        }
        return {
          reply: formatSpecificPlanPriceReply(plan, intent),
          leadProfilePatch: {
            selected_plan: normalizePlanKey(String(plan.slug || plan.name || "")),
            plano_interesse: normalizePlanKey(String(plan.slug || plan.name || "")),
            commercial_stage: "plan_selected",
            stage: "plan_selected",
            last_customer_intent: "specific_plan_selected",
            next_expected_reply: "payment_method"
          }
        };
      }
      if (!isAllPricesRequested(message)) {
        return {
          reply: BROAD_PRICE_QUALIFICATION_QUESTION,
          leadProfilePatch: {
            commercial_stage: "qualified",
            stage: "qualified",
            last_customer_intent: "ask_price",
            next_expected_reply: "plan_choice",
            last_bot_question: BROAD_PRICE_QUALIFICATION_QUESTION
          }
        };
      }
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

    if (intent === "ask_payment") {
      return {
        reply: "Claro. Você pode pagar com Pix ou cartão pelo Mercado Pago.\n\nSe já escolheu o plano, me diga qual é para eu gerar o pagamento certinho.",
        menu: allowMenu ? PAYMENT_MENU : undefined,
        sendTextBeforeMenu: allowMenu
      };
    }

    if (intent === "receipt_sent") {
      return {
        reply: "Recebi. Vou verificar com segurança e aguardar a confirmação real do pagamento antes de liberar qualquer acesso.",
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
        const preferenceMenu = allowMenu && plans.length ? buildPlansMenu(plans) : null;
        if (intent === "renew_plan" && isTrafficRechargeOpener(message)) {
          return buildTrafficRechargeWelcomeReply();
        }
        if (intent === "renew_plan" && isRenewalLeadMessage(message)) {
          return {
            reply: RENEWAL_CONTEXT_QUESTION,
            menu: preferenceMenu || undefined,
            sendTextBeforeMenu: Boolean(preferenceMenu),
            leadProfilePatch: {
              commercial_stage: "qualified",
              stage: "qualified",
              wants_recharge: true,
              last_customer_intent: "renew",
              next_expected_reply: "activation_or_renewal"
            }
          };
        }

        return {
          reply: PLAN_PREFERENCE_QUESTION,
          menu: preferenceMenu || undefined,
          sendTextBeforeMenu: Boolean(preferenceMenu),
          leadProfilePatch: {
            commercial_stage: "qualified",
            stage: "qualified",
            last_customer_intent: "plan_preference_question",
            next_expected_reply: "plan_choice"
          }
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
          reply: "Encontrei esse plano, mas o valor ainda precisa ser confirmado no cadastro. Vou encaminhar para atendimento humano finalizar seu pedido com seguranca."
        };
      }

      if (getCommercialPlanLabel(plan) === "mensal") {
        return {
          reply: buildMonthlyPriceComparisonReply(leadProfile),
          leadProfilePatch: {
            selected_plan: "mensal",
            plano_interesse: "mensal",
            commercial_stage: "monthly_offer_pending",
            stage: "monthly_offer_pending",
            last_customer_intent: "ask_monthly_price",
            next_expected_reply: "monthly_offer_interest",
            last_bot_question: MONTHLY_OFFER_QUESTION
          }
        };
      }

      return {
        reply: formatSpecificPlanPriceReply(plan, intent),
        leadProfilePatch: {
          selected_plan: normalizePlanKey(String(plan.slug || plan.name || "")),
          plano_interesse: normalizePlanKey(String(plan.slug || plan.name || "")),
          commercial_stage: "plan_selected",
          stage: "plan_selected",
          last_customer_intent: "specific_plan_selected",
          next_expected_reply: "payment_method"
        }
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
      return {
        reply: buildLowRiskRecoveryReply(conversationIntelligence),
        menu: allowMenu ? MAIN_MENU : undefined,
        sendTextBeforeMenu: allowMenu,
        responseSource: "local_rule",
        responseRule: "conversation_intelligence_greeting",
        leadProfilePatch: buildLowRiskRecoveryPatch(conversationIntelligence)
      };
    }

    return { reply: this.generateReply(input) };
  }

  private async generateContextualCommercialAIReply(
    input: CommercialReplyInput,
    message: string,
    intent: string,
    leadProfile: Record<string, unknown>,
    fallbackReply: string | null
  ): Promise<CommercialReplyResult | null> {
    if (isSensitiveExecutionIntent(intent)) {
      return null;
    }

    if (!shouldUseAIResponse({
      message,
      intent,
      leadProfile,
      recentMessages: input.recentMessages,
      specialistExamplesCount: input.specialistExamples?.length || 0,
      learningMemoriesCount: input.learningMemories?.length || 0
    })) {
      return null;
    }

    const aiReply = await this.salesResponseAIService.generateResponse({
      message,
      intent,
      leadProfile,
      recentMessages: input.recentMessages,
      specialistExamples: input.specialistExamples,
      learningMemories: input.learningMemories,
      fallbackReply,
      conversationId: input.conversation.id,
      useStrongModel: false
    });

    if (!aiReply || !isSafeAICommercialReply(aiReply, leadProfile, input.recentMessages)) {
      return null;
    }

    return { reply: aiReply, responseSource: "ai", responseRule: "sales_response_ai_contextual_first" };
  }

  private async generateCardPayment(
    input: CommercialReplyInput,
    knowledge: Array<{ category?: string; content?: string }>
  ): Promise<CommercialReplyResult> {
    const leadProfile = readLeadProfile(input.conversation.metadata);
    const metaAttribution = buildMetaAttributionOrderMetadata(input.conversation.metadata);
    const promoAccepted = isSpecialPromoAccepted(leadProfile);
    let order = await this.ordersService.findLatestOpenOrderByCustomerId(input.customer.id);
    let planForPayment: { name: string; slug: string } | null = null;
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
            payment_method_requested: "card",
            ...metaAttribution,
            ...(promoAccepted
              ? {
                  special_promo_offer: SPECIAL_PROMO_OFFER_ID,
                  special_promo_price_cents: SPECIAL_PROMO_MONTHLY_PRICE_CENTS,
                  original_price_cents: Number(selectedPlan.price_cents)
                }
              : {})
          }
        } as never);
        planForPayment = { name: String(selectedPlan.name), slug: String(selectedPlan.slug) };
      }
    }

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
    const existingCheckoutMatchesPromo = metadata.special_promo_offer === SPECIAL_PROMO_OFFER_ID;
    if (checkoutUrl && (!promoAccepted || existingCheckoutMatchesPromo)) {
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
      const needsPromoOrderUpdate = promoAccepted &&
        (Number(order.amount_cents) !== SPECIAL_PROMO_MONTHLY_PRICE_CENTS || metadata.special_promo_offer !== SPECIAL_PROMO_OFFER_ID);
      const paymentOrder = needsPromoOrderUpdate
        ? await this.ordersService.updateOrder(String(order.id), {
            amount_cents: SPECIAL_PROMO_MONTHLY_PRICE_CENTS,
            metadata: {
              ...metadata,
              ...metaAttribution,
              special_promo_offer: SPECIAL_PROMO_OFFER_ID,
              special_promo_price_cents: SPECIAL_PROMO_MONTHLY_PRICE_CENTS,
              original_price_cents: metadata.original_price_cents || Number(order.amount_cents)
            }
          })
        : order;
      const paymentOrderMetadata = readOrderMetadata(paymentOrder);
      const preference = await this.mercadoPagoService.createOrderPreference({
        order: {
          id: String(paymentOrder.id),
          order_number: String(paymentOrder.order_number),
          customer_id: String(paymentOrder.customer_id),
          plan_id: String(paymentOrder.plan_id),
          amount_cents: Number(paymentOrder.amount_cents),
          currency: String(paymentOrder.currency || "BRL")
        },
        plan: planForPayment || readOrderPlan(paymentOrder)
      });

      await this.ordersService.updateOrder(String(paymentOrder.id), {
        payment_provider: "mercado_pago",
        payment_reference: preference.id,
        metadata: {
          ...paymentOrderMetadata,
          ...metaAttribution,
          mercado_pago_preference_id: preference.id,
          mercado_pago_checkout_url: preference.checkoutUrl
        }
      });

      return {
        order: paymentOrder,
        reply: formatCardReply(preference.checkoutUrl),
        leadProfilePatch: {
          commercial_stage: "awaiting_payment",
          stage: "awaiting_payment",
          payment_method: "card",
          payment_status: "pending",
          last_customer_intent: "request_card_payment",
          next_expected_reply: "payment_proof",
          selected_plan: leadProfile.selected_plan || leadProfile.plano_interesse || null,
          plano_interesse: leadProfile.plano_interesse || leadProfile.selected_plan || null
        }
      };
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

    const allocation = getPlanCodeAllocation(order);
    if (!allocation.supported) {
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

    const planId = typeof order.plan_id === "string" ? order.plan_id : null;
    const availableCodes = await this.activationCodesService.findAvailableCodes(productId, planId, allocation.codeCount);
    if (availableCodes.length < allocation.codeCount) {
      await this.ordersService.transitionStatus(String(order.id), ["paid", "code_reserved"], "waiting_stock");
      return {
        order,
        requiresHuman: true,
        notifyOwner: true,
        ownerNotificationText:
          "âš ï¸ Pagamento confirmado sem cÃ³digo disponÃ­vel.\n\n" +
          `Pedido: ${orderNumber}\n` +
          `Cliente: ${input.customer.id}\n\n` +
          `Esse plano precisa de ${allocation.codeCount} codigo(s) mensal(is), mas nao ha estoque suficiente.`,
        reply: buildNoAccessCodeAvailableMessage(orderNumber)
      };
    }

    const reservedCodes: Array<Record<string, unknown>> = [];
    for (const availableCode of availableCodes) {
      const reservedCode = await this.activationCodesService.reserveCode(String(availableCode.id), String(order.id), input.customer.id);
      if (!reservedCode) {
        await this.activationCodesService.releaseReservedCodesForOrder(String(order.id), reservedCodes.map((code) => String(code.id)));
        return {
          order,
          reply:
            `Pagamento confirmado para o pedido ${orderNumber}.\n\n` +
            "O estoque acabou de ser atualizado por outro atendimento. Vou tentar liberar novamente em instantes."
        };
      }
      reservedCodes.push(reservedCode);
    }

    const codeIds = reservedCodes.map((code) => String(code.id));
    if (!codeIds.length) {
      return {
        order,
        reply:
          `Pagamento confirmado para o pedido ${orderNumber}.\n\n` +
          "O estoque acabou de ser atualizado por outro atendimento. Vou tentar liberar novamente em instantes."
      };
    }

    await this.ordersService.updateOrder(String(order.id), { code_id: codeIds[0], status: "code_reserved" });
    for (const reservedCode of reservedCodes) {
      await this.activationCodesService.markCodeAsSent(String(reservedCode.id));
    }
    const sentOrder = await this.ordersService.updateOrder(String(order.id), {
      code_id: codeIds[0],
      status: "code_sent",
      metadata: {
        ...(isRecord(order.metadata) ? order.metadata : {}),
        activation_code_ids: codeIds,
        activation_code_count: codeIds.length
      }
    });

    await this.auditService.createAuditLog({
      actor_type: "ai_agent",
      action: "activation_code_sent_after_payment_confirmation",
      entity_type: "orders",
      entity_id: String(order.id),
      metadata: { webhookEventId: input.webhookEventId, code_id: codeIds[0], code_ids: codeIds, code_count: codeIds.length }
    });

    const postPurchaseMessages = buildPostPurchaseMessages(reservedCodes.map((code) => String(code.code)));
    return {
      order: sentOrder,
      reply: postPurchaseMessages[0],
      followUpMessages: postPurchaseMessages.slice(1)
    };
  }

  private async generatePixPayment(
    input: CommercialReplyInput,
    knowledge: Array<{ category?: string; content?: string }>
  ): Promise<CommercialReplyResult> {
    const leadProfile = readLeadProfile(input.conversation.metadata);
    const metaAttribution = buildMetaAttributionOrderMetadata(input.conversation.metadata);
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
            ...metaAttribution,
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
              ...metaAttribution,
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
          ...metaAttribution,
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
    reply = "Vou encaminhar para atendimento humano para te ajudar melhor. Enquanto isso, pode me mandar mais detalhes por aqui.",
    details: Record<string, unknown> = {}
  ): Promise<CommercialReplyResult> {
    await this.agentActionsService.createAgentAction({
      conversation_id: input.conversation.id,
      customer_id: input.customer.id,
      action_name: "handoff_to_human",
      status: "requested",
      input_payload: { reason, message: input.message, knowledge_categories: knowledge.map((article) => article.category), ...details },
      output_payload: {},
      requires_human_approval: true
    });

    await this.auditService.createAuditLog({
      actor_type: "ai_agent",
      action: "handoff_to_human",
      entity_type: "conversations",
      entity_id: input.conversation.id,
      metadata: { reason, webhookEventId: input.webhookEventId, ...details }
    });

    return {
      requiresHuman: true,
      reply
    };
  }

  private async generateContextualInstallTrialReply(
    input: CommercialReplyInput,
    message: string,
    intent: string,
    leadProfile: Record<string, unknown>
  ): Promise<CommercialReplyResult> {
    const aiReply = await this.salesResponseAIService.generateResponse({
      message: [
        message,
        "",
        "Contexto operacional: o cliente ja esta em suporte de instalacao/download.",
        "Ele nao precisa responder aparelho de novo.",
        "Responda confirmando que existe teste gratis de 3 dias e conduza para o proximo passo da instalacao atual.",
        "Se o historico mencionar Downloader, codigo ou tela de login, use esse contexto naturalmente.",
        "Nao use mensagem pronta e nao pergunte o aparelho novamente."
      ].join("\n"),
      intent,
      leadProfile: {
        ...leadProfile,
        wants_test: true,
        stage: "install_support",
        next_expected_reply: "install_confirmation"
      },
      recentMessages: input.recentMessages,
      specialistExamples: input.specialistExamples,
      learningMemories: input.learningMemories,
      conversationId: input.conversation.id,
      useStrongModel: false
    });

    if (!aiReply) {
      return this.silentHandoffToHuman(input, "install_trial_contextual_ai_unavailable");
    }

    return {
      reply: aiReply,
      responseSource: "ai",
      responseRule: "sales_response_ai_install_trial_context",
      leadProfilePatch: {
        wants_test: true,
        stage: "install_support",
        next_expected_reply: "install_confirmation"
      }
    };
  }

  private async silentHandoffToHuman(
    input: CommercialReplyInput,
    reason: string,
    knowledge: Array<{ category?: string; content?: string }> = []
  ): Promise<CommercialReplyResult> {
    const leadProfile = readLeadProfile(input.conversation.metadata);
    const risk = detectConversationRisk(input.classification.intent, input.message, leadProfile);
    const stage = firstStringValue(leadProfile.stage, leadProfile.commercial_stage, leadProfile.etapa_atual);
    const details = {
      detected_intent: input.classification.intent,
      confidence: input.classification.confidence,
      risk,
      stage,
      recovery_attempted: true,
      recovery_result: "blocked_or_empty",
      block_reason: reason
    };
    const result = await this.handoffToHuman(input, reason, knowledge, "", details);
    return {
      ...result,
      responseSource: "local_rule",
      responseRule: reason,
      notifyOwner: true,
      ownerNotificationText:
        "Atendimento automatico pausado apos falha em resposta segura.\n\n" +
        `Cliente: ${input.customer.id}\n` +
        `Mensagem: ${input.message}\n` +
        `Intencao: ${String(details.detected_intent)}\n` +
        `Risco: ${String(details.risk)}\n` +
        `Motivo: ${reason}`
    };
  }
}

function readLeadProfile(metadata: Record<string, unknown> | null | undefined) {
  const profile = metadata?.lead_profile;
  return profile && typeof profile === "object" && !Array.isArray(profile) ? profile as Record<string, unknown> : {};
}

type ConversationIntelligenceLayer = {
  latestCustomerMessage: string;
  detectedIntent: string;
  risk: "low" | "high";
  leadProfile: Record<string, unknown>;
  latestBotMessage: string | null;
  lastBotQuestion: string | null;
  stage: string | null;
  confidence: number;
};

function buildConversationIntelligenceLayer(input: {
  message: string;
  intent: string;
  leadProfile: Record<string, unknown>;
  recentMessages?: Array<{ role?: string; content?: string | null }>;
  confidence: number;
}): ConversationIntelligenceLayer {
  const latestBotMessage = [...(input.recentMessages || [])]
    .reverse()
    .find((item) => item.role === "assistant" || item.role === "human_agent");
  const lastBotQuestion = typeof input.leadProfile.last_bot_question === "string"
    ? input.leadProfile.last_bot_question
    : extractLastQuestionFromText(latestBotMessage?.content || "");
  const stage = firstStringValue(
    input.leadProfile.stage,
    input.leadProfile.commercial_stage,
    input.leadProfile.etapa_atual
  );

  return {
    latestCustomerMessage: input.message,
    detectedIntent: input.intent,
    risk: detectConversationRisk(input.intent, input.message, input.leadProfile),
    leadProfile: input.leadProfile,
    latestBotMessage: typeof latestBotMessage?.content === "string" ? latestBotMessage.content : null,
    lastBotQuestion,
    stage,
    confidence: input.confidence
  };
}

function detectConversationRisk(intent: string, message: string, leadProfile: Record<string, unknown>): "low" | "high" {
  const normalized = normalizeContextMessage(message);
  if (
    isSensitiveExecutionIntent(intent) ||
    intent === "receipt_sent" ||
    intent === "activation_help" ||
    /\b(comprovante|paguei|ja paguei|pix copia|qr code|codigo|código|libera o acesso|liberar acesso)\b/.test(normalized)
  ) {
    return "high";
  }

  if (
    ["greeting", "ask_price", "free_trial", "renew_plan", "buy_plan", "technical_support", "ask_payment", "unknown"].includes(intent) &&
    (
      isLowRiskOpeningMessage(normalized) ||
      /\b(valor|preco|preço|plano|planos|recarga|renovar|teste|instalar|download|aparelho|telas?)\b/.test(normalized) ||
      Boolean(leadProfile.last_bot_question)
    )
  ) {
    return "low";
  }

  return "high";
}

function shouldBlockHumanHandoff(context: ConversationIntelligenceLayer) {
  const lastQuestion = normalizeContextMessage(context.lastBotQuestion || "");
  const stage = normalizeContextMessage(context.stage || "");
  const lowRiskStages = [
    "welcome",
    "welcome_activation",
    "test_offer",
    "first_time_qualification",
    "device_qualification",
    "download_instructions",
    "download_support",
    "installation_tutorial",
    "install_support",
    "plan_discovery",
    "price_discovery",
    "qualified"
  ];
  const lastBotMessageWasQuestion =
    Boolean(context.latestBotMessage?.includes("?")) ||
    isDeviceQualificationQuestion(lastQuestion) ||
    /\b(primeira vez|uso do app|faz o uso|plano especifico|quantas telas|pix ou cartao)\b/.test(lastQuestion);
  const customerIsExpectedToAnswer =
    String(context.leadProfile.pendingCustomerResponse || "") === "true" ||
    String(context.leadProfile.pending_customer_response || "") === "true" ||
    String(context.leadProfile.state || "") === "awaiting_customer_response" ||
    String(context.leadProfile.next_expected_reply || "").trim().length > 0 ||
    Boolean(context.leadProfile.last_bot_question);
  const normalLowRiskFlow =
    lowRiskStages.includes(stage) ||
    isDeviceQualificationQuestion(lastQuestion) ||
    /\b(teste|download|instalacao|instalar|valor|preco|plano|recarga)\b/.test(stage);

  if (normalLowRiskFlow && (lastBotMessageWasQuestion || customerIsExpectedToAnswer)) {
    return {
      block: true,
      reason: "awaiting_customer_response_in_low_risk_flow"
    };
  }

  return { block: false, reason: null };
}

function buildContextualUnderstandingReply(
  decision: ContextualDecision | null | undefined,
  context: ConversationIntelligenceLayer
): CommercialReplyResult | null {
  if (!decision || !decision.should_reply || decision.should_handoff || decision.confidence < 0.55) {
    return null;
  }

  const lastQuestion = normalizeContextMessage(context.lastBotQuestion || context.latestBotMessage || "");
  const activeContext = Boolean(lastQuestion || context.stage || context.leadProfile.last_bot_question);
  const safeResponse = String(decision.recommended_response || "").trim();

  if (
    decision.next_action === "ask_device_for_trial" &&
    decision.detected_intent === "FREE_TRIAL_REQUEST" &&
    (activeContext || decision.confidence >= 0.92)
  ) {
    return {
      reply: safeResponse || CONTEXTUAL_TRIAL_DEVICE_REPLY,
      responseRule: "contextual_understanding_free_trial",
      leadProfilePatch: {
        commercial_stage: "device_qualification",
        stage: "device_qualification",
        state: "awaiting_customer_response",
        wants_test: true,
        first_time_user: context.leadProfile.first_time_user ?? true,
        last_customer_intent: "free_trial_request",
        next_expected_reply: "device",
        contextual_detected_intent: decision.detected_intent,
        contextual_next_action: decision.next_action,
        contextual_reason: decision.reason,
        last_bot_question: "Me fala so qual aparelho voce vai usar: celular Android, TV Box, Android TV/Google TV ou Fire Stick?"
      }
    };
  }

  if (
    decision.next_action === "confirm_android_phone" &&
    decision.detected_intent === "DEVICE_ANDROID_PHONE_NEEDS_CONFIRMATION"
  ) {
    return {
      reply: safeResponse || ANDROID_PHONE_CONFIRMATION_REPLY,
      responseRule: "contextual_understanding_confirm_android_phone",
      leadProfilePatch: {
        commercial_stage: "device_qualification",
        stage: "device_qualification",
        state: "awaiting_customer_response",
        wants_test: context.leadProfile.wants_test ?? true,
        last_customer_intent: "device_android_phone_needs_confirmation",
        next_expected_reply: "device",
        contextual_detected_intent: decision.detected_intent,
        contextual_next_action: decision.next_action,
        contextual_reason: decision.reason,
        last_bot_question: ANDROID_PHONE_CONFIRMATION_REPLY
      }
    };
  }

  if (decision.next_action === "ask_download_problem" && decision.detected_intent === "DOWNLOAD_HELP") {
    return {
      reply: safeResponse || DOWNLOAD_PROBLEM_CONTEXT_REPLY,
      responseRule: "contextual_understanding_download_help",
      leadProfilePatch: {
        commercial_stage: "download_support",
        stage: "download_support",
        state: "awaiting_customer_response",
        install_status: "failed",
        download_status: "failed",
        last_customer_intent: "download_issue",
        next_expected_reply: "download_confirmation",
        contextual_detected_intent: decision.detected_intent,
        contextual_next_action: decision.next_action,
        contextual_reason: decision.reason,
        last_bot_question: DOWNLOAD_PROBLEM_CONTEXT_REPLY
      }
    };
  }

  if (decision.next_action === "ask_installation_status" && decision.detected_intent === "DOWNLOAD_CONFIRMED") {
    return {
      reply: safeResponse ||
        "Perfeito. Agora abre o aplicativo e me avisa se aparecer a tela de login/cadastro para seguirmos com a liberacao do teste.",
      responseRule: "contextual_understanding_download_confirmed",
      leadProfilePatch: {
        commercial_stage: "awaiting_download_installation",
        stage: "awaiting_download_installation",
        state: "awaiting_download_installation",
        downloaded_app: true,
        install_status: decision.install_status || "downloaded",
        download_status: decision.install_status || "downloaded",
        last_customer_intent: "download_confirmed",
        next_expected_reply: "install_confirmation",
        contextual_detected_intent: decision.detected_intent,
        contextual_next_action: decision.next_action,
        contextual_reason: decision.reason
      }
    };
  }

  return null;
}

function getExpectedDeviceAnswerReply(message: string, context: ConversationIntelligenceLayer): CommercialReplyResult | null {
  const lastQuestion = normalizeContextMessage(context.lastBotQuestion || "");
  if (!isDeviceQualificationQuestion(lastQuestion) || !isUnitvInstallationRequest(message)) {
    return null;
  }

  const installationReply = getInstallationReply(message);
  if (!installationReply || installationReply.requiresHuman) {
    return null;
  }

  return {
    ...installationReply,
    leadProfilePatch: {
      ...(installationReply.leadProfilePatch || {}),
      wants_test: context.leadProfile.wants_test ?? true,
      commercial_stage: "download_instructions",
      stage: "download_instructions",
      state: "awaiting_download_installation",
      install_status: "link_sent",
      download_status: "link_sent",
      next_expected_reply: "download_confirmation"
    }
  };
}

function getActiveDownloadFlowReply(message: string, context: ConversationIntelligenceLayer): CommercialReplyResult | null {
  if (!isDownloadFlowActive(context)) {
    return null;
  }

  const normalized = normalizeContextMessage(message);
  const basePatch = {
    commercial_stage: "awaiting_download_installation",
    stage: "awaiting_download_installation",
    state: "awaiting_download_installation",
    next_expected_reply: "install_confirmation",
    last_customer_intent: "download_installation_followup"
  };

  if (isDownloadIssueAnswer(normalized)) {
    return {
      reply: "Entendi. Me fala o que apareceu ai: deu erro no link, nao iniciou o download ou o celular bloqueou a instalacao?",
      leadProfilePatch: {
        ...basePatch,
        install_status: "failed",
        download_status: "failed"
      }
    };
  }

  if (isDownloadedAnswer(normalized)) {
    return {
      reply: "Perfeito. Agora abre o aplicativo e me avisa se aparecer a tela de login/cadastro para seguirmos com a liberacao do teste.",
      leadProfilePatch: {
        ...basePatch,
        downloaded_app: true,
        install_status: "downloaded",
        download_status: "downloaded",
        next_expected_reply: "install_confirmation"
      }
    };
  }

  if (customerMentionsAndroidDevice(normalized)) {
    return {
      reply:
        "Perfeito, entao esse link e o correto para seu celular Android.\n\n" +
        "Pode baixar por ele e, quando terminar de instalar, me avisa por aqui que seguimos com a liberacao do teste.",
      leadProfilePatch: {
        ...basePatch,
        device: "android_phone",
        aparelho: "Celular Android",
        device_compatible: true,
        install_status: "link_sent",
        download_status: "link_sent"
      }
    };
  }

  if (/^(ok|certo|beleza|blz|ta|t[aá]|vou baixar|vou tentar|pronto|sim|s)$/i.test(normalized)) {
    return {
      reply: "Perfeito. Pode baixar por esse link e, quando terminar de instalar, me avisa por aqui que seguimos com a liberacao do teste.",
      leadProfilePatch: basePatch
    };
  }

  return null;
}

function isDownloadFlowActive(context: ConversationIntelligenceLayer) {
  const stage = normalizeContextMessage(context.stage || "");
  const latestBotMessage = normalizeContextMessage(context.latestBotMessage || "");
  const installStatus = normalizeContextMessage(String(context.leadProfile.install_status || context.leadProfile.download_status || ""));
  return (
    stage === "download_instructions" ||
    stage === "download_instructions_sent" ||
    stage === "awaiting_download_installation" ||
    stage === "awaiting_installation" ||
    installStatus === "link_sent" ||
    Boolean(context.leadProfile.last_download_url_sent) ||
    /\b(mediafire\.com|baixe por aqui|apk|tutorial:)\b/.test(latestBotMessage)
  );
}

function customerMentionsAndroidDevice(normalized: string) {
  return /\b(e android|eh android|android|celular android|meu celular)\b/.test(normalized);
}

function isDownloadedAnswer(normalized: string) {
  return /\b(baixei|ja baixei|consegui baixar|download feito|instalei|ja instalei|pronto|consegui)\b/.test(normalized);
}

function isDownloadIssueAnswer(normalized: string) {
  return /\b(nao consegui|n consegui|deu erro|erro|bloqueou|nao iniciou|nao baixou|link nao funciona|link n funciona)\b/.test(normalized);
}

function isDeviceQualificationQuestion(lastQuestion: string) {
  return /\b(aparelho|celular android|tv box|tvbox|android tv|google tv|fire stick|firestick|instalar onde|vai usar)\b/.test(lastQuestion);
}

function isShortOfferAvailabilityQuestion(normalized: string) {
  return /^(oferece|oferecem|oferece isso|voces oferecem|vcs oferecem|tem|tem sim|tem como)[!?.,\s]*$/.test(normalized);
}

function isLowRiskOpeningMessage(normalized: string) {
  return (
    /^(oi|ola|olá|olq|opa|bom dia|boa tarde|boa noite|oie|oii+|oiii+)[!?.,\s]*$/.test(normalized) ||
    /\b(tenho interesse|me interessei|quero saber|quero conhecer|saber mais|saiba mais|mais informacoes|informacoes sobre isso|posso ter mais informacoes)\b/.test(normalized)
  );
}

function buildLowRiskRecoveryReply(context: ConversationIntelligenceLayer) {
  const shortAnswerResolution = resolveShortAnswerWithLastBotQuestion(context);
  if (shortAnswerResolution) {
    return shortAnswerResolution.reply;
  }

  const normalized = normalizeContextMessage(context.latestCustomerMessage);
  const lastQuestion = normalizeContextMessage(context.lastBotQuestion || "");

  if (isFirstTimeActivationAnswer(normalized) && isInitialUseQuestion(lastQuestion)) {
    return FIRST_TIME_ACTIVATION_QUESTION;
  }

  if (isClarificationPrompt(normalized) && isFirstTimeProgressQuestion(lastQuestion, context.leadProfile)) {
    return FIRST_TIME_CLARIFICATION_QUESTION;
  }

  if (/^(sim|s|isso|ok|pode|pode ser)$/.test(normalized) && /\b(ja usa|primeira vez|uso do app)\b/.test(lastQuestion)) {
    return "Perfeito. É para recarga de um acesso que você já tem ou seria sua primeira ativação?";
  }

  if (/\b(valor|preco|preço|quanto|planos?)\b/.test(normalized)) {
    return BROAD_PRICE_QUALIFICATION_QUESTION;
  }

  if (/\b(recarga|renovar|recarregar)\b/.test(normalized)) {
    return RENEWAL_CONTEXT_QUESTION;
  }

  if (/\b(teste|gratis|gratuito)\b/.test(normalized)) {
    return "Claro. Pra eu liberar seu teste grátis de 3 dias, me diz só em qual aparelho você vai usar: celular Android, TV Box, Android TV, Google TV ou Fire Stick?";
  }

  if (isShortOfferAvailabilityQuestion(normalized) && /\b(teste|gratis|gratuito|aparelho|celular android|tv box|android tv|fire stick|firestick)\b/.test(lastQuestion)) {
    return "Tem sim. O teste grÃ¡tis Ã© de 3 dias. Me confirma sÃ³ o aparelho: celular Android, TV Box Android, Android TV ou Fire Stick?";
  }

  if (isDeviceQualificationQuestion(lastQuestion)) {
    return "Sem problema. SÃ³ me confirma o aparelho que vocÃª vai usar: celular Android, TV Box Android, Android TV ou Fire Stick?";
  }

  return INITIAL_UNITV_REPLY;
}

function buildLowRiskRecoveryPatch(context: ConversationIntelligenceLayer) {
  const shortAnswerResolution = resolveShortAnswerWithLastBotQuestion(context);
  if (shortAnswerResolution) {
    return shortAnswerResolution.leadProfilePatch;
  }

  const normalized = normalizeContextMessage(context.latestCustomerMessage);
  const lastQuestion = normalizeContextMessage(context.lastBotQuestion || "");
  if (isFirstTimeActivationAnswer(normalized) && isInitialUseQuestion(lastQuestion)) {
    return {
      commercial_stage: "first_time_qualification",
      stage: "first_time_qualification",
      last_customer_intent: "first_time_user",
      next_expected_reply: "test_or_plan_choice",
      last_bot_question: FIRST_TIME_ACTIVATION_QUESTION
    };
  }

  if (isClarificationPrompt(normalized) && isFirstTimeProgressQuestion(lastQuestion, context.leadProfile)) {
    return {
      commercial_stage: "first_time_qualification",
      stage: "first_time_qualification",
      last_customer_intent: "needs_clarification",
      next_expected_reply: "test_or_plan_choice",
      last_bot_question: FIRST_TIME_CLARIFICATION_QUESTION
    };
  }
  if (/\b(valor|preco|preço|quanto|planos?)\b/.test(normalized)) {
    return {
      commercial_stage: "qualified",
      stage: "qualified",
      last_customer_intent: "ask_price",
      next_expected_reply: "plan_choice",
      last_bot_question: BROAD_PRICE_QUALIFICATION_QUESTION
    };
  }

  if (isShortOfferAvailabilityQuestion(normalized) && /\b(teste|gratis|gratuito|aparelho|celular android|tv box|android tv|fire stick|firestick)\b/.test(lastQuestion)) {
    return {
      commercial_stage: "device_qualification",
      stage: "device_qualification",
      last_customer_intent: "free_trial_availability_question",
      next_expected_reply: "device",
      last_bot_question: "Qual aparelho voce quer usar para testar: celular Android, TV Box Android, Android TV ou Fire Stick?"
    };
  }

  if (isDeviceQualificationQuestion(lastQuestion)) {
    return {
      commercial_stage: "device_qualification",
      stage: "device_qualification",
      last_customer_intent: context.detectedIntent,
      next_expected_reply: "device",
      state: "awaiting_customer_response",
      last_bot_question: "Qual aparelho voce quer usar para testar: celular Android, TV Box Android, Android TV ou Fire Stick?"
    };
  }

  return {
    commercial_stage: "welcome_activation",
    stage: "welcome_activation",
    last_customer_intent: context.detectedIntent,
    next_expected_reply: "activation_or_renewal",
    last_bot_question: INITIAL_UNITV_REPLY
  };
}

function resolveShortAnswerWithLastBotQuestion(context: ConversationIntelligenceLayer): {
  reply: string;
  leadProfilePatch: Record<string, unknown>;
} | null {
  const normalized = normalizeContextMessage(context.latestCustomerMessage);
  const lastQuestion = normalizeContextMessage(context.lastBotQuestion || context.latestBotMessage || "");
  const isShortFirstTimeNo = /^(nao|n|nunca|nunca usei|nao usei|nao uso|ainda nao|primeira vez)$/.test(normalized);
  const askedFirstTimeOrTrial =
    /\b(ja usou|ja usa|uso do app|faz o uso|primeira vez|3 dias gratis|teste gratis|liberar 3 dias|libero 3 dias)\b/.test(lastQuestion);
  const askedDeviceForTest =
    isDeviceQualificationQuestion(lastQuestion) ||
    /\b(qual aparelho|aparelho voce quer testar|aparelho quer testar|baixar|download)\b/.test(lastQuestion);

  if (isShortFirstTimeNo && askedFirstTimeOrTrial) {
    return {
      reply: FIRST_TIME_ASK_DEVICE_FOR_TEST_REPLY,
      leadProfilePatch: {
        commercial_stage: "device_qualification",
        stage: "device_qualification",
        state: "awaiting_customer_response",
        wants_test: true,
        first_time_user: true,
        last_customer_intent: "first_time_user",
        next_expected_reply: "device",
        last_bot_question: "Qual aparelho voce quer baixar para fazer seu teste de 3 dias: celular Android, TV Box, Android TV/Google TV ou Fire Stick?"
      }
    };
  }

  if (isShortFirstTimeNo && askedDeviceForTest) {
    return {
      reply: ASK_DEVICE_AGAIN_WITH_OPTIONS_REPLY,
      leadProfilePatch: {
        commercial_stage: "device_qualification",
        stage: "device_qualification",
        state: "awaiting_customer_response",
        wants_test: context.leadProfile.wants_test ?? true,
        last_customer_intent: "device_not_provided",
        next_expected_reply: "device",
        last_bot_question: "Voce quer testar em qual aparelho? Celular Android, TV Box, Android TV/Google TV ou Fire Stick?"
      }
    };
  }

  return null;
}

function isInitialUseQuestion(lastQuestion: string) {
  return /\b(ja usa|uso do app|faz o uso|primeira vez)\b/.test(lastQuestion);
}

function isFirstTimeActivationAnswer(normalized: string) {
  return (
    /\b(primeira vez|primeira ativacao|novo por aqui|sou novo|sou nova|nunca usei|nunca use|nunca primeira vez)\b/.test(normalized) ||
    /\b(nao uso|nao usei|nunca tive|nunca testei)\b/.test(normalized)
  );
}

function isClarificationPrompt(normalized: string) {
  return /^[?!.]*$/.test(normalized) || /\b(nao entendi|n entendi|como assim|pode explicar)\b/.test(normalized);
}

function isFirstTimeProgressQuestion(lastQuestion: string, leadProfile: Record<string, unknown>) {
  return (
    /\b(teste gratis|ver os planos|mostrar os planos|comecar pelo teste)\b/.test(lastQuestion) ||
    String(leadProfile.last_customer_intent || "") === "first_time_user" ||
    String(leadProfile.next_expected_reply || "") === "test_or_plan_choice"
  );
}

function isRechargeLaterReply(normalized: string) {
  return (
    /\b(mais tarde|depois|daqui a pouco|logo mais|quando eu chegar)\b.{0,50}\b(faco|fazer|pago|pagar|recarga|recarrego|recarregar|fecho|fechar|realizo|realizar)\b/.test(normalized) ||
    /\b(vou|quero)\b.{0,35}\b(fazer|pagar|realizar|fechar|recarregar)\b.{0,50}\b(mais tarde|depois|daqui a pouco|logo mais|quando eu chegar)\b/.test(normalized)
  );
}

function isWarmRechargeContext(leadProfile: Record<string, unknown>) {
  return Boolean(
    leadProfile.selected_plan ||
    leadProfile.plano_interesse ||
    leadProfile.wants_recharge ||
    leadProfile.asked_price ||
    leadProfile.asked_screens ||
    leadProfile.payment_intent_status === "later" ||
    leadProfile.stage === "pre_sale_recharge_intent" ||
    leadProfile.customer_stage === "pre_sale_recharge_intent"
  );
}

function extractLastQuestionFromText(text: string) {
  const questions = String(text || "").match(/[^?]+\?/g);
  return questions?.at(-1)?.trim() || null;
}

function buildMetaAttributionOrderMetadata(metadata: Record<string, unknown> | null | undefined) {
  const leadProfile = readLeadProfile(metadata);
  const referral = isRecord(metadata?.meta_referral) ? metadata.meta_referral : {};
  const ctwaClid = firstStringValue(metadata?.meta_ctwa_clid, leadProfile.meta_ctwa_clid, referral.ctwaClid, referral.ctwa_clid);
  if (!ctwaClid) {
    return {};
  }

  const sourceId = firstStringValue(metadata?.meta_ad_source_id, leadProfile.meta_ad_source_id, referral.sourceId, referral.source_id);
  const sourceUrl = firstStringValue(metadata?.meta_ad_source_url, leadProfile.meta_ad_source_url, referral.sourceUrl, referral.source_url);
  const sourceType = firstStringValue(metadata?.meta_ad_source_type, leadProfile.meta_ad_source_type, referral.sourceType, referral.source_type);
  const entryPoint = firstStringValue(metadata?.meta_entry_point, leadProfile.meta_entry_point, referral.entryPointConversionSource);

  return {
    meta_ctwa_clid: ctwaClid,
    meta_ad_source_id: sourceId || null,
    meta_ad_source_url: sourceUrl || null,
    meta_ad_source_type: sourceType || null,
    meta_entry_point: entryPoint || null,
    meta_referral: referral && Object.keys(referral).length ? referral : metadata?.meta_referral || null
  };
}

function firstStringValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function getContextualCommercialReply(message: string, leadProfile: Record<string, unknown>): CommercialReplyResult | null {
  const normalized = normalizeContextMessage(message);
  const selectedPlan = leadProfile.selected_plan || leadProfile.plano_interesse;
  const lastBotQuestion = normalizeContextMessage(String(leadProfile.last_bot_question || ""));
  const confirmedDownload =
    /\b(ja baixei|baixei|download feito|fiz o download|ja instalei|instalei)\b/.test(normalized) ||
    (/^(sim|s|ja|ok|feito|consegui)$/.test(normalized) && /\b(baixou|download|instalou)\b/.test(lastBotQuestion));

  if (leadProfile.saudacao_enviada !== true && isInitialAdInformationRequest(normalized)) {
    return buildTrafficRechargeWelcomeReply();
  }

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

  if (isRechargeLaterReply(normalized) && isWarmRechargeContext(leadProfile)) {
    return {
      reply: "Combinado. Vou deixar anotado por aqui e, mais tarde, confirmo com voce se posso te mandar a chave Pix.",
      leadProfilePatch: {
        commercial_stage: "pre_sale_recharge_intent",
        stage: "pre_sale_recharge_intent",
        payment_intent_status: "later",
        last_customer_intent: "wants_to_recharge_later",
        next_expected_reply: "pix_permission_later",
        next_best_action: "follow_up_4h_pedir_permissao_pix",
        last_bot_question: "Posso te mandar a chave Pix mais tarde?"
      }
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

  if (isFirstTimeActivationAnswer(normalized) && isInitialUseQuestion(lastBotQuestion)) {
    return {
      reply: FIRST_TIME_ACTIVATION_QUESTION,
      leadProfilePatch: {
        commercial_stage: "first_time_qualification",
        stage: "first_time_qualification",
        last_customer_intent: "first_time_user",
        next_expected_reply: "test_or_plan_choice",
        last_bot_question: FIRST_TIME_ACTIVATION_QUESTION
      }
    };
  }

  if (isClarificationPrompt(normalized) && isFirstTimeProgressQuestion(lastBotQuestion, leadProfile)) {
    return {
      reply: FIRST_TIME_CLARIFICATION_QUESTION,
      leadProfilePatch: {
        commercial_stage: "first_time_qualification",
        stage: "first_time_qualification",
        last_customer_intent: "needs_clarification",
        next_expected_reply: "test_or_plan_choice",
        last_bot_question: FIRST_TIME_CLARIFICATION_QUESTION
      }
    };
  }

  if (confirmedDownload) {
    return {
      reply:
        "Perfeito. Como voc\u00ea j\u00e1 baixou o app, agora posso te ajudar com a ativa\u00e7\u00e3o. " +
        "Voc\u00ea quer liberar o teste gr\u00e1tis de 3 dias ou j\u00e1 ativar o mensal de R$ 25?"
    };
  }

  if (/\b(ja uso|ja usei|ja tenho|ja conheco|uso o app|uso unitv)\b/.test(normalized)) {
    return {
      reply: selectedPlan === "mensal"
        ? "\u00d3timo, ent\u00e3o voc\u00ea j\u00e1 conhece o app. Quer seguir com o mensal de R$ 25 agora?"
        : PLAN_PREFERENCE_QUESTION
    };
  }

  if (/^(sim|s|isso|ok|pode|quero|pode ser)$/.test(normalized) && /\b(interesse em seguir hoje|quer seguir com ele)\b/.test(lastBotQuestion)) {
    return {
      reply: PAYMENT_TEXT,
      leadProfilePatch: {
        selected_plan: "mensal",
        plano_interesse: "mensal",
        commercial_stage: "payment_choice",
        stage: "payment_choice",
        last_customer_intent: "monthly_offer_accepted",
        next_expected_reply: "payment_method",
        last_bot_question: PAYMENT_TEXT
      }
    };
  }

  if (/^(sim|s|isso|ok|pode|quero|pode ser)$/.test(normalized) && /\b(interesse no mensal|mensal mesmo)\b/.test(lastBotQuestion)) {
    return {
      reply: buildMonthlyPriceComparisonReply(leadProfile),
      leadProfilePatch: {
        selected_plan: "mensal",
        plano_interesse: "mensal",
        commercial_stage: "monthly_offer_pending",
        stage: "monthly_offer_pending",
        last_customer_intent: "ask_monthly_price",
        next_expected_reply: "monthly_offer_interest",
        last_bot_question: MONTHLY_OFFER_QUESTION
      }
    };
  }

  if (/^(nao|n[aã]o|sem preferencia|tanto faz)$/.test(normalized) && /\b(plano especifico|mensal|trimestral|semestral|anual)\b/.test(lastBotQuestion)) {
    return {
      reply: "Entendi. Entao pra comecar mais simples, voce prefere fazer o teste gratis de 3 dias ou ja seguir pelo mensal?",
      leadProfilePatch: {
        commercial_stage: "qualified",
        stage: "qualified",
        last_customer_intent: "no_specific_plan_preference",
        next_expected_reply: "activation_or_renewal",
        last_bot_question: "Voce prefere fazer o teste gratis de 3 dias ou ja seguir pelo mensal?"
      }
    };
  }

  if (/\b(estarei agora|vou querer agora|quero agora|pode ser agora|agora)\b/.test(normalized) && /\b(plano especifico|quantas telas|mensal|trimestral|semestral|anual)\b/.test(lastBotQuestion)) {
    return {
      reply: "Perfeito. Pra comecar agora do jeito mais simples, voce quer fazer o teste gratis ou ja ativar o mensal?",
      leadProfilePatch: {
        commercial_stage: "qualified",
        stage: "qualified",
        last_customer_intent: "wants_to_start_now",
        next_expected_reply: "activation_or_renewal",
        last_bot_question: "Voce quer fazer o teste gratis ou ja ativar o mensal?"
      }
    };
  }

  if (/\b(faz a quanto|recarga.*quanto|quanto voce paga|quanto vc paga)\b/.test(lastBotQuestion)) {
    if (isFirstRechargeOnlyTestMessage(normalized)) {
      return {
        reply: buildFirstRechargePromoReply(leadProfile),
        leadProfilePatch: buildSoftPromoOfferPatch({
          currentRechargePriceCents: null,
          lastCustomerIntent: "first_recharge_after_trial"
        })
      };
    }

    const currentPriceCents = extractCurrencyCents(normalized);
    if (currentPriceCents && currentPriceCents <= 2000) {
      return {
        reply: buildSoftPriceMatchPromoReply(currentPriceCents),
        leadProfilePatch: buildSoftPromoOfferPatch({
          currentRechargePriceCents: currentPriceCents,
          lastCustomerIntent: "price_objection"
        })
      };
    }

    if (currentPriceCents) {
      return {
        reply: "Entendi. O mensal comigo fica R$ 25 e eu te ajudo na ativacao por aqui.\n\nVoce quer seguir com ele?",
        leadProfilePatch: {
          selected_plan: "mensal",
          plano_interesse: "mensal",
          commercial_stage: "plan_selected",
          stage: "plan_selected",
          current_recharge_price_cents: currentPriceCents,
          last_customer_intent: "choose_plan",
          next_expected_reply: "plan_confirmation",
          last_bot_question: "Voce quer seguir com ele?"
        }
      };
    }
  }

  if (/^(ativar|ativacao|ativa|liberar)$/i.test(normalized)) {
    return {
      reply: RENEWAL_CONTEXT_QUESTION
    };
  }

  if (/^(mensal|plano mensal)$/i.test(normalized)) {
    return {
      reply: buildMonthlyPriceComparisonReply(leadProfile),
      leadProfilePatch: {
        selected_plan: "mensal",
        plano_interesse: "mensal",
        commercial_stage: "monthly_offer_pending",
        stage: "monthly_offer_pending",
        last_customer_intent: "ask_monthly_price",
        next_expected_reply: "monthly_offer_interest",
        last_bot_question: MONTHLY_OFFER_QUESTION
      }
    };
  }

  return null;
}

function isInitialAdInformationRequest(normalized: string) {
  return /\b(posso ter mais informacoes|mais informacoes|informacoes sobre isso|informacao sobre isso|saiba mais|saber mais)\b/.test(normalized);
}

function buildTrafficRechargeWelcomeReply(): CommercialReplyResult {
  return {
    reply: TRAFFIC_RECHARGE_WELCOME,
    menu: undefined,
    sendTextBeforeMenu: false,
    leadProfilePatch: {
      commercial_stage: "welcome_activation",
      stage: "welcome_activation",
      wants_recharge: true,
      traffic_source_opener: true,
      last_customer_intent: "traffic_recharge_opener",
      next_expected_reply: "activation_or_renewal",
      last_bot_question: "Voce ja faz o uso do app? Ou e a primeira vez?"
    }
  };
}

function buildMonthlyPriceComparisonReply(leadProfile: Record<string, unknown>) {
  const firstName = getLeadFirstName(leadProfile);
  const namePart = firstName ? `, ${firstName},` : "";
  return `O mensal${namePart} esta saindo a R$ 25.\n\n${MONTHLY_OFFER_QUESTION}`;
}

function buildFirstRechargePromoReply(leadProfile: Record<string, unknown>) {
  const deviceLabel = getKnownDeviceLabel(leadProfile);
  const activationQuestion = deviceLabel
    ? `Voce tem interesse em ativar o mensal no ${deviceLabel}?`
    : "Voce tem interesse em ativar o mensal?";
  return [
    "Entendi. Como voce ja fez o teste, agora seria sua primeira recarga mesmo.",
    "Como e sua primeira vez fazendo recarga, consigo deixar o mensal por R$ 19,99 pra voce comecar.",
    `${activationQuestion} E so pra eu te orientar certinho: voce ja tem o app instalado ai?`
  ].join("\n\n");
}

function buildSoftPriceMatchPromoReply(currentPriceCents: number) {
  const currentPrice = currentPriceCents <= 2000 ? "nesse valor" : "perto desse valor";
  return [
    `Entendi, voce ja fazia recarga ${currentPrice}.`,
    "Consigo deixar o mensal por R$ 19,99 pra voce comecar aqui comigo.",
    "Voce tem interesse?"
  ].join("\n\n");
}

function buildSoftPromoOfferPatch({
  currentRechargePriceCents,
  lastCustomerIntent
}: {
  currentRechargePriceCents: number | null;
  lastCustomerIntent: string;
}) {
  return {
    selected_plan: "mensal",
    plano_interesse: "mensal",
    commercial_stage: "special_promo_offered",
    stage: "special_promo_offered",
    ...(currentRechargePriceCents ? { current_recharge_price_cents: currentRechargePriceCents } : {}),
    special_promo_followup_sent: true,
    special_promo_offer: SPECIAL_PROMO_OFFER_ID,
    special_promo_price_cents: SPECIAL_PROMO_MONTHLY_PRICE_CENTS,
    original_price_cents: 2500,
    last_customer_intent: lastCustomerIntent,
    next_expected_reply: "promo_confirmation",
    last_bot_question: "Voce tem interesse?"
  };
}

function isFirstRechargeOnlyTestMessage(normalized: string) {
  return (
    /\b(so|somente|apenas)\b.*\b(teste|testei|testado)\b/.test(normalized) ||
    /\b(fiz|feito|usei)\b.*\b(teste)\b/.test(normalized) ||
    /\b(primeira recarga|nunca recarreguei|nao fiz recarga|nao fiz nenhuma recarga|nunca fiz recarga)\b/.test(normalized)
  );
}

function getKnownDeviceLabel(leadProfile: Record<string, unknown>) {
  const rawDevice = normalizeContextMessage(String(
    leadProfile.device ||
    leadProfile.aparelho ||
    leadProfile.device_type ||
    leadProfile.install_device ||
    ""
  ));
  if (!rawDevice || rawDevice === "unknown") return "";
  if (/\b(android_phone|celular|celular android)\b/.test(rawDevice)) return "celular Android";
  if (/\b(tvbox|tv box)\b/.test(rawDevice)) return "TV Box Android";
  if (/\b(android_tv|android tv|google tv)\b/.test(rawDevice)) return "Android TV";
  if (/\b(firestick|fire stick)\b/.test(rawDevice)) return "Fire Stick";
  return "";
}

function getLeadFirstName(leadProfile: Record<string, unknown>) {
  const rawName = String(
    leadProfile.nome ||
    leadProfile.name ||
    leadProfile.customer_name ||
    leadProfile.contact_name ||
    ""
  ).trim();
  const firstName = rawName.split(/\s+/).find(Boolean) || "";
  return /^[A-Za-zÀ-ÿ]{2,}$/.test(firstName) ? firstName : "";
}

function extractCurrencyCents(normalizedMessage: string) {
  const match = normalizedMessage.match(/(?:r\$\s*)?(\d{1,3})(?:[,.](\d{1,2}))?/);
  if (!match) return null;
  const reais = Number(match[1]);
  const cents = Number((match[2] || "0").padEnd(2, "0"));
  if (!Number.isFinite(reais) || !Number.isFinite(cents)) return null;
  return reais * 100 + cents;
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

function isSensitiveExecutionIntent(intent: string) {
  return [
    "pix_payment",
    "card_payment",
    "buy_plan",
    "renew_plan",
    "receipt_sent",
    "activation_help",
    "human_help"
  ].includes(intent);
}

function isSafeAICommercialReply(
  reply: string,
  leadProfile: Record<string, unknown>,
  recentMessages?: Array<{ role?: string; content?: string | null }>
) {
  const recentBotMessages = (recentMessages || [])
    .filter((item) => item.role === "assistant" && typeof item.content === "string")
    .slice(-5)
    .map((item) => item.content as string);
  return validateResponseAgainstLeadProfile(reply, leadProfile, recentBotMessages).valid;
}

function isAllPricesRequested(message: string) {
  const normalized = normalizeContextMessage(message);
  return (
    /\b(quais|todos|todas|cada|lista|tabela)\b.*\b(valor|valores|preco|precos|planos)\b/.test(normalized) ||
    /\b(valor|valores|preco|precos|planos)\b.*\b(quais|todos|todas|cada|lista|tabela)\b/.test(normalized) ||
    /\b(me manda|manda|envia|mostra|ver)\b.*\b(valores|precos|planos)\b/.test(normalized) ||
    /\b(tem quais planos|quais planos tem|quero ver os planos|quero ver todos|quanto custa cada plano)\b/.test(normalized)
  );
}

function formatSpecificPlanPriceReply(
  plan: { name?: unknown; slug?: unknown; price_cents?: unknown; currency?: unknown; duration_days?: unknown },
  intent: string
) {
  const label = getCommercialPlanLabel(plan);
  const price = formatMoney(Number(plan.price_cents || 0), String(plan.currency || "BRL")).replace(/\s+/g, " ");
  const nextQuestion = intent === "renew_plan" ? "Voce quer seguir com essa renovacao?" : "Voce tem interesse?";
  if (label === "anual") {
    return `O anual fica ${price}. Ele e o melhor custo-beneficio. ${nextQuestion}`;
  }
  return `O ${label} fica ${price}. ${nextQuestion}`;
}

function getCommercialPlanLabel(plan: { name?: unknown; slug?: unknown; duration_days?: unknown }) {
  const key = normalizePlanKey(`${String(plan.slug || "")} ${String(plan.name || "")}`);
  const durationDays = Number(plan.duration_days || 0);
  if (key.includes("mensal") || durationDays === 30) return "mensal";
  if (key.includes("trimestral") || key.includes("3_meses") || durationDays === 90) return "trimestral";
  if (key.includes("semestral") || key.includes("6_meses") || durationDays === 180) return "semestral";
  if (key.includes("anual") || durationDays === 365) return "anual";
  return String(plan.name || "plano").trim().toLowerCase() || "plano";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

function isActiveInstallationSupportContext(
  leadProfile: Record<string, unknown>,
  recentMessages: Array<{ role?: string; content?: string | null }> | undefined
) {
  const recentText = (recentMessages || [])
    .slice(-10)
    .map((item) => `${item.role || ""}: ${item.content || ""}`)
    .join("\n");
  const normalized = normalizeContextMessage(recentText);
  const stage = normalizeContextMessage(String(leadProfile.stage || leadProfile.commercial_stage || ""));
  const installStatus = normalizeContextMessage(String(leadProfile.install_status || leadProfile.download_status || ""));

  return (
    stage.includes("download") ||
    stage.includes("install") ||
    installStatus === "link_sent" ||
    installStatus === "downloaded" ||
    Boolean(leadProfile.last_download_url_sent) ||
    /\b(downloader|download|baixar|instalar|codigo certo|tela de login|abrir o app|apk)\b/.test(normalized)
  );
}

function isRenewalLeadMessage(message: string) {
  const normalized = message
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return /\b(recarga|renovar|renovacao|codigo unitv)\b/.test(normalized) && !/\b(mensal|3 meses|6 meses|anual|trimestral|semestral)\b/.test(normalized);
}

function isTrafficRechargeOpener(message: string) {
  const normalized = message
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return /\bol[aá]!\s*quero fazer recarga codigo unitv\b/.test(normalized) ||
    /\bquero fazer recarga codigo unitv\b/.test(normalized);
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

function formatPixReply(order: Record<string, unknown>, qrCode: string, _ticketUrl: string | null, promoAccepted = false) {
  if (promoAccepted) {
    return [
      "Perfeito ✅",
      "Gerei o Pix do mensal por R$ 19,99 pelo Mercado Pago.",
      "Condição especial aplicada: R$ 19,99 nos 2 primeiros meses.",
      `PIX do pedido ${String(order.order_number)}`,
      "Pix Copia e Cola:",
      qrCode,
      "Se preferir, toque e segure nesta mensagem e escolha copiar.",
      "A confirmação é automática pelo Mercado Pago. Não precisa enviar comprovante."
    ].join("\n\n");
  }

  return [
    `PIX do pedido ${String(order.order_number)}`,
    "Pix Copia e Cola:",
    qrCode,
    "Se preferir, toque e segure nesta mensagem e escolha copiar.",
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
