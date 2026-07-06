import { describe, expect, it } from "vitest";

import { detectHotLeadSignal } from "@/lib/unitv/hot-lead-rules";

describe("hot lead rules", () => {
  it.each([
    ["manda pix", "pix_requested", "muito_quente"],
    ["quero pagar", "wants_to_pay", "muito_quente"],
    ["mensal", "plan_selected", "quente"],
    ["ja baixei", "downloaded_app", "quente"],
    ["paguei segue comprovante", "proof_sent", "muito_quente"],
    ["quero teste gratis", "test_requested", "quente"],
    ["nao consigo instalar", "installation_stuck", "quente"],
    ["quantas telas?", "screens_question", "quente"]
  ])("detects %s as %s", (message, alertType, temperature) => {
    const signal = detectHotLeadSignal({
      message,
      leadProfile: {
        stage: message.includes("instalar") ? "instalacao" : "valores",
        selected_plan: message.includes("pix") ? "mensal" : undefined
      }
    });

    expect(signal).toEqual(expect.objectContaining({
      alert_type: alertType,
      lead_temperature: temperature
    }));
  });

  it("detects repeated price questions as hot lead", () => {
    const signal = detectHotLeadSignal({
      message: "quanto fica mensal?",
      leadProfile: { asked_price: true },
      recentMessages: [{ role: "customer", content: "qual valor?" }]
    });

    expect(signal).toEqual(expect.objectContaining({
      alert_type: "price_asked_multiple_times",
      lead_temperature: "quente"
    }));
  });

  it("does not alert cold greetings", () => {
    expect(detectHotLeadSignal({ message: "oi", leadProfile: {} })).toBeNull();
  });
});
