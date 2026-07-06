const MASKED_CODE = "[CODIGO_MASCARADO]";
const MASKED_DOCUMENT = "[DOCUMENTO_MASCARADO]";
const MASKED_PIX = "[PIX_MASCARADO]";

export function maskSpecialistTrainingText(value: string | null | undefined) {
  if (!value) {
    return value || null;
  }

  return value
    .replace(/\b(?:chave\s+)?pix\s*[:=-]\s*\S+/gi, `Pix: ${MASKED_PIX}`)
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, MASKED_DOCUMENT)
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, MASKED_DOCUMENT)
    .replace(/\b(?:cpf|cnpj|documento)\s*[:=-]?\s*\d[\d.\/-]{9,17}\b/gi, MASKED_DOCUMENT)
    .replace(/\b(?:codigo|código|senha|acesso)\s*[:=-]\s*[a-z0-9-]{5,}\b/gi, `Código: ${MASKED_CODE}`)
    .replace(/\b(?=[a-z0-9-]{8,}\b)(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z0-9-]+\b/gi, MASKED_CODE);
}

export function buildMaskedConversationExcerpt(
  messages: Array<{ role?: unknown; content?: unknown }>,
  specialistMessage: string
) {
  const labels: Record<string, string> = {
    customer: "Cliente",
    assistant: "Bot",
    human_agent: "Especialista"
  };
  const lines = messages
    .slice(-8)
    .filter((message) => typeof message.content === "string" && message.content.trim())
    .map((message) => `${labels[String(message.role)] || "Conversa"}: ${maskSpecialistTrainingText(String(message.content))}`);

  lines.push(`Especialista: ${maskSpecialistTrainingText(specialistMessage)}`);
  return lines.join("\n");
}
