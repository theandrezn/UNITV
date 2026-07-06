import type { LeadHotAlertType, LeadTemperature } from "@/repositories/lead-hot-alerts.repository";

export type HotLeadSignal = {
  alert_type: LeadHotAlertType;
  lead_temperature: Extract<LeadTemperature, "quente" | "muito_quente">;
  reason: string;
  next_best_action: string;
  priority: number;
};

export type HotLeadSignalContext = {
  message: string;
  intent?: string | null;
  leadProfile?: Record<string, unknown>;
  stage?: string | null;
  hasMedia?: boolean;
  recentMessages?: Array<{ role?: string; content?: string | null }>;
};

export function detectHotLeadSignal(context: HotLeadSignalContext): HotLeadSignal | null {
  const normalized = normalize(context.message);
  const profile = context.leadProfile || {};
  const stage = normalize(String(context.stage || profile.stage || profile.etapa_atual || ""));
  const planInterest = String(profile.selected_plan || profile.plano_interesse || "");
  const askedPriceCount = countRecentPriceQuestions(context.recentMessages || []) + (profile.asked_price ? 1 : 0);
  const commercialHumanStage = /\b(valores|instalacao|teste|pagamento|ativacao|compra|escolha_plano|recarga)\b/.test(stage);

  if (isProofMessage(normalized, context.hasMedia)) {
    return {
      alert_type: "proof_sent",
      lead_temperature: "muito_quente",
      reason: "enviou comprovante",
      next_best_action: "Validar pagamento e liberar codigo.",
      priority: 5
    };
  }

  if (/\b(quero pagar|vou pagar|como pago|fazer pagamento|manda pagamento|pode mandar pagamento)\b/.test(normalized)) {
    return {
      alert_type: "wants_to_pay",
      lead_temperature: "muito_quente",
      reason: "quer pagar",
      next_best_action: planInterest ? "Fechar pagamento agora." : "Confirmar plano e fechar pagamento.",
      priority: 5
    };
  }

  if (/\b(pix|chave pix|manda pix|copia e cola|qr code|pagamento)\b/.test(normalized) || context.intent === "pix_payment") {
    return {
      alert_type: planInterest ? "pix_requested" : "wants_to_pay",
      lead_temperature: "muito_quente",
      reason: planInterest ? "pediu Pix" : "quer pagar, mas ainda precisa confirmar plano",
      next_best_action: planInterest ? "Enviar Pix/link de pagamento e acompanhar comprovante." : "Confirmar plano e fechar pagamento.",
      priority: 5
    };
  }

  if (askedPriceCount >= 2 && /\b(valor|preco|quanto|mensal|fica)\b/.test(normalized)) {
    return {
      alert_type: "price_asked_multiple_times",
      lead_temperature: "quente",
      reason: "perguntou valor mais de uma vez",
      next_best_action: "Abordar com teste gratis ou melhor custo-beneficio.",
      priority: 3
    };
  }

  const selectedPlan = detectPlan(normalized) || planInterest;
  if (selectedPlan) {
    const veryHot = /\b(pagar|pix|ativar|quero|vou querer)\b/.test(normalized);
    return {
      alert_type: "plan_selected",
      lead_temperature: veryHot ? "muito_quente" : "quente",
      reason: `escolheu plano ${selectedPlan}`,
      next_best_action: "Conduzir para pagamento.",
      priority: veryHot ? 5 : 4
    };
  }

  if (isDownloadedMessage(normalized) || profile.downloaded_app === true || profile.installed_app === true) {
    const veryHot = /\b(ativar|teste|pagar|mensal)\b/.test(normalized) || profile.wants_activation || profile.wants_test;
    return {
      alert_type: "downloaded_app",
      lead_temperature: veryHot ? "muito_quente" : "quente",
      reason: "cliente ja baixou/instalou o app",
      next_best_action: "Conduzir para teste gratis de 3 dias ou mensal de R$ 25.",
      priority: veryHot ? 4 : 3
    };
  }

  if (/\b(teste gratis|teste|3 dias|libera teste|liberar teste|quero testar)\b/.test(normalized) || profile.wants_test) {
    const alreadyReady = profile.downloaded_app === true || profile.installed_app === true;
    return {
      alert_type: "test_requested",
      lead_temperature: alreadyReady ? "muito_quente" : "quente",
      reason: "pediu teste gratis",
      next_best_action: alreadyReady ? "Liberar teste ou pedir dado necessario." : "Garantir instalacao e liberar teste.",
      priority: alreadyReady ? 4 : 3
    };
  }

  if (isInstallationStuck(normalized, stage)) {
    const veryHot = Boolean(profile.selected_plan || profile.plano_interesse || profile.wants_test || profile.wants_activation);
    return {
      alert_type: "installation_stuck",
      lead_temperature: veryHot ? "muito_quente" : "quente",
      reason: "travou na instalacao",
      next_best_action: "Entrar manualmente para destravar instalacao.",
      priority: veryHot ? 4 : 3
    };
  }

  if (/\b(quantas telas|2 telas|duas telas|aparelhos|simultaneo|tv e celular)\b/.test(normalized)) {
    return {
      alert_type: "screens_question",
      lead_temperature: "quente",
      reason: "perguntou telas/aparelhos",
      next_best_action: "Responder sem inventar e conduzir para plano adequado ou atendimento manual.",
      priority: 3
    };
  }

  if (context.intent === "human_help" && commercialHumanStage) {
    return {
      alert_type: "human_support_needed",
      lead_temperature: "quente",
      reason: "pediu humano em etapa comercial",
      next_best_action: "Assumir atendimento manual.",
      priority: 3
    };
  }

  return null;
}

export function isHotLeadTemperatureAllowed(temperature: LeadTemperature, minimum: LeadTemperature) {
  const rank: Record<LeadTemperature, number> = { frio: 0, morno: 1, quente: 2, muito_quente: 3 };
  return rank[temperature] >= rank[minimum];
}

function detectPlan(normalized: string) {
  if (/\banual|1 ano|365|200\b/.test(normalized)) return "anual";
  if (/\b6 meses|semestral|180|120\b/.test(normalized)) return "6_meses";
  if (/\b3 meses|trimestral|90|70\b/.test(normalized)) return "3_meses";
  if (/\bmensal|30 dias|mes\b|25\b/.test(normalized)) return "mensal";
  return null;
}

function countRecentPriceQuestions(messages: Array<{ role?: string; content?: string | null }>) {
  return messages.filter((message) =>
    message.role === "customer" &&
    typeof message.content === "string" &&
    /\b(valor|preco|preço|quanto|mensal|fica)\b/i.test(message.content)
  ).length;
}

function isProofMessage(normalized: string, hasMedia?: boolean) {
  return Boolean(hasMedia && /\b(comprovante|paguei|pix|pagamento|recibo|segue)\b/.test(normalized)) ||
    /\b(comprovante|segue comprovante|ja fiz o pix|paguei|pagamento feito)\b/.test(normalized);
}

function isDownloadedMessage(normalized: string) {
  return /\b(ja baixei|baixei|ja instalei|instalei|ja tenho o app|ja usei)\b/.test(normalized);
}

function isInstallationStuck(normalized: string, stage: string) {
  return /\b(erro|nao consigo|nao baixou|nao baixa|nao instala|travou|nao abre|link nao abre|link nao funciona|nao achei|nao aparece|fontes desconhecidas)\b/.test(normalized) &&
    (/\b(instalacao|download|teste|ativacao)\b/.test(stage) || /\b(instalar|download|downloader|apk|app)\b/.test(normalized));
}

function normalize(value: string) {
  return value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
