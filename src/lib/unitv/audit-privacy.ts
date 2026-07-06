const DOCUMENT_PATTERN = /\b(?:\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})\b/g;
const LONG_NUMBER_PATTERN = /\b\d{11,18}\b/g;
const ACCESS_CODE_PATTERN = /\b(?=[A-Z0-9-]{6,24}\b)(?=.*[A-Z])(?=.*\d)[A-Z0-9-]{6,24}\b/g;
const PIX_LABEL_PATTERN = /\b(pix|chave pix|copia e cola)\s*[:\-]?\s*[^\n]{8,120}/gi;

export function maskAuditText(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }

  return value
    .replace(PIX_LABEL_PATTERN, "$1: [PIX_MASCARADO]")
    .replace(DOCUMENT_PATTERN, "[DOCUMENTO_MASCARADO]")
    .replace(LONG_NUMBER_PATTERN, "[NUMERO_MASCARADO]")
    .replace(ACCESS_CODE_PATTERN, "[CODIGO_MASCARADO]");
}

export function maskAuditPhone(phone: unknown) {
  const digits = typeof phone === "string" ? phone.replace(/\D/g, "") : "";
  if (digits.length < 8) {
    return "telefone nao informado";
  }

  const country = digits.startsWith("55") ? "+55 " : "+";
  const local = digits.startsWith("55") ? digits.slice(2) : digits;
  const area = local.slice(0, 2);
  const last = local.slice(-4);
  return `${country}${area} *****-${last}`;
}

export function sanitizeAuditMetadata(value: unknown): unknown {
  if (typeof value === "string") {
    return maskAuditText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditMetadata(item));
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      if (/(base64|media|raw|comprovante|receipt|file|code|codigo|pix_payload)/i.test(key)) {
        output[key] = "[DADO_MASCARADO]";
      } else {
        output[key] = sanitizeAuditMetadata(field);
      }
    }
    return output;
  }

  return value;
}

export function excerptAuditText(value: unknown, maxLength = 160) {
  const text = typeof value === "string" ? String(maskAuditText(value)).replace(/\s+/g, " ").trim() : "";
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}
