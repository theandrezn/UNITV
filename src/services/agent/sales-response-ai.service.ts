import "server-only";
import { createOpenAIClient, getSalesAgentOpenAIModel, getStrongSalesAgentOpenAIModel } from "@/lib/openai/client";
import { sanitizeCustomerMessage } from "@/lib/whatsapp/customer-message-safety";

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
};

type GenerateSalesResponseInput = {
  message: string;
  intent: string;
  leadProfile: Record<string, unknown>;
  recentMessages?: ConversationMessage[];
  specialistExamples?: SpecialistExample[];
  fallbackReply?: string | null;
  useStrongModel?: boolean;
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
  "Nunca repita pergunta que o cliente ja respondeu.",
  "Se disse que ja baixou, nao pergunte se baixou.",
  "Se disse que ja usou, considere que conhece o app.",
  "Se disse que nao pagou, nao peca comprovante.",
  "Nao jogue tabela completa de preco cedo demais.",
  "Primeiro descubra se e renovacao ou primeira vez; depois pergunte preferencia de plano sem valores.",
  "So cite todos os valores se o cliente pedir claramente todos os valores, precos, tabela ou quais planos tem.",
  "Se o cliente escolher um plano especifico ou citar um valor, responda somente o valor daquele plano e avance para Pix/cartao.",
  "Se escolheu mensal, considere o plano mensal de R$ 25 e nao cite os outros planos.",
  "Se informou TV Box, nao pergunte o aparelho novamente.",
  "Faca no maximo uma pergunta e conduza ao proximo passo.",
  "Nao mande menu. Nao cite IA, regra local, debug, sistema, schema ou backend.",
  "Nao confirme pagamento sem validacao. Nao invente numero de telas.",
  "Dados oficiais para usar somente quando permitido: mensal R$ 25, trimestral/3 meses R$ 70, semestral/6 meses R$ 120, anual R$ 200.",
  "Teste gratis: 3 dias.",
  "Downloader TV: 8322904.",
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
      facts: input.leadProfile,
      recent_conversation: (input.recentMessages || []).slice(-12).map((item) => ({
        role: item.role,
        content: item.content
      })),
      specialist_examples: (input.specialistExamples || []).slice(0, 3),
      safe_fallback: input.fallbackReply || null
    };

    try {
      const response = await client.responses.create({
        model: input.useStrongModel ? getStrongSalesAgentOpenAIModel() : getSalesAgentOpenAIModel(),
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
        }
      });

      const parsed = JSON.parse(response.output_text || "{}") as { reply?: string };
      const sanitized = sanitizeCustomerMessage(parsed.reply || "");
      return sanitized.blocked || !sanitized.text ? null : sanitized.text;
    } catch {
      return null;
    }
  }
}

export function shouldUseAIResponse(input: {
  message: string;
  intent: string;
  leadProfile: Record<string, unknown>;
  recentMessages?: ConversationMessage[];
  specialistExamplesCount?: number;
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

  return hasSpecialistLearning || (commercialStage && (contextualShortMessage || contextualFact || hasKnownFacts || hasHumanHistory));
}
