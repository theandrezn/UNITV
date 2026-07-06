export const CUSTOMER_SAFE_FALLBACK =
  "Claro, eu te ajudo. Me confirma rapidinho: você quer ativar um plano, fazer teste grátis ou precisa de ajuda com instalação?";

const INTERNAL_PATTERNS = [
  /\bresolvido por regra local\b/i,
  /\bregra local\b/i,
  /\bsem uso de ia\b/i,
  /\bintent\b/i,
  /\bclassifier\b/i,
  /\bdebug\b/i,
  /\bhandoff_reason\b/i,
  /\bfollowup_key\b/i,
  /\brequires_human\b/i,
  /\blead_profile\b/i,
  /\bjson\b/i,
  /\bschema\b/i,
  /\bopenai\b/i,
  /\bresponses api\b/i,
  /\bteste passou\b/i,
  /\bhealth ok\b/i,
  /\bcommit\b/i
];

const BAD_CUSTOMER_PATTERNS = [
  /consigo te ajudar com a ativa[cç][aã]o,\s*mas n[aã]o libero c[oó]digo automaticamente/i,
  /coleta o problema/i,
  /^suporte!!$/i
];

export type CustomerMessageSafetyResult = {
  text: string;
  blocked: boolean;
  reason?: string;
};

export function sanitizeCustomerMessage(message: string): CustomerMessageSafetyResult {
  const text = String(message || "").trim();
  if (!text) {
    return { text: "", blocked: false };
  }

  const unsafePattern = [...INTERNAL_PATTERNS, ...BAD_CUSTOMER_PATTERNS].find((pattern) => pattern.test(text));
  if (unsafePattern) {
    return { text: CUSTOMER_SAFE_FALLBACK, blocked: true, reason: String(unsafePattern) };
  }

  if (looksLikeTechnicalPayload(text)) {
    return { text: CUSTOMER_SAFE_FALLBACK, blocked: true, reason: "technical_payload" };
  }

  return { text, blocked: false };
}

export function validateResponseAgainstLeadProfile(
  response: string,
  leadProfile: Record<string, unknown> | null | undefined,
  recentBotMessages: string[] = []
) {
  const normalized = normalize(response);
  const profile = leadProfile && typeof leadProfile === "object" && !Array.isArray(leadProfile) ? leadProfile : {};

  if (profile.downloaded_app === true && /\b(voce ja baixou|você já baixou|ja baixou|já baixou)\b/.test(normalized)) {
    return { valid: false, reason: "asks_download_again" };
  }

  if ((profile.device === "tvbox" || profile.aparelho === "TV Box / Android TV") && /\b(qual aparelho|onde vai instalar|vai usar onde)\b/.test(normalized)) {
    return { valid: false, reason: "asks_device_again" };
  }

  if ((profile.selected_plan === "mensal" || profile.plano_interesse === "mensal") && /\b(qual plano voce quer|qual plano você quer|escolha o plano)\b/.test(normalized)) {
    return { valid: false, reason: "asks_plan_again" };
  }

  if ((profile.has_paid === false || profile.payment_status === "not_paid") && /\b(se ja pagou|se já pagou|envie o comprovante|mand[ae] o comprovante)\b/.test(normalized)) {
    return { valid: false, reason: "asks_receipt_when_not_paid" };
  }

  if (recentBotMessages.some((previous) => areSimilar(normalized, normalize(previous)))) {
    return { valid: false, reason: "similar_to_recent_bot_message" };
  }

  return { valid: true };
}

export function createCustomerMessageHash(text: string) {
  let hash = 0;
  const normalized = normalize(text);
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
}

function looksLikeTechnicalPayload(text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return false;
  }

  return /"?(intent|debug|schema|lead_profile|requires_human|followup_key)"?\s*:/i.test(trimmed);
}

function areSimilar(current: string, previous: string) {
  if (!current || !previous) {
    return false;
  }

  if (current === previous) {
    return true;
  }

  const currentWords = new Set(current.split(/\s+/).filter(Boolean));
  const previousWords = new Set(previous.split(/\s+/).filter(Boolean));
  if (currentWords.size < 5 || previousWords.size < 5) {
    return false;
  }

  let overlap = 0;
  for (const word of currentWords) {
    if (previousWords.has(word)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(currentWords.size, previousWords.size) >= 0.82;
}

function normalize(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
