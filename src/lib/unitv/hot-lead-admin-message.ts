import { excerptAuditText, maskAuditText } from "@/lib/unitv/audit-privacy";
import type { HotLeadSignal } from "@/lib/unitv/hot-lead-rules";

export type HotLeadAdminMessageInput = {
  signal: HotLeadSignal;
  customerPhone: string;
  customerName?: string | null;
  planInterest?: string | null;
  device?: string | null;
  stage?: string | null;
  mainObjection?: string | null;
  lastCustomerMessage?: string | null;
  lastBotMessage?: string | null;
  format?: "full" | "compact";
};

export function buildHotLeadAdminMessage(input: HotLeadAdminMessageInput) {
  const lastCustomer = excerptAuditText(maskAuditText(input.lastCustomerMessage || ""), 220) || "sem mensagem";
  const plan = input.planInterest || "ainda nao definido";
  const device = input.device || "nao informado";
  const stage = input.stage || "nao informada";
  const objection = input.mainObjection || "nenhuma";

  if (input.format === "compact") {
    return [
      "Lead quente UNITV",
      `Cliente: +${input.customerPhone.replace(/\D/g, "")}`,
      `Motivo: ${input.signal.reason}`,
      `Interesse: ${plan}`,
      `Ultima: \"${lastCustomer}\"`,
      `Acao: ${input.signal.next_best_action}`
    ].join("\n");
  }

  return [
    "Lead quente UNITV",
    "",
    `Cliente: +${input.customerPhone.replace(/\D/g, "")}`,
    `Nome: ${input.customerName || "Desconhecido"}`,
    `Temperatura: ${input.signal.lead_temperature}`,
    `Motivo: ${input.signal.reason}`,
    "",
    `Interesse: ${plan}`,
    `Aparelho: ${device}`,
    `Etapa: ${stage}`,
    `Objecao: ${objection}`,
    "",
    "Ultima mensagem:",
    `\"${lastCustomer}\"`,
    "",
    "Proxima acao:",
    input.signal.next_best_action
  ].join("\n");
}
