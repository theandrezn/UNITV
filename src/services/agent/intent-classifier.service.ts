import "server-only";
import { z } from "zod";
import { createOpenAIClient, getDefaultOpenAIModel, getIntentOpenAIModel } from "@/lib/openai/client";
import { UNITV_INTENT_JSON_SCHEMA, UNITV_INTENT_SYSTEM_PROMPT } from "./unitv-sales-ai-prompt";
import { isUnitvInstallationRequest } from "@/lib/unitv/device-compatibility";

export const intentSchema = z.enum([
  "greeting",
  "buy_plan",
  "renew_plan",
  "ask_price",
  "ask_payment",
  "card_payment",
  "pix_payment",
  "free_trial",
  "support",
  "activation_help",
  "receipt_sent",
  "technical_support",
  "human_help",
  "unknown"
]);

export const intentClassificationSchema = z.object({
  intent: intentSchema,
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
  suggested_reply: z.string().min(1)
});

export type IntentClassification = z.infer<typeof intentClassificationSchema>;

const fallbackClassification: IntentClassification = {
  intent: "unknown",
  confidence: 0.2,
  summary: "NÃ£o foi possÃ­vel classificar a mensagem com seguranÃ§a.",
  suggested_reply: "Claro, eu te ajudo. VocÃª quer comprar um plano, renovar um acesso ou precisa de ajuda com instalaÃ§Ã£o?"
};

export class IntentClassifierService {
  async classify(input: { message: string }): Promise<IntentClassification> {
    const deterministic = classifyDeterministicIntent(input.message);
    if (deterministic) {
      return deterministic;
    }

    try {
      const client = createOpenAIClient();
      const content = await classifyWithResponsesApi(client, input.message);
      if (!content) {
        const completion = await client.chat.completions.create({
          model: getDefaultOpenAIModel(),
          messages: [
            {
              role: "system",
              content:
                `${UNITV_INTENT_SYSTEM_PROMPT}\nResponda somente JSON valido com intent, confidence, summary e suggested_reply.`
            },
            {
              role: "user",
              content: input.message
            }
          ],
          response_format: { type: "json_object" },
          temperature: 0
        });

        return parseClassification(completion.choices[0]?.message.content);
      }

      return parseClassification(content);
    } catch {
      return fallbackClassification;
    }
  }
}

async function classifyWithResponsesApi(client: unknown, message: string) {
  const responsesClient = client as {
    responses?: {
      create: (input: Record<string, unknown>) => Promise<{ output_text?: string; output?: unknown[] }>;
    };
  };
  if (!responsesClient.responses?.create) {
    return null;
  }

  const response = await responsesClient.responses.create({
    model: getIntentOpenAIModel(),
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: UNITV_INTENT_SYSTEM_PROMPT }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: message }]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "unitv_intent_classification",
        schema: UNITV_INTENT_JSON_SCHEMA,
        strict: true
      }
    }
  });

  return response.output_text || extractResponseText(response.output);
}

function extractResponseText(output: unknown) {
  if (!Array.isArray(output)) {
    return null;
  }

  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) {
        return text;
      }
    }
  }

  return null;
}

function parseClassification(content: string | null | undefined) {
  if (!content) {
    return fallbackClassification;
  }

  try {
    const parsed = intentClassificationSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : fallbackClassification;
  } catch {
    return fallbackClassification;
  }
}

function classifyDeterministicIntent(message: string): IntentClassification | null {
  const text = normalizeMessage(message);
  if (!text) {
    return {
      intent: "unknown",
      confidence: 0.2,
      summary: "Mensagem vazia.",
      suggested_reply: fallbackClassification.suggested_reply
    };
  }

  if (/^(oi|ola|olq|olÃ¡|opa|bom dia|boa tarde|boa noite|e ai|e aÃ­|oie|oii+|oiii+|quero saber|mais informacoes|mais informaÃ§Ãµes)[!?.,\s]*$/.test(text)) {
    return fixedClassification("greeting", "SaudaÃ§Ã£o simples.");
  }

  if (/\b(humano|atendente|especialista|vendedor|consultor|pessoa|responsavel|responsÃ¡vel)\b/.test(text)) {
    return fixedClassification("human_help", "Cliente pediu atendimento humano.");
  }

  if (/\b(teste|gratis|gratuito|free trial)\b/.test(text)) {
    return fixedClassification("free_trial", "Cliente pediu teste grÃ¡tis.");
  }

  if (/\b(quantas telas|2 telas|duas telas|telas?)\b/.test(text)) {
    return fixedClassification("unknown", "Cliente perguntou sobre telas.");
  }

  if (/\b(preco|preÃ§o|valor|valores|quanto|quanto custa|planos?|mensal|trimestral|semestral|anual|desconto|promo[cÃ§]ao|promoÃ§Ã£o|caro|barato)\b/.test(text) &&
      !/\b(comprar|quero|renovar|renovacao|renovaÃ§Ã£o)\b/.test(text)) {
    return fixedClassification("ask_price", "Cliente pediu valores ou planos.");
  }

  if (/\b(renovar|renovacao|renovaÃ§Ã£o|recarga|recarregar)\b/.test(text)) {
    return fixedClassification("renew_plan", "Cliente pediu renovaÃ§Ã£o.");
  }

  if (/\b(comprar|compra|assinar|quero um codigo|quero codigo|liberar acesso|ativar plano|novo plano|novo acesso)\b/.test(text)) {
    return fixedClassification("buy_plan", "Cliente demonstrou intenÃ§Ã£o de compra.");
  }

  if (/^(ativar|ativacao|ativa|liberar)$/i.test(text)) {
    return fixedClassification("activation_help", "Cliente pediu ativacao.");
  }

  if (/\b(pix|chave pix|copia e cola|qr code)\b/.test(text)) {
    return fixedClassification("pix_payment", "Cliente pediu pagamento por Pix.");
  }

  if (/\b(cartao|cartÃ£o|credito|crÃ©dito|debito|dÃ©bito|link de pagamento)\b/.test(text)) {
    return fixedClassification("card_payment", "Cliente pediu pagamento por cartÃ£o.");
  }

  if (/\b(como pagar|pagamento|formas de pagamento|pagar)\b/.test(text)) {
    return fixedClassification("ask_payment", "Cliente perguntou sobre pagamento.");
  }

  if (/\b(paguei|ja paguei|feito o pagamento|pagamento feito|fiz o pagamento|acabei de pagar)\b/.test(text)) {
    return fixedClassification("unknown", "Cliente informou pagamento para checagem do provedor.");
  }

  if (/\b(comprovante|recibo|print do pagamento|transferencia|transferÃªncia)\b/.test(text)) {
    return fixedClassification("receipt_sent", "Cliente mencionou comprovante.");
  }

  if (isUnitvInstallationRequest(text) || /\b(codigo downloader|link nao funciona|link nÃ£o funciona)\b/.test(text)) {
    return fixedClassification("technical_support", "Cliente pediu instalaÃ§Ã£o ou download.");
  }

  if (/\b(travando|trava|erro|nao abre|nÃ£o abre|suporte|ajuda|problema|funciona|iphone|ios)\b/.test(text)) {
    return fixedClassification("technical_support", "Cliente pediu suporte tÃ©cnico.");
  }

  return null;
}

function fixedClassification(intent: IntentClassification["intent"], summary: string): IntentClassification {
  return {
    intent,
    confidence: 0.95,
    summary,
    suggested_reply: "Claro, eu te ajudo. Qual e o proximo passo que voce quer seguir?"
  };
}

function normalizeMessage(message: string) {
  return message
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
