import { NextRequest, NextResponse } from "next/server";
import { requireAdminApiKey } from "@/lib/admin/auth";
import { AgentShadowDecisionsRepository } from "@/repositories/agent-shadow-decisions.repository";
import { summarizeShadowDecisions } from "@/services/agent/shadow-decision.service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const unauthorized = requireAdminApiKey(request);
  if (unauthorized) return unauthorized;
  const limit = Number(request.nextUrl.searchParams.get("limit") || 100);
  const rows = await new AgentShadowDecisionsRepository().listRecent(limit);
  return NextResponse.json({ status: "ok", summary: summarizeShadowDecisions(rows), decisions: rows });
}
