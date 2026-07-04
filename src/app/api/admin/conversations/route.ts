import { NextRequest, NextResponse } from "next/server";
import { requireAdminApiKey } from "@/lib/admin/auth";
import { ConversationsRepository } from "@/repositories/conversations.repository";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const unauthorized = requireAdminApiKey(request);
  if (unauthorized) return unauthorized;

  const limit = Number(request.nextUrl.searchParams.get("limit") || 50);
  const conversations = await new ConversationsRepository().listRecentConversations(Math.min(Math.max(limit, 1), 100));

  return NextResponse.json({ status: "ok", conversations });
}
