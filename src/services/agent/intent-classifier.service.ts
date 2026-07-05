import "server-only";
import { z } from "zod";
import { createOpenAIClient, getDefaultOpenAIModel } from "@/lib/openai/client";

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
  summary: "Não foi possível classificar a mensagem com segurança.",
  suggested_reply: "Entendi. Você quer comprar um plano, renovar um acesso ou falar com suporte?"
};

export class IntentClassifierService {
  async classify(input: { message: string }): Promise<IntentClassification> {
    const deterministic = classifyDeterministicIntent(input.message);
    if (deterministic) {
      return deterministic;
    }

    const client = createOpenAIClient();
    const completion = await client.chat.completions.create({
      model: getDefaultOpenAIModel(),
      messages: [
        {
          role: "system",
          content:
            "Classifique a intenção do cliente UniTV usando apenas: greeting, buy_plan, renew_plan, ask_price, ask_payment, card_payment, pix_payment, free_trial, receipt_sent, activation_help, technical_support, human_help, unknown. Use card_payment quando pedir pagamento por cartão ou link de pagamento. Use pix_payment quando pedir Pix, chave Pix, QR Code ou Pix Copia e Cola. Use free_trial quando pedir teste grátis. Responda somente JSON válido com intent, confidence, summary e suggested_reply. Nunca ofereça código de ativação."
        },
        {
          role: "user",
          content: input.message
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0
    });

    const content = completion.choices[0]?.message.content;
    if (!content) {
      return fallbackClassification;
    }

    const parsed = intentClassificationSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : fallbackClassification;
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

  if (/^(oi|ola|olá|opa|bom dia|boa tarde|boa noite|e ai|e aí|oie|oii+|oiii+)[!?.,\s]*$/.test(text)) {
    return fixedClassification("greeting", "Saudação simples.");
  }

  if (/\b(humano|atendente|especialista|vendedor|consultor|pessoa|responsavel|responsável)\b/.test(text)) {
    return fixedClassification("human_help", "Cliente pediu atendimento humano.");
  }

  if (/\b(teste|gratis|gratuito|free trial)\b/.test(text)) {
    return fixedClassification("free_trial", "Cliente pediu teste grátis.");
  }

  if (/\b(preco|preço|valor|valores|quanto custa|planos?|mensal|trimestral|semestral|anual)\b/.test(text) &&
      !/\b(comprar|quero|renovar|renovacao|renovação)\b/.test(text)) {
    return fixedClassification("ask_price", "Cliente pediu valores ou planos.");
  }

  if (/\b(renovar|renovacao|renovação)\b/.test(text)) {
    return fixedClassification("renew_plan", "Cliente pediu renovação.");
  }

  if (/\b(comprar|compra|assinar|quero um codigo|quero codigo|liberar acesso|ativar plano)\b/.test(text)) {
    return fixedClassification("buy_plan", "Cliente demonstrou intenção de compra.");
  }

  if (/\b(pix|chave pix|copia e cola|qr code)\b/.test(text)) {
    return fixedClassification("pix_payment", "Cliente pediu pagamento por Pix.");
  }

  if (/\b(cartao|cartão|credito|crédito|debito|débito|link de pagamento)\b/.test(text)) {
    return fixedClassification("card_payment", "Cliente pediu pagamento por cartão.");
  }

  if (/\b(como pagar|pagamento|formas de pagamento|pagar)\b/.test(text)) {
    return fixedClassification("ask_payment", "Cliente perguntou sobre pagamento.");
  }

  if (/\b(paguei|ja paguei|feito o pagamento|pagamento feito|fiz o pagamento|acabei de pagar)\b/.test(text)) {
    return fixedClassification("unknown", "Cliente informou pagamento para checagem do provedor.");
  }

  if (/\b(comprovante|recibo|print do pagamento|transferencia|transferência)\b/.test(text)) {
    return fixedClassification("receipt_sent", "Cliente mencionou comprovante.");
  }

  if (/\b(instalar|instalacao|instalação|baixar|download|dowload|apk|tutorial|downloader|tv box|android tv|celular|codigo downloader)\b/.test(text)) {
    return fixedClassification("technical_support", "Cliente pediu instalação ou download.");
  }

  if (/\b(travando|trava|erro|nao abre|não abre|suporte|ajuda|problema|funciona)\b/.test(text)) {
    return fixedClassification("technical_support", "Cliente pediu suporte técnico.");
  }

  return null;
}

function fixedClassification(intent: IntentClassification["intent"], summary: string): IntentClassification {
  return {
    intent,
    confidence: 0.95,
    summary,
    suggested_reply: "Resolvido por regra local sem uso de IA."
  };
}

function normalizeMessage(message: string) {
  return message
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
