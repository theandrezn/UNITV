import "server-only";
import { validateConciseUnitvReply } from "@/lib/whatsapp/customer-message-safety";
import { z } from "zod";
import { createOpenAIClient, getSalesAgentOpenAIModel, getStrongSalesAgentOpenAIModel } from "@/lib/openai/client";
import { executeObservedOpenAICall } from "@/services/ai/openai-call-observer";
import { OPENAI_ECONOMY_POLICY } from "@/lib/openai/economy-policy";
import type { SpecialistLearningGuidance } from "@/services/agent/specialist-learning-guidance";
import { OFFICIAL_ALL_PLAN_PRICES_TEXT, OFFICIAL_MONTHLY_MAX_SCREENS, OFFICIAL_MONTHLY_OFFER_TEXT } from "@/lib/unitv/official-catalog";
import {
  CANONICAL_CONVERSATION_STATES,
  isAllowedConversationStateTransition,
  normalizeConversationState,
  resolveConversationState,
  type ConversationState
} from "@/lib/conversation-state";
import { getStructuredKnowledgeContext } from "@/lib/unitv/structured-knowledge";
import { findUnitvAuthoritativeKnowledgeReply } from "@/lib/unitv/objection-map";
import { UNITV_FIXED_INITIAL_GREETING } from "@/lib/unitv/agent-identity";
import { detectUnitvDevice, getUnitvInstallationGuidance, type UnitvDeviceId } from "@/lib/unitv/device-compatibility";
import {
  extractDirectiveContract,
  extractRequiredArtifacts,
  validateResponseAgainstDirectiveContract
} from "@/services/agent/contextual-response-ai.service";

const agentActionSchema = z.enum(["reply", "silent", "wait", "handoff", "backend_action"]);
const canonicalConversationStateSchema = z.enum(CANONICAL_CONVERSATION_STATES);

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
  "first_time_check",
  "trial_selection",
  "device_qualification",
  "download_instructions",
  "awaiting_download_installation",
  "plan_selected",
  "checkout",
  "awaiting_payment",
  "paid",
  "download_support",
  "install_support",
  "active",
  "human_support"
]);

const contextualDetectedIntentSchema = z.enum([
  "FREE_TRIAL_REQUEST",
  "PLAN_PRICE_REQUEST",
  "PLAN_DURATION_REQUEST",
  "PLAN_SCREEN_COVERAGE",
  "PLAN_SELECTION_MONTHLY",
  "PLAN_SELECTION_QUARTERLY",
  "PLAN_SELECTION_SEMIANNUAL",
  "PLAN_SELECTION_YEARLY",
  "DEVICE_ANDROID_PHONE",
  "DEVICE_ANDROID_PHONE_NEEDS_CONFIRMATION",
  "DEVICE_ANDROID_TV",
  "DEVICE_TV_BOX",
  "DEVICE_FIRE_STICK",
  "DEVICE_UNSUPPORTED_OR_NEEDS_CHECK",
  "PIX_REQUEST",
  "PIX_PERMISSION_CONFIRMED",
  "PAYMENT_INTENT",
  "PAYMENT_PROOF_SENT",
  "DOWNLOAD_HELP",
  "DOWNLOAD_CONFIRMED",
  "INSTALLATION_HELP",
  "RECHARGE_REQUEST",
  "HUMAN_NEEDED",
  "UNKNOWN_BUT_CLARIFIABLE",
  "UNKNOWN"
]);

const nextActionSchema = z.enum([
  "ask_device_for_trial",
  "confirm_android_phone",
  "send_android_download",
  "send_tvbox_download",
  "send_firestick_guidance",
  "ask_plan_preference",
  "show_monthly_plan",
  "answer_screen_coverage",
  "answer_plan_duration",
  "show_requested_prices",
  "send_pix",
  "ask_payment_method",
  "verify_payment",
  "ask_download_problem",
  "ask_installation_status",
  "continue_recharge_flow",
  "clarify_intent",
  "human_handoff",
  "no_safe_action"
]);

const planSchema = z.enum(["mensal", "trimestral", "semestral", "anual", "teste"]).nullable();
const paymentMethodSchema = z.enum(["pix", "card"]).nullable();
const nextExpectedReplySchema = z.enum([
  "activation_or_renewal",
  "plan_choice",
  "payment_method",
  "payment_proof",
  "download_confirmation",
  "device",
  "install_confirmation"
]).nullable();
const installStatusSchema = z.enum(["not_sent", "link_sent", "downloaded", "installed", "failed"]).nullable();

export const contextualDecisionSchema = z.object({
  action: agentActionSchema,
  next_state: canonicalConversationStateSchema,
  intent: commercialIntentSchema,
  detected_intent: contextualDetectedIntentSchema,
  stage: commercialStageSchema,
  selected_plan: planSchema,
  payment_method: paymentMethodSchema,
  should_create_order: z.boolean(),
  should_generate_pix: z.boolean(),
  should_send_download: z.boolean(),
  should_schedule_followup: z.boolean(),
  should_reply: z.boolean(),
  should_handoff: z.boolean(),
  should_clarify: z.boolean(),
  next_action: nextActionSchema,
  customer_message_meaning: z.string().min(1),
  reason: z.string().min(1),
  recommended_response: z.string(),
  next_expected_reply: nextExpectedReplySchema,
  install_status: installStatusSchema.optional().nullable(),
  confidence: z.number().min(0).max(1)
});

export type ContextualDecision = z.infer<typeof contextualDecisionSchema> & { source?: "deterministic" | "ai" };

const compactAIDecisionSchema = z.object({
  action: z.enum(["reply", "silent", "wait", "handoff"]),
  intent: commercialIntentSchema,
  next_state: canonicalConversationStateSchema,
  meaning: z.string().min(1).max(120),
  reason: z.string().min(1).max(120),
  reply: z.string().max(240),
  confidence: z.number().min(0).max(1)
});

