import { NextRequest, NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { WhatsappFollowupService } from "@/services/followups/whatsapp-followup.service";

export const dynamic = "force-dynamic";

function isAuthorized(request: NextRequest) {
  const adminApiKey = getServerEnv().ADMIN_API_KEY;
  if (!adminApiKey) {
    return false;
  }

  const headerKey =
    request.headers.get("x-admin-api-key") ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const queryKey = request.nextUrl.searchParams.get("key");

  return headerKey === adminApiKey || queryKey === adminApiKey;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ status: "error", message: "unauthorized" }, { status: 401 });
  }

  const requestedMode = request.headers.get("x-unitv-followup-mode");
  const sendExplicitlyEnabled = process.env.UNITV_FOLLOWUP_SEND_ENABLED === "true";
  const mode = requestedMode === "send" && sendExplicitlyEnabled ? "send" : "shadow";
  const result = await new WhatsappFollowupService().processDueFollowups(new Date(), { mode });
  return NextResponse.json({ status: "ok", mode, result });
}

export async function GET(request: NextRequest) {
  return POST(request);
}
