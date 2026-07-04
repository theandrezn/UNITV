import "server-only";
import { WebhookEventsRepository } from "@/repositories/webhook-events.repository";
import { webhookEventSchema, type WebhookEvent } from "@/types/domain";

export class WebhooksService {
  constructor(private readonly webhookEventsRepository = new WebhookEventsRepository()) {}

  createWebhookEvent(data: WebhookEvent) {
    return this.webhookEventsRepository.createWebhookEvent(webhookEventSchema.parse(data));
  }

  findWebhookByIdempotencyKey(key: string) {
    return this.webhookEventsRepository.findWebhookByIdempotencyKey(key);
  }

  markWebhookProcessed(id: string) {
    return this.webhookEventsRepository.markWebhookProcessed(id);
  }

  markWebhookFailed(id: string, error: string) {
    return this.webhookEventsRepository.markWebhookFailed(id, error);
  }
}
