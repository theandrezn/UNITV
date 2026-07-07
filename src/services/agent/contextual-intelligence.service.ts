import "server-only";
import { z } from "zod";
import { createOpenAIClient, getSalesAgentOpenAIModel, getStrongSalesAgentOpenAIModel } from "@/lib/openai/client";

const commercialIntentSchema = z.enum([
  "activate",
  "renew",
  "ask_price",
  "choose_plan",
  "request_pix",
  "request_card",
  "payment_sent",
  "receipt_sent",
  "ask_download",
  "download_issue",
  "confirmation_yes",
  "confirmation_no",
  "already_downloaded",
  "installed_success",
  "compatibility_question",
  "objection",
  "human_help",
  "unknown"
]);

const commercialStageSchema = z.enum([
  "new",
  "qualified",
  "plan_selected",
  "checkout",
  "awaiting_payment",
  "paid",
  "download_support",
  "install_support",
  "active",
  "human_support"
]);

const planSchema = z.enum(["mensal", "trimestral", "semestral", "anual", "teste"]).nullable();
const paymentMethodSchema = z.enum(["pix", "card"]).nullable();
const nextExpectedReplySchema = z.enum([
  "activation_or_renewal",
  "plan_choice",
  "payment_method",
  "payment_proof",
  "download_confirmation",
  "install_confirmation"
]).nullable();
const installStatusSchema = z.enum(["not_sent", "link_sent", "downloaded", "installed", "failed"]).nullable();

export const contextualDecisionSchema = z.object({
  intent: commercialIntentSchema,
  stage: commercialStageSchema,
  selected_plan: planSchema,
  payment_method: paymentMethodSchema,
  should_create_order: z.boolean(),
  should_generate_pix: z.boolean(),
  should_send_download: z.boolean(),
  should_schedule_followup: z.boolean(),
  customer_message_meaning: z.string().min(1),
  next_expected_reply: nextExpectedReplySchema,
  install_status: installStatusSchema.optional().nullable(),
  confidence: z.number().min(0).max(1)
});

export type ContextualDecision = z.infer<typeof contextualDecisionSchema>;

export type CommercialContext = {
  current_message: string;
  recent_messages: Array<{ role?: string; content?: string | null }>;
  lead_profile: Record<string, unknown>;
  open_order: Record<string, unknown> | null;
  latest_order: Record<string, unknown> | null;
  last_bot_question: string | null;
  last_bot_message_at: string | null;
  last_specialist_message_at: string | null;
  followup_key: string | null;
  followup_due_at: string | null;
  human_hold_active: boolean;
};

const SYSTEM_PROMPT = [
  "Voce e um extrator de contexto comercial UNITV.",
  "Retorne somente JSON valido no schema solicitado.",
  "Interprete historico, lead_profile, pedido aberto e ultima pergunta do bot.",
  "Voce NAO executa acoes, NAO confirma pagamento, NAO cria Pix, NAO entrega codigo.",
  "Precos oficiais: mensal R$25, trimestral R$70, semestral R$120, anual R$200.",
  "Se a mensagem curta depender da ultima pergunta, use o historico para inferir.",
  "Se cliente escolheu plano e pede Pix, marque request_pix, should_generate_pix=true.",
  "Se nao houver plano selecionado para Pix, should_generate_pix=false.",
  "Se cliente disse que baixou/conseguiu, marque already_downloaded ou installed_success.",
  "Se cliente disse que nao deu/erro/nao conseguiu, marque download_issue."
].join("\n");

export class ContextualIntelligenceService {
  async extract(input: { context: CommercialContext; useStrongModel?: boolean }): Promise<ContextualDecision> {
    const deterministic = extractDeterministicDecision(input.context);
    if (deterministic.confidence >= 0.92 || !process.env.OPENAI_API_KEY) {
      return deterministic;
    }

    try {
      const client = createOpenAIClient();
      const response = await client.responses.create({
        model: input.useStrongModel ? getStrongSalesAgentOpenAIModel() : getSalesAgentOpenAIModel(),
        input: [
          { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
          { role: "user", content: [{ type: "input_text", text: JSON.stringify(input.context) }] }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "unitv_contextual_decision",
            schema: toJsonSchema(),
            strict: true
          }
        }
      });

      const parsed = contextualDecisionSchema.safeParse(JSON.parse(response.output_text || "{}"));
      return parsed.success ? parsed.data : deterministic;
    } catch {
      return deterministic;
    }
  }
}