export type CommercialContext = {
  conversation_id?: string | null;
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

export const CONTEXTUAL_DECISION_PROMPT_VERSION = "unitv-decision-v3-ultra-low";
export const CONTEXTUAL_DECISION_SYSTEM_PROMPT = [
  "Decida e escreva a resposta deste turno da UNITV. Retorne apenas o JSON solicitado.",
  "Prioridade: estado > ultima pergunta > cliente > humano > base.",
  "Passos: interprete; escolha uma acao; mantenha ou avance o estado; responda curto.",
  "Se houver guard, ele contem fatos e resultado obrigatorios: preserve-os, mas formule a frase agora com linguagem natural.",
  "Responda diretamente perguntas claras. Nao use pedido generico de esclarecimento quando o sentido puder ser inferido.",
  "Acoes: reply, silent, wait, handoff. Use silent em agradecimento ou encerramento.",
  "Handoff somente quando o cliente pedir humano ou tratar de revenda.",
  "Nunca execute Pix, pagamento, codigo ou download; o backend e a autoridade.",
  "Nunca saude conversa ativa, repita pergunta, invente fato ou regrida estado.",
  "Quando responder, use 6 a 15 palavras, no maximo 22, com um unico proximo passo."
].join("\n");

export class ContextualIntelligenceService {
  async extract(input: { context: CommercialContext; useStrongModel?: boolean; specialistLearning?: SpecialistLearningGuidance | null }): Promise<ContextualDecision> {
    const deterministic = extractDeterministicDecision(input.context);
    if (!process.env.OPENAI_API_KEY || !shouldUseAIWording(deterministic)) {
      return { ...deterministic, source: "deterministic" };
    }

    try {
      const client = createOpenAIClient();
      const model = input.useStrongModel ? getStrongSalesAgentOpenAIModel() : getSalesAgentOpenAIModel();
      const knowledge = this.loadKnowledge(input.context);
      const compactContext = compactCommercialContextForModel(input.context, knowledge, input.specialistLearning, deterministic);
      const compactContextText = JSON.stringify(compactContext);
      const response = await executeObservedOpenAICall(
        {
          callType: "context_interpretation",
          model,
          conversationId: input.context.conversation_id || null,
          promptVersion: CONTEXTUAL_DECISION_PROMPT_VERSION,
          promptCharacters: CONTEXTUAL_DECISION_SYSTEM_PROMPT.length + compactContextText.length
        },
        () => client.responses.create({
        model,
        input: [
          { role: "system", content: [{ type: "input_text", text: CONTEXTUAL_DECISION_SYSTEM_PROMPT }] },
          { role: "user", content: [{ type: "input_text", text: compactContextText }] }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "unitv_contextual_decision",
            schema: toJsonSchema(),
            strict: true
          }
        },
        max_output_tokens: OPENAI_ECONOMY_POLICY.contextualDecision.maxOutputTokens
      })
      );
      if (!response) {
        return { ...deterministic, source: "deterministic" };
      }

      const parsed = compactAIDecisionSchema.safeParse(JSON.parse(response.output_text || "{}"));
      if (!parsed.success) return { ...deterministic, source: "deterministic" };
      return expandCompactAIDecision(parsed.data, deterministic, input.context);
    } catch {
      return { ...deterministic, source: "deterministic" };
    }
  }

  private loadKnowledge(context: CommercialContext) {
    const stage = String(context.lead_profile.conversation_state || context.lead_profile.stage || "");
    const query = [context.current_message, stage, context.last_bot_question].filter(Boolean).join(" ");
    return getStructuredKnowledgeContext({ query, stage, limit: 2 })
      .slice(0, OPENAI_ECONOMY_POLICY.contextualDecision.knowledgeArticles)
      .map((rule) => rule.guidance.slice(0, OPENAI_ECONOMY_POLICY.contextualDecision.knowledgeCharacters));
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
    detected_intent: "UNKNOWN",
    stage: normalizeStage(leadProfile.conversation_state || leadProfile.stage || leadProfile.etapa_atual),
    selected_plan: selectedPlan,
    payment_method: normalizePaymentMethod(leadProfile.payment_method),
    customer_message_meaning: "Mensagem ainda sem intencao comercial clara.",
    reason: "Nao ha sinal deterministico suficiente sem usar mais contexto.",
    next_action: "clarify_intent",
    should_reply: true,
    should_handoff: false,
    should_clarify: true,
    recommended_response: "Me confirma rapidinho: voce quer fazer teste gratis, ver os planos ou precisa de ajuda para instalar?",
    confidence: 0.45
  });

  if (isClosingAcknowledgement(normalized)) {
    return buildDecision({
      ...base,
      action: "silent",
      next_state: resolveConversationState({ leadProfile }),
      should_reply: false,
      should_schedule_followup: false,
      should_clarify: false,
      customer_message_meaning: "Cliente apenas agradeceu ou encerrou o turno.",
      reason: "Agradecimento isolado nao exige resposta nem chamada de IA.",
      next_action: "no_safe_action",
      recommended_response: "",
      confidence: 0.99
    });
  }

  if (isSimpleGreeting(normalized)) {
    const hasActiveContext = resolveConversationState({ leadProfile }) !== "new_lead" ||
      context.recent_messages.some((message) => message.role === "assistant" || message.role === "human_agent") ||
      Boolean(context.last_bot_question);
    return buildDecision({
      ...base,
      next_state: hasActiveContext ? resolveConversationState({ leadProfile }) : "welcome_sent",
      stage: hasActiveContext ? normalizeStage(resolveConversationState({ leadProfile })) : "new",
      should_schedule_followup: false,
      should_clarify: false,
      customer_message_meaning: hasActiveContext ? "Cliente retomou uma conversa existente." : "Novo cliente iniciou a conversa.",
      reason: hasActiveContext ? "Retomada nao pode reiniciar o atendimento." : "Saudacao fixa e deterministica para novo lead.",
      next_action: "clarify_intent",
      recommended_response: hasActiveContext ? "Oi! Pode me dizer como posso continuar te ajudando?" : UNITV_FIXED_INITIAL_GREETING,
      confidence: 0.99
    });
  }

  const authoritativeReply = findUnitvAuthoritativeKnowledgeReply(context.current_message);
  if (authoritativeReply) {
    return buildDecision({
      ...base,
      action: authoritativeReply.needsHuman ? "handoff" : "reply",
      intent: authoritativeReply.needsHuman ? "human_help" : "compatibility_question",
      detected_intent: authoritativeReply.needsHuman ? "HUMAN_NEEDED" : "UNKNOWN_BUT_CLARIFIABLE",
      stage: authoritativeReply.needsHuman ? "human_support" : base.stage,
      should_reply: !authoritativeReply.needsHuman,
      should_handoff: Boolean(authoritativeReply.needsHuman),
      should_schedule_followup: false,
      should_clarify: false,
      customer_message_meaning: `Cliente perguntou sobre conhecimento oficial: ${authoritativeReply.id}.`,
      reason: "Resposta oficial ja existe na base estruturada; IA nao e necessaria.",
      next_action: authoritativeReply.needsHuman ? "human_handoff" : "no_safe_action",
      recommended_response: authoritativeReply.reply,
      confidence: 0.99
    });
  }

  if (isAllPlanPricesRequest(normalized)) {
    return buildDecision({
      ...base,
      intent: "ask_price",
      detected_intent: "PLAN_PRICE_REQUEST",
      stage: "qualified",
      should_schedule_followup: false,
      should_clarify: false,
      customer_message_meaning: "Cliente pediu explicitamente os valores de todos os planos.",
      reason: "Tabela oficial completa foi solicitada; resposta deterministica evita IA.",
      next_action: "show_requested_prices",
      recommended_response: OFFICIAL_ALL_PLAN_PRICES_TEXT,
      next_expected_reply: "plan_choice",
      confidence: 0.99
    });
  }

  if (isPlanDurationQuestion(normalized)) {
    return buildDecision({
      ...base,
      intent: "ask_price",
      detected_intent: "PLAN_DURATION_REQUEST",
      stage: "qualified",
      next_state: "price_discovery",
      selected_plan: null,
      should_schedule_followup: false,
      should_clarify: false,
      customer_message_meaning: "Cliente quer saber se o acesso e vitalicio ou quais duracoes de plano existem.",
      reason: "A UNITV nao e vitalicia e possui planos mensal, trimestral, semestral e anual.",
      next_action: "answer_plan_duration",
      recommended_response: "Informe que nao e vitalicio e que existem planos mensal, trimestral, semestral e anual. Pergunte se quer conhecer o mensal.",
      next_expected_reply: "plan_choice",
      confidence: 0.88
    });
  }

  const requestedPlanPrice = getRequestedPlanPrice(normalized);
  if (requestedPlanPrice) {
    return buildDecision({
      ...base,
      intent: "ask_price",
      detected_intent: "PLAN_PRICE_REQUEST",
      stage: "qualified",
      selected_plan: requestedPlanPrice.plan,
      should_schedule_followup: false,
      should_clarify: false,
      customer_message_meaning: `Cliente pediu especificamente o valor do plano ${requestedPlanPrice.plan}.`,
      reason: "Preco oficial especifico pode ser respondido sem IA.",
      next_action: "show_requested_prices",
      recommended_response: requestedPlanPrice.reply,
      next_expected_reply: "plan_choice",
      confidence: 0.99
    });
  }

  const detectedDevice = detectUnitvDevice(context.current_message);
  if (detectedDevice !== "unknown") {
    if (detectedDevice === "android_phone" && !/\bandroid\b/.test(normalized)) {
      return buildDecision({
        ...base,
        intent: "ask_download",
        detected_intent: "DEVICE_ANDROID_PHONE_NEEDS_CONFIRMATION",
        stage: "device_qualification",
        should_schedule_followup: false,
        should_clarify: false,
        customer_message_meaning: "Cliente informou celular sem confirmar Android.",
        reason: "Compatibilidade do celular exige confirmar Android, sem usar IA.",
        next_action: "confirm_android_phone",
        recommended_response: "So me confirma: esse celular e Android?",
        next_expected_reply: "device",
        confidence: 0.98
      });
    }
    const guidance = getUnitvInstallationGuidance(context.current_message);
    if (guidance) {
      const incompatible = guidance.leadProfilePatch.compatibility_status === "incompatible";
      return buildDecision({
        ...base,
        action: guidance.reply ? "reply" : "silent",
        intent: "compatibility_question",
        detected_intent: detectedIntentForDevice(detectedDevice),
        stage: incompatible ? "download_support" : "device_qualification",
        should_reply: Boolean(guidance.reply),
        should_schedule_followup: false,
        should_clarify: false,
        install_status: incompatible ? "failed" : null,
        customer_message_meaning: incompatible
          ? "Aparelho informado e tentativa ja confirmaram incompatibilidade."
          : `Cliente informou o aparelho ${detectedDevice}.`,
        reason: incompatible
          ? "Nao insistir em instalacao para aparelho incompatível."
          : "Compatibilidade e instalacao sao regras locais; IA nao e necessaria.",
        next_action: guidance.reply ? nextActionForDevice(detectedDevice) : "no_safe_action",
        recommended_response: guidance.reply,
        next_expected_reply: guidance.reply ? "download_confirmation" : null,
        confidence: 0.98
      });
    }
  }

  if (/\b(comprovante|recibo|print)\b/.test(normalized)) {
    return buildDecision({
      ...base,
      intent: "receipt_sent",
      detected_intent: "PAYMENT_PROOF_SENT",
      stage: "awaiting_payment",
      selected_plan: selectedPlan,
      payment_method: "pix",
      customer_message_meaning: "Cliente enviou ou mencionou comprovante; pagamento ainda depende de confirmacao do provedor.",
      reason: "Comprovante exige validacao real de pagamento antes de qualquer codigo.",
      next_action: "verify_payment",
      recommended_response: "Recebi. Vou verificar com seguranca e aguardar a confirmacao real do pagamento antes de liberar qualquer acesso.",
      next_expected_reply: "payment_proof",
      confidence: 0.94
    });
  }

  if (isGenericPriceRequest(normalized)) {
    return buildDecision({
      ...base,
      intent: "ask_price",
      detected_intent: "PLAN_PRICE_REQUEST",
      stage: "plan_selected",
      selected_plan: "mensal",
      should_clarify: false,
      customer_message_meaning: "Cliente pediu o valor de forma generica; a oferta inicial autorizada e o plano mensal.",
      reason: "Pedido generico de valor deve receber o mensal diretamente, sem perguntar plano ou quantidade de telas.",
      next_action: "show_monthly_plan",
      recommended_response: OFFICIAL_MONTHLY_OFFER_TEXT,
      next_expected_reply: "plan_choice",
      confidence: 0.98
    });
  }

  if (isPlanScreenCoverageQuestion(normalized)) {
    return buildDecision({
      ...base,
      intent: "compatibility_question",
      detected_intent: "PLAN_SCREEN_COVERAGE",
      stage: "plan_selected",
      selected_plan: selectedPlan || "mensal",
      should_clarify: false,
      customer_message_meaning: "Cliente perguntou quantas telas o plano mensal cobre.",
      reason: "A cobertura oficial do mensal e de ate 3 telas; nao e necessario perguntar a quantidade desejada.",
      next_action: "answer_screen_coverage",
      recommended_response: `O plano mensal cobre ate ${OFFICIAL_MONTHLY_MAX_SCREENS} telas.`,
      next_expected_reply: null,
      confidence: 0.98
    });
  }

  if (/\b(ja baixei|baixei|download feito|fiz o download)\b/.test(normalized)) {
    return buildDecision({
      ...base,
      intent: "already_downloaded",
      detected_intent: "DOWNLOAD_CONFIRMED",
      stage: "install_support",
      selected_plan: selectedPlan,
      install_status: "downloaded",
      customer_message_meaning: "Cliente informou que ja baixou o app.",
      reason: "Cliente respondeu dentro do fluxo de download/instalacao.",
      next_action: "ask_installation_status",
      recommended_response: "Perfeito. Agora abre o aplicativo e me avisa se aparecer a tela de login/cadastro para seguirmos com a liberacao do teste.",
      next_expected_reply: "install_confirmation",
      confidence: 0.97
    });
  }

  if (/\b(ja instalei|instalei|instalado|consegui instalar)\b/.test(normalized)) {
    return buildDecision({
      ...base,
      intent: "installed_success",
      detected_intent: "DOWNLOAD_CONFIRMED",
      stage: "qualified",
      selected_plan: selectedPlan,
      install_status: "installed",
      customer_message_meaning: "Cliente informou que instalou com sucesso.",
      reason: "Instalacao concluida deve avancar para ativacao/teste, nao reiniciar conversa.",
      next_action: "ask_installation_status",
      recommended_response: "Perfeito. Agora abre o aplicativo e me avisa se aparecer a tela de login/cadastro para seguirmos com a liberacao do teste.",
      next_expected_reply: "activation_or_renewal",
      confidence: 0.97
    });
  }

  if (/\b(nao consegui|nao deu|erro|nao abre|nao baixa|link nao funciona|codigo nao deu|codigo n[aã]o deu)\b/.test(normalized)) {
    return buildDecision({
      ...base,
      intent: "download_issue",
      detected_intent: "DOWNLOAD_HELP",
      stage: "download_support",
      selected_plan: selectedPlan,
      install_status: "failed",
      should_schedule_followup: true,
      customer_message_meaning: "Cliente teve problema no download ou instalacao.",
      reason: "Cliente informou explicitamente problema no download ou instalacao.",
      next_action: "ask_download_problem",
      recommended_response: "Tudo bem, me fala onde travou: no link, no Downloader ou na instalacao?",
      next_expected_reply: "download_confirmation",
      confidence: 0.95
    });
  }

  if (isDownloadProblemMessage(normalized, lastQuestion)) {
    return buildDecision({
      ...base,
      intent: "download_issue",
      detected_intent: "DOWNLOAD_HELP",
      stage: "download_support",
      selected_plan: selectedPlan,
      install_status: "failed",
      should_schedule_followup: true,
      customer_message_meaning: "Cliente teve problema no download ou instalacao.",
      reason: "A ultima pergunta era sobre conseguir baixar/instalar, entao a resposta curta indica travamento no download.",
      next_action: "ask_download_problem",
      recommended_response: "Tudo bem, me fala onde travou: no link, no Downloader ou na instalacao?",
      next_expected_reply: "download_confirmation",
      confidence: 0.95
    });
  }

  if (isTrialSelectionAnswer(normalized, lastQuestion)) {
    return buildDecision({
      ...base,
      intent: "activate",
      detected_intent: "FREE_TRIAL_REQUEST",
      stage: "device_qualification",
      selected_plan: null,
      should_create_order: false,
      should_generate_pix: false,
      should_send_download: false,
      should_schedule_followup: false,
      customer_message_meaning: "Cliente escolheu fazer o teste gratis considerando a ultima pergunta do bot.",
      reason: "A ultima pergunta oferecia teste gratis ou planos; a resposta curta deve avancar para aparelho do teste.",
      next_action: "ask_device_for_trial",
      recommended_response:
        "Perfeito! Como e sua primeira vez, voce consegue fazer o teste gratis de 3 dias sim.\n\n" +
        "Me fala so qual aparelho voce vai usar: celular Android, TV Box, Android TV/Google TV ou Fire Stick?",
      next_expected_reply: "device",
      confidence: 0.97
    });
  }

  if (isAndroidPhoneNeedsConfirmation(normalized, lastQuestion)) {
    return buildDecision({
      ...base,
      intent: "ask_download",
      detected_intent: "DEVICE_ANDROID_PHONE_NEEDS_CONFIRMATION",
      stage: "device_qualification",
      selected_plan: null,
      should_create_order: false,
      should_generate_pix: false,
      should_send_download: false,
      should_schedule_followup: false,
      customer_message_meaning: "Cliente informou celular, mas o agente precisa confirmar se e Android antes de enviar APK.",
      reason: "Aparelho 'celular' sozinho nao garante compatibilidade, entao a proxima pergunta deve confirmar Android.",
      next_action: "confirm_android_phone",
      recommended_response: "So me confirma: esse celular e Android?",
      next_expected_reply: "device",
      confidence: 0.93
    });
  }

  const plan = normalizePlan(normalized);
  if (plan === "teste") {
    return buildDecision({
      ...base,
      intent: "activate",
      detected_intent: "FREE_TRIAL_REQUEST",
      stage: "device_qualification",
      selected_plan: null,
      should_create_order: false,
      should_generate_pix: false,
      should_send_download: false,
      customer_message_meaning: "Cliente pediu teste gratis; deve confirmar o aparelho antes de liberar o teste.",
      reason: "Teste gratis exige descobrir aparelho antes de enviar download ou liberar teste.",
      next_action: "ask_device_for_trial",
      recommended_response:
        "Perfeito! Como e sua primeira vez, voce consegue fazer o teste gratis de 3 dias sim.\n\n" +
        "Me fala so qual aparelho voce vai usar: celular Android, TV Box, Android TV/Google TV ou Fire Stick?",
      next_expected_reply: "device",
      confidence: 0.96
    });
  }
  if (plan) {
    const askedPixBefore = /\b(pix|chave|pagamento)\b/.test(lastQuestion) || leadProfile.pediu_pix === true;
    return buildDecision({
      ...base,
      intent: "choose_plan",
      detected_intent: planToDetectedIntent(plan),
      stage: askedPixBefore ? "checkout" : "plan_selected",
      selected_plan: plan,
      payment_method: askedPixBefore ? "pix" : null,
      should_create_order: askedPixBefore,
      should_generate_pix: askedPixBefore,
      customer_message_meaning: askedPixBefore
        ? "Cliente escolheu o plano depois de pedir Pix; deve seguir para pagamento."
        : "Cliente escolheu um plano.",
      reason: askedPixBefore
        ? "A ultima pergunta pediu plano para Pix, entao a escolha de plano autoriza seguir ao pagamento."
        : "Cliente escolheu um plano comercial.",
      next_action: askedPixBefore ? "send_pix" : "ask_payment_method",
      recommended_response: askedPixBefore
        ? "Perfeito. Vou gerar o Pix desse plano para voce."
        : "Perfeito. Voce prefere pagar com Pix ou cartao?",
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
      detected_intent: /^(sim|s|ok|quero|manda|pode|pode ser|isso)$/.test(normalized)
        ? "PIX_PERMISSION_CONFIRMED"
        : "PIX_REQUEST",
      stage: selectedPlan || openOrder ? "checkout" : "qualified",
      selected_plan: selectedPlan,
      payment_method: "pix",
      should_create_order: Boolean(selectedPlan && !openOrder),
      should_generate_pix: Boolean(selectedPlan || openOrder),
      customer_message_meaning: selectedPlan || openOrder
        ? "Cliente quer pagar por Pix usando o contexto comercial atual."
        : "Cliente pediu Pix, mas ainda nao ha plano selecionado.",
      reason: selectedPlan || openOrder
        ? "Ha plano/pedido no contexto, entao Pix pode ser tratado pelo fluxo seguro."
        : "Pix sem plano precisa voltar para escolha de plano antes de gerar cobranca.",
      next_action: selectedPlan || openOrder ? "send_pix" : "ask_plan_preference",
      should_clarify: !(selectedPlan || openOrder),
      recommended_response: selectedPlan || openOrder
        ? "Perfeito. Vou gerar o Pix do plano selecionado para voce."
        : "Consigo sim. Qual plano voce quer ativar para eu gerar o Pix: mensal, trimestral, semestral ou anual?",
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
        reason: "Confirmacao curta responde a pergunta anterior sobre ativacao ou recarga.",
        next_action: selectedPlan ? "ask_payment_method" : "ask_plan_preference",
        recommended_response: selectedPlan
          ? "Perfeito. Voce prefere pagar com Pix ou cartao?"
          : "Perfeito. Qual plano voce quer seguir?",
        confidence: 0.96
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
      reason: "Pedido explicito de ativacao nao precisa de interpretacao por IA.",
      next_action: selectedPlan ? "ask_payment_method" : "ask_plan_preference",
      recommended_response: selectedPlan
        ? "Perfeito. Voce prefere pagar com Pix ou cartao?"
        : "Perfeito. Qual plano voce quer seguir?",
      confidence: 0.96
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
      reason: "Pedido explicito de renovacao ou recarga nao precisa de IA.",
      next_action: selectedPlan ? "ask_payment_method" : "ask_plan_preference",
      recommended_response: selectedPlan
        ? "Perfeito. Voce prefere pagar com Pix ou cartao?"
        : "Perfeito. Qual plano voce quer seguir?",
      confidence: 0.96
    });
  }

  return base;
}

