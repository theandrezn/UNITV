import "server-only";
import { z } from "zod";
import { createOpenAIClient, getSalesAgentOpenAIModel, getStrongSalesAgentOpenAIModel } from "@/lib/openai/client";
import {
  sanitizeCustomerMessage,
  validateConciseUnitvReply,
  validateResponseAgainstLeadProfile
} from "@/lib/whatsapp/customer-message-safety";
import { KnowledgeService } from "@/services/knowledge/knowledge.service";
import { executeObservedOpenAICall } from "@/services/ai/openai-call-observer";
import { OPENAI_ECONOMY_POLICY } from "@/lib/openai/economy-policy";

type ConversationMessage = {
  role?: string | null;
  content?: string | null;
};

type KnowledgeArticle = {
  id?: string;
  title?: string;
  category?: string;
  content?: string;
};

export type ContextualResponseInput = {
  currentMessage: string;
  intent: string;
  leadProfile: Record<string, unknown>;
  recentMessages?: ConversationMessage[];
  responseDirective: string;
  operationalContext?: Record<string, unknown>;
  conversationId?: string | null;
  useStrongModel?: boolean;
};

const responseSchema = z.object({ reply: z.string().min(1) });

const RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string", minLength: 1 }
  },
  required: ["reply"]
} as const;

const SYSTEM_PROMPT = [
  "Voce e o atendente comercial humano da UNITV no WhatsApp.",
  "Toda resposta deve ser criada agora a partir do contexto real e da base de conhecimento recebida.",
  "Nao copie literalmente exemplos da base; transforme fatos e orientacoes em uma resposta original.",
  "Quando houver aprendizado do especialista no contexto operacional, aplique o raciocinio e o estilo sem copiar a frase original.",
  "Considere primeiro o estado persistido, depois a ultima pergunta do atendente, a ultima mensagem do cliente, o historico recente e a intervencao humana.",
  "Use somente fatos autorizados pelo contexto operacional, pelos artefatos obrigatorios e pela base. Nao invente preco, desconto, compatibilidade, Pix, pagamento ou codigo.",
  "Preserve literalmente todos os artefatos obrigatorios recebidos, como links, valores, numero de pedido, codigo Downloader e codigos de acesso.",
  "Cumpra tambem o resultado semantico obrigatorio e nao mencione os assuntos proibidos recebidos no contrato de escrita.",
  "Pagamento, Pix, pedido e codigo so podem ser tratados como confirmados quando o estado e os artefatos autorizados indicarem confirmacao real.",
  "Imite o ritmo do especialista Andre: responda primeiro ao ponto exato e indique apenas o proximo passo.",
  "Em respostas normais use de 6 a 15 palavras, nunca mais de 22, no maximo duas frases e uma pergunta.",
  "So ultrapasse 22 palavras quando links, codigos, Pix ou um passo tecnico obrigatorio precisarem ser preservados.",
  "Em oferta mensal, nunca acrescente valores trimestral, semestral ou anual. Revele outro valor apenas quando ele estiver no resultado autorizado.",
  "Quando todos os valores forem autorizados, mantenha o nome de cada plano junto do respectivo valor.",
  "Nao mencione IA, prompt, regra, template, sistema, backend, JSON, base de conhecimento ou classificacao.",
  "Retorne somente JSON valido no schema solicitado."
].join("\n");

const RESPONSE_POLICY = OPENAI_ECONOMY_POLICY.contextualResponse;

export class ContextualResponseAIService {
  constructor(private readonly knowledgeService = new KnowledgeService()) {}