export function extractDeterministicDecision(context: CommercialContext): ContextualDecision {
  const normalized = normalize(context.current_message);
  const leadProfile = context.lead_profile || {};
  const selectedPlan = normalizePlan(leadProfile.selected_plan || leadProfile.plano_interesse);
  const lastQuestion = normalize(String(context.last_bot_question || leadProfile.last_bot_question || ""));
  const openOrder = context.open_order;
  const base = buildDecision({
    intent: "unknown",
    stage: normalizeStage(leadProfile.stage || leadProfile.etapa_atual),
    selected_plan: selectedPlan,
    payment_method: normalizePaymentMethod(leadProfile.payment_method),
    customer_message_meaning: "Mensagem ainda sem intencao comercial clara.",
    confidence: 0.45
  });

  if (/\b(comprovante|recibo|print)\b/.test(normalized)) {
    return buildDecision({
      ...base,
      intent: "receipt_sent",
      stage: "awaiting_payment",
      selected_plan: selectedPlan,
      payment_method: "pix",
      customer_message_meaning: "Cliente enviou ou mencionou comprovante; pagamento ainda depende de confirmacao do provedor.",
      next_expected_reply: "payment_proof",
      confidence: 0.94
    });
  }

  if (/\b(ja baixei|baixei|download feito|fiz o download)\b/.test(normalized)) {
    return buildDecision({
      ...base,
      intent: "already_downloaded",
      stage: "install_support",
      selected_plan: selectedPlan,
      install_status: "downloaded",
      customer_message_meaning: "Cliente informou que ja baixou o app.",
      next_expected_reply: "install_confirmation",
      confidence: 0.97
    });
  }

  if (/\b(ja instalei|instalei|instalado|consegui instalar)\b/.test(normalized)) {
    return buildDecision({
      ...base,
      intent: "installed_success",
      stage: "qualified",
      selected_plan: selectedPlan,
      install_status: "installed",
      customer_message_meaning: "Cliente informou que instalou com sucesso.",
      next_expected_reply: "activation_or_renewal",
      confidence: 0.97
    });
  }

  if (/\b(nao consegui|nao deu|erro|nao abre|nao baixa|link nao funciona|codigo nao deu|codigo n[aã]o deu)\b/.test(normalized)) {
    return buildDecision({
      ...base,
      intent: "download_issue",
      stage: "download_support",
      selected_plan: selectedPlan,
      install_status: "failed",
      should_schedule_followup: true,
      customer_message_meaning: "Cliente teve problema no download ou instalacao.",
      next_expected_reply: "download_confirmation",
      confidence: 0.95
    });
  }

  const plan = normalizePlan(normalized);
  if (plan) {
    const askedPixBefore = /\b(pix|chave|pagamento)\b/.test(lastQuestion) || leadProfile.pediu_pix === true;
    return buildDecision({
      ...base,
      intent: "choose_plan",
      stage: askedPixBefore ? "checkout" : "plan_selected",
      selected_plan: plan,
      payment_method: askedPixBefore ? "pix" : null,
      should_create_order: askedPixBefore,
      should_generate_pix: askedPixBefore,
      customer_message_meaning: askedPixBefore
        ? "Cliente escolheu o plano depois de pedir Pix; deve seguir para pagamento."
        : "Cliente escolheu um plano.",
      next_expected_reply: askedPixBefore ? "payment_proof" : "payment_method",
      confidence: 0.96
    });
  }

  const wantsPix = /\b(pix|chave pix|copia e cola|qr code)\b/.test(normalized) ||
    (/^(sim|s|ok|quero|manda|pode|pode ser|isso)$/.test(normalized) && /\b(pix|gerar|chave)\b/.test(lastQuestion));
  if (wantsPix) {
    return buildDecision({
      ...base,
      intent: "request_pix",
      stage: selectedPlan || openOrder ? "checkout" : "qualified",
      selected_plan: selectedPlan,
      payment_method: "pix",
      should_create_order: Boolean(selectedPlan && !openOrder),
      should_generate_pix: Boolean(selectedPlan || openOrder),
      customer_message_meaning: selectedPlan || openOrder
        ? "Cliente quer pagar por Pix usando o contexto comercial atual."
        : "Cliente pediu Pix, mas ainda nao ha plano selecionado.",
      next_expected_reply: selectedPlan || openOrder ? "payment_proof" : "plan_choice",
      confidence: 0.96
    });
  }

  if (/^(sim|s|ok|quero|pode|pode ser|isso)$/.test(normalized)) {
    if (/\b(ativar|renovar|recarga|novo plano)\b/.test(lastQuestion)) {
      return buildDecision({
        ...base,
        intent: "activate",
        stage: "qualified",
        selected_plan: selectedPlan,
        customer_message_meaning: "Cliente confirmou interesse em ativacao/recarga.",
        next_expected_reply: selectedPlan ? "payment_method" : "plan_choice",
        confidence: 0.9
      });
    }
    if (/\b(baixou|download|conseguiu|instalou)\b/.test(lastQuestion)) {
      return buildDecision({
        ...base,
        intent: "already_downloaded",
        stage: "install_support",
        selected_plan: selectedPlan,
        install_status: "downloaded",
        customer_message_meaning: "Cliente confirmou que conseguiu baixar ou avançar.",
        next_expected_reply: "install_confirmation",
        confidence: 0.93
      });
    }
  }

  if (/\b(ativar|ativacao|liberar)\b/.test(normalized)) {
    return buildDecision({
      ...base,
      intent: "activate",
      stage: "qualified",
      selected_plan: selectedPlan,
      customer_message_meaning: "Cliente quer ativar acesso.",
      next_expected_reply: selectedPlan ? "payment_method" : "plan_choice",
      confidence: 0.9
    });
  }

  if (/\b(renovar|recarga|recarregar)\b/.test(normalized)) {
    return buildDecision({
      ...base,
      intent: "renew",
      stage: "qualified",
      selected_plan: selectedPlan,
      customer_message_meaning: "Cliente quer renovar ou fazer recarga.",
      next_expected_reply: selectedPlan ? "payment_method" : "plan_choice",
      confidence: 0.9
    });
  }

  return base;
}