function compactCommercialContextForModel(
  context: CommercialContext,
  knowledge: string[] = [],
  specialistLearning?: SpecialistLearningGuidance | null,
  deterministic?: ContextualDecision
) {
  const profileKeys = [
    "selected_plan", "device", "operating_system", "compatibility_status", "install_status",
    "payment_status", "payment_method", "next_expected_reply", "main_objection"
  ];
  const leadProfile = profileKeys.reduce<Record<string, unknown>>((result, key) => {
    const value = context.lead_profile[key];
    if (value !== undefined && value !== null && typeof value !== "object") {
      result[key] = typeof value === "string"
        ? value.slice(-OPENAI_ECONOMY_POLICY.contextualDecision.profileValueCharacters)
        : value;
    }
    return result;
  }, {});

  return {
    message: context.current_message.slice(-OPENAI_ECONOMY_POLICY.contextualDecision.currentMessageCharacters),
    state: resolveConversationState({ leadProfile: context.lead_profile }),
    recent_messages: context.recent_messages.slice(-OPENAI_ECONOMY_POLICY.contextualDecision.recentMessages).map((message) => ({
      r: message.role === "assistant" ? "a" : message.role === "human_agent" ? "h" : "c",
      t: typeof message.content === "string"
        ? message.content.slice(-OPENAI_ECONOMY_POLICY.contextualDecision.messageCharacters)
        : null
    })),
    profile: leadProfile,
    order_status: String(context.open_order?.status || context.latest_order?.status || "") || null,
    last_question: context.last_bot_question?.slice(
      -OPENAI_ECONOMY_POLICY.contextualDecision.messageCharacters
    ) || null,
    human_hold: context.human_hold_active || undefined,
    guard: deterministic ? {
      action: deterministic.action,
      intent: deterministic.intent,
      next_state: deterministic.next_state,
      required_outcome: deterministic.recommended_response.slice(0, 260),
      required_facts: extractRequiredArtifacts(deterministic.recommended_response)
    } : undefined,
    knowledge: knowledge.length ? knowledge : undefined,
    specialist_hint: compactSpecialistLearning(specialistLearning) || undefined
  };
}

