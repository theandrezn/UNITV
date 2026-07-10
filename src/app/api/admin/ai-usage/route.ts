import { NextRequest, NextResponse } from "next/server";
import { requireAdminApiKey } from "@/lib/admin/auth";
import { AuditLogsRepository } from "@/repositories/audit-logs.repository";

export const dynamic = "force-dynamic";

type Dependencies = {
  repository?: Pick<AuditLogsRepository, "listOpenAIUsageSince">;
  now?: Date;
};

export async function GET(request: NextRequest) {
  return handleOpenAIUsage(request);
}

export async function handleOpenAIUsage(request: NextRequest, dependencies: Dependencies = {}) {
  const unauthorized = requireAdminApiKey(request);
  if (unauthorized) return unauthorized;

  const days = Math.min(Math.max(Number(request.nextUrl.searchParams.get("days") || 7), 1), 31);
  const now = dependencies.now || new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = await (dependencies.repository || new AuditLogsRepository()).listOpenAIUsageSince(since);

  return NextResponse.json({
    status: "ok",
    since,
    days,
    summary: summarizeUsage(rows)
  });
}

export function summarizeUsage(rows: Array<Record<string, unknown>>) {
  const totals = { calls: 0, input_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0, errors: 0, circuit_open: 0 };
  const byCallType = new Map<string, Record<string, number>>();
  const byModel = new Map<string, Record<string, number>>();

  for (const row of rows) {
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
    const target = metricsFromMetadata(metadata);
    addMetrics(totals, target);
    addMetricsToMap(byCallType, String(metadata.call_type || "unknown"), target);
    addMetricsToMap(byModel, String(metadata.model || "unknown"), target);
  }

  return {
    totals,
    by_call_type: Object.fromEntries(byCallType),
    by_model: Object.fromEntries(byModel)
  };
}

function metricsFromMetadata(metadata: Record<string, unknown>) {
  const outcome = String(metadata.outcome || "unknown");
  return {
    calls: 1,
    input_tokens: numberValue(metadata.input_tokens),
    cached_input_tokens: numberValue(metadata.cached_input_tokens),
    cache_write_tokens: numberValue(metadata.cache_write_tokens),
    output_tokens: numberValue(metadata.output_tokens),
    reasoning_tokens: numberValue(metadata.reasoning_tokens),
    total_tokens: numberValue(metadata.total_tokens),
    errors: outcome === "error" ? 1 : 0,
    circuit_open: outcome === "circuit_open" ? 1 : 0
  };
}

function addMetrics(target: Record<string, number>, source: Record<string, number>) {
  for (const [key, value] of Object.entries(source)) {
    target[key] = Number(target[key] || 0) + value;
  }
}

function addMetricsToMap(map: Map<string, Record<string, number>>, key: string, source: Record<string, number>) {
  const target = map.get(key) || { calls: 0, input_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0, errors: 0, circuit_open: 0 };
  addMetrics(target, source);
  map.set(key, target);
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
