import "server-only";
import type { IntentClassification } from "./intent-classifier.service";
import { sanitizeReply } from "@/lib/agent/reply-safety";
import { AppSettingsService } from "@/services/app-settings.service";
import { AgentActionsService } from "@/services/agent-actions.service";
import { AuditService } from "@/services/audit.service";
import { KnowledgeService } from "@/services/knowledge/knowledge.service";
import { OrdersService } from "@/services/orders.service";
import { PlansService } from "@/services/plans.service";

export const INITIAL_UNITV_REPLY =
  "Ola! Sou o atendimento automatico da UniTV. Posso te ajudar com planos, renovacao, ativacao ou suporte. Voce quer comprar, renovar ou precisa de ajuda com o app?";

const LOW_CONFIDENCE_REPLY = "Entendi. Voce quer comprar um plano, renovar um acesso ou falar com suporte?";

type CommercialReplyInput = {
  message: string;
  classification: IntentClassification;
  customer: { id: string };
  conversation: { id: string; metadata?: Record<string, unknown> | null };
  webhookEventId: string;
};

type CommercialReplyResult = {
  reply: string;
  order?: Record<string, unknown>;
  requiresHuman?: boolean;
};

export class ChatAgentService {
  constructor(
    private readonly plansService = new PlansService(),
    private readonly knowledgeService = new KnowledgeService(),
    private readonly ordersService = new OrdersService(),
    private readonly appSettingsService = new AppSettingsService(),
    private readonly agentActionsService = new AgentActionsService(),
    private readonly auditService = new AuditService()
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
          "Consigo te ajudar com a ativacao, mas nao libero codigo automaticamente. Se ja pagou, envie o comprovante por aqui para conferencia manual."
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
      return {
        reply: plans.length
          ? `Planos disponiveis:\n${plans.map(formatPlan).join("\n")}\n\nQual deles voce quer?`
          : "Ainda nao encontrei planos ativos cadastrados. Vou encaminhar para atendimento humano conferir."
      };
    }

    if (intent === "ask_payment" || intent === "card_payment") {
      return { reply: await this.appSettingsService.getPaymentInstructions() };
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
        return {
          reply: plans.length
            ? `Perfeito. Qual plano voce quer?\n${plans.map(formatPlan).join("\n")}`
            : "Entendi que voce quer comprar, mas nao encontrei planos ativos cadastrados. Vou encaminhar para atendimento humano."
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

      const paymentInstructions = await this.appSettingsService.getPaymentInstructions();
      const receiptHint = /comprovante/i.test(paymentInstructions)
        ? ""
        : "\n\nDepois envie o comprovante por aqui. A liberacao do codigo sera feita somente apos conferencia manual.";
      return {
        order,
        reply: `Pedido criado: ${order.order_number}\nPlano: ${plan.name} - ${formatMoney(plan.price_cents, plan.currency)}\n\n${paymentInstructions}${receiptHint}`
      };
    }

    if (intent === "technical_support") {
      const preferredCategory = getSupportKnowledgeCategory(message);
      const supportKnowledge =
        knowledge.find((article) => article.category === preferredCategory) ||
        knowledge.find((article) => article.category === "technical_support");
      return {
        reply:
          supportKnowledge?.content ||
          "Me diga qual aparelho/app voce usa, o erro que aparece e se sua internet esta funcionando. Assim eu te ajudo melhor."
      };
    }

    if (intent === "greeting") {
      return { reply: INITIAL_UNITV_REPLY };
    }

    return { reply: this.generateReply(input) };
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
