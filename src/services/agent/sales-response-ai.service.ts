import "server-only";
import { createOpenAIClient, getSalesAgentOpenAIModel, getStrongSalesAgentOpenAIModel } from "@/lib/openai/client";
import { sanitizeCustomerMessage, validateResponseAgainstLeadProfile } from "@/lib/whatsapp/customer-message-safety";
import { executeObservedOpenAICall } from "@/services/ai/openai-call-observer";

type ConversationMessage = {
  role?: string;
  content?: string | null;
};

type SpecialistExample = {
  customer_last_message?: string | null;
  bot_previous_message?: string | null;
  specialist_message?: string | null;
  style_notes?: string | null;
  inferred_specialist_action?: string | null;
  why_specialist_intervened?: string | null;
  success_signal?: string | null;
  metadata?: Record<string, unknown> | null;
};

type LearnedOperationalDirective = {
  intent?: string | null;
  stage?: string | null;
  rule?: string | null;
  style_directive?: string | null;
  avoid?: string[] | null;
  confidence?: number | null;
};

type GenerateSalesResponseInput = {
  message: string;
  intent: string;
  leadProfile: Record<string, unknown>;
  recentMessages?: ConversationMessage[];
  specialistExamples?: SpecialistExample[];
  learningMemories?: LearnedOperationalDirective[];
  fallbackReply?: string | null;
  useStrongModel?: boolean;
  conversationId?: string | null;
};

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string", minLength: 1 }
  },
  required: ["reply"]
} as const;

const SYSTEM_PROMPT = [
  "Voce e Andre, vendedor humano da UNITV no WhatsApp.",
  "Interprete o historico e responda como um atendente experiente, natural, curto e comercial.",
  "O especialista humano costuma responder curto. Prefira 1 ou 2 frases curtas, sem texto grande.",
  "Nao explique demais. Uma pergunta por vez. Uma acao clara por mensagem.",
  "Nunca repita pergunta que o cliente ja respondeu.",
  "Se disse que ja baixou, nao pergunte se baixou.",
  "Se disse que ja usou, considere que conhece o app.",
  "Se disse que nao pagou, nao peca comprovante.",
  "Nao soe desesperado para fechar. Evite pressao, urgencia falsa e frases como 'so hoje', 'fechar agora' ou 'ja mando a chave' antes do cliente confirmar.",
  "Antes de pagamento, confirme intencao. Antes de instalacao, confirme se o app ja esta baixado/instalado.",
  "Nunca assuma que o cliente ja vai comprar porque perguntou valor, plano ou aparelho.",
  "Se o cliente ainda nao confirmou claramente que quer pagar, nao diga 'vamos liberar', 'vou ativar', 'vou gerar o Pix', 'vamos seguir', 'vou fazer sua recarga' ou 'vamos liberar no celular Android'.",
  "Se o cliente disse que so fez teste, trate como primeira recarga e confirme interesse antes de falar como compra fechada.",
  "Evite repetir emoji. Se o historico recente ja tem emoji, responda sem emoji.",
  "Nao jogue tabela completa de preco cedo demais.",
  "Primeiro descubra se e renovacao ou primeira vez; depois pergunte preferencia de plano sem valores.",
  "So cite todos os valores se o cliente pedir claramente todos os valores, precos, tabela ou quais planos tem.",
  "Se o cliente escolher um plano especifico ou citar um valor, responda somente o valor daquele plano.",
  "Nunca reutilize uma mensagem pronta. Escreva uma resposta original para a conversa atual, com uma unica proxima acao clara.",
  "Para valores e condicoes comerciais, respeite o plano, o estado e os dados oficiais recebidos no contexto. Nao invente nem antecipe desconto, Pix ou pagamento.",
  "Se escolheu mensal, considere o plano mensal de R$ 25 e nao cite os outros planos.",
  "Se informou TV Box, nao pergunte o aparelho novamente.",
  "Faca no maximo uma pergunta e conduza ao proximo passo.",
  "Nao mande menu. Nao cite IA, regra local, debug, sistema, schema ou backend.",
  "Nao confirme pagamento sem validacao. Nao invente numero de telas.",
  "Dados oficiais para usar somente quando permitido: mensal R$ 25, trimestral/3 meses R$ 70, semestral/6 meses R$ 120, anual R$ 200.",
  "Teste gratis: 3 dias.",
  "Downloader TV: 862585.",
  "APK Android: https://www.mediafire.com/file_premium/e2jc97dcqr80tjw/UniTV_mobile_3.21.6.apk/file",
  "APK TV Box/Android TV: https://www.mediafire.com/file_premium/tjgxo5756ftbx02/unitv_stb_4.19.apk/file",
  "Tutorial obrigatorio de instalacao: https://www.youtube.com/watch?v=LBBAbs2-I0c",
  "A UNITV so funciona em aparelhos Android ou baseados em Android: TV Box Android, Android TV, Google TV, celular Android, Fire Stick ou TV com Android e Play Store.",
  "Nao envie APK Android para iPhone, Roku, Samsung ou LG sem confirmar Android ou Play Store.",
  "Samsung e LG normalmente nao sao Android; confirme se tem Play Store ou recomende TV Box Android ou Fire Stick.",
  "Sempre que enviar instrucao, APK ou codigo de instalacao, inclua o tutorial obrigatorio.",
  "Se o cliente ja baixou ou instalou, nao envie download novamente; avance para teste ou ativacao.",
  "Use exemplos reais do especialista como referencia de logica e estilo, nunca como texto para copiar cegamente.",
  "Quando houver specialist_examples, priorize a logica, o ritmo e a forma de conduzir do especialista sobre respostas padrao.",
  "Quando houver learned_operational_directives, aplique-as como principios de raciocinio, nunca como frases para repetir.",
  "Se o exemplo do especialista for curto, responda curto tambem. Nao transforme resposta curta em paragrafo grande.",
  "Evite templates genericos quando um exemplo do especialista mostrar uma abordagem mais contextual.",
  "Nao copie safe_fallback literalmente; use apenas como contexto de seguranca se precisar.",
  "Varie a resposta conforme o historico recente e o ultimo passo real da conversa.",
  "Ignore preco, Pix, link ou codigo de exemplos se divergirem dos dados oficiais acima."
].join("\n");

