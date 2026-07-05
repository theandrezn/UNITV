export const UNITV_COMMUNITY_LINK = "https://chat.whatsapp.com/GuMhy92y5cJ6PVC0KLtZh3";

export function buildPostPurchaseMessages(accessCode: string) {
  return [
    [
      "✅ Agradecemos pela sua compra!",
      "",
      "Sua assinatura UNITV foi registrada com sucesso. Seja bem-vindo à nossa plataforma! 🎬",
      "",
      "🔐 Seu código de acesso:",
      "",
      accessCode,
      "",
      "Agora você pode aproveitar filmes, séries e canais ao vivo em um só lugar, com suporte sempre que precisar.",
      "",
      "🎁 Promoção especial para clientes UNITV",
      "",
      "Indique 3 pessoas para assinarem a UNITV e ganhe 1 mês grátis na sua assinatura.",
      "",
      "Como funciona:",
      "",
      "1️⃣ Convide 3 amigos ou familiares",
      "2️⃣ Eles realizam a assinatura",
      "3️⃣ Após a confirmação das 3 compras, você recebe 1 mês de UNITV grátis",
      "",
      "Compartilhe a UNITV com quem também quer aproveitar uma experiência completa de entretenimento. 🚀"
    ].join("\n"),
    [
      "🎬 Entre na Comunidade Oficial da UNITV!",
      "",
      "Criamos um grupo exclusivo para clientes e interessados acompanharem tudo sobre a UNITV em primeira mão.",
      "",
      "Na comunidade você terá:",
      "",
      "🔥 Promoções semanais e condições especiais",
      "📢 Avisos importantes sobre atualizações",
      "💬 Grupo para tirar dúvidas e receber orientações",
      "🎥 Novidades sobre filmes, séries e canais ao vivo",
      "🛠️ Suporte e instruções para instalação e uso do app",
      "",
      "Entre pelo link oficial:",
      "",
      `👉 ${UNITV_COMMUNITY_LINK}`,
      "",
      "Faça parte da comunidade UNITV e fique por dentro de todas as novidades. 🚀"
    ].join("\n")
  ];
}

export function buildNoAccessCodeAvailableMessage(orderNumber: string) {
  return [
    `Pagamento confirmado para o pedido ${orderNumber}.`,
    "",
    "Ainda não encontrei código de acesso disponível no estoque para esse plano.",
    "Já avisei o administrador para inserir/liberar um código válido. Assim que estiver disponível, o acesso será enviado por aqui."
  ].join("\n");
}
