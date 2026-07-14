import "server-only";
import { validateConciseUnitvReply } from "@/lib/whatsapp/customer-message-safety";
import { z } from "zod";
import { createOpenAIClient, getSalesAgentOpenAIModel, getStrongSalesAgentOpenAIModel } from "@/lib/openai/client";
import { executeObservedOpenAICall } from "@/services/ai/openai-call-observer";
import { OPENAI_ECONOMY_POLICY } from "@/lib/openai/economy-policy";
import { KnowledgeService } from "@/services/knowledge/knowledge.service";
import type { SpecialistLearningGuidance } from "@/services/agent/specialist-learning-guidance";
import { OFFICIAL_MONTHLY_MAX_SCREENS, OFFICIAL_MONTHLY_OFFER_TEXT } from "@/lib/unitv/official-catalog";
import { CANONICAL_CONVERSATION_STATES, normalizeConversationState } from "@/lib/conversation-state";
import { getStructuredKnowledgeContext } from "@/lib/unitv/structured-knowledge";

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

const SYSTEM_PROMPT = [
  "Voce e o decisor contextual do vendedor UNITV. Esta e a unica chamada de IA permitida neste turno.",
  "Retorne somente JSON valido no schema solicitado.",
  "PASSO 1: identifique a intencao e o significado da mensagem pela ultima pergunta e pelo estado persistido.",
  "PASSO 2: escolha uma unica action: reply, silent, wait, handoff ou backend_action.",
  "PASSO 3: escolha next_state sem regredir o funil.",
  "PASSO 4: quando action=reply, escreva recommended_response curta e pronta para envio; ela nao sera reescrita por outra IA.",
  "PASSO 5: explique reason de forma objetiva para auditoria interna.",
  "Interprete historico, lead_profile, pedido aberto, ultima mensagem do bot e ultima pergunta do bot.",
  "Consulte a base de conhecimento recebida para fatos, fluxo e estilo, sem copiar exemplos literalmente.",
  "recommended_response deve ter preferencialmente 6 a 15 palavras, no maximo 22 palavras, duas frases e uma pergunta.",
  "Voce NAO executa acoes, NAO confirma pagamento, NAO cria Pix, NAO entrega codigo.",
  "Precos oficiais: mensal R$20,90, trimestral R$70, semestral R$120, anual R$200.",
  "Se o cliente perguntar apenas valor, responda exatamente o mensal de R$ 20,90 e pergunte se tem interesse pra hoje; nao revele outros valores.",
  "Se perguntar quantas telas o mensal cobre, informe ate 3 telas. Outros planos usam os fatos da base de conhecimento.",
  "Se a mensagem curta depender da ultima pergunta, use o historico para inferir a intencao.",
  "Exemplo: bot perguntou 'teste gratis ou planos?' e cliente respondeu 'Testes' => FREE_TRIAL_REQUEST, ask_device_for_trial.",
  "Exemplo: bot perguntou aparelho e cliente respondeu 'celular' => DEVICE_ANDROID_PHONE_NEEDS_CONFIRMATION, confirm_android_phone.",
  "Exemplo: bot perguntou 'Voce conseguiu baixar?' e cliente respondeu 'nao' => DOWNLOAD_HELP, ask_download_problem.",
  "Nunca recomende saudacao inicial quando existe conversa ativa, ultima pergunta ou etapa comercial em andamento.",
  "Nao mande humano para respostas simples de teste, aparelho, download, preco ou Pix.",
  "Se cliente escolheu plano e pede Pix, marque request_pix, should_generate_pix=true.",
  "Se nao houver plano selecionado para Pix, should_generate_pix=false.",
  "Se cliente disse que baixou/conseguiu, marque already_downloaded ou installed_success.",
  "Se cliente disse que nao deu/erro/nao conseguiu, marque download_issue."
].join("\n");

export class ContextualIntelligenceService {
  constructor(private readonly knowledgeService = new KnowledgeService()) {}