export class SalesResponseAIService {
  async generateResponse(input: GenerateSalesResponseInput) {
    if (!process.env.OPENAI_API_KEY) {
      return null;
    }

    const client = createOpenAIClient();
    const context = {
      latest_customer_message: input.message,
      detected_intent: input.intent,
      facts: compactSalesLeadProfile(input.leadProfile),
      recent_conversation: (input.recentMessages || []).slice(-8).map((item) => ({
        role: item.role,
        content: truncateForModel(item.content, 700)
      })),
      specialist_examples: (input.specialistExamples || []).slice(0, 2).map(compactSpecialistExample),
      learned_operational_directives: (input.learningMemories || []).slice(0, 3).map((memory) => ({
        intent: memory.intent || null,
        stage: memory.stage || null,
        rule: truncateForModel(memory.rule, 360),
        style_directive: truncateForModel(memory.style_directive, 220),
        avoid: (memory.avoid || []).slice(0, 3).map((item) => truncateForModel(item, 120)),
        confidence: memory.confidence || null
      })),
      specialist_style_directives: buildSpecialistStyleDirectives(input.specialistExamples || []),
      safe_fallback: input.fallbackReply || null
    };

    try {
      const model = input.useStrongModel ? getStrongSalesAgentOpenAIModel() : getSalesAgentOpenAIModel();
      const response = await executeObservedOpenAICall(
        { callType: "sales_response", model, conversationId: input.conversationId },
        () => client.responses.create({
        model,
        input: [
          { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
          { role: "user", content: [{ type: "input_text", text: JSON.stringify(context) }] }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "unitv_sales_response",
            schema: RESPONSE_SCHEMA,
            strict: true
          }
        },
        max_output_tokens: 220
      })
      );
      if (!response) {
        return null;
      }

      const parsed = JSON.parse(response.output_text || "{}") as { reply?: string };
      const sanitized = sanitizeCustomerMessage(parsed.reply || "");
      if (sanitized.blocked || !sanitized.text) {
        return null;
      }
      const recentBotMessages = (input.recentMessages || [])
        .filter((item) => item.role === "assistant" && typeof item.content === "string")
        .slice(-5)
        .map((item) => item.content as string);
      const validation = validateResponseAgainstLeadProfile(sanitized.text, input.leadProfile, recentBotMessages);
      return validation.valid ? sanitized.text : null;
    } catch {
      return null;
    }
  }
}