function compactSpecialistLearning(guidance?: SpecialistLearningGuidance | null) {
  if (!guidance) return null;
  const maxLength = OPENAI_ECONOMY_POLICY.contextualDecision.specialistGuidanceCharacters;
  const hints = Object.values(guidance)
    .filter((value) => typeof value === "string" && value.trim())
    .slice(0, 2)
    .map((value) => String(value).slice(0, maxLength));
  return hints.length ? hints.join(" | ") : null;
}

function expandCompactAIDecision(
  compact: z.infer<typeof compactAIDecisionSchema>,
  deterministic: ContextualDecision,
  context: CommercialContext
): ContextualDecision {
  const currentState = resolveConversationState({ leadProfile: context.lead_profile });
  const requestedState = compact.action === "handoff" ? "human_handoff" : compact.next_state;
  const nextState = isAllowedConversationStateTransition(currentState, requestedState)
    ? requestedState
    : currentState;
  const proposedReply = compact.action === "reply" ? compact.reply.trim() : "";
  const fallbackReply = deterministic.recommended_response || "Me conta em uma frase o que voce precisa agora.";
  const usedAIReply = Boolean(
    proposedReply &&
    validateConciseUnitvReply(proposedReply).valid &&
    validateAIReplyAgainstGuard(proposedReply, deterministic, context)
  );
  const recommendedResponse = usedAIReply
    ? proposedReply
    : compact.action === "reply" ? fallbackReply : "";
  const selectedPlan = normalizePlan(context.lead_profile.selected_plan || context.lead_profile.plano_interesse || context.current_message);
  const paymentMethod = normalizePaymentMethod(context.lead_profile.payment_method || context.current_message);
  const deterministicGuarded = deterministic.confidence >= 0.8 && deterministic.detected_intent !== "UNKNOWN";
  const action = deterministicGuarded ? deterministic.action : compact.action;

  return buildDecision({
    action,
    next_state: deterministicGuarded ? deterministic.next_state : nextState,
    intent: deterministicGuarded ? deterministic.intent : compact.intent,
    detected_intent: deterministicGuarded ? deterministic.detected_intent : detectedIntentForCommercialIntent(compact.intent),
    stage: stageForConversationState(deterministicGuarded ? deterministic.next_state : nextState),
    selected_plan: deterministicGuarded ? deterministic.selected_plan : selectedPlan,
    payment_method: deterministicGuarded ? deterministic.payment_method : paymentMethod,
    should_create_order: false,
    should_generate_pix: false,
    should_send_download: false,
    should_schedule_followup: false,
    should_reply: action === "reply",
    should_handoff: action === "handoff",
    should_clarify: action === "reply" && compact.intent === "unknown",
    next_action: deterministicGuarded ? deterministic.next_action : nextActionForCommercialIntent(compact.intent, compact.action),
    customer_message_meaning: compact.meaning,
    reason: compact.reason,
    recommended_response: recommendedResponse,
    next_expected_reply: deterministicGuarded ? deterministic.next_expected_reply : nextExpectedReplyForCommercialIntent(compact.intent),
    install_status: deterministic.install_status,
    confidence: compact.confidence,
    source: usedAIReply ? "ai" : "deterministic"
  });
}

