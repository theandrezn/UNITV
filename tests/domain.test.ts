import { describe, expect, it } from "vitest";
import { canReserveActivationCode } from "@/lib/activation-codes/rules";
import { isValidOrderNumber } from "@/lib/orders/order-number";
import { normalizeIdempotencyKey } from "@/lib/webhooks/idempotency";
import { orderSchema, orderStatusSchema } from "@/types/domain";

describe("domain validation", () => {
  it("validates generated order number format", () => {
    expect(isValidOrderNumber("UTV-20260704-000001")).toBe(true);
    expect(isValidOrderNumber("BAD-20260704-000001")).toBe(false);
  });

  it("rejects invalid order statuses", () => {
    expect(orderStatusSchema.safeParse("pending_payment").success).toBe(true);
    expect(orderStatusSchema.safeParse("paid_without_review").success).toBe(false);
  });

  it("requires positive order amount", () => {
    expect(
      orderSchema.safeParse({
        customer_id: "00000000-0000-0000-0000-000000000001",
        product_id: "00000000-0000-0000-0000-000000000002",
        amount_cents: 0
      }).success
    ).toBe(false);
  });

  it("only reserves available activation codes", () => {
    expect(canReserveActivationCode("available")).toBe(true);
    expect(canReserveActivationCode("reserved")).toBe(false);
    expect(canReserveActivationCode("missing")).toBe(false);
  });

  it("normalizes webhook idempotency keys", () => {
    expect(normalizeIdempotencyKey("  provider:event:123  ")).toBe("provider:event:123");
  });
});