function buildDecision(input: Partial<ContextualDecision> & Pick<ContextualDecision, "intent" | "stage" | "customer_message_meaning" | "confidence">): ContextualDecision {
  return {
    selected_plan: null,
    payment_method: null,
    should_create_order: false,
    should_generate_pix: false,
    should_send_download: false,
    should_schedule_followup: true,
    next_expected_reply: null,
    install_status: null,
    ...input
  };
}

function normalize(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizePlan(value: unknown): ContextualDecision["selected_plan"] {
  const normalized = normalize(value).replace(/\s+/g, "_");
  if (!normalized) return null;
  if (normalized.includes("mensal") || normalized === "mes" || normalized === "30_dias") return "mensal";
  if (normalized.includes("trimestral") || normalized.includes("3_meses")) return "trimestral";
  if (normalized.includes("semestral") || normalized.includes("6_meses")) return "semestral";
  if (normalized.includes("anual") || normalized.includes("1_ano")) return "anual";
  if (normalized.includes("teste")) return "teste";
  return null;
}

function normalizePaymentMethod(value: unknown): ContextualDecision["payment_method"] {
  const normalized = normalize(value);
  if (normalized.includes("pix")) return "pix";
  if (normalized.includes("card") || normalized.includes("cartao")) return "card";
  return null;
}

function normalizeStage(value: unknown): ContextualDecision["stage"] {
  const normalized = normalize(value);
  if (normalized.includes("pagamento") || normalized.includes("checkout")) return "checkout";
  if (normalized.includes("instal")) return "install_support";
  if (normalized.includes("download")) return "download_support";
  if (normalized.includes("comprovante") || normalized.includes("pix")) return "awaiting_payment";
  if (normalized.includes("recarga") || normalized.includes("escolha")) return "qualified";
  return "new";
}

function toJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      intent: { type: "string", enum: commercialIntentSchema.options },
      stage: { type: "string", enum: commercialStageSchema.options },
      selected_plan: { type: ["string", "null"], enum: ["mensal", "trimestral", "semestral", "anual", "teste", null] },
      payment_method: { type: ["string", "null"], enum: ["pix", "card", null] },
      should_create_order: { type: "boolean" },
      should_generate_pix: { type: "boolean" },
      should_send_download: { type: "boolean" },
      should_schedule_followup: { type: "boolean" },
      customer_message_meaning: { type: "string" },
      next_expected_reply: { type: ["string", "null"], enum: ["activation_or_renewal", "plan_choice", "payment_method", "payment_proof", "download_confirmation", "install_confirmation", null] },
      install_status: { type: ["string", "null"], enum: ["not_sent", "link_sent", "downloaded", "installed", "failed", null] },
      confidence: { type: "number", minimum: 0, maximum: 1 }
    },
    required: [
      "intent",
      "stage",
      "selected_plan",
      "payment_method",
      "should_create_order",
      "should_generate_pix",
      "should_send_download",
      "should_schedule_followup",
      "customer_message_meaning",
      "next_expected_reply",
      "install_status",
      "confidence"
    ]
  } as const;
}