function shouldUseAIWording(decision: ContextualDecision) {
  if (decision.action !== "reply" || !decision.should_reply || decision.should_handoff) return false;
  if (!decision.recommended_response.trim() || decision.recommended_response === UNITV_FIXED_INITIAL_GREETING) return false;
  if (decision.should_create_order || decision.should_generate_pix || decision.should_send_download) return false;
  return ![
    "send_pix",
    "verify_payment",
    "send_android_download",
    "send_tvbox_download",
    "send_firestick_guidance",
    "human_handoff"
  ].includes(decision.next_action);
}

function validateAIReplyAgainstGuard(reply: string, deterministic: ContextualDecision, context: CommercialContext) {
  const requiredArtifacts = extractRequiredArtifacts(deterministic.recommended_response);
  if (!requiredArtifacts.every((artifact) => reply.includes(artifact))) return false;
  const directiveContract = extractDirectiveContract(deterministic.recommended_response);
  if (directiveContract.requiredSemanticOutcome && !validateResponseAgainstDirectiveContract(reply, directiveContract)) return false;
  if (deterministic.detected_intent === "PLAN_DURATION_REQUEST") {
    const normalizedReply = normalize(reply);
    if (!/\bmensal\b/.test(normalizedReply) || !/\b(anual|ano)\b/.test(normalizedReply)) return false;
    if (/\bvitalici/.test(normalize(context.current_message)) && !/\b(nao|nunca)\b/.test(normalizedReply)) return false;
  }
  if (deterministic.detected_intent === "FREE_TRIAL_REQUEST" && !/\b3 dias\b/.test(normalize(reply))) return false;
  return true;
}

