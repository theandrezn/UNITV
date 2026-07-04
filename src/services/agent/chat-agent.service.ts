import "server-only";
import type { IntentClassification } from "./intent-classifier.service";
import { sanitizeReply } from "@/lib/agent/reply-safety";
import { AppSettingsService } from "@/services/app-settings.service";
import { AgentActionsService } from "@/services/agent-actions.service";
import { AuditService } from "@/services/audit.service";
import { KnowledgeService } from "@/services/knowledge/knowledge.service";
import { OrdersService } from "@/services/orders.service";
import { MercadoPagoService } from "@/services/payments/mercadopago.service";
import { PlansService } from "@/services/plans.service";
import {
  buildPlansMenu,
  CONTINUATION_MENU,
  DEVICE_MENU,
  MAIN_MENU,
  PAYMENT_MENU,
  type WhatsAppMenu
} from "@/lib/whatsapp/menus";

export const INITIAL_UNITV_REPLY =
  "Ola! Sou o atendimento automatico da UniTV. Posso te ajudar com planos, renovacao, ativacao ou suporte. Voce quer comprar, renovar ou precisa de ajuda com o app?";

const LOW_CONFIDENCE_REPLY = "Entendi. Voce quer comprar um plano, renovar um acesso ou falar com suporte?";

type CommercialReplyInput = {
  message: string;
  classification: IntentClassification;
  customer: { id: string; email?: string | null };
  conversation: { id: string; metadata?: Record<string, unknown> | null };
  webhookEventId: string;
};

