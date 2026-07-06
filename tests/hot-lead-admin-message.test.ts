import { describe, expect, it } from "vitest";

import { buildHotLeadAdminMessage } from "@/lib/unitv/hot-lead-admin-message";

describe("hot lead admin message", () => {
  it("formats a full admin alert and keeps customer phone visible", () => {
    const message = buildHotLeadAdminMessage({
      signal: {
        alert_type: "pix_requested",
        lead_temperature: "muito_quente",
        reason: "pediu Pix",
        next_best_action: "Enviar Pix/link de pagamento e acompanhar comprovante.",
        priority: 5
      },
      customerPhone: "5575999999999",
      customerName: "Joao",
      planInterest: "mensal",
      device: "TV Box Android",
      stage: "pagamento",
      mainObjection: "nenhuma",
      lastCustomerMessage: "Quero pagar no Pix"
    });

    expect(message).toContain("Lead quente UNITV");
    expect(message).toContain("+5575999999999");
    expect(message).toContain("Temperatura: muito_quente");
    expect(message).toContain("Motivo: pediu Pix");
  });

  it("masks documents, Pix keys and access codes in the last customer message", () => {
    const message = buildHotLeadAdminMessage({
      signal: {
        alert_type: "proof_sent",
        lead_temperature: "muito_quente",
        reason: "enviou comprovante",
        next_best_action: "Validar pagamento e liberar codigo.",
        priority: 5
      },
      customerPhone: "5575999999999",
      lastCustomerMessage: "CPF 123.456.789-09 Pix: 67070222000151 codigo ABC12345"
    });

    expect(message).not.toContain("123.456.789-09");
    expect(message).not.toContain("67070222000151");
    expect(message).not.toContain("ABC12345");
  });
});
