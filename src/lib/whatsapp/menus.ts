export type WhatsAppMenuRow = {
  title: string;
  description: string;
  rowId: string;
};

export type WhatsAppMenu = {
  id: string;
  title: string;
  description: string;
  buttonText: string;
  footerText: string;
  sections: Array<{ title: string; rows: WhatsAppMenuRow[] }>;
  fallbackText: string;
};

type MenuSelection = {
  intent:
    | "ask_price"
    | "free_trial"
    | "buy_plan"
    | "technical_support"
    | "receipt_sent"
    | "human_help"
    | "pix_payment"
    | "card_payment";
  message: string;
};

const mainRows: WhatsAppMenuRow[] = [
  { title: "Ver planos", description: "Conheca valores e duracoes", rowId: "menu:main:view_plans" },
  { title: "Fazer teste grátis", description: "Teste a UNiTV por 3 dias", rowId: "menu:main:free_trial" },
  { title: "Comprar agora", description: "Escolha seu plano", rowId: "menu:main:buy_now" },
  { title: "Aprender a instalar", description: "Receba o passo a passo", rowId: "menu:main:install" },
  { title: "Enviar comprovante", description: "Envie imagem ou PDF", rowId: "menu:main:receipt" },
  { title: "Falar com especialista", description: "Atendimento humano", rowId: "menu:main:specialist" }
];

export const MAIN_MENU: WhatsAppMenu = {
  id: "main",
  title: "Como posso te ajudar?",
  description: "Escolha uma opcao abaixo",
  buttonText: "Ver opções",
  footerText: "UNiTV",
  sections: [{ title: "Atendimento", rows: mainRows }],
  fallbackText: formatFallback(
    "Olá! Bem-vindo à melhor plataforma de filmes e canais de todo o Brasil 🧡\n\nO que você quer hoje?",
    mainRows
  )
};

const deviceRows: WhatsAppMenuRow[] = [
  { title: "Smart TV", description: "TV com sistema de aplicativos", rowId: "menu:devices:smart_tv" },
  { title: "TV Box", description: "Aparelho conectado a TV", rowId: "menu:devices:tv_box" },
  { title: "Celular Android", description: "Smartphone ou tablet Android", rowId: "menu:devices:android" },
  { title: "iPhone", description: "iPhone ou iPad", rowId: "menu:devices:iphone" },
  { title: "Computador", description: "Windows, macOS ou Linux", rowId: "menu:devices:computer" },
  { title: "Outro aparelho", description: "Informe o modelo", rowId: "menu:devices:other" }
];

export const DEVICE_MENU: WhatsAppMenu = {
  id: "devices",
  title: "Qual aparelho voce usa?",
  description: "Escolha o aparelho para receber a orientacao correta",
  buttonText: "Escolher aparelho",
  footerText: "UNiTV",
  sections: [{ title: "Aparelhos", rows: deviceRows }],
  fallbackText: formatFallback("Qual aparelho voce usa?", deviceRows)
};

const installRows: WhatsAppMenuRow[] = [
  { title: "Instalar na TV pelo Downloader", description: "Codigo 8322904 e passo a passo", rowId: "menu:install:downloader_tv" },
  { title: "Baixar APK para TV", description: "TV Box, Android TV e aparelhos compativeis", rowId: "menu:install:apk_tv" },
  { title: "Baixar APK para celular Android", description: "Versao mobile para Android", rowId: "menu:install:apk_android" },
  { title: "Ver video tutorial", description: "Tutorial no YouTube", rowId: "menu:install:video" },
  { title: "Falar com suporte", description: "Atendimento para instalacao", rowId: "menu:install:support" }
];

export const INSTALL_MENU: WhatsAppMenu = {
  id: "install",
  title: "Instalação UNiTV",
  description: "Escolha a opção ideal para o seu aparelho",
  buttonText: "Ver instalação",
  footerText: "UNiTV",
  sections: [{ title: "Instalação", rows: installRows }],
  fallbackText: formatFallback("📥 Instalação UNiTV\n\nEscolha a opção ideal para o seu aparelho 👇", installRows)
};

const continuationRows: WhatsAppMenuRow[] = [
  { title: "Ver planos", description: "Conheca valores e duracoes", rowId: "menu:continue:view_plans" },
  { title: "Fazer teste grátis", description: "Teste a UNiTV por 3 dias", rowId: "menu:continue:free_trial" },
  { title: "Comprar agora", description: "Escolha seu plano", rowId: "menu:continue:buy_now" },
  { title: "Falar com especialista", description: "Atendimento humano", rowId: "menu:continue:specialist" }
];

export const CONTINUATION_MENU: WhatsAppMenu = {
  id: "continue",
  title: "Consegui te ajudar?",
  description: "Escolha o proximo passo",
  buttonText: "Continuar",
  footerText: "UNiTV",
  sections: [{ title: "Próximo passo", rows: continuationRows }],
  fallbackText: formatFallback("O que você quer fazer agora?", continuationRows)
};

const paymentRows: WhatsAppMenuRow[] = [
  { title: "Pagar com Pix", description: "QR Code e Copia e Cola", rowId: "menu:payment:pix" },
  { title: "Pagar com cartão", description: "Link seguro do Mercado Pago", rowId: "menu:payment:card" }
];

