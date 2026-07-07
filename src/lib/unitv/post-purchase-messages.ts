export const UNITV_COMMUNITY_LINK = "https://chat.whatsapp.com/GuMhy92y5cJ6PVC0KLtZh3";

export function buildPostPurchaseMessages(accessCode: string | string[]) {
  const accessCodes = Array.isArray(accessCode) ? accessCode : [accessCode];
  const accessCodeText = accessCodes.length === 1 ? accessCodes[0] : accessCodes.map((code, index) => `${index + 1}. ${code}`).join("\n");
  const accessCodeLabel = accessCodes.length === 1 ? "Seu codigo de acesso:" : "Seus codigos de acesso:";

  return [
    [
      "Agradecemos pela sua compra!",
      "",
      "Sua assinatura UNITV foi registrada com sucesso. Seja bem-vindo a nossa plataforma!",
      "",
      accessCodeLabel,
      "",
      accessCodeText,
      "",
      "Agora voce pode aproveitar filmes, series e canais ao vivo em um so lugar, com suporte sempre que precisar.",
      "",
      "Promocao especial para clientes UNITV",
      "",
      "Indique 3 pessoas para assinarem a UNITV e ganhe 1 mes gratis na sua assinatura.",
      "",
      "Como funciona:",
      "",
      "1. Convide 3 amigos ou familiares",
      "2. Eles realizam a assinatura",
      "3. Apos a confirmacao das 3 compras, voce recebe 1 mes de UNITV gratis",
      "",
      "Compartilhe a UNITV com quem tambem quer aproveitar uma experiencia completa de entretenimento."
    ].join("\n"),
    [
      "Entre na Comunidade Oficial da UNITV!",
      "",
      "Criamos um grupo exclusivo para clientes e interessados acompanharem tudo sobre a UNITV em primeira mao.",
      "",
      "Na comunidade voce tera:",
      "",
      "Promocoes semanais e condicoes especiais",
      "Avisos importantes sobre atualizacoes",
      "Grupo para tirar duvidas e receber orientacoes",
      "Novidades sobre filmes, series e canais ao vivo",
      "Suporte e instrucoes para instalacao e uso do app",
      "",
      "Entre pelo link oficial:",
      "",
      UNITV_COMMUNITY_LINK,
      "",
      "Faca parte da comunidade UNITV e fique por dentro de todas as novidades."
    ].join("\n")
  ];
}

export function buildNoAccessCodeAvailableMessage(orderNumber: string) {
  return [
    `Pagamento confirmado para o pedido ${orderNumber}.`,
    "",
    "Ainda nao encontrei codigo de acesso disponivel no estoque para esse plano.",
    "Ja avisei o especialista para liberar o acesso correto. Assim que estiver disponivel, o acesso sera enviado por aqui."
  ].join("\n");
}
