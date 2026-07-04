import { NextRequest, NextResponse } from "next/server";
import { extractIncomingMessageFromWebhook, getEvolutionIdempotencyKey } from "@/lib/evolution/client";
import { getServerEnv } from "@/lib/env";
import { WhatsappMessageService } from "@/services/whatsapp/whatsapp-message.service";
import { WebhooksService } from "@/services/webhooks.service";

export const dynamic = "force-dynamic";

function isAuthorized(request: NextRequest) {
  const env = getServerEnv();
  const secret = env.EVOLUTION_WEBHOOK_SECRET;

  if (!secret) {
    return false;
  }

  const headerSecret =
    request.headers.get("x-evolution-webhook-secret") ||
    request.headers.get("x-webhook-secret") ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  return headerSecret === secret;
}

export function GET(request: NextRequest) {
  const env = getServerEnv();
  const token = request.nextUrl.searchParams.get("token") || request.nextUrl.searchParams.get("verify_token");

  if (env.EVOLUTION_WEBHOOK_VERIFY_TOKEN && token !== env.EVOLUTION_WEBHOOK_VERIFY_TOKEN) {
    return NextResponse.json({ status: "error", message: "invalid verify token" }, { status: 401 });
  }

  return NextResponse.json({ status: "ok", webhook: "evolution" });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ status: "error", message: "unauthorized" }, { status: 401 });
  }

  const webhooksService = new WebhooksService();
  const whatsappMessageService = new WhatsappMessageService();
  let webhookEventId: string | null = null;

  try {
    const payload = (await request.json()) as unknown;
    const incomingMessage = extractIncomingMessageFromWebhook(payload);
    const idempotencyKey = incomingMessage ? getEvolutionIdempotencyKey(incomingMessage.externalMessageId) : null;

    if (idempotencyKey) {
      const existingWebhook = await webhooksService.findWebhookByIdempotencyKey(idempotencyKey);
      if (existingWebhook) {
        return NextResponse.json({ status: "ok", result: "duplicate" });
      }
    }

    const webhookEvent = await webhooksService.createWebhookEvent({
      provider: "evolution",
      event_type: incomingMessage?.event || "unknown",
      event_id: incomingMessage?.externalMessageId || null,
      idempotency_key: idempotencyKey,
      status: "processing",
      raw_payload: payload as Record<string, unknown>
    });
    const currentWebhookEventId = webhookEvent.id as string;
    webhookEventId = currentWebhookEventId;

    if (!incomingMessage) {
      await webhooksService.markWebhookIgnored(currentWebhookEventId);
      return NextResponse.json({ status: "ok", result: "ignored_invalid_payload" });
    }

    if (incomingMessage.fromMe) {
      await webhooksService.markWebhookIgnored(currentWebhookEventId);
      return NextResponse.json({ status: "ok", result: "ignored_from_me" });
    }

    if (incomingMessage.isGroup) {
      await webhooksService.markWebhookIgnored(currentWebhookEventId);
      return NextResponse.json({ status: "ok", result: "ignored_group" });
    }

    if (!incomingMessage.text.trim()) {
      await webhooksService.markWebhookIgnored(currentWebhookEventId);
      return NextResponse.json({ status: "ok", result: "ignored_empty_message" });
    }

    const result = await whatsappMessageService.processIncomingMessage({
      webhookEventId: currentWebhookEventId,
      message: incomingMessage
    });

    if (result.status === "processed") {
      await webhooksService.markWebhookProcessed(currentWebhookEventId);
    } else {
      await webhooksService.markWebhookIgnored(currentWebhookEventId);
    }

    return NextResponse.json({ status: "ok", result: result.status });
  } catch (error) {
    if (webhookEventId) {
      await webhooksService.markWebhookFailed(
        webhookEventId,
        error instanceof Error ? error.message : "Unknown Evolution webhook error"
      );
    }

    return NextResponse.json(
      {
        status: "error",
        message: error instanceof Error ? error.message : "Unknown Evolution webhook error"
      },
      { status: 500 }
    );
  }
}