  async extract(input: { context: CommercialContext; useStrongModel?: boolean; specialistLearning?: SpecialistLearningGuidance | null }): Promise<ContextualDecision> {
    const deterministic = extractDeterministicDecision(input.context);
    if (deterministic.confidence >= 0.92 || !process.env.OPENAI_API_KEY) {
      return { ...deterministic, source: "deterministic" };
    }

    try {
      const client = createOpenAIClient();
      const model = input.useStrongModel ? getStrongSalesAgentOpenAIModel() : getSalesAgentOpenAIModel();
      const knowledge = await this.loadKnowledge(input.context);
      const response = await executeObservedOpenAICall(
        { callType: "context_interpretation", model, conversationId: input.context.conversation_id || null },
        () => client.responses.create({
        model,
        input: [
          { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
          { role: "user", content: [{ type: "input_text", text: JSON.stringify(compactCommercialContextForModel(input.context, knowledge, input.specialistLearning)) }] }
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
        return deterministic;
      }

      const parsed = contextualDecisionSchema.safeParse(JSON.parse(response.output_text || "{}"));
      if (!parsed.success) return { ...deterministic, source: "deterministic" };
      const recommendedResponse = validateConciseUnitvReply(parsed.data.recommended_response).valid
        ? parsed.data.recommended_response
        : "";
      return { ...parsed.data, recommended_response: recommendedResponse, source: "ai" };
    } catch {
      return { ...deterministic, source: "deterministic" };
    }
  }

  private async loadKnowledge(context: CommercialContext) {
    const stage = String(context.lead_profile.stage || context.lead_profile.commercial_stage || "");
    const query = [context.current_message, stage, context.last_bot_question].filter(Boolean).join(" ");
    const [identity, neverDo, relevant] = await Promise.all([
      this.knowledgeService.getKnowledgeByCategory("identidade_do_agente"),
      this.knowledgeService.getKnowledgeByCategory("o_que_nunca_fazer"),
      this.knowledgeService.searchKnowledge(query)
    ]);
    const structured = getStructuredKnowledgeContext({ query, stage, limit: 6 });
    const unique = new Map<string, Record<string, unknown>>();
    // Spend the compact RAG budget on the current issue first. The stable
    // system prompt already carries identity and immutable safety rules.
    for (const article of [...relevant, ...neverDo, ...identity]) {
      const key = String(article.id || article.title || article.category || "");
      if (key && !unique.has(key)) unique.set(key, article);
    }

    const markdownKnowledge = [...unique.values()].slice(0, 1).map((article) => ({
      title: String(article.title || article.category || "Conhecimento UNITV"),
      category: String(article.category || "geral"),
      guidance: selectKnowledgeExcerpt(String(article.content || ""), query, OPENAI_ECONOMY_POLICY.contextualDecision.knowledgeCharacters)
    })).filter((article) => article.guidance);
    return [
      ...(structured.length ? [{
        title: "Conhecimento estruturado UNITV",
        category: "compiled_operational_knowledge",
        guidance: structured.map((rule) => rule.guidance).join("\n").slice(0, OPENAI_ECONOMY_POLICY.contextualDecision.knowledgeCharacters)
      }] : []),
      ...markdownKnowledge
    ].slice(0, OPENAI_ECONOMY_POLICY.contextualDecision.knowledgeArticles);
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

function compactCommercialContextForModel(
  context: CommercialContext,
  knowledge: Array<Record<string, unknown>> = [],
  specialistLearning?: SpecialistLearningGuidance | null
) {
  const profileKeys = [
    "stage", "etapa_atual", "commercial_stage", "ultima_intencao", "selected_plan", "plano_interesse",
    "device", "aparelho", "download_status", "install_status", "trial_status", "payment_status",
    "payment_method", "wants_test", "wants_recharge", "wants_activation", "pediu_pix", "codigo_enviado",
    "last_bot_question", "next_expected_reply", "main_objection"
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
    current_message: context.current_message.slice(-OPENAI_ECONOMY_POLICY.contextualDecision.currentMessageCharacters),
    recent_messages: context.recent_messages.slice(-OPENAI_ECONOMY_POLICY.contextualDecision.recentMessages).map((message) => ({
      role: message.role || null,
      content: typeof message.content === "string"
        ? message.content.slice(-OPENAI_ECONOMY_POLICY.contextualDecision.messageCharacters)
        : null
    })),
    lead_profile: leadProfile,
    open_order: context.open_order ? { id: context.open_order.id || null, status: context.open_order.status || null } : null,
    latest_order: context.latest_order ? { id: context.latest_order.id || null, status: context.latest_order.status || null } : null,
    last_bot_question: context.last_bot_question?.slice(
      -OPENAI_ECONOMY_POLICY.contextualDecision.messageCharacters
    ) || null,
    followup_key: context.followup_key,
    human_hold_active: context.human_hold_active,
    knowledge_base: knowledge,
    specialist_learning: compactSpecialistLearning(specialistLearning)
  };
}

function compactSpecialistLearning(guidance?: SpecialistLearningGuidance | null) {
  if (!guidance) return null;
  const maxLength = OPENAI_ECONOMY_POLICY.contextualDecision.specialistGuidanceCharacters;
  const compact = Object.fromEntries(
    Object.entries(guidance)
      .filter(([, value]) => typeof value === "string" && value.trim())
      .map(([key, value]) => [key, String(value).slice(0, maxLength)])
  );
  return Object.keys(compact).length ? compact : null;
}

function selectKnowledgeExcerpt(content: string, query: string, maxLength: number) {
  const terms = normalize(query).split(/\W+/).filter((term) => term.length >= 4).slice(0, 8);
  const sections = content.split(/\n(?=##?\s)/).filter(Boolean);
  const selected = sections
    .map((section, index) => ({ section, index, score: terms.reduce((score, term) => score + (normalize(section).includes(term) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 2)
    .map((item) => item.section)
    .join("\n")
    .trim();
  const excerpt = selected || content.trim();
  return excerpt.length > maxLength ? `${excerpt.slice(0, maxLength)}...` : excerpt;
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
      action: { type: "string", enum: agentActionSchema.options },
      next_state: { type: "string", enum: CANONICAL_CONVERSATION_STATES },
      intent: { type: "string", enum: commercialIntentSchema.options },
      detected_intent: { type: "string", enum: contextualDetectedIntentSchema.options },
      stage: { type: "string", enum: commercialStageSchema.options },
      selected_plan: { type: ["string", "null"], enum: ["mensal", "trimestral", "semestral", "anual", "teste", null] },
      payment_method: { type: ["string", "null"], enum: ["pix", "card", null] },
      should_create_order: { type: "boolean" },
      should_generate_pix: { type: "boolean" },
      should_send_download: { type: "boolean" },
      should_schedule_followup: { type: "boolean" },
      should_reply: { type: "boolean" },
      should_handoff: { type: "boolean" },
      should_clarify: { type: "boolean" },
      next_action: { type: "string", enum: nextActionSchema.options },
      customer_message_meaning: { type: "string" },
      reason: { type: "string" },
      recommended_response: { type: "string" },
      next_expected_reply: { type: ["string", "null"], enum: ["activation_or_renewal", "plan_choice", "payment_method", "payment_proof", "download_confirmation", "device", "install_confirmation", null] },
      install_status: { type: ["string", "null"], enum: ["not_sent", "link_sent", "downloaded", "installed", "failed", null] },
      confidence: { type: "number", minimum: 0, maximum: 1 }
    },
    required: [
      "action",
      "next_state",
      "intent",
      "detected_intent",
      "stage",
      "selected_plan",
      "payment_method",
      "should_create_order",
      "should_generate_pix",
      "should_send_download",
      "should_schedule_followup",
      "should_reply",
      "should_handoff",
      "should_clarify",
      "next_action",
      "customer_message_meaning",
      "reason",
      "recommended_response",
      "next_expected_reply",
      "install_status",
      "confidence"
    ]
  } as const;
}
