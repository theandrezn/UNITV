import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

import { handleDailyAgentAuditJob } from "@/app/api/jobs/daily-agent-audit/route";

describe("daily agent audit job route", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.ADMIN_API_KEY = "secret";
    process.env.UNITV_DAILY_AUDIT_ENABLED = "true";
    process.env.UNITV_AGENT_MODE = "active";
  });

  it("skips the daily audit entirely while Pix-only mode is active", async () => {
    process.env.UNITV_AGENT_MODE = "pix_only";
    const service = {
      buildDailyAgentAudit: vi.fn(),
      sendAuditRecordToAdmin: vi.fn()
    };
    const request = new NextRequest("https://unitv.test/api/jobs/daily-agent-audit?send=true", {
      headers: { authorization: "Bearer secret" }
    });

    const response = await handleDailyAgentAuditJob(request, { service });
    await expect(response.json()).resolves.toEqual({ ok: true, skipped: true, reason: "agent_runtime_pix_only" });
    expect(service.buildDailyAgentAudit).not.toHaveBeenCalled();
    expect(service.sendAuditRecordToAdmin).not.toHaveBeenCalled();
  });

  it("requires CRON/admin secret", async () => {
    const response = await handleDailyAgentAuditJob(new NextRequest("https://unitv.test/api/jobs/daily-agent-audit"));
    expect(response.status).toBe(401);
  });

  it("dryRun does not send WhatsApp", async () => {
    const service = {
      buildDailyAgentAudit: vi.fn(async () => ({
        audit_date: "2026-07-06",
        total_conversations: 0,
        asked_price_count: 0,
        asked_pix_count: 0,
        converted_count: 0,
        pix_requested_not_paid_count: 0,
        sales_concluded_count: 2,
        customer_abandoned_count: 3,
        human_takeover_count: 1,
        repeated_question_count: 1,
        greeting_blocked_count: 2,
        download_stuck_count: 1,
        followup_cancelled_count: 4,
        approved_specialist_examples_count: 5,
        pending_specialist_examples_count: 2,
        short_report: "Auditoria diaria UNITV"
      })),
      sendAuditRecordToAdmin: vi.fn()
    };
    const request = new NextRequest("https://unitv.test/api/jobs/daily-agent-audit?dryRun=true&send=true", {
      headers: { authorization: "Bearer secret" }
    });

    const response = await handleDailyAgentAuditJob(request, { service });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.dryRun).toBe(true);
    expect(json.metrics).toEqual(expect.objectContaining({
      sales_concluded_count: 2,
      customer_abandoned_count: 3,
      followup_cancelled_count: 4,
      approved_specialist_examples_count: 5
    }));
    expect(service.sendAuditRecordToAdmin).not.toHaveBeenCalled();
  });

  it("send=true sends to admin and returns metrics", async () => {
    const service = {
      buildDailyAgentAudit: vi.fn(async () => ({
        id: "audit-id",
        audit_date: "2026-07-06",
        total_conversations: 18,
        asked_price_count: 7,
        asked_pix_count: 3,
        converted_count: 2,
        pix_requested_not_paid_count: 1,
        short_report: "Auditoria diaria UNITV"
      })),
      sendAuditRecordToAdmin: vi.fn(async () => ({ sent: true, result: {}, audit: { id: "audit-id" } }))
    };
    const request = new NextRequest("https://unitv.test/api/jobs/daily-agent-audit?send=true&date=2026-07-06", {
      headers: { authorization: "Bearer secret" }
    });

    const response = await handleDailyAgentAuditJob(request, { service });
    const json = await response.json();

    expect(json.sent_to_admin).toBe(true);
    expect(json.metrics).toEqual(expect.objectContaining({ total_conversations: 18, asked_pix_count: 3 }));
    expect(service.sendAuditRecordToAdmin).toHaveBeenCalledWith(expect.objectContaining({ id: "audit-id" }), false);
  });
});
