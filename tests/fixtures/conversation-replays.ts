export type ConversationReplayStep = {
  customer: string;
  expected_action: "reply" | "silent" | "wait" | "handoff" | "backend_action";
  expected_state: string;
  reply_must_include?: string;
  forbidden_replies?: string[];
};

export type ConversationReplayScenario = {
  id: string;
  initial_state: string;
  initial_profile?: Record<string, unknown>;
  previous_messages: Array<{ role: "customer" | "assistant" | "human_agent"; content: string }>;
  steps: ConversationReplayStep[];
  maximum_ai_calls: number;
};

export const CONVERSATION_REPLAYS: ConversationReplayScenario[] = [
  {
    id: "recharge_later_acknowledgement_is_silent",
    initial_state: "pre_sale_recharge_intent",
    previous_messages: [
      { role: "customer", content: "Quando eu receber eu faço a recarga." },
      { role: "assistant", content: "Perfeito, fico no aguardo." }
    ],
    steps: [{ customer: "Sim, obrigado", expected_action: "silent", expected_state: "pre_sale_recharge_intent", forbidden_replies: ["bem-vindo", "Como posso ajudar"] }],
    maximum_ai_calls: 0
  },
  {
    id: "legacy_lg_installation_failure_stays_silent",
    initial_state: "device_qualification",
    previous_messages: [{ role: "assistant", content: "Qual aparelho voce pretende usar?" }],
    steps: [
      { customer: "LG antiga", expected_action: "silent", expected_state: "incompatible_device", forbidden_replies: ["Downloader", "Play Store"] },
      { customer: "Nao deu certo", expected_action: "silent", expected_state: "incompatible_device", forbidden_replies: ["Baixa", "instalacao"] }
    ],
    maximum_ai_calls: 0
  },
  {
    id: "download_context_interprets_android",
    initial_state: "download_link_sent",
    initial_profile: { last_download_url_sent: "https://example.invalid/apk", install_status: "link_sent" },
    previous_messages: [{ role: "assistant", content: "Baixe pelo link e me avise quando instalar." }],
    steps: [
      { customer: "E Android", expected_action: "reply", expected_state: "awaiting_download_installation", reply_must_include: "link e o correto", forbidden_replies: ["primeira vez", "bem-vindo"] },
      { customer: "Baixei", expected_action: "reply", expected_state: "awaiting_download_installation", reply_must_include: "abre o aplicativo", forbidden_replies: ["qual aparelho"] }
    ],
    maximum_ai_calls: 0
  },
  {
    id: "payment_pending_never_restarts_greeting",
    initial_state: "payment_pending",
    previous_messages: [{ role: "assistant", content: "Assim que confirmar, sigo com a liberacao." }],
    steps: [{ customer: "Boa noite", expected_action: "reply", expected_state: "payment_pending", forbidden_replies: ["Seja bem-vindo", "primeira vez"] }],
    maximum_ai_calls: 0
  },
  {
    id: "human_intervention_keeps_active_context",
    initial_state: "price_discovery",
    previous_messages: [
      { role: "customer", content: "Qual o valor?" },
      { role: "human_agent", content: "O mensal esta saindo por 20,90. Voce tem interesse pra hoje?" }
    ],
    steps: [{ customer: "Sim", expected_action: "reply", expected_state: "price_discovery", forbidden_replies: ["Seja bem-vindo", "todos os planos"] }],
    maximum_ai_calls: 1
  }
];
