export function sanitizeReply(reply: string) {
  return reply
    .replace(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{2,}){1,}\b/g, "[codigo removido]")
    .replace(/código de ativação/gi, "orientacao de ativacao")
    .replace(/codigo de ativacao/gi, "orientacao de ativacao")
    .trim();
}