function detectedIntentForCommercialIntent(intent: ContextualDecision["intent"]): ContextualDecision["detected_intent"] {
  const map: Partial<Record<ContextualDecision["intent"], ContextualDecision["detected_intent"]>> = {
    activate: "FREE_TRIAL_REQUEST",
    renew: "RECHARGE_REQUEST",
    ask_price: "PLAN_PRICE_REQUEST",
    choose_plan: "PLAN_PRICE_REQUEST",
    request_pix: "PIX_REQUEST",
    request_card: "PAYMENT_INTENT",
    payment_sent: "PAYMENT_PROOF_SENT",
    receipt_sent: "PAYMENT_PROOF_SENT",
    ask_download: "DOWNLOAD_HELP",
    download_issue: "DOWNLOAD_HELP",
    already_downloaded: "DOWNLOAD_CONFIRMED",
    installed_success: "DOWNLOAD_CONFIRMED",
    human_help: "HUMAN_NEEDED"
  };
  return map[intent] || "UNKNOWN_BUT_CLARIFIABLE";
}

function detectedIntentForDevice(device: UnitvDeviceId): ContextualDecision["detected_intent"] {
  const map: Partial<Record<UnitvDeviceId, ContextualDecision["detected_intent"]>> = {
    android_phone: "DEVICE_ANDROID_PHONE",
    android_tv_google_tv: "DEVICE_ANDROID_TV",
    tvbox_android: "DEVICE_TV_BOX",
    firestick: "DEVICE_FIRE_STICK"
  };
  return map[device] || "DEVICE_UNSUPPORTED_OR_NEEDS_CHECK";
}

