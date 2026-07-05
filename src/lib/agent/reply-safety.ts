export function sanitizeReply(reply: string) {
  return reply
    .replace(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{2,}){1,}\b/g, "[código removido]")
    .replace(/código de ativação/gi, "orientação de ativação")
    .replace(/codigo de ativacao/gi, "orientação de ativação")
    .trim();
}