  async generateResponse(input: ContextualResponseInput): Promise<string | null> {
    if (!process.env.OPENAI_API_KEY) {
      return null;
    }

    const knowledge = await this.loadKnowledge(input);
    if (!knowledge.length) {
      return null;
    }

    const recentBotMessages = (input.recentMessages || [])
      .filter((message) => message.role === "assistant" && typeof message.content === "string")
      .slice(-5)
      .map((message) => String(message.content));
    const requiredArtifacts = extractRequiredArtifacts(input.responseDirective);
    const directiveContract = extractDirectiveContract(input.responseDirective);
    const context = {
      current_customer_message: truncate(input.currentMessage, RESPONSE_POLICY.currentMessageCharacters),
      intent: input.intent,
      state_and_known_facts: compactLeadProfile(input.leadProfile),
      recent_conversation: (input.recentMessages || []).slice(-RESPONSE_POLICY.recentMessages).map((message) => ({
        role: message.role || "unknown",
        content: truncate(message.content || "", RESPONSE_POLICY.messageCharacters)
      })),
      operational_context: compactRecord(
        input.operationalContext || {},
        12,
        RESPONSE_POLICY.operationalValueCharacters
      ),
      required_artifacts: requiredArtifacts,
      knowledge_base: knowledge,
      writing_contract: {
        original_contextual_copy_required: true,
        programmed_copy_forbidden: true,
        one_clear_next_step: true,
        preferred_words: "6-15",
        normal_maximum_words: 22,
        maximum_sentences: 2,
        maximum_questions: 1,
        required_semantic_outcome: directiveContract.requiredSemanticOutcome,
        forbidden_topics: directiveContract.forbiddenTopics
      }
    };

    try {
      const model = input.useStrongModel ? getStrongSalesAgentOpenAIModel() : getSalesAgentOpenAIModel();
      const response = await executeObservedOpenAICall(
        { callType: "contextual_response", model, conversationId: input.conversationId || null },
        () => createOpenAIClient().responses.create({
          model,
          input: [
            { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
            { role: "user", content: [{ type: "input_text", text: JSON.stringify(context) }] }
          ],
          text: {
            format: {
              type: "json_schema",
              name: "unitv_contextual_response",
              schema: RESPONSE_JSON_SCHEMA,
              strict: true
            }
          },
          max_output_tokens: getContextualResponseOutputBudget(input, requiredArtifacts)
        })
      );
      if (!response) {
        return null;
      }

      const parsed = responseSchema.safeParse(JSON.parse(response.output_text || "{}"));
      if (!parsed.success) {
        return null;
      }
      const sanitized = sanitizeCustomerMessage(parsed.data.reply);
      if (sanitized.blocked || !sanitized.text) {
        return null;
      }
      if (!requiredArtifacts.every((artifact) => sanitized.text.includes(artifact))) {
        return null;
      }
      if (!validateResponseAgainstDirectiveContract(sanitized.text, directiveContract)) {
        return null;
      }
      const styleValidation = validateConciseUnitvReply(sanitized.text, {
        allowOperationalDetail: requiredArtifacts.length > 0 ||
          /(technical_support|support|activation_help|card_payment|pix_payment|receipt_sent)/.test(input.intent)
      });
      if (!styleValidation.valid) {
        return null;
      }
      const validation = validateResponseAgainstLeadProfile(sanitized.text, input.leadProfile, recentBotMessages);
      return validation.valid ? sanitized.text : null;
    } catch {
      return null;
    }
  }

  private async loadKnowledge(input: ContextualResponseInput) {
    const stage = String(input.leadProfile.stage || input.leadProfile.commercial_stage || "");
    const query = [input.currentMessage, input.intent, stage].filter(Boolean).join(" ");
    const [identity, neverDo, relevant] = await Promise.all([
      this.knowledgeService.getKnowledgeByCategory("identidade_do_agente"),
      this.knowledgeService.getKnowledgeByCategory("o_que_nunca_fazer"),
      this.knowledgeService.searchKnowledge(query)
    ]);

    const unique = new Map<string, KnowledgeArticle>();
    // Relevant operational knowledge must win the small token budget. Identity
    // is already enforced by the stable system prompt, while one guardrail
    // article remains available for state and payment safety.
    for (const article of [...relevant, ...neverDo, ...identity] as KnowledgeArticle[]) {
      const key = String(article.id || article.title || article.category || "");
      if (key && !unique.has(key)) {
        unique.set(key, article);
      }
    }

    return [...unique.values()].slice(0, RESPONSE_POLICY.knowledgeArticles).map((article) => ({
      title: article.title || article.category || "Conhecimento UNITV",
      category: article.category || "geral",
      guidance: selectRelevantExcerpt(article.content || "", query, RESPONSE_POLICY.knowledgeCharacters)
    })).filter((article) => article.guidance);
  }
}

function getContextualResponseOutputBudget(input: ContextualResponseInput, requiredArtifacts: string[]) {
  const needsMoreRoom = requiredArtifacts.length > 0 ||
    /(technical_support|support|activation_help|card_payment|pix_payment|receipt_sent)/.test(input.intent);
  return needsMoreRoom ? RESPONSE_POLICY.complexOutputTokens : RESPONSE_POLICY.defaultOutputTokens;
}

export function extractRequiredArtifacts(directive: string) {
  const artifacts = new Set<string>();
  for (const match of directive.matchAll(/https?:\/\/[^\s)]+/gi)) {
    artifacts.add(match[0].replace(/[.,;!?]+$/, ""));
  }
  for (const match of directive.matchAll(/R\$\s*\d+(?:[.,]\d{1,2})?/gi)) {
    artifacts.add(match[0]);
  }
  if (/\b20[,.]90\b/.test(directive) && ![...artifacts].some((artifact) => /20[,.]90/.test(artifact))) {
    artifacts.add(directive.match(/\b20[,.]90\b/)?.[0] || "20,90");
  }
  for (const match of directive.matchAll(/\bUTV-[A-Z0-9-]+\b/gi)) {
    artifacts.add(match[0]);
  }
  for (const match of directive.matchAll(/\b862585\b/g)) {
    artifacts.add(match[0]);
  }