function buildSpecialistStyleDirectives(examples: SpecialistExample[]) {
  const selected = examples.slice(0, 3);
  const hasFastLearning = selected.some((example) => example.metadata?.fast_learning === true);
  const hasShortHumanStyle = selected.some((example) =>
    example.metadata?.human_style === "curto_direto_uma_acao" ||
    example.metadata?.specialist_message_is_short === true ||
    countWords(example.specialist_message || "") <= 22
  );

  return {
    use_fast_learning_examples: hasFastLearning,
    preferred_style: hasShortHumanStyle ? "curto_direto_contextual" : "contextual_sem_textao",
    max_sentences: hasShortHumanStyle ? 2 : 3,
    avoid: ["template_generico", "pergunta_repetida", "resposta_longa", "listar_opcoes_sem_contexto"],
    instruction: hasShortHumanStyle
      ? "Responder como especialista: frase curta, proximo passo claro, no maximo uma pergunta."
      : "Responder pelo contexto recente, sem alongar e sem copiar texto fixo."
  };
}

function countWords(value: string) {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

const SALES_LEAD_PROFILE_KEYS = [
  "stage", "etapa_atual", "commercial_stage", "ultima_intencao", "intencao_inicial",
  "selected_plan", "plano_interesse", "requested_screens", "device", "aparelho",
  "download_status", "install_status", "trial_status", "payment_status", "payment_method",
  "wants_test", "wants_recharge", "wants_renewal", "wants_activation", "pediu_pix",
  "codigo_enviado", "accepted_special_promo", "special_promo_offer", "nivel_interesse",
  "last_bot_question", "next_expected_reply", "next_best_action", "main_objection"
] as const;

function compactSalesLeadProfile(leadProfile: Record<string, unknown>) {
  return SALES_LEAD_PROFILE_KEYS.reduce<Record<string, unknown>>((result, key) => {
    const value = leadProfile[key];
    if (value !== undefined && value !== null && typeof value !== "object") {
      result[key] = typeof value === "string" ? truncateForModel(value, 240) : value;
    }
    return result;
  }, {});
}

function compactSpecialistExample(example: SpecialistExample) {
  return {
    customer_last_message: truncateForModel(example.customer_last_message, 280),
    bot_previous_message: truncateForModel(example.bot_previous_message, 360),
    specialist_message: truncateForModel(example.specialist_message, 420),
    style_notes: truncateForModel(example.style_notes, 220),
    inferred_specialist_action: truncateForModel(example.inferred_specialist_action, 140),
    why_specialist_intervened: truncateForModel(example.why_specialist_intervened, 180),
    success_signal: example.success_signal || null
  };
}

function truncateForModel(value: unknown, maxLength: number) {
  if (typeof value !== "string") return value || null;
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export function shouldUseAIResponse(input: {
  message: string;
  intent: string;
  leadProfile: Record<string, unknown>;
  recentMessages?: ConversationMessage[];
  specialistExamplesCount?: number;
  learningMemoriesCount?: number;
}) {
  const normalized = input.message.trim().toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean);
  const contextualShortMessage = words.length < 4 || /^(sim|nao|não|isso|ja|já|ok|pode|quero|ativar|mensal)$/i.test(normalized);
  const contextualFact = /\b(paguei|pagamento|baixei|instalei|usei|ativar|teste|mensal)\b/i.test(normalized);
  const commercialStage = ["unknown", "technical_support", "activation_help", "free_trial", "ask_price", "ask_payment"].includes(input.intent);
  const hasKnownFacts = Object.keys(input.leadProfile).some((key) =>
    ["selected_plan", "device", "downloaded_app", "used_app_before", "payment_status", "wants_test", "wants_activation"].includes(key)
  );
  const hasHumanHistory = (input.recentMessages || []).some((item) => item.role === "human_agent");
  const hasSpecialistLearning = Number(input.specialistExamplesCount || 0) > 0;
  const hasDailyLearning = Number(input.learningMemoriesCount || 0) > 0;

  return hasSpecialistLearning || hasDailyLearning || (commercialStage && (contextualShortMessage || contextualFact || hasKnownFacts || hasHumanHistory));
}
