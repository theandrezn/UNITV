import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MetaConversionsService } from "@/services/marketing/meta-conversions.service";

describe("MetaConversionsService", () => {
  it("does not call Meta when tracking is disabled", async () => {
    const client = vi.fn();
    const service = new MetaConversionsService({
      enabled: false,
      accessToken: "token",
      datasetId: "pixel-id",
      pageId: "page-id",
      apiVersion: "v23.0",
      testEventCode: null
    }, client as never);

    const result = await service.trackPurchase(basePurchaseInput());

    expect(result).toEqual({ status: "skipped", reason: "disabled" });
    expect(client).not.toHaveBeenCalled();
  });

  it("does not call Meta when required config is missing", async () => {
    const client = vi.fn();
    const service = new MetaConversionsService({
      enabled: true,
      accessToken: null,
      datasetId: "pixel-id",
      pageId: "page-id",
      apiVersion: "v23.0",
      testEventCode: null
    }, client as never);

    const result = await service.trackPurchase(basePurchaseInput());

    expect(result).toEqual({ status: "skipped", reason: "missing_config" });
    expect(client).not.toHaveBeenCalled();
  });

  it("sends a Purchase event to the configured Meta dataset", async () => {
    const client = vi.fn(async (_input: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ events_received: 1 }), { status: 200 })
    );
    const service = new MetaConversionsService({
      enabled: true,
      accessToken: "meta-token",
      datasetId: "123456789",
      pageId: "9988776655",
      apiVersion: "v23.0",
      testEventCode: "TEST123"
    }, client as never);

    const result = await service.trackPurchase(basePurchaseInput());

    expect(client).toHaveBeenCalledWith("https://graph.facebook.com/v23.0/123456789/events", expect.objectContaining({
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer meta-token"
      }
    }));
    const calls = client.mock.calls as Array<[string, RequestInit]>;
    const body = JSON.parse(String(calls[0][1].body));
    expect(body.test_event_code).toBe("TEST123");
    expect(body.data[0]).toEqual(expect.objectContaining({
      event_name: "Purchase",
      event_time: 1783188000,
      event_id: "purchase-event-id",
      action_source: "business_messaging",
      messaging_channel: "whatsapp"
    }));
    expect(body.data[0].user_data.page_id).toBe("9988776655");
    expect(body.data[0].custom_data).toEqual(expect.objectContaining({
      currency: "BRL",
      value: 25,
      order_id: "UTV-20260704-000100",
      content_name: "mensal"
    }));
    expect(body.data[0].user_data.ph[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toContain("5511999998888");
    expect(result).toEqual({ status: "sent", eventId: "purchase-event-id", response: { events_received: 1 } });
  });
});

function basePurchaseInput() {
  return {
    eventId: "purchase-event-id",
    eventTime: 1783188000,
    orderId: "11111111-1111-4111-8111-111111111111",
    orderNumber: "UTV-20260704-000100",
    amountCents: 2500,
    currency: "BRL",
    customerPhone: "5511999998888",
    planSlug: "mensal"
  };
}
