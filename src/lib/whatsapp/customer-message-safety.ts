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
  /^suporte!!$/i,
  /funciona em qualquer tv/i,
  /serve para iphone/i,
  /^escolha uma op[cç][aã]o/i
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
    return { text: "", blocked: true, reason: String(unsafePattern) };
  }

  if (looksLikeTechnicalPayload(text)) {
    return { text: "", blocked: true, reason: "technical_payload" };
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
  const responseIntent = classifyCustomerFacingResponseIntent(response);

  if (
    (responseIntent === "saudacao_inicial" || isInitialGreetingResponse(normalized)) &&
    (
      profile.saudacao_enviada === true ||
      isActiveDownloadOrTrialFlow(profile) ||
      recentBotMessages.some((previous) => classifyCustomerFacingResponseIntent(previous) === "saudacao_inicial")
    )
  ) {
    return { valid: false, reason: "repeats_welcome" };
  }

  if (
    responseIntent === "pergunta_aparelho_teste" &&
    profile.pergunta_aparelho_enviada === true &&
    !/\b(so me confirma|só me confirma|qual deles)\b/.test(normalized)
  ) {
    return { valid: false, reason: "repeats_device_question" };
  }

  if (
    responseIntent === "valores_enviados" &&
    (profile.valores_enviados === true || recentBotMessages.some((previous) => classifyCustomerFacingResponseIntent(previous) === "valores_enviados"))
  ) {
    return { valid: false, reason: "repeats_values" };
  }

  if (profile.downloaded_app === true && /\b(voce ja baixou|você já baixou|ja baixou|já baixou)\b/.test(normalized)) {
    return { valid: false, reason: "asks_download_again" };
  }

  if (
    typeof profile.device === "string" && profile.device !== "unknown" &&
    /\b(qual aparelho|onde vai instalar|vai usar onde|qual aparelho voce usa|qual aparelho você usa)\b/.test(normalized)
  ) {
    return { valid: false, reason: "asks_device_again" };
  }

  if ((profile.selected_plan === "mensal" || profile.plano_interesse === "mensal") && /\b(qual plano voce quer|qual plano você quer|escolha o plano)\b/.test(normalized)) {
    return { valid: false, reason: "asks_plan_again" };
  }

  if (isPrematurePurchaseAssumption(normalized) && !hasClearPurchaseConfirmation(profile)) {
    return { valid: false, reason: "assumes_purchase_before_confirmation" };
  }

  if ((profile.has_paid === false || profile.payment_status === "not_paid") && /\b(se ja pagou|se já pagou|envie o comprovante|mand[ae] o comprovante)\b/.test(normalized)) {
    return { valid: false, reason: "asks_receipt_when_not_paid" };
  }

  if (
    (
      profile.device_compatible === false ||
      profile.device_compatible === "unknown" ||
      ["iphone", "roku", "samsung_tv", "lg_tv", "computer"].includes(String(profile.device || ""))
    ) &&
    /(mediafire\.com|\b862585\b|baixe o apk|use esse link)/i.test(response)
  ) {
    return { valid: false, reason: "sends_installation_to_unconfirmed_device" };
  }

  if (recentBotMessages.some((previous) => areSimilar(normalized, normalize(previous)))) {
    return { valid: false, reason: "similar_to_recent_bot_message" };
  }

  return { valid: true };
}

export function classifyCustomerFacingResponseIntent(response: string) {
  const normalized = normalize(response);

  if (/\b(seja bem vindo|seja bem-vindo|meu nome e andre|meu nome é andre)\b/.test(normalized)) {
    return "saudacao_inicial";
  }

  if (
    /\b(teste gratis|teste gratuito|3 dias)\b/.test(normalized) &&
    /\b(qual aparelho|em qual aparelho|me diz so em qual aparelho|me diz só em qual aparelho|celular android|tv box|android tv|google tv|fire stick|firestick)\b/.test(normalized)
  ) {
    if (/\b(so me confirma|só me confirma|qual deles)\b/.test(normalized)) {
      return "confirmacao_aparelho_teste";
    }
    return "pergunta_aparelho_teste";
  }

  if (/\b(mensal).*\br\$ ?25\b/.test(normalized) && /\b(3 meses|6 meses|anual|r\$ ?70|r\$ ?120|r\$ ?200)\b/.test(normalized)) {
    return "valores_enviados";
  }

  if (/\b(pix copia e cola|qr code pix|chave pix|vou te passar a chave pix)\b/.test(normalized)) {
    return "pix_enviado";
  }

  if (/\b(conseguiu fazer o pagamento|enviar o comprovante|envia o comprovante|mande o comprovante)\b/.test(normalized)) {
    return "followup_pagamento";
  }

  if (/\b(teste gratis|teste gratuito|3 dias)\b/.test(normalized)) {
    return "convite_teste";
  }

  return "resposta_geral";
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

function isActiveDownloadOrTrialFlow(profile: Record<string, unknown>) {
  const state = [
    profile.stage,
    profile.commercial_stage,
    profile.state,
    profile.next_expected_reply,
    profile.install_status,
    profile.download_status
  ].map((value) => String(value || "").toLowerCase()).join(" ");

  return (
    /\b(test_offer|device_qualification|download_instructions|download_instructions_sent|awaiting_download_installation|awaiting_installation|awaiting_test_activation|download_confirmation|link_sent)\b/.test(state) ||
    Boolean(profile.last_download_url_sent)
  );
}

function isInitialGreetingResponse(normalized: string) {
  return /\b(oi|ola|ol[aá])\b.{0,80}\b(voce ja usa|você já usa|primeira vez|seria sua primeira vez|faz o uso do app)\b/.test(normalized);
}

function isPrematurePurchaseAssumption(normalized: string) {
  return (
    /\b(vamos liberar|vou liberar|entao vamos liberar|entao vou liberar)\b/.test(normalized) ||
    /\b(vou ativar|vamos ativar|vou fazer sua recarga|vamos fazer sua recarga)\b/.test(normalized) ||
    /\b(vou gerar o pix|vou gerar pix|vamos gerar o pix|vamos seguir)\b/.test(normalized) ||
    /\b(liberar no celular android|liberar no celular|ativar no celular android)\b/.test(normalized)
  );
}

function hasClearPurchaseConfirmation(profile: Record<string, unknown>) {
  return (
    profile.accepted_special_promo === true ||
    profile.payment_method === "pix" ||
    profile.payment_method === "card" ||
    profile.pediu_pix === true ||
    profile.has_paid === true ||
    profile.payment_status === "paid" ||
    profile.payment_status === "confirmed" ||
    profile.stage === "awaiting_payment" ||
    profile.commercial_stage === "awaiting_payment" ||
    profile.next_expected_reply === "payment_proof"
  );
}

function normalize(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
