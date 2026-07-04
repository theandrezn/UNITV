import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateMercadoPagoSignature } from "@/lib/mercadopago/signature";

describe("Mercado Pago webhook signature", () => {
  const secret = "webhook-secret";
  const dataId = "123456";
  const requestId = "request-id";
  const timestamp = "1783188000";
  const digest = createHmac("sha256", secret)
    .update(`id:${dataId};request-id:${requestId};ts:${timestamp};`)
    .digest("hex");

  it("accepts a valid signature", () => {
    expect(
      validateMercadoPagoSignature({
        dataId,
        requestId,
        signature: `ts=${timestamp},v1=${digest}`,
        secret
      })
    ).toBe(true);
  });

  it("normalizes an alphanumeric data id to lowercase", () => {
    const mixedDataId = "ABC123";
    const mixedDigest = createHmac("sha256", secret)
      .update(`id:${mixedDataId.toLowerCase()};request-id:${requestId};ts:${timestamp};`)
      .digest("hex");

    expect(
      validateMercadoPagoSignature({
        dataId: mixedDataId,
        requestId,
        signature: `ts=${timestamp},v1=${mixedDigest}`,
        secret
      })
    ).toBe(true);
  });

  it("rejects missing and invalid signatures", () => {
    expect(validateMercadoPagoSignature({ dataId, requestId, signature: "", secret })).toBe(false);
    expect(
      validateMercadoPagoSignature({
        dataId,
        requestId,
        signature: `ts=${timestamp},v1=${"0".repeat(64)}`,
        secret
      })
    ).toBe(false);
  });
});