  const accessCodeSection = directive.match(/(?:seu codigo de acesso|seus codigos de acesso|codigos? autorizados?)[^\n]*\n+([\s\S]{1,500})/i)?.[1] || "";
  for (const line of accessCodeSection.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const candidate = line.replace(/^\d+\.\s*/, "").trim();
    if (/^(?=.*\d)[A-Z0-9-]{5,}$/i.test(candidate)) {
      artifacts.add(candidate);
    }
  }

  return [...artifacts];
}

export function extractDirectiveContract(directive: string) {
  const normalized = normalize(directive);
  const monthlyInterestOffer = /\b(plano )?mensal\b/.test(normalized) &&
    /\b(?:r\$ ?)?20[,.]?90\b/.test(normalized) &&
    /\binteresse\b/.test(normalized);
  const monthlyScreenCoverage = /\b(plano )?mensal\b/.test(normalized) && /\bate 3 telas\b/.test(normalized);
  const allPlanPrices = /\bmensal\b/.test(normalized) && /\btrimestral\b/.test(normalized) &&
    /\bsemestral\b/.test(normalized) && /\banual\b/.test(normalized) &&
    /20[,.]?90/.test(normalized) && /\b70\b/.test(normalized) && /\b120\b/.test(normalized) && /\b200\b/.test(normalized);
  return {
    requiredSemanticOutcome: allPlanPrices
      ? "identificar os quatro planos com seus respectivos valores"
      : monthlyInterestOffer
      ? "perguntar se o cliente tem interesse no plano mensal"
      : monthlyScreenCoverage
        ? "informar que o plano mensal cobre ate 3 telas"
        : null,
    forbiddenTopics: monthlyInterestOffer
      ? ["quantidade de telas", "aparelhos", "outros planos", "outros valores"]
      : monthlyScreenCoverage
        ? ["perguntar quantas telas", "lista de outros planos"]
        : []
  };
}

