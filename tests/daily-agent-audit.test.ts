import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildAuditRecord, resolveAuditPeriod } from "@/services/audit/daily-agent-audit.service";
import { DailyAgentAuditService } from "@/services/audit/daily-agent-audit.service";
import { maskAuditPhone, maskAuditText } from "@/lib/unitv/audit-privacy";

const period = {
  auditDate: "2026-07-06",
  periodStart: "2026-07-06T03:00:00.000Z",
  periodEnd: "2026-07-07T02:59:59.999Z"
};

describe("daily agent audit aggregation", () => {
  it("creates an empty daily audit without errors", () => {
    const audit = buildAuditRecord({
      period,
      timezone: "America/Sao_Paulo",
      conversations: [],
      messages: [],
      events: [],
      specialistExamples: [],
      now: new Date("2026-07-07T02:55:00.000Z")
    });

    expect(audit.total_conversations).toBe(0);
    expect(audit.total_customer_messages).toBe(0);
    expect(audit.short_report).toContain("Auditoria diaria UNITV");
    expect(audit.full_report).toContain("Detalhes:");
  });

  it("counts messages, AI, local rules, interventions, followups and funnel events", () => {
    const audit = buildAuditRecord({
      period,
      timezone: "America/Sao_Paulo",
      conversations: [
        {
          id: "conversation-1",
          last_message_at: "2026-07-06T18:00:00.000Z",
          metadata: { lead_profile: { device: "tvbox_android", main_objection: "preco", stage: "pagamento_pix" } },
          customers: { phone: "5511999991234" }
        }
      ],
      messages: [
        { conversation_id: "conversation-1", role: "customer", content: "qual valor", created_at: "2026-07-06T17:00:00.000Z" },
        { conversation_id: "conversation-1", role: "assistant", content: "Mensal R$ 25", created_at: "2026-07-06T17:01:00.000Z" },
        { conversation_id: "conversation-1", role: "human_agent", content: "Vou ajudar", created_at: "2026-07-06T17:02:00.000Z" }
      ],
      events: [
        event("conversation-1", "ai_called", { intent: "ask_price", device: "tvbox_android", objection: "preco", stage: "valores" }),
        event("conversation-1", "local_rule_used"),
        event("conversation-1", "human_intervention", { metadata: { reason: "cliente_quente" } }),
        event("conversation-1", "repetition_blocked"),
        event("conversation-1", "greeting_blocked"),
        event("conversation-1", "followup_cancelled"),
        event("conversation-1", "followup_sent"),
        event("conversation-1", "price_asked"),
        event("conversation-1", "download_asked"),
        event("conversation-1", "installation_asked"),
        event("conversation-1", "test_asked"),
        event("conversation-1", "pix_asked"),
        event("conversation-1", "plan_selected"),
        event("conversation-1", "proof_sent"),
        event("conversation-1", "payment_confirmed"),
        event("conversation-1", "converted"),
        event("conversation-1", "support_requested")
      ],
      specialistExamples: [{ human_intervention_detected: true, why_specialist_intervened: "corrigiu_bot", review_status: "approved", outcome_status: "positive" }],
      now: new Date("2026-07-07T02:55:00.000Z")
    });

    expect(audit.total_conversations).toBe(1);
    expect(audit.total_customer_messages).toBe(1);
    expect(audit.total_bot_messages).toBe(1);
    expect(audit.total_specialist_messages).toBe(1);
    expect(audit.total_ai_calls).toBe(1);
    expect(audit.total_local_rule_responses).toBe(1);
    expect(audit.total_human_interventions).toBe(2);
    expect(audit.total_repetition_blocks).toBe(1);
    expect(audit.total_followups_sent).toBe(1);
    expect(audit.asked_price_count).toBe(1);
    expect(audit.asked_download_count).toBe(1);
    expect(audit.asked_installation_count).toBe(1);
    expect(audit.asked_test_count).toBe(1);
    expect(audit.asked_pix_count).toBe(1);
    expect(audit.selected_plan_count).toBe(1);
    expect(audit.sent_proof_count).toBe(1);
    expect(audit.payment_confirmed_count).toBe(1);
    expect(audit.converted_count).toBe(1);
    expect(audit.sales_concluded_count).toBe(1);
    expect(audit.human_takeover_count).toBe(1);
    expect(audit.repeated_question_count).toBe(1);
    expect(audit.greeting_blocked_count).toBe(1);
    expect(audit.followup_cancelled_count).toBe(1);
    expect(audit.approved_specialist_examples_count).toBe(1);
    expect(audit.pending_specialist_examples_count).toBe(0);
    expect(audit.objections_summary).toEqual(expect.objectContaining({ preco: expect.any(Number) }));
    expect(audit.devices_summary).toEqual(expect.objectContaining({ tvbox_android: expect.any(Number) }));
    expect(audit.stages_summary).toEqual(expect.objectContaining({ valores: expect.any(Number) }));
    expect(audit.ai_intents_summary).toEqual({ ask_price: 1 });
    expect(audit.human_intervention_reasons).toEqual(expect.objectContaining({ cliente_quente: 1, corrigiu_bot: 1 }));
  });

  it("detects abandoned after price, download, Pix, Pix not paid and stuck installation", () => {
    const audit = buildAuditRecord({
      period,
      timezone: "America/Sao_Paulo",
      conversations: [
        conversation("price", { lead_profile: { asked_price: true, stage: "valores" } }),
        conversation("download", { followup_key: "download", lead_profile: { stage: "instalacao" } }),
        conversation("pix", { followup_key: "pix", lead_profile: { stage: "pagamento_pix" } }),
        conversation("install", { lead_profile: { stage: "instalacao" } })
      ],
      messages: [
        message("price", "customer", "qual valor", "2026-07-06T16:00:00.000Z"),
        message("price", "assistant", "R$25", "2026-07-06T16:01:00.000Z"),
        message("download", "assistant", "baixe aqui", "2026-07-06T16:02:00.000Z"),
        message("pix", "assistant", "Pix copia e cola", "2026-07-06T16:03:00.000Z"),
        message("install", "customer", "nao consigo instalar", "2026-07-06T16:04:00.000Z")
      ],
      events: [
        event("price", "price_asked"),
        event("download", "download_asked"),
        event("pix", "pix_asked"),
        event("install", "install_stuck")
      ],
      specialistExamples: [],
      now: new Date("2026-07-06T18:00:00.000Z")
    });

    expect(audit.abandoned_after_price_count).toBe(1);
    expect(audit.abandoned_after_download_count).toBe(1);
    expect(audit.abandoned_after_pix_count).toBe(1);
    expect(audit.pix_requested_not_paid_count).toBe(1);
    expect(audit.stuck_installation_count).toBeGreaterThanOrEqual(1);
    expect(audit.customer_abandoned_count).toBeGreaterThanOrEqual(3);
    expect(audit.download_stuck_count).toBeGreaterThanOrEqual(1);
    expect(audit.top_problem_conversations.length).toBeGreaterThan(0);
    expect(audit.recommendations.length).toBeGreaterThan(0);
  });

  it("masks sensitive data in audit text and phones", () => {
    const masked = maskAuditText("CPF 123.456.789-09 Pix: 67070222000151 codigo ABC12345");
    expect(masked).not.toContain("123.456.789-09");
    expect(masked).not.toContain("67070222000151");
    expect(masked).not.toContain("ABC12345");
    expect(maskAuditPhone("5511999991234")).toBe("+55 11 *****-1234");
  });

  it("resolves Sao Paulo audit periods and uses previous day before dawn", () => {
    const current = resolveAuditPeriod(undefined, "America/Sao_Paulo", new Date("2026-07-06T05:00:00.000Z"));
    expect(current.auditDate).toBe("2026-07-05");

    const explicit = resolveAuditPeriod("2026-07-06", "America/Sao_Paulo", new Date("2026-07-06T23:00:00.000Z"));
    expect(explicit.periodStart).toBe("2026-07-06T03:00:00.000Z");
    expect(explicit.periodEnd).toBe("2026-07-07T02:59:59.999Z");
  });

  it("does not resend an audit already sent to admin without forceSend", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    const sendTextMessage = vi.fn();
    const service = new DailyAgentAuditService({
      dailyAuditsRepository: {
        findById: vi.fn(async () => ({ id: "audit-id", sent_to_admin: true, short_report: "ja enviado" })),
        findByDate: vi.fn(),
        findPrevious: vi.fn(),
        upsertAudit: vi.fn(),
        markSent: vi.fn()
      },
      evolutionService: { sendTextMessage },
      conversationsRepository: { listTouchedBetween: vi.fn() },
      messagesRepository: { listMessagesBetween: vi.fn() },
      eventLogsRepository: { listEventsBetween: vi.fn(), createEvent: vi.fn() },
      specialistTrainingExamplesRepository: { listExamplesBetween: vi.fn() }
    });

    const result = await service.sendDailyAgentAuditToAdmin({ auditId: "audit-id" });

    expect(result).toEqual(expect.objectContaining({ sent: false, reason: "already_sent" }));
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});

function event(conversationId: string, eventType: string, extra: Record<string, unknown> = {}) {
  return {
    conversation_id: conversationId,
    event_type: eventType,
    event_source: "webhook",
    created_at: "2026-07-06T17:00:00.000Z",
    ...extra
  };
}

function conversation(id: string, metadata: Record<string, unknown>) {
  return {
    id,
    metadata,
    last_message_at: "2026-07-06T16:05:00.000Z",
    customers: { phone: `551199999${id.length.toString().padStart(4, "0")}` }
  };
}

function message(conversationId: string, role: string, content: string, createdAt: string) {
  return { conversation_id: conversationId, role, content, created_at: createdAt };
}
