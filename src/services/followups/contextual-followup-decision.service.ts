import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createOpenAIClient, getSalesAgentOpenAIModel, getStrongSalesAgentOpenAIModel } from "@/lib/openai/client";

const followupDecisionSchema = z.object({
  should_send_followup: z.boolean(),
  followup_type: z.enum([
    "none",
    "values_check",
    "plan_choice",
    "payment_check",
    "trial_check",
    "download_check",
    "install_check",
    "reseller_check",
    "support_check"
  ]),
  reason: z.string().min(1),
  conversation_summary: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  suggested_message: z.string().nullable(),
  cancel_existing_followup: z.boolean(),
  new_stage: z.string().nullable(),
  new_followup_key: z.string().nullable(),
  confidence: z.number().min(0).max(1)
});

export type FollowupDecision = z.infer<typeof followupDecisionSchema>;

export type FollowupContextMessage = {
  id?: string | null;
  role?: string | null;
  content?: string | null;
  created_at?: string | null;
  external_message_id?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type FollowupContext = {
  conversation_id: string;
  customer_id: string | null;
  phone: string | null;
  now: string;
  metadata: Record<string, unknown>;
  lead_profile: Record<string, unknown>;
  recent_messages: FollowupContextMessage[];
  latest_customer_message: FollowupContextMessage | null;
  latest_bot_message: FollowupContextMessage | null;
  latest_human_message: FollowupContextMessage | null;
  last_speaker: string | null;
  last_customer_was_answered: boolean;
  last_bot_question: string | null;
  last_human_question: string | null;
  open_order: Record<string, unknown> | null;
  latest_order: Record<string, unknown> | null;
  human_hold_active: boolean;
  followup_key: string | null;
  followup_due_at: string | null;
  last_followup_text_hash: string | null;
  last_followup_context_hash: string | null;
};

const SYSTEM_PROMPT = [
  "Voce decide follow-up contextual para o WhatsApp comercial da UNITV.",
  "Retorne somente JSON no schema.",
  "Analise o historico completo, nao apenas a ultima mensagem.",
  "Follow-up so deve ser enviado quando a conversa realmente precisa de uma proxima mensagem agora.",
  "Nao use mensagens genericas quando o contexto mostrar uma etapa especifica.",
  "Nunca confirme pagamento, nunca invente Pix, preco, codigo ou compatibilidade.",
  "Se humano esta conduzindo ou cliente disse que avisaria se tivesse problema, cancele ou reprograme.",
  "Se for revenda, nao use fluxo de cliente final.",
  "Se pagamento estiver pago/confirmado, nao cobre Pix.",
  "Mensagens devem ser curtas, humanas e com no maximo uma pergunta."
].join("\n");

export class ContextualFollowupDecisionService {
  async decide(context: FollowupContext): Promise<FollowupDecision> {
    const deterministic = decideFollowupDeterministically(context);
    if (deterministic.confidence >= 0.92 || !process.env.OPENAI_API_KEY) {
      return deterministic;
    }

    try {
      const response = await createOpenAIClient().responses.create({
        model: shouldUseStrongModel(context) ? getStrongSalesAgentOpenAIModel() : getSalesAgentOpenAIModel(),
        input: [
          { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
          { role: "user", content: [{ type: "input_text", text: JSON.stringify(context) }] }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "unitv_followup_decision",
            schema: toJsonSchema(),
            strict: true
          }
        }
      });

      const parsed = followupDecisionSchema.safeParse(JSON.parse(response.output_text || "{}"));
      return parsed.success ? parsed.data : deterministic;
    } catch {
      return deterministic;
    }
  }
}

export function decideFollowupDeterministically(context: FollowupContext): FollowupDecision {
  const textWindow = normalize(
    context.recent_messages
      .slice(-20)
      .map((message) => message.content || "")
      .join("\n")
  );
  const lastCustomer = normalize(context.latest_customer_message?.content || "");
  const profile = context.lead_profile || {};
  const followupKey = String(context.followup_key || "");
  const latestOrderStatus = String(context.latest_order?.status || context.open_order?.status || profile.payment_status || "");

  if (context.human_hold_active) {
    return cancelDecision("Atendimento humano recente ainda esta ativo.", "Humano falou recentemente e o bot deve aguardar.", ["human_hold_active=true"], "human_support", 0.98);
  }

  if (isResellerContext(textWindow, profile)) {
    const humanLeading = context.latest_human_message && context.last_speaker !== "customer";
    if (humanLeading || context.last_human_question) {
      return cancelDecision(
        "Conversa entrou em fluxo de revenda e o humano esta conduzindo.",
        "Cliente pediu revenda e Andre conduziu perguntas sobre rounds/valor.",
        collectEvidence(context, ["revenda", "revendedor", "rounds", "valor"]),
        "human_support_reseller",
        0.98,
        "reseller_flow"
      );
    }

    return sendDecision({
      type: "reseller_check",
      reason: "Cliente esta em fluxo de revenda e precisa de follow-up especifico, nao Pix ou plano final.",
      summary: "Conversa trata de revenda/rounds.",
      evidence: collectEvidence(context, ["revenda", "revendedor", "rounds"]),
      message: "Conseguiu ver certinho sobre os rounds?",
      stage: "reseller_flow",
      key: "reseller_check",
      confidence: 0.93
    });
  }

  if (customerStartedTesting(textWindow)) {
    return cancelDecision(
      "Cliente ja comecou a testar e disse que avisaria se tivesse problema.",
      "Cliente recebeu suporte e entrou em modo de teste/self-monitoring.",
      collectEvidence(context, ["vou comecar a testar", "qualquer problema", "aviso", "👍"]),
      "active_trial",
      0.97,
      "trial_check",
      distantTrialDue(context.now)
    );
  }

  if (customerResolvedInstall(textWindow)) {
    return cancelDecision(
      "Cliente indicou que baixou/instalou/deu certo.",
      "Etapa de download ou instalacao foi resolvida.",
      collectEvidence(context, ["ja baixei", "instalei", "deu certo", "consegui"]),
      "active",
      0.96
    );
  }

  if (latestOrderStatus === "paid" || latestOrderStatus === "confirmed" || profile.codigo_enviado === true) {
    return cancelDecision("Pagamento ja foi confirmado ou codigo ja foi enviado.", "Nao deve cobrar Pix apos pagamento confirmado.", ["payment_status=paid/confirmed"], "paid", 0.99);
  }

  if (followupKey === "pix" || followupKey === "payment_choice" || followupKey === "payment_check") {
    if (!hasPendingPixOrder(context)) {
      return cancelDecision("Nao existe pedido/Pix pendente para cobrar.", "Follow-up de Pix sem pedido aberto seria fora de contexto.", ["open_order=null"], null, 0.97);
    }

    return sendDecision({
      type: "payment_check",
      reason: "Existe pedido pendente com Pix e o cliente ainda nao retornou.",
      summary: "Cliente tem pagamento pendente.",
      evidence: [`order_status=${String(context.open_order?.status || "")}`],
      message: "Conseguiu finalizar o Pix? Se precisar, eu te envio de novo.",
      stage: "awaiting_payment",
      key: "pix",
      confidence: 0.93
    });
  }

  if (followupKey === "download" || followupKey === "install") {
    const passwordContext = /\b(senha|criar uma senha|formato da senha)\b/.test(textWindow);
    return sendDecision({
      type: passwordContext ? "install_check" : "download_check",
      reason: "Cliente ainda nao confirmou conclusao da etapa de instalacao.",
      summary: passwordContext ? "Cliente estava criando senha no app." : "Cliente estava no fluxo de download/instalacao.",
      evidence: collectEvidence(context, passwordContext ? ["senha"] : ["baixar", "instalar", "app"]),
      message: passwordContext ? "Conseguiu criar a senha e entrar certinho?" : "Conseguiu abrir o app e chegar na tela de login?",
      stage: "install_support",
      key: followupKey,
      confidence: 0.86
    });
  }

  if (followupKey === "values" || followupKey === "plan_choice") {
    return sendDecision({
      type: followupKey === "plan_choice" ? "plan_choice" : "values_check",
      reason: "Cliente recebeu valores e ainda nao escolheu o proximo passo.",
      summary: "Conversa esta em escolha de plano.",
      evidence: collectEvidence(context, ["mensal", "anual", "valores", "plano"]),
      message: followupKey === "plan_choice" ? "Qual plano voce prefere seguir: mensal, trimestral ou anual?" : "Te ajudo a escolher o melhor plano. Voce quer mensal, trimestral ou anual?",
      stage: "plan_selected",
      key: followupKey,
      confidence: 0.87
    });
  }

  if (followupKey === "welcome_activation" || followupKey === "test") {
    const recoveryStep = readRecoveryStep(context);
    const trialMessage = buildTrialRecoveryMessage(context, recoveryStep);
    return sendDecision({
      type: "trial_check",
      reason: "Lead inicial sem resposta apos abordagem.",
      summary: "Cliente ainda nao informou se quer teste ou ativacao.",
      evidence: collectEvidence(context, ["teste", "ativar", "recarga"]),
      message: trialMessage,
      stage: "qualified",
      key: "welcome_activation",
      confidence: 0.88
    });
  }

  return cancelDecision("Contexto insuficiente para follow-up automatico.", "Sem proxima acao automatica segura.", [], null, 0.78);
}

function sendDecision(input: {
  type: FollowupDecision["followup_type"];
  reason: string;
  summary: string;
  evidence: string[];
  message: string;
  stage: string | null;
  key: string | null;
  confidence: number;
}): FollowupDecision {
  return {
    should_send_followup: true,
    followup_type: input.type,
    reason: input.reason,
    conversation_summary: input.summary,
    evidence: input.evidence,
    suggested_message: input.message,
    cancel_existing_followup: false,
    new_stage: input.stage,
    new_followup_key: input.key,
    confidence: input.confidence
  };
}

function cancelDecision(
  reason: string,
  summary: string,
  evidence: string[],
  stage: string | null,
  confidence: number,
  newFollowupKey: string | null = null,
  newFollowupDueAt?: string | null
): FollowupDecision & { new_followup_due_at?: string | null } {
  return {
    should_send_followup: false,
    followup_type: "none",
    reason,
    conversation_summary: summary,
    evidence,
    suggested_message: null,
    cancel_existing_followup: true,
    new_stage: stage,
    new_followup_key: newFollowupKey,
    confidence,
    ...(newFollowupDueAt ? { new_followup_due_at: newFollowupDueAt } : {})
  };
}

export function buildFollowupContextHash(input: unknown) {
  return hashText(JSON.stringify(input));
}

export function hashText(value: string) {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isResellerContext(text: string, profile: Record<string, unknown>) {
  return Boolean(profile.reseller_intent || profile.stage === "reseller_flow" || /\b(revenda|revendedor|revender|painel|rounds|creditos|cr[eé]ditos|recarga com revendedor|valor que fazia|comecar com quantos)\b/.test(text));
}

function customerStartedTesting(text: string) {
  return /\b(vou comecar a testar|vou começar a testar|comecar a testar|qualquer problema.*aviso|te aviso|eu aviso|beleza)\b/.test(text);
}

function customerResolvedInstall(text: string) {
  return /\b(ja baixei|baixei|ja instalei|instalei|consegui instalar|deu certo|entrei certinho|funcionou)\b/.test(text);
}

function hasPendingPixOrder(context: FollowupContext) {
  const order = context.open_order;
  if (!order) {
    return false;
  }

  const status = String(order.status || "");
  const paymentMethod = String(order.payment_method || context.lead_profile.payment_method || "");
  const hasPixReference = Boolean(order.payment_reference || order.metadata || context.lead_profile.pix_code || context.lead_profile.pediu_pix);
  return ["draft", "pending_payment", "manual_review", "receipt_under_review"].includes(status) && (paymentMethod === "pix" || hasPixReference);
}

function collectEvidence(context: FollowupContext, terms: string[]) {
  const normalizedTerms = terms.map(normalize);
  return context.recent_messages
    .filter((message) => {
      const content = normalize(message.content || "");
      return normalizedTerms.some((term) => term && content.includes(term));
    })
    .slice(-4)
    .map((message) => `${message.role || "unknown"}: ${String(message.content || "").slice(0, 140)}`);
}

function readRecoveryStep(context: FollowupContext) {
  const raw = Number(context.metadata.lead_recovery_followup_step || 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function buildTrialRecoveryMessage(context: FollowupContext, recoveryStep: number) {
  const firstName = readFirstName(context.lead_profile.nome || context.latest_customer_message?.metadata?.pushName);
  const prefix = firstName ? `${firstName}, ` : "";

  if (recoveryStep <= 0) {
    return firstName
      ? `${prefix}voce ja usou o UNITV? Se nao, posso liberar 3 dias gratis. Qual aparelho voce quer testar?`
      : "Voce ja usou o UNITV? Se nao, posso liberar 3 dias gratis. Qual aparelho voce quer testar?";
  }

  if (recoveryStep === 1) {
    return firstName
      ? `${prefix}passando rapidinho: se ainda quiser testar, eu libero 3 dias e te ajudo pelo aparelho que voce usa. Qual aparelho seria?`
      : "Passando rapidinho: se ainda quiser testar, eu libero 3 dias e te ajudo pelo aparelho que voce usa. Qual aparelho seria?";
  }

  return firstName
    ? `${prefix}ultima tentativa por aqui hoje: quer que eu deixe o teste de 3 dias encaminhado pra voce?`
    : "Ultima tentativa por aqui hoje: quer que eu deixe o teste de 3 dias encaminhado pra voce?";
}

function readFirstName(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().split(/\s+/)[0]?.replace(/[^\p{L}'-]/gu, "") || "";
}

function distantTrialDue(now: string) {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Date(date.getTime() + 20 * 60 * 60 * 1000).toISOString();
}

function shouldUseStrongModel(context: FollowupContext) {
  const text = normalize(context.recent_messages.map((message) => message.content || "").join("\n"));
  return /\b(revenda|revendedor|pix|comprovante|pagamento|senha|erro|reclama|cancelar)\b/.test(text);
}

function toJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      should_send_followup: { type: "boolean" },
      followup_type: { type: "string", enum: ["none", "values_check", "plan_choice", "payment_check", "trial_check", "download_check", "install_check", "reseller_check", "support_check"] },
      reason: { type: "string" },
      conversation_summary: { type: "string" },
      evidence: { type: "array", items: { type: "string" } },
      suggested_message: { type: ["string", "null"] },
      cancel_existing_followup: { type: "boolean" },
      new_stage: { type: ["string", "null"] },
      new_followup_key: { type: ["string", "null"] },
      confidence: { type: "number" }
    },
    required: ["should_send_followup", "followup_type", "reason", "conversation_summary", "evidence", "suggested_message", "cancel_existing_followup", "new_stage", "new_followup_key", "confidence"]
  };
}
