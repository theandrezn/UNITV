import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { HotLeadAlertService } from "@/services/leads/hot-lead-alert.service";

describe("HotLeadAlertService", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.UNITV_HOT_LEAD_ALERTS_ENABLED = "true";
    process.env.UNITV_HOT_LEAD_ALERT_ADMIN_PHONE = "558699802602";
    process.env.UNITV_HOT_LEAD_ALERT_MIN_TEMPERATURE = "quente";
  });

  it("creates and sends a Pix requested alert", async () => {
    const harness = createHarness();

    await harness.service.maybeNotifyHotLead(baseContext("manda pix", { selected_plan: "mensal", stage: "pagamento" }));

    expect(harness.alertsRepository.createAlert).toHaveBeenCalledWith(expect.objectContaining({
      alert_type: "pix_requested",
      lead_temperature: "muito_quente",
      plan_interest: "mensal"
    }));
    expect(harness.evolutionService.sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({
      phone: "558699802602",
      text: expect.stringContaining("Lead quente UNITV")
    }));
    expect(harness.conversationsRepository.updateConversationMetadata).toHaveBeenCalledWith("conversation-id", expect.objectContaining({
      lead_profile: expect.objectContaining({
        hot_lead: true,
        lead_temperature: "muito_quente",
        last_hot_alert_type: "pix_requested"
      })
    }));
    expect(harness.agentEventLogService.safeCreateEvent).toHaveBeenCalledWith(expect.objectContaining({ event_type: "hot_lead_detected" }));
    expect(harness.agentEventLogService.safeCreateEvent).toHaveBeenCalledWith(expect.objectContaining({ event_type: "hot_lead_alert_sent" }));
  });

  it("dedupes repeated alerts inside the configured window", async () => {
    const harness = createHarness({ recentAlert: { id: "existing", lead_temperature: "muito_quente" } });

    const result = await harness.service.maybeNotifyHotLead(baseContext("manda pix", { selected_plan: "mensal" }));

    expect(result).toBeNull();
    expect(harness.alertsRepository.createAlert).not.toHaveBeenCalled();
    expect(harness.evolutionService.sendTextMessage).not.toHaveBeenCalled();
  });

  it("allows a new alert when lead evolves from quente to muito_quente", async () => {
    const harness = createHarness({ recentAlert: { id: "existing", lead_temperature: "quente" } });

    await harness.service.maybeNotifyHotLead(baseContext("quero pagar", {}));

    expect(harness.alertsRepository.createAlert).toHaveBeenCalledWith(expect.objectContaining({
      alert_type: "wants_to_pay",
      lead_temperature: "muito_quente"
    }));
  });

  it("always alerts proof sent using the message id dedupe key", async () => {
    const harness = createHarness({ recentAlert: { id: "existing", lead_temperature: "muito_quente" } });

    await harness.service.maybeNotifyHotLead(baseContext("paguei segue comprovante", {}, { hasMedia: true, externalMessageId: "proof-1" }));

    expect(harness.alertsRepository.findRecentAlert).not.toHaveBeenCalled();
    expect(harness.alertsRepository.createAlert).toHaveBeenCalledWith(expect.objectContaining({
      alert_type: "proof_sent",
      dedupe_key: "conversation-id:proof_sent:proof-1"
    }));
  });

  it("does not alert fromMe messages or recent human activity except proof", async () => {
    const harness = createHarness();
    await harness.service.maybeNotifyHotLead(baseContext("manda pix", {}, { fromMe: true }));
    await harness.service.maybeNotifyHotLead({
      ...baseContext("manda pix", { selected_plan: "mensal" }),
      conversation: {
        id: "conversation-id",
        metadata: { last_specialist_message_at: new Date().toISOString(), lead_profile: { selected_plan: "mensal" } }
      }
    });

    expect(harness.alertsRepository.createAlert).not.toHaveBeenCalled();
  });

  it("stores failed sends without breaking the flow", async () => {
    const harness = createHarness({ sendFails: true });

    const result = await harness.service.maybeNotifyHotLead(baseContext("quero teste gratis", {}));

    expect(result).toEqual(expect.objectContaining({ id: "alert-id" }));
    expect(harness.alertsRepository.markFailed).toHaveBeenCalledWith("alert-id", expect.stringContaining("send failed"), 0);
    expect(harness.agentEventLogService.safeCreateEvent).toHaveBeenCalledWith(expect.objectContaining({ event_type: "hot_lead_alert_failed" }));
  });
});

function createHarness(options: { recentAlert?: Record<string, unknown> | null; sendFails?: boolean } = {}) {
  const alertsRepository = {
    findRecentAlert: vi.fn(async () => options.recentAlert || null),
    createAlert: vi.fn(async (data) => ({ id: "alert-id", send_attempts: 0, ...data })),
    markSent: vi.fn(async (id) => ({ id, sent_to_admin: true })),
    markFailed: vi.fn(async (id, error) => ({ id, sent_to_admin: false, last_send_error: error }))
  };
  const conversationsRepository = { updateConversationMetadata: vi.fn(async (_id, metadata) => ({ id: _id, metadata })) };
  const evolutionService = {
    sendTextMessage: options.sendFails
      ? vi.fn(async () => { throw new Error("send failed"); })
      : vi.fn(async () => ({ id: "admin-message-id" }))
  };
  const agentEventLogService = { safeCreateEvent: vi.fn(async () => ({})) };
  const service = new HotLeadAlertService(
    alertsRepository as never,
    conversationsRepository as never,
    evolutionService as never,
    agentEventLogService as never
  );
  return { service, alertsRepository, conversationsRepository, evolutionService, agentEventLogService };
}

function baseContext(message: string, leadProfile: Record<string, unknown>, options: Record<string, unknown> = {}) {
  return {
    conversation: { id: "conversation-id", metadata: { lead_profile: leadProfile } },
    customer: { phone: "5575999999999", name: "Cliente" },
    message: {
      text: message,
      externalMessageId: "message-id",
      hasMedia: false,
      fromMe: false,
      ...options
    },
    intent: message.includes("teste") ? "free_trial" : "pix_payment",
    recentMessages: [{ role: "assistant", content: "Como posso ajudar?" }],
    leadProfile
  };
}