export const PAYMENT_MENU: WhatsAppMenu = {
  id: "payment",
  title: "Como deseja pagar?",
  description: "Escolha uma forma de pagamento",
  buttonText: "Escolher pagamento",
  footerText: "Pagamento seguro Mercado Pago",
  sections: [{ title: "Pagamento", rows: paymentRows }],
  fallbackText: formatFallback("Como deseja pagar?", paymentRows)
};

export function buildPlansMenu(
  plans: Array<{ name: string; slug: string; price_cents: number; currency?: string; duration_days?: number | null }>
): WhatsAppMenu {
  const rows = plans.filter((plan) => plan.price_cents > 0).slice(0, 6).map((plan) => ({
    title: `${plan.name} - ${formatMoney(plan.price_cents, plan.currency)}`,
    description: plan.duration_days ? `${plan.duration_days} dias` : "Escolher este plano",
    rowId: `menu:plans:${plan.slug}`
  }));

  return {
    id: "plans",
    title: "Escolha seu plano UNiTV",
    description: "Selecione uma opcao abaixo",
    buttonText: "Ver planos",
    footerText: "UNiTV",
    sections: [{ title: "Planos disponiveis", rows }],
    fallbackText: formatFallback("Escolha seu plano UNiTV", rows)
  };
}

export function resolveMenuSelection(text: string, metadata: Record<string, unknown> | null | undefined) {
  const trimmed = text.trim();
  const direct = directSelections[trimmed];
  if (direct) {
    return direct;
  }

  if (!/^[1-6]$/.test(trimmed)) {
    return null;
  }

  const menuId = typeof metadata?.last_menu_id === "string" ? metadata.last_menu_id : "";
  return numericSelections[menuId]?.[Number(trimmed) - 1] || null;
}

const directSelections: Record<string, MenuSelection> = {
  "menu:main:view_plans": { intent: "ask_price", message: "quero ver os planos" },
  "menu:main:free_trial": { intent: "free_trial", message: "quero fazer o teste gratis" },
  "menu:main:buy_now": { intent: "buy_plan", message: "quero comprar agora" },
  "menu:main:install": { intent: "technical_support", message: "quero aprender a instalar" },
  "menu:main:receipt": { intent: "receipt_sent", message: "quero enviar comprovante" },
  "menu:main:specialist": { intent: "human_help", message: "quero falar com especialista" },
  "menu:continue:view_plans": { intent: "ask_price", message: "quero ver os planos" },
  "menu:continue:free_trial": { intent: "free_trial", message: "quero fazer o teste gratis" },
  "menu:continue:buy_now": { intent: "buy_plan", message: "quero comprar agora" },
  "menu:continue:specialist": { intent: "human_help", message: "quero falar com especialista" },
  "menu:payment:pix": { intent: "pix_payment", message: "quero pagar no pix" },
  "menu:payment:card": { intent: "card_payment", message: "quero pagar com cartao" },
  "menu:install:downloader_tv": { intent: "technical_support", message: "instalar na tv pelo downloader" },
  "menu:install:apk_tv": { intent: "technical_support", message: "baixar apk para tv" },
  "menu:install:apk_android": { intent: "technical_support", message: "baixar apk para celular android" },
  "menu:install:video": { intent: "technical_support", message: "ver video tutorial de instalacao" },
  "menu:install:support": { intent: "human_help", message: "quero falar com suporte sobre instalacao" },
  "menu:devices:smart_tv": { intent: "technical_support", message: "quero instalar na Smart TV" },
  "menu:devices:tv_box": { intent: "technical_support", message: "quero instalar na TV Box" },
  "menu:devices:android": { intent: "technical_support", message: "quero instalar no celular Android" },
  "menu:devices:iphone": { intent: "technical_support", message: "quero instalar no iPhone" },
  "menu:devices:computer": { intent: "technical_support", message: "quero instalar no computador" },
  "menu:devices:other": { intent: "technical_support", message: "quero instalar em outro aparelho" }
};

const numericSelections: Record<string, MenuSelection[]> = {
  main: mainRows.map((row) => directSelections[row.rowId]),
  plans: ["mensal", "trimestral", "semestral", "anual"].map((slug) => planSelection(slug)),
  devices: deviceRows.map((row) => directSelections[row.rowId]),
  install: installRows.map((row) => directSelections[row.rowId]),
  continue: continuationRows.map((row) => directSelections[row.rowId]),
  payment: paymentRows.map((row) => directSelections[row.rowId])
};

for (const slug of ["mensal", "trimestral", "semestral", "anual"]) {
  directSelections[`menu:plans:${slug}`] = planSelection(slug);
}

function planSelection(slug: string): MenuSelection {
  const names: Record<string, string> = {
    mensal: "mensal",
    trimestral: "3 meses",
    semestral: "6 meses",
    anual: "anual"
  };
  return { intent: "buy_plan", message: `quero comprar o plano ${names[slug] || slug}` };
}

function formatFallback(title: string, rows: WhatsAppMenuRow[]) {
  const numberLabels = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"];
  return `${title}\n\n${rows.map((row, index) => `${numberLabels[index]} ${row.title}`).join("\n")}`;
}

function formatMoney(priceCents: number, currency = "BRL") {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(priceCents / 100).replace(/\u00a0/g, " ");
}
