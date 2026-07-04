import { createHmac, timingSafeEqual } from "node:crypto";

type MercadoPagoSignatureInput = {
  dataId: string;
  requestId: string;
  signature: string;
  secret: string;
};

export function validateMercadoPagoSignature(input: MercadoPagoSignatureInput) {
  if (!input.dataId || !input.requestId || !input.signature || !input.secret) {
    return false;
  }

  const parts = Object.fromEntries(
    input.signature.split(",").flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator < 1) {
        return [];
      }

      return [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()]];
    })
  );
  const timestamp = parts.ts;
  const receivedDigest = parts.v1;

  if (!timestamp || !receivedDigest || !/^[a-f0-9]{64}$/i.test(receivedDigest)) {
    return false;
  }

  const manifest = `id:${input.dataId.toLowerCase()};request-id:${input.requestId};ts:${timestamp};`;
  const expectedDigest = createHmac("sha256", input.secret).update(manifest).digest("hex");
  const received = Buffer.from(receivedDigest.toLowerCase(), "hex");
  const expected = Buffer.from(expectedDigest, "hex");

  return received.length === expected.length && timingSafeEqual(received, expected);
}
