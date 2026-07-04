import { NextRequest, NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";

export function requireAdminApiKey(request: NextRequest) {
  const adminApiKey = getServerEnv().ADMIN_API_KEY;

  if (!adminApiKey) {
    return NextResponse.json({ status: "error", message: "ADMIN_API_KEY is not configured" }, { status: 503 });
  }

  const provided =
    request.headers.get("x-admin-api-key") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (provided !== adminApiKey) {
    return NextResponse.json({ status: "error", message: "unauthorized" }, { status: 401 });
  }

  return null;
}
