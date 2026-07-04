import "server-only";
import { z } from "zod";
import { createOpenAIClient, getDefaultOpenAIModel } from "@/lib/openai/client";

export const intentSchema = z.enum([
  "buy_plan",
  "renew_plan",
  "support",
  "activation_help",
  "receipt_sent",
  "price_question",
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
  summary: "Nao foi possivel classificar a mensagem com seguranca.",
  suggested_reply: "Entendi. Voce quer comprar um plano, renovar um acesso ou falar com suporte?"
};

export class IntentClassifierService {
  async classify(input: { message: string }): Promise<IntentClassification> {
    const client = createOpenAIClient();
    const completion = await client.chat.completions.create({
      model: getDefaultOpenAIModel(),
      messages: [
        {
          role: "system",
          content:
            "Classifique a intencao do cliente UniTV. Responda somente JSON valido com intent, confidence, summary e suggested_reply. Nunca ofereca codigo de ativacao."
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
