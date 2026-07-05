import "server-only";
import { createOpenAIClient, getDefaultOpenAIModel } from "@/lib/openai/client";

export class AiService {
  async generateAssistantReply(input: { message: string }) {
    const client = createOpenAIClient();
    const completion = await client.chat.completions.create({
      model: getDefaultOpenAIModel(),
      messages: [
        {
          role: "system",
          content: "Você é um assistente de atendimento da UNITV. Responda de forma objetiva e segura."
        },
        { role: "user", content: input.message }
      ],
      temperature: 0.2
    });

    return completion.choices[0]?.message.content ?? "";
  }

  async analyzeReceiptPlaceholder(input: { description: string }) {
    return {
      status: "not_implemented",
      summary: `Receipt analysis is prepared but not implemented yet: ${input.description}`
    };
  }

  async classifyCustomerIntent(input: { message: string }) {
    const client = createOpenAIClient();
    const completion = await client.chat.completions.create({
      model: getDefaultOpenAIModel(),
      messages: [
        {
          role: "system",
          content: "Classifique a intenção em uma palavra: purchase, renewal, support, receipt, unknown."
        },
        { role: "user", content: input.message }
      ],
      temperature: 0
    });

    return completion.choices[0]?.message.content?.trim() || "unknown";
  }
}
