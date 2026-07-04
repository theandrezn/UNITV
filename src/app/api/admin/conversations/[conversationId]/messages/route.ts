import { NextRequest, NextResponse } from "next/server";
import { requireAdminApiKey } from "@/lib/admin/auth";
import { MessagesRepository } from "@/repositories/messages.repository";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ conversationId: string }> }) {
  const unauthorized = requireAdminApiKey(request);
  if (unauthorized) return unauthorized;

  const { conversationId } = await params;
  const limit = Number(request.nextUrl.searchParams.get("limit") || 100);
  const messages = await new MessagesRepository().listMessagesByConversationId(
    conversationId,
    Math.min(Math.max(limit, 1), 200)
  );

  return NextResponse.json({ status: "ok", messages });
}
