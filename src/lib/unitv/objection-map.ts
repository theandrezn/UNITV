import { CONTINUATION_MENU, type WhatsAppMenu } from "@/lib/whatsapp/menus";

const PLANS_TEXT = ["Mensal - R$ 25", "3 meses - R$ 70", "6 meses - R$ 120", "Anual - R$ 200"].join("\n");

export type UnitvObjectionReply = {
  id: string;
  reply: string;
  menu?: WhatsAppMenu;
  followupKey?: string;
  needsHuman?: boolean;
};

type ObjectionRule = {
  id: string;
  pattern: RegExp;
  followupKey?: string;
  needsHuman?: boolean;
  buildReply: () => string;
  menu?: WhatsAppMenu;
};

const rules: ObjectionRule[] = [
  {
    id: "screens",
    pattern: /\b(quantas telas|2 telas|duas telas|telas?)\b/,
    followupKey: "screens",
    menu: CONTINUATION_MENU,
    buildReply: () =>
      "Depende do tipo de acesso e da configuração.\n\n" +
      "Para eu te orientar certo, você quer usar em quantos aparelhos e quais seriam eles?\n\n" +
      "Não quero te passar informação errada sobre telas."
  },
  {
    id: "price",
    pattern: /\b(qual valor|valor|preco|quanto custa|planos?)\b/,
    followupKey: "values",
    buildReply: () =>
      "O mensal fica R$ 25.\n\n" +
      "Também temos:\n" +
      PLANS_TEXT +
      "\n\nO mensal é uma boa opção para começar. Se você quiser economizar mais, o anual sai melhor no custo-benefício.\n\n" +
      "Você quer começar pelo mensal ou prefere um plano maior?"
  },
  {
    id: "too_expensive",
    pattern: /\b(caro|ta caro|muito caro)\b/,
    followupKey: "values",
    buildReply: () =>
      "Entendo.\n\n" +
      "O mensal fica R$ 25, que é o valor mais baixo para começar.\n\n" +
      "Agora, se você pensa em usar por mais tempo, os planos maiores compensam mais:\n" +
      PLANS_TEXT +
      "\n\nVocê quer começar com o mensal para testar ou prefere economizar no plano maior?"
  },
  {
    id: "discount",
    pattern: /\b(desconto|promocao|promo)\b/,
    followupKey: "values",
    buildReply: () =>
      "Os valores atuais já estão fechados:\n\n" +
      PLANS_TEXT +
      "\n\nO desconto real fica nos planos maiores, principalmente no anual.\n\nQuer que eu te passe o melhor custo-benefício?"
  },
  {
    id: "competitor_price",
    pattern: /\b(mais barato|vi barato|concorrente)\b/,
    followupKey: "values",
    buildReply: () =>
      "Entendo.\n\n" +
      "A diferença aqui é que você tem suporte para instalação, orientação na ativação e atendimento caso precise de ajuda.\n\n" +
      "Se quiser começar sem compromisso alto, o mensal é R$ 25.\n\nQuer começar pelo mensal ou fazer o teste grátis primeiro?"
  },
  {
    id: "stability",
    pattern: /\b(funciona mesmo|funciona|e bom|trava|travar|travando|travamento|cai muito)\b/,
    followupKey: "test",
    menu: CONTINUATION_MENU,
    buildReply: () =>
      "Boa pergunta.\n\n" +
      "Funciona em aparelhos compatíveis, sim. A qualidade depende da internet, do aparelho e da instalação.\n\n" +
      "O ideal é você fazer o teste grátis de 3 dias no seu aparelho e ver como fica.\n\nVocê vai usar na TV ou no celular?"
  },
  {
    id: "catalog_live_channels",
    pattern: /\b(futebol|jogo|canais?)\b/,
    followupKey: "test",
    menu: CONTINUATION_MENU,
    buildReply: () =>
      "A UNITV reúne canais ao vivo, filmes e séries no app.\n\n" +
      "A disponibilidade pode variar, mas você pode testar grátis por 3 dias e conferir no seu aparelho.\n\nQuer fazer o teste?"
  },
  {
    id: "catalog_movies",
    pattern: /\b(filmes|series)\b/,
    followupKey: "test",
    menu: CONTINUATION_MENU,
    buildReply: () =>
      "Tem sim. A UNITV reúne filmes, séries e canais ao vivo no mesmo app.\n\nVocê quer testar grátis ou já quer ver os planos?"
  },
  {
    id: "iphone",
    pattern: /\b(iphone|ios)\b/,
    followupKey: "support",
    menu: CONTINUATION_MENU,
    buildReply: () =>
      "No momento eu preciso confirmar a melhor forma para iPhone.\n\nVocê quer usar no iPhone ou tem também TV/TV Box?"
  },
  {
    id: "trust",
    pattern: /\b(golpe|confiavel|medo)\b/,
    followupKey: "test",
    menu: CONTINUATION_MENU,
    buildReply: () =>
      "Entendo totalmente.\n\n" +
      "Por isso o atendimento é feito por aqui, com suporte, orientação de instalação e ativação após confirmação.\n\n" +
      "Se preferir, você pode começar pelo teste grátis de 3 dias antes de contratar."
  },
  {
    id: "thinking",
    pattern: /\b(vou pensar|depois eu vejo|pensar)\b/,
    followupKey: "values",
    menu: CONTINUATION_MENU,
    buildReply: () =>
      "Sem problema.\n\nPara facilitar, os planos são:\n\n" +
      PLANS_TEXT +
      "\n\nVocê também pode testar grátis por 3 dias antes de decidir."
  }
];

export function findUnitvObjectionReply(message: string): UnitvObjectionReply | null {
  const normalized = normalize(message);
  for (const rule of rules) {
    if (!rule.pattern.test(normalized)) {
      continue;
    }

    return {
      id: rule.id,
      reply: rule.buildReply(),
      menu: rule.menu,
      followupKey: rule.followupKey,
      needsHuman: rule.needsHuman
    };
  }

  return null;
}

function normalize(message: string) {
  return message
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
