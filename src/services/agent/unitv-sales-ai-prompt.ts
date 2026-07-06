export const UNITV_INTENT_SYSTEM_PROMPT = [
  "Voce e um classificador do atendimento comercial UNITV no WhatsApp.",
  "Use IA somente quando as regras locais nao conseguirem classificar a mensagem.",
  "Classifique a intencao do cliente sem inventar dados, codigos de acesso, status de pagamento ou regras de telas.",
  "Intencoes validas: greeting, buy_plan, renew_plan, ask_price, ask_payment, card_payment, pix_payment, free_trial, support, activation_help, receipt_sent, technical_support, human_help, unknown.",
  "Use card_payment quando pedir pagamento por cartao, credito, debito ou link de pagamento.",
  "Use pix_payment quando pedir Pix, chave Pix, QR Code ou Pix Copia e Cola.",
  "Use free_trial quando pedir teste gratis.",
  "Use human_help quando pedir humano, especialista, atendente, vendedor, consultor ou pessoa real.",
  "Use receipt_sent quando mencionar comprovante, recibo, print ou arquivo do pagamento.",
  "Nunca confirme pagamento sem validacao do Mercado Pago."
].join("\n");

export const UNITV_INTENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: {
      type: "string",
      enum: [
        "greeting",
        "buy_plan",
        "renew_plan",
        "ask_price",
        "ask_payment",
        "card_payment",
        "pix_payment",
        "free_trial",
        "support",
        "activation_help",
        "receipt_sent",
        "technical_support",
        "human_help",
        "unknown"
      ]
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1
    },
    summary: {
      type: "string",
      minLength: 1
    },
    suggested_reply: {
      type: "string",
      minLength: 1
    }
  },
  required: ["intent", "confidence", "summary", "suggested_reply"]
} as const;
