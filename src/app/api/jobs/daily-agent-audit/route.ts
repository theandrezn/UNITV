import { NextRequest, NextResponse } from "next/server";
import { getDailyAuditConfig, getServerEnv } from "@/lib/env";
import { DailyAgentAuditService } from "@/services/audit/daily-agent-audit.service";
import { isUnitvPixOnlyMode } from "@/lib/unitv/agent-runtime-mode";

export const dynamic = "force-dynamic";

type DailyAgentAuditJobDependencies = {
  service?: Pick<DailyAgentAuditService, "buildDailyAgentAudit" | "sendAuditRecordToAdmin">;
};

export async function handleDailyAgentAuditJob(
  request: NextRequest,
  dependencies: DailyAgentAuditJobDependencies = {}
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, message: "unauthorized" }, { status: 401 });
  }

  if (isUnitvPixOnlyMode()) {
    return NextResponse.json({ ok: true, skipped: true, reason: "agent_runtime_pix_only" });
  }

  const config = getDailyAuditConfig();
  if (!config.enabled) {
    return NextResponse.json({ ok: true, skipped: true, reason: "daily_audit_disabled" });
  }

  const service = dependencies.service || new DailyAgentAuditService();
  const date = request.nextUrl.searchParams.get("date");
  const send = readBoolean(request.nextUrl.searchParams.get("send"));
  const dryRun = readBoolean(request.nextUrl.searchParams.get("dryRun"));
  const forceSend = readBoolean(request.nextUrl.searchParams.get("forceSend"));
  const audit = await service.buildDailyAgentAudit({ date, dryRun });
  let sendResult: unknown = null;

  if (send && !dryRun) {
    sendResult = await service.sendAuditRecordToAdmin(audit, forceSend);
  }

  return NextResponse.json({
    ok: true,
    audit_date: audit.audit_date,
    audit_id: "id" in audit ? audit.id || null : null,
    sent_to_admin: Boolean((sendResult as { sent?: boolean } | null)?.sent),
    dryRun,
    metrics: {
      total_conversations: audit.total_conversations,
      asked_price_count: audit.asked_price_count,
      asked_pix_count: audit.asked_pix_count,
      converted_count: audit.converted_count,
      sales_concluded_count: audit.sales_concluded_count,
      customer_abandoned_count: audit.customer_abandoned_count,
      human_takeover_count: audit.human_takeover_count,
      repeated_question_count: audit.repeated_question_count,
      greeting_blocked_count: audit.greeting_blocked_count,
      download_stuck_count: audit.download_stuck_count,
      followup_cancelled_count: audit.followup_cancelled_count,
      approved_specialist_examples_count: audit.approved_specialist_examples_count,
      pending_specialist_examples_count: audit.pending_specialist_examples_count,
      learning_memories_created_count: Number(audit.learning_memories_created_count || 0),
      learning_skipped_reason:
        audit.learning_summary && typeof audit.learning_summary === "object" && "skipped_reason" in audit.learning_summary
          ? String((audit.learning_summary as Record<string, unknown>).skipped_reason || "") || null
          : null,
      pix_requested_not_paid_count: audit.pix_requested_not_paid_count
    },
    short_report: dryRun ? audit.short_report : undefined
  });
}

export async function GET(request: NextRequest) {
  return handleDailyAgentAuditJob(request);
}

export async function POST(request: NextRequest) {
  return handleDailyAgentAuditJob(request);
}

function isAuthorized(request: NextRequest) {
  const adminApiKey = getServerEnv().ADMIN_API_KEY;
  if (!adminApiKey) {
    return false;
  }

  const headerKey =
    request.headers.get("x-admin-api-key") ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const queryKey = request.nextUrl.searchParams.get("key") || request.nextUrl.searchParams.get("secret");

  return headerKey === adminApiKey || queryKey === adminApiKey;
}

function readBoolean(value: string | null) {
  return value === "true" || value === "1";
}
