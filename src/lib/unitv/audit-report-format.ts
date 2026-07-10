import { maskAuditPhone } from "@/lib/unitv/audit-privacy";

type ReportInput = {
  audit_date: string;
  total_conversations: number;
  total_customer_messages: number;
  total_ai_calls: number;
  total_human_interventions: number;
  total_repetition_blocks: number;
  asked_price_count: number;
  asked_download_count: number;
  asked_installation_count: number;
  asked_test_count: number;
  asked_pix_count: number;
  sent_proof_count: number;
  converted_count: number;
  sales_concluded_count: number;
  customer_abandoned_count: number;
  human_takeover_count: number;
  repeated_question_count: number;
  greeting_blocked_count: number;
  download_stuck_count: number;
  followup_cancelled_count: number;
  approved_specialist_examples_count: number;
  pending_specialist_examples_count: number;
  abandoned_after_price_count: number;
  abandoned_after_download_count: number;
  abandoned_after_pix_count: number;
  pix_requested_not_paid_count: number;
  stuck_installation_count: number;
  support_requested_count: number;
  objections_summary: Record<string, number>;
  devices_summary: Record<string, number>;
  recommendations: string[];
  top_problem_conversations: Array<Record<string, unknown>>;
};

export function formatDailyAuditShortReport(audit: ReportInput) {
  const objections = formatTopMap(audit.objections_summary);
  const devices = formatTopMap(audit.devices_summary);
  const leads = audit.top_problem_conversations.slice(0, 5).map((item, index) => {
    const phone = maskAuditPhone(String(item.phone || ""));
    return `${index + 1}. ${phone} - ${item.problem || "revisar conversa"} - ${item.recommended_action || "chamar manualmente"}`;
  });

  return [
    `Auditoria diaria UNITV - ${formatDateLabel(audit.audit_date)}`,
    "",
    "Resumo:",
    `- Conversas atendidas: ${audit.total_conversations}`,
    `- Mensagens de clientes: ${audit.total_customer_messages}`,
    `- Chamadas de IA: ${audit.total_ai_calls}`,
    `- Intervencoes humanas: ${audit.total_human_interventions}`,
    `- Repeticoes bloqueadas: ${audit.total_repetition_blocks}`,
    "",
    "Funil:",
    `- Perguntaram valores: ${audit.asked_price_count}`,
    `- Pediram teste gratis: ${audit.asked_test_count}`,
    `- Pediram download/instalacao: ${audit.asked_download_count + audit.asked_installation_count}`,
    `- Pediram Pix: ${audit.asked_pix_count}`,
    `- Enviaram comprovante: ${audit.sent_proof_count}`,
    `- Convertidos: ${audit.converted_count}`,
    `- Vendas concluidas: ${audit.sales_concluded_count}`,
    "",
    "Gargalos:",
    `- Sumiram apos valores: ${audit.abandoned_after_price_count}`,
    `- Sumiram apos download: ${audit.abandoned_after_download_count}`,
    `- Pediram Pix e nao pagaram: ${audit.pix_requested_not_paid_count}`,
    `- Instalacao travada: ${audit.stuck_installation_count}`,
    `- Pediram suporte/humano: ${audit.support_requested_count}`,
    `- Clientes abandonados: ${audit.customer_abandoned_count}`,
    `- Humano assumiu: ${audit.human_takeover_count}`,
    `- Perguntas repetidas bloqueadas: ${audit.repeated_question_count}`,
    `- Saudacoes iniciais bloqueadas: ${audit.greeting_blocked_count}`,
    `- Follow-ups cancelados por contexto: ${audit.followup_cancelled_count}`,
    `- Exemplos do Andre aprovados/pendentes: ${audit.approved_specialist_examples_count}/${audit.pending_specialist_examples_count}`,
    "",
    "Principais objecoes:",
    ...padTopList(objections),
    "",
    "Principais aparelhos:",
    ...padTopList(devices),
    "",
    "Acoes recomendadas:",
    ...audit.recommendations.slice(0, 3).map((item, index) => `${index + 1}. ${item}`),
    "",
    "Leads para revisar:",
    ...(leads.length ? leads : ["1. Nenhum lead critico para revisar agora."]),
    "",
    "Responder rapido esses leads pode recuperar vendas."
  ].join("\n");
}

export function formatDailyAuditFullReport(audit: ReportInput & { previous_comparison?: string | null }) {
  return [
    formatDailyAuditShortReport(audit),
    "",
    "Detalhes:",
    `- Sumiram apos Pix: ${audit.abandoned_after_pix_count}`,
    `- Download travado: ${audit.download_stuck_count}`,
    `- Comparativo: ${audit.previous_comparison || "sem auditoria anterior para comparar."}`,
    "",
    "Conversas problematicas:",
    JSON.stringify(audit.top_problem_conversations, null, 2)
  ].join("\n");
}

function formatTopMap(value: Record<string, number>) {
  return Object.entries(value)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([key, count], index) => `${index + 1}. ${key}: ${count}`);
}

function padTopList(items: string[]) {
  if (items.length) {
    return items;
  }
  return ["1. sem dados"];
}

function formatDateLabel(date: string) {
  const [year, month, day] = date.split("-");
  return day && month && year ? `${day}/${month}/${year}` : date;
}
