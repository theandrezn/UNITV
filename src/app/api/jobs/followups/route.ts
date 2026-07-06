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

  const result = await new WhatsappFollowupService().processDueFollowups();
  return NextResponse.json({ status: "ok", result });
}

export async function GET(request: NextRequest) {
  return POST(request);
}
