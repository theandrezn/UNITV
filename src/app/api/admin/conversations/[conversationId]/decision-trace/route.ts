import { NextRequest, NextResponse } from "next/server";
import { requireAdminApiKey } from "@/lib/admin/auth";
import { AgentEventLogsRepository } from "@/repositories/agent-event-logs.repository";

export const dynamic = "force-dynamic";

type Dependencies = {
  repository?: Pick<AgentEventLogsRepository, "listEventsByConversationId">;
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
  dependencies: Dependencies = {}
) {
  const unauthorized = requireAdminApiKey(request);
  if (unauthorized) return unauthorized;

  const { conversationId } = await params;
  const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get("limit") || 100), 1), 200);
  const events = await (dependencies.repository || new AgentEventLogsRepository()).listEventsByConversationId(conversationId, limit);

  return NextResponse.json({
    status: "ok",
    traces: events.map(toDecisionTrace)
  });
}

function toDecisionTrace(event: Record<string, unknown>) {
  const metadata = isRecord(event.metadata) ? event.metadata : {};
  return {
    id: typeof event.id === "string" ? event.id : null,
    created_at: typeof event.created_at === "string" ? event.created_at : null,
    event_type: typeof event.event_type === "string" ? event.event_type : null,
    event_source: typeof event.event_source === "string" ? event.event_source : null,
    intent: typeof event.intent === "string" ? event.intent : null,
    stage: typeof event.stage === "string" ? event.stage : null,
    device: typeof event.device === "string" ? event.device : null,
    plan_interest: typeof event.plan_interest === "string" ? event.plan_interest : null,
    decision: {
      rule: stringValue(metadata.rule, metadata.brain_response_rule),
      brain_stage: stringValue(metadata.brain_stage),
      context_active: booleanValue(metadata.brain_context_active),
      initial_greeting_allowed: booleanValue(metadata.brain_allows_initial_greeting),
      human_handoff_allowed: booleanValue(metadata.brain_allows_human_handoff),
      followup_allowed: booleanValue(metadata.brain_allows_followup),
      followup_key: stringValue(metadata.followup_key),
      reason: stringValue(metadata.reason),
      confidence: numberValue(metadata.confidence)
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string") || null;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
