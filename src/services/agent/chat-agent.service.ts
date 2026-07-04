import "server-only";
import type { IntentClassification } from "./intent-classifier.service";
import { sanitizeReply } from "@/lib/agent/reply-safety";

export const INITIAL_UNITV_REPLY =
  "Ola! Sou o atendimento automatico da UniTV. Posso te ajudar com planos, renovacao, ativacao ou suporte. Voce quer comprar, renovar ou precisa de ajuda com o app?";

const LOW_CONFIDENCE_REPLY = "Entendi. Voce quer comprar um plano, renovar um acesso ou falar com suporte?";

export class ChatAgentService {
  generateReply(input: { message: string; classification: IntentClassification }) {
    const trimmed = input.message.trim();

    if (!trimmed) {
      return "";
    }

    if (input.classification.confidence < 0.55) {
      return LOW_CONFIDENCE_REPLY;
    }

    const suggestedReply = sanitizeReply(input.classification.suggested_reply);
    return suggestedReply || INITIAL_UNITV_REPLY;
  }
}