export function validateResponseAgainstDirectiveContract(
  response: string,
  contract: ReturnType<typeof extractDirectiveContract>
) {
  if (!contract.requiredSemanticOutcome) return true;
  const normalized = normalize(response);
  if (contract.requiredSemanticOutcome === "perguntar se o cliente tem interesse no plano mensal") {
    const asksInterest = /\binteresse\b/.test(normalized) && /\bhoje\b/.test(normalized) && response.includes("?");
    const mentionsMonthly = /\bmensal\b/.test(normalized);
    const mentionsForbiddenTopic = /\b(tela|telas|aparelho|aparelhos|trimestral|semestral|anual)\b/.test(normalized);
    const mentionsForbiddenPrice = /(?:r\$\s*)?(?:70|120|200)(?:[,.]00)?\b/.test(normalized);
    return asksInterest && mentionsMonthly && !mentionsForbiddenTopic && !mentionsForbiddenPrice;
  }
  if (contract.requiredSemanticOutcome === "identificar os quatro planos com seus respectivos valores") {
    return /\bmensal\b[^\n]{0,30}20[,.]?90/.test(normalized) &&
      /\btrimestral\b[^\n]{0,30}\b70\b/.test(normalized) &&
      /\bsemestral\b[^\n]{0,30}\b120\b/.test(normalized) &&
      /\banual\b[^\n]{0,30}\b200\b/.test(normalized);
  }
  if (contract.requiredSemanticOutcome === "informar que o plano mensal cobre ate 3 telas") {
    const statesCoverage = /\bate 3 telas\b/.test(normalized);
    const asksScreenCount = /\b(quantas telas|quantos aparelhos)\b/.test(normalized);
    const mentionsOtherPlans = /\b(trimestral|semestral|anual)\b/.test(normalized);
    return statesCoverage && !asksScreenCount && !mentionsOtherPlans;
  }
  return false;
}

function compactLeadProfile(profile: Record<string, unknown>) {
  const allowedKeys = [
    "stage", "commercial_stage", "state", "ultima_intencao", "selected_plan", "plano_interesse",
    "requested_screens", "device", "aparelho", "device_compatible", "download_status", "install_status",
    "downloaded_app", "installed_app", "trial_status", "payment_status", "payment_method", "has_paid",
    "codigo_enviado", "last_bot_question", "next_expected_reply", "next_best_action", "main_objection",
    "accepted_special_promo", "special_promo_offer", "wants_test", "wants_recharge", "wants_renewal"
  ];
  return allowedKeys.reduce<Record<string, unknown>>((result, key) => {
    const value = profile[key];
    if (value !== undefined && value !== null && typeof value !== "object") {
      result[key] = typeof value === "string" ? truncate(value, RESPONSE_POLICY.profileValueCharacters) : value;
    }
    return result;
  }, {});
}

function compactRecord(record: Record<string, unknown>, limit: number, valueCharacters: number) {
  return Object.entries(record).slice(0, limit).reduce<Record<string, unknown>>((result, [key, value]) => {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      result[key] = typeof value === "string" ? truncate(value, valueCharacters) : value;
    }
    return result;
  }, {});
}

function selectRelevantExcerpt(content: string, query: string, maxLength: number) {
  const normalizedTerms = query
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\W+/)
    .filter((term) => term.length >= 4)
    .slice(0, 8);
  const sections = content.split(/\n(?=##?\s)/).filter(Boolean);
  const ranked = sections
    .map((section, index) => ({
      section,
      index,
      score: normalizedTerms.reduce((score, term) => score + (normalize(section).includes(term) ? 1 : 0), 0)
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = ranked.filter((item) => item.score > 0).slice(0, 3);
  return truncate((selected.length ? selected : ranked.slice(0, 2)).map((item) => item.section).join("\n"), maxLength);
}

function normalize(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function truncate(value: string, maxLength: number) {
  const text = String(value || "").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
