import { NextResponse } from "next/server";
import { getAppEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    app: "unitv-agent",
    env: getAppEnv()
  });
}