type CommercialReplyResult = {
  reply: string;
  order?: Record<string, unknown>;
  requiresHuman?: boolean;
  menu?: WhatsAppMenu;
  sendTextBeforeMenu?: boolean;
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
    private readonly mercadoPagoService = new MercadoPagoService()
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
    return suggestedReply || INITIAL_UNITV_REPLY;
  }

  async generateCommercialReply(input: CommercialReplyInput): Promise<CommercialReplyResult> {
    const message = input.message.trim();
    if (!message) {
      return { reply: "" };
    }

    const knowledge = await this.knowledgeService.searchKnowledge(message);
    const intent = input.classification.intent === "support" ? "technical_support" : input.classification.intent;

    const objectionCategory = getObjectionKnowledgeCategory(message);
    if (objectionCategory) {
      const objection = knowledge.find((article) => article.category === objectionCategory);
      if (objection?.content) {
        return {
          reply: objection.content,
          menu: objectionCategory === "objecao_preco" || objectionCategory === "objecao_concorrencia"
            ? buildPlansMenu(await this.plansService.listActivePlans())
            : CONTINUATION_MENU,
          sendTextBeforeMenu: true
        };
      }
    }

    if (input.classification.confidence < 0.45) {
      return this.handoffToHuman(input, "low_confidence", knowledge);
    }

    if (intent === "human_help") {
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
          "Consigo te ajudar com a ativacao, mas nao libero codigo automaticamente. Se ja pagou, envie o comprovante por aqui para conferencia manual.",
        menu: CONTINUATION_MENU,
        sendTextBeforeMenu: true
      };
    }

    if (intent === "free_trial" || isFreeTrialMessage(message)) {
      return this.handoffToHuman(
        input,
        "free_trial_activation",
        knowledge,
        "Claro! O teste gratis e de 3 dias. Vou te encaminhar para ativacao do teste agora."
      );
    }

    if (intent === "ask_price") {
      const plans = await this.plansService.listActivePlans();
      const menu = plans.length ? buildPlansMenu(plans) : null;
      return {
        reply: menu?.fallbackText || "Ainda nao encontrei planos ativos cadastrados. Vou encaminhar para atendimento humano conferir.",
        menu: menu || undefined
      };
    }

    if (intent === "pix_payment" || isPixPaymentMessage(message)) {
      return this.generatePixPayment(input, knowledge);
    }

    if (intent === "card_payment") {
      return this.generateCardPayment(input, knowledge);
    }

    if (intent === "ask_payment") {
      return { reply: PAYMENT_MENU.fallbackText, menu: PAYMENT_MENU };
    }

    if (isPaymentDoneMessage(message)) {
      return {
        reply:
          "FEITO. Vou aguardar a confirmacao automatica do Mercado Pago. Assim que o webhook confirmar o pagamento do pedido, sigo para liberacao do acesso."
      };
    }

    if (intent === "receipt_sent") {
      return {
        reply: "Envie a foto ou o PDF do comprovante aqui na conversa. O pagamento sera encaminhado para validacao.",
        menu: CONTINUATION_MENU,
        sendTextBeforeMenu: true
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
        const menu = plans.length ? buildPlansMenu(plans) : null;
        return {
          reply: menu?.fallbackText || "Entendi que voce quer comprar, mas nao encontrei planos ativos cadastrados. Vou encaminhar para atendimento humano.",
          menu: menu || undefined
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
            "Encontrei esse plano, mas o valor ainda precisa ser confirmado no cadastro. Vou encaminhar para atendimento humano finalizar seu pedido com seguranca."
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
        reply: `Pedido criado: ${order.order_number}\nPlano: ${plan.name} - ${formatMoney(plan.price_cents, plan.currency)}\n\n${PAYMENT_MENU.fallbackText}`,
        menu: PAYMENT_MENU
      };
    }

    if (intent === "technical_support") {
      const preferredCategory = getSupportKnowledgeCategory(message);
      const supportKnowledge =
        knowledge.find((article) => article.category === preferredCategory) ||
        knowledge.find((article) => article.category === "technical_support");
      if (isInstallationMessage(message)) {
        return { reply: DEVICE_MENU.fallbackText, menu: DEVICE_MENU };
      }

      const supportReply =
        supportKnowledge?.content ||
        "Me diga qual aparelho/app voce usa, o erro que aparece e se sua internet esta funcionando. Assim eu te ajudo melhor.";
      return {
        reply: supportReply,
        menu: CONTINUATION_MENU,
        sendTextBeforeMenu: true
      };
    }

    if (intent === "greeting") {
      return { reply: `Ola! Seja bem-vindo a UNiTV.\n\n${MAIN_MENU.fallbackText}`, menu: MAIN_MENU };
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
      const menu = plans.length ? buildPlansMenu(plans) : null;
      return {
        reply: menu?.fallbackText || "Ainda nao encontrei um pedido aberto. Vou encaminhar para atendimento humano.",
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
        "Encontrei seu pedido, mas nao consegui identificar o plano para gerar o link do cartao. Vou encaminhar para atendimento humano."
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
        `Seu pedido ${String(order.order_number)} esta aberto, mas nao consegui gerar o link do cartao agora. Vou encaminhar para atendimento humano.`
      );
    }
  }

  private async generatePixPayment(
    input: CommercialReplyInput,
    knowledge: Array<{ category?: string; content?: string }>
  ): Promise<CommercialReplyResult> {
    const order = await this.ordersService.findLatestOpenOrderByCustomerId(input.customer.id);
    if (!order) {
      const plans = await this.plansService.listActivePlans();
      const menu = plans.length ? buildPlansMenu(plans) : null;
      return {
        reply: menu?.fallbackText || "Ainda nao encontrei um pedido aberto. Vou encaminhar para atendimento humano.",
        menu: menu || undefined
      };
    }

    const metadata = readOrderMetadata(order);
    const existingQrCode = readMetadataString(metadata, "mercado_pago_pix_qr_code");
    const existingTicketUrl = readMetadataString(metadata, "mercado_pago_pix_ticket_url");
    if (existingQrCode) {
      return {
        order,
        reply: formatPixReply(order, existingQrCode, existingTicketUrl)
      };
    }

    const plan = readOrderPlan(order);
    if (!order.plan_id) {
      return this.handoffToHuman(
        input,
        "pix_order_plan_missing",
        knowledge,
        "Encontrei seu pedido, mas nao consegui identificar o plano para gerar o Pix. Vou encaminhar para atendimento humano."
      );
    }

    try {
      const pix = await this.mercadoPagoService.createPixPayment({
        order: {
          id: String(order.id),
          order_number: String(order.order_number),
          customer_id: String(order.customer_id),
          plan_id: String(order.plan_id),
          amount_cents: Number(order.amount_cents),
          currency: String(order.currency || "BRL")
        },
        plan,
        payer: { email: buildMercadoPagoPixEmail(order, input.customer.id) }
      });

      await this.ordersService.updateOrder(String(order.id), {
        payment_provider: "mercado_pago",
        payment_reference: pix.id,
        metadata: {
          ...metadata,
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
        reply: formatPixReply(order, pix.qrCode, pix.ticketUrl),
        media: {
          base64: pix.qrCodeBase64,
          mimetype: "image/png",
          fileName: `pix-${String(order.order_number)}.png`,
          caption: `QR Code Pix do pedido ${String(order.order_number)}`
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
        `Seu pedido ${String(order.order_number)} esta aberto, mas nao consegui gerar o Pix agora. Vou encaminhar para atendimento humano.`
      );
    }
  }

  private async handoffToHuman(
    input: CommercialReplyInput,
    reason: string,
    knowledge: Array<{ category?: string; content?: string }> = [],
    reply = "Vou encaminhar para atendimento humano te ajudar melhor. Enquanto isso, pode me mandar mais detalhes por aqui."
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

function formatMoney(priceCents: number, currency = "BRL") {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency
  }).format(priceCents / 100);
}

function formatPlan(plan: { name: string; price_cents: number; currency?: string; duration_days?: number | null }) {
  const duration = plan.duration_days ? ` (${plan.duration_days} dias)` : "";
  const price = Number(plan.price_cents) > 0 ? formatMoney(plan.price_cents, plan.currency) : "gratis";
  return `- ${plan.name}${duration}: ${price}`;
}

function isFreeTrialMessage(message: string) {
  return /\b(teste|gratis|gratuito|free trial)\b/i.test(message);
}

function isPixPaymentMessage(message: string) {
  return /\b(pix|chave pix|copia e cola|qr code)\b/i.test(message);
}

function isPaymentDoneMessage(message: string) {
  return /^(feito|paguei|pagamento feito|ja paguei|j[aá] paguei)$/i.test(message.trim());
}

function isInstallationMessage(message: string) {
  return /\b(instalar|instalacao|downloader|aparelho|smart tv|tv box|android|iphone|computador)\b/i.test(message);
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

function formatPixReply(order: Record<string, unknown>, qrCode: string, ticketUrl: string | null) {
  const link = ticketUrl ? `\n\nAbrir instrucoes e QR Code:\n${ticketUrl}` : "";
  return `PIX do pedido ${String(order.order_number)}:\n\nCopia e Cola:\n${qrCode}${link}\n\nA confirmacao e automatica pelo Mercado Pago. Nao precisa enviar comprovante.`;
}

function formatCardReply(checkoutUrl: string) {
  return `PAGUE COM CARTAO AQUI ABAIXO\n${checkoutUrl}`;
}

function buildMercadoPagoPixEmail(order: Record<string, unknown>, customerId: string) {
  const reference = String(order.order_number || order.id || customerId).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `pix-${reference}@unitv.local`;
}
