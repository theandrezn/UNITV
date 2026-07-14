import "server-only";
import { createOpenAIClient, getSalesAgentOpenAIModel, getStrongSalesAgentOpenAIModel } from "@/lib/openai/client";
import {
  sanitizeCustomerMessage,
  validateConciseUnitvReply,
  validateResponseAgainstLeadProfile
} from "@/lib/whatsapp/customer-message-safety";
import { executeObservedOpenAICall } from "@/services/ai/openai-call-observer";
import { KnowledgeService } from "@/services/knowledge/knowledge.service";
import { extractRequiredArtifacts } from "@/services/agent/contextual-response-ai.service";
import { OPENAI_ECONOMY_POLICY } from "@/lib/openai/economy-policy";

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
  "Interprete o historico, o estado e a base de conhecimento antes de escrever.",
  "A base de conhecimento e a fonte dos fatos comerciais, fluxos, identidade e estilo; nao existem frases prontas para copiar.",
  "Escreva uma resposta original com o ritmo do especialista Andre: direta, contextual e com uma unica proxima acao.",
  "Em respostas normais use de 6 a 15 palavras, nunca mais de 22, no maximo duas frases e uma pergunta.",
  "So ultrapasse 22 palavras quando um passo tecnico ou artefato obrigatorio precisar ser preservado.",
  "Use exemplos do especialista como referencia de raciocinio e ritmo, nunca como texto para copiar.",
  "Preserve os artefatos obrigatorios recebidos, mas crie a mensagem a partir do contexto e da base.",
  "Nao invente preco, Pix, link, codigo, compatibilidade ou pagamento. Nao mencione IA, sistema, regra, template ou backend.",
  "Respeite sempre os fatos e bloqueios persistidos no contexto."
].join("\n");

const SALES_POLICY = OPENAI_ECONOMY_POLICY.salesResponse;

export class SalesResponseAIService {
  constructor(private readonly knowledgeService = new KnowledgeService()) {}

  async generateResponse(input: GenerateSalesResponseInput) {
    if (!process.env.OPENAI_API_KEY) {
      return null;
    }

    const client = createOpenAIClient();
    const stage = String(input.leadProfile.stage || input.leadProfile.commercial_stage || "");
    const knowledgeQuery = [input.message, input.intent, stage].filter(Boolean).join(" ");
    const [identityKnowledge, guardrailKnowledge, relevantKnowledge] = await Promise.all([
      this.knowledgeService.getKnowledgeByCategory("identidade_do_agente"),
      this.knowledgeService.getKnowledgeByCategory("o_que_nunca_fazer"),
      this.knowledgeService.searchKnowledge(knowledgeQuery)
    ]);
    const knowledge = deduplicateKnowledge([...identityKnowledge, ...guardrailKnowledge, ...relevantKnowledge]);
    const requiredArtifacts = extractRequiredArtifacts(input.fallbackReply || "");
    const context = {
      latest_customer_message: truncateForModel(input.message, 600),
      detected_intent: input.intent,
      facts: compactSalesLeadProfile(input.leadProfile),
      recent_conversation: (input.recentMessages || []).slice(-SALES_POLICY.recentMessages).map((item) => ({
        role: item.role,
        content: truncateForModel(item.content, SALES_POLICY.messageCharacters)
      })),
      specialist_examples: (input.specialistExamples || []).slice(0, 1).map(compactSpecialistExample),
      learned_operational_directives: (input.learningMemories || []).slice(0, 2).map((memory) => ({
        intent: memory.intent || null,
        stage: memory.stage || null,
        rule: truncateForModel(memory.rule, 360),
        style_directive: truncateForModel(memory.style_directive, 220),
        avoid: (memory.avoid || []).slice(0, 3).map((item) => truncateForModel(item, 120)),
        confidence: memory.confidence || null
      })),
      specialist_style_directives: buildSpecialistStyleDirectives(input.specialistExamples || []),
      required_artifacts: requiredArtifacts,
      knowledge_base: knowledge
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
        max_output_tokens: getSalesResponseOutputBudget(input)
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
      if (!requiredArtifacts.every((artifact) => sanitized.text.includes(artifact))) {
        return null;
      }
      const styleValidation = validateConciseUnitvReply(sanitized.text, {
        allowOperationalDetail: requiredArtifacts.length > 0 ||
          /(technical_support|support|activation_help)/.test(input.intent)
      });
      if (!styleValidation.valid) {
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

function deduplicateKnowledge(articles: Array<Record<string, unknown>>) {
  const unique = new Map<string, Record<string, unknown>>();
  for (const article of articles) {
    const key = String(article.id || article.title || article.category || "");
    if (key && !unique.has(key)) {
      unique.set(key, article);
    }
  }
  return [...unique.values()].slice(0, SALES_POLICY.knowledgeArticles).map((article) => ({
    title: article.title || article.category || "Conhecimento UNITV",
    category: article.category || "geral",
    guidance: truncateForModel(article.content, SALES_POLICY.knowledgeCharacters)
  }));
}

function getSalesResponseOutputBudget(input: GenerateSalesResponseInput) {
  if (/(technical_support|support|activation_help)/.test(input.intent)) return SALES_POLICY.technicalOutputTokens;
  if (/(free_trial|ask_price|buy_plan|renew_plan)/.test(input.intent)) return SALES_POLICY.commercialOutputTokens;
  return SALES_POLICY.defaultOutputTokens;
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
    preferred_words: "6-15",
    max_words: 22,
    max_sentences: 2,
    max_questions: 1,
    avoid: ["template_generico", "pergunta_repetida", "resposta_longa", "listar_opcoes_sem_contexto"],
    instruction: hasShortHumanStyle
      ? "Responder como especialista: frase curta, proximo passo claro, no maximo uma pergunta."
      : "Responder pelo contexto recente em ate 22 palavras, sem alongar e sem copiar texto fixo."
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