function nextActionForDevice(device: UnitvDeviceId): ContextualDecision["next_action"] {
  if (device === "android_phone") return "send_android_download";
  if (device === "tvbox_android" || device === "android_tv_google_tv") return "send_tvbox_download";
  if (device === "firestick") return "send_firestick_guidance";
  return "clarify_intent";
}

function nextActionForCommercialIntent(
  intent: ContextualDecision["intent"],
  action: z.infer<typeof compactAIDecisionSchema>["action"]
): ContextualDecision["next_action"] {
  if (action === "handoff") return "human_handoff";
  if (action === "silent" || action === "wait") return "no_safe_action";
  const map: Partial<Record<ContextualDecision["intent"], ContextualDecision["next_action"]>> = {
    activate: "ask_device_for_trial",
    renew: "ask_plan_preference",
    ask_price: "show_monthly_plan",
    choose_plan: "ask_payment_method",
    request_pix: "ask_plan_preference",
    request_card: "ask_payment_method",
    payment_sent: "verify_payment",
    receipt_sent: "verify_payment",
    ask_download: "ask_installation_status",
    download_issue: "ask_download_problem",
    already_downloaded: "ask_installation_status",
    installed_success: "ask_installation_status",
    human_help: "human_handoff"
  };
  return map[intent] || "clarify_intent";
}

function nextExpectedReplyForCommercialIntent(intent: ContextualDecision["intent"]): ContextualDecision["next_expected_reply"] {
  if (intent === "activate") return "device";
  if (intent === "renew" || intent === "ask_price") return "plan_choice";
  if (intent === "choose_plan") return "payment_method";
  if (["request_pix", "request_card", "payment_sent", "receipt_sent"].includes(intent)) return "payment_proof";
  if (["ask_download", "download_issue"].includes(intent)) return "download_confirmation";
  if (["already_downloaded", "installed_success"].includes(intent)) return "install_confirmation";
  return null;
}

function stageForConversationState(state: ConversationState): ContextualDecision["stage"] {
  const map: Record<ConversationState, ContextualDecision["stage"]> = {
    new_lead: "new",
    welcome_sent: "new",
    test_requested: "trial_selection",
    first_time_check: "first_time_check",
    device_qualification: "device_qualification",
    download_link_sent: "download_instructions",
    awaiting_download_installation: "awaiting_download_installation",
    awaiting_test_activation: "qualified",
    price_discovery: "qualified",
    monthly_offer_pending: "qualified",
    plan_preference: "qualified",
    plan_selected: "plan_selected",
    pre_sale_recharge_intent: "qualified",
    pix_permission: "checkout",
    pix_sent: "awaiting_payment",
    payment_pending: "awaiting_payment",
    payment_approved: "paid",
    code_delivered: "active",
    post_sale: "active",
    incompatible_device: "download_support",
    human_handoff: "human_support"
  };
  return map[state];
}

function isClosingAcknowledgement(normalized: string) {
  return /^(sim[, ]+)?(obrigad[oa]|valeu|show|beleza|perfeito|ta bom|tudo bem|ok|blz)[.! ]*$/.test(normalized);
}

function isSimpleGreeting(normalized: string) {
  return /^(oi|ola|bom dia|boa tarde|boa noite|oi tudo bem|ola tudo bem)[!,.? ]*$/.test(normalized);
}

function isAllPlanPricesRequest(normalized: string) {
  return /\b(todos|todas|tabela|opcoes|quais valores|valores dos planos|quais planos)\b/.test(normalized) &&
    /\b(valor|valores|preco|precos|plano|planos|mensal|trimestral|semestral|anual)\b/.test(normalized);
}

function isPlanDurationQuestion(normalized: string) {
  return /\bvitalici[oa]\b/.test(normalized) ||
    (/\b(mes|mensal)\b/.test(normalized) && /\b(ano|anual)\b/.test(normalized));
}

function getRequestedPlanPrice(normalized: string): { plan: NonNullable<ContextualDecision["selected_plan"]>; reply: string } | null {
  if (!/\b(valor|preco|quanto|custa|fica|sai)\b/.test(normalized)) return null;
  if (/\btrimestral|3 meses\b/.test(normalized)) return { plan: "trimestral", reply: "O plano trimestral fica em R$ 70. Voce tem interesse?" };
  if (/\bsemestral|6 meses\b/.test(normalized)) return { plan: "semestral", reply: "O plano semestral fica em R$ 120. Voce tem interesse?" };
  if (/\banual|1 ano|12 meses\b/.test(normalized)) return { plan: "anual", reply: "O plano anual fica em R$ 200. Voce tem interesse?" };
  if (/\bmensal|1 mes|30 dias\b/.test(normalized)) return { plan: "mensal", reply: OFFICIAL_MONTHLY_OFFER_TEXT };
  return null;
}

