export type AuditRecommendationInput = {
  abandoned_after_price_count: number;
  abandoned_after_download_count: number;
  pix_requested_not_paid_count: number;
  stuck_installation_count: number;
  support_requested_count: number;
  total_human_interventions: number;
  total_ai_calls: number;
  asked_download_count: number;
  converted_count: number;
};

export function buildAuditRecommendations(metrics: AuditRecommendationInput) {
  const recommendations: string[] = [];

  if (metrics.pix_requested_not_paid_count > 0) {
    recommendations.push("Revisar leads que pediram Pix e nao pagaram; uma abordagem manual pode recuperar vendas.");
  }
  if (metrics.abandoned_after_price_count > 0) {
    recommendations.push("Melhorar resposta de valores e oferecer teste gratis para leads que somem depois do preco.");
  }
  if (metrics.abandoned_after_download_count > 0 || (metrics.asked_download_count > 0 && metrics.converted_count === 0)) {
    recommendations.push("Fortalecer o CTA depois do download para levar o cliente ao teste ou pagamento.");
  }
  if (metrics.stuck_installation_count > 0) {
    recommendations.push("Revisar instrucoes de instalacao e priorizar suporte nos aparelhos com mais erro.");
  }
  if (metrics.total_human_interventions > 0) {
    recommendations.push("Revisar intervencoes humanas e transformar boas respostas do Andre em exemplos aprovados.");
  }
  if (metrics.total_ai_calls >= 20) {
    recommendations.push("Mapear mensagens que mais acionaram IA e transformar casos repetidos em regras locais.");
  }
  if (metrics.support_requested_count > 0) {
    recommendations.push("Separar suporte tecnico de venda para nao travar fechamento de clientes quentes.");
  }

  if (!recommendations.length) {
    recommendations.push("Monitorar o funil de hoje; ainda nao apareceu gargalo critico.");
  }

  return recommendations.slice(0, 5);
}
