import { CONTINUATION_MENU, type WhatsAppMenu } from "@/lib/whatsapp/menus";

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
      "Depende do tipo de acesso e da configuracao.\n\n" +
      "Para eu te orientar certo, voce quer usar em quantos aparelhos e quais seriam eles?\n\n" +
      "Nao quero te passar informacao errada sobre telas."
  },
  {
    id: "price",
    pattern: /\b(qual valor|preco|quanto custa)\b/,
    followupKey: "values",
    buildReply: () => "Voce teria interesse no mensal mesmo?"
  },
  {
    id: "too_expensive",
    pattern: /\b(caro|ta caro|muito caro)\b/,
    followupKey: "values",
    buildReply: () => "Entendo. Voce ja faz recarga por qual valor hoje?"
  },
  {
    id: "discount",
    pattern: /\b(desconto|promocao|promo)\b/,
    followupKey: "values",
    buildReply: () => "Me diz primeiro qual plano voce quer seguir que eu vejo a melhor condicao pra voce."
  },
  {
    id: "competitor_price",
    pattern: /\b(mais barato|vi barato|concorrente)\b/,
    followupKey: "values",
    buildReply: () =>
      "Entendo. Aqui eu te ajudo na instalacao e na ativacao por aqui mesmo.\n\n" +
      "Voce fazia recarga por qual valor?"
  },
  {
    id: "stability",
    pattern: /\b(funciona mesmo|funciona|e bom|trava|travar|travando|travamento|cai muito)\b/,
    followupKey: "test",
    menu: CONTINUATION_MENU,
    buildReply: () =>
      "Boa pergunta.\n\n" +
      "Funciona em aparelhos compativeis, sim. A qualidade depende da internet, do aparelho e da instalacao.\n\n" +
      "O ideal e voce fazer o teste gratis de 3 dias no seu aparelho e ver como fica.\n\nVoce vai usar na TV ou no celular?"
  },
  {
    id: "catalog_live_channels",
    pattern: /\b(futebol|jogo|canais?)\b/,
    followupKey: "test",
    menu: CONTINUATION_MENU,
    buildReply: () =>
      "A UNITV reune canais ao vivo, filmes e series no app.\n\n" +
      "A disponibilidade pode variar, mas voce pode testar gratis por 3 dias e conferir no seu aparelho.\n\nQuer fazer o teste?"
  },
  {
    id: "catalog_movies",
    pattern: /\b(filmes|series)\b/,
    followupKey: "test",
    menu: CONTINUATION_MENU,
    buildReply: () => "Tem sim. A UNITV reune filmes, series e canais ao vivo no mesmo app.\n\nVoce quer testar gratis?"
  },
  {
    id: "iphone",
    pattern: /\b(iphone|ios)\b/,
    followupKey: "support",
    menu: CONTINUATION_MENU,
    buildReply: () =>
      "No iPhone eu nao tenho instalacao Android para enviar.\n\nVoce teria uma TV Box, Android TV, Fire Stick ou celular Android para usar?"
  },
  {
    id: "trust",
    pattern: /\b(golpe|confiavel|medo)\b/,
    followupKey: "test",
    menu: CONTINUATION_MENU,
    buildReply: () =>
      "Entendo totalmente.\n\n" +
      "Por isso o atendimento e feito por aqui, com suporte, orientacao de instalacao e ativacao apos confirmacao.\n\n" +
      "Se preferir, voce pode comecar pelo teste gratis de 3 dias antes de contratar."
  },
  {
    id: "thinking",
    pattern: /\b(vou pensar|depois eu vejo|pensar)\b/,
    followupKey: "values",
    menu: CONTINUATION_MENU,
    buildReply: () => "Sem problema. Se quiser, eu te ajudo a escolher o melhor caminho: teste gratis ou mensal pra comecar."
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