function isTrialSelectionAnswer(normalized: string, lastQuestion: string) {
  const askedTrialOrPlans = /\b(teste gratis|teste|3 dias|ver os planos|planos|mensal|trimestral|semestral|anual)\b/.test(lastQuestion) &&
    /\b(prefere|quer|primeiro|comecar)\b/.test(lastQuestion);
  const trialAnswer = /^(teste|testes|quero teste|teste gratis|gratis|gratuito|3 dias|sim teste|pode ser teste|primeiro o teste)$/.test(normalized) ||
    /\b(quero|fazer|liberar|comecar)\b.{0,25}\b(teste|gratis|3 dias)\b/.test(normalized);

  return askedTrialOrPlans && trialAnswer;
}

function isAndroidPhoneNeedsConfirmation(normalized: string, lastQuestion: string) {
  const askedDevice = /\b(aparelho|celular android|tv box|android tv|google tv|fire stick|firestick|vai usar|baixar)\b/.test(lastQuestion);
  return askedDevice && /^(celular|telefone|meu celular|no celular|smartphone)$/.test(normalized);
}

function isDownloadProblemMessage(normalized: string, lastQuestion: string) {
  if (/\b(nao consegui|n consegui|nao deu|n deu|erro|nao abre|nao baixa|link nao funciona|codigo nao deu|codigo nao funcionou|bloqueou|travou)\b/.test(normalized)) {
    return true;
  }

  const lastQuestionAskedDownload = /\b(conseguiu baixar|voce conseguiu baixar|baixou|download|instalou|instalacao)\b/.test(lastQuestion);
  return lastQuestionAskedDownload && /^(nao|n|ainda nao|nao ainda|nada|nao consegui|n consegui)$/.test(normalized);
}

function planToDetectedIntent(plan: NonNullable<ContextualDecision["selected_plan"]>): ContextualDecision["detected_intent"] {
  switch (plan) {
    case "mensal":
      return "PLAN_SELECTION_MONTHLY";
    case "trimestral":
      return "PLAN_SELECTION_QUARTERLY";
    case "semestral":
      return "PLAN_SELECTION_SEMIANNUAL";
    case "anual":
      return "PLAN_SELECTION_YEARLY";
    case "teste":
      return "FREE_TRIAL_REQUEST";
  }

  return "UNKNOWN";
}

function buildDecision(input: Partial<ContextualDecision> & Pick<ContextualDecision, "intent" | "stage" | "customer_message_meaning" | "confidence">): ContextualDecision {
  const decision: ContextualDecision = {
    action: "reply" as const,
    next_state: "new_lead" as const,
    detected_intent: "UNKNOWN",
    selected_plan: null,
    payment_method: null,
    should_create_order: false,
    should_generate_pix: false,
    should_send_download: false,
    should_schedule_followup: true,
    should_reply: true,
    should_handoff: false,
    should_clarify: false,
    next_action: "clarify_intent",
    reason: "Decisao deterministica baseada na mensagem atual e no contexto recente.",
    recommended_response: "",
    next_expected_reply: null,
    install_status: null,
    ...input
  };
  return {
    ...decision,
    action: input.action || inferAgentAction(decision),
    next_state: input.next_state || normalizeConversationState(decision.stage) || "new_lead"
  };
}

function inferAgentAction(decision: {
  should_reply: boolean;
  should_handoff: boolean;
  should_generate_pix: boolean;
  should_create_order: boolean;
  should_send_download: boolean;
  next_action: string;
}) {
  if (decision.should_handoff || decision.next_action === "human_handoff") return "handoff" as const;
  if (decision.should_generate_pix || decision.should_create_order || decision.should_send_download || decision.next_action === "verify_payment") {
    return "backend_action" as const;
  }
  if (!decision.should_reply) return "silent" as const;
  return "reply" as const;
}

function isGenericPriceRequest(normalized: string) {
  const text = normalized.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (/\b(mensal|trimestral|semestral|anual|3 meses|6 meses|1 ano|12 meses)\b/.test(text)) return false;
  if (/\b(todos|todas|tabela|opcoes|quais valores|valores dos planos|quais planos)\b/.test(text)) return false;
  return /\b(valor|valores|preco|precos|quanto custa|qual valor|qual o valor)\b/.test(text);
}

function isPlanScreenCoverageQuestion(normalized: string) {
  const text = normalized.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  return (
    /\b(quantas telas|ate quantas telas|quantos aparelhos)\b/.test(text) ||
    /\b(cobre|suporta|da direito|pode usar)\b.{0,35}\b(tela|telas|aparelho|aparelhos)\b/.test(text)
  );
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
  if (normalized.includes("awaiting_download_installation") || normalized.includes("aguardando_download")) return "awaiting_download_installation";
  if (normalized.includes("download_instructions") || normalized.includes("download_sent")) return "download_instructions";
  if (normalized.includes("device_qualification") || normalized.includes("aparelho")) return "device_qualification";
  if (normalized.includes("first_time_check") || normalized.includes("primeira_vez")) return "first_time_check";
  if (normalized.includes("trial_selection") || normalized.includes("test_or_plan")) return "trial_selection";
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
      action: { type: "string", enum: ["reply", "silent", "wait", "handoff"] },
      intent: { type: "string", enum: commercialIntentSchema.options },
      next_state: { type: "string", enum: CANONICAL_CONVERSATION_STATES },
      meaning: { type: "string", minLength: 1, maxLength: 120 },
      reason: { type: "string", minLength: 1, maxLength: 120 },
      reply: { type: "string", maxLength: 240 },
      confidence: { type: "number", minimum: 0, maximum: 1 }
    },
    required: ["action", "intent", "next_state", "meaning", "reason", "reply", "confidence"]
  } as const;
}
