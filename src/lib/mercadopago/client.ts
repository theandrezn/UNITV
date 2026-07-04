import "server-only";
import { getMercadoPagoEnv } from "@/lib/env";

export class MercadoPagoClient {
  constructor(
    private readonly accessToken: string,
    private readonly request: typeof fetch = fetch
  ) {}

  async requestJson(path: string, init: RequestInit = {}) {
    const response = await this.request(`https://api.mercadopago.com${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
        ...init.headers
      },
      signal: AbortSignal.timeout(15_000)
    });

    if (!response.ok) {
      throw new Error(`Mercado Pago API failed with HTTP ${response.status}.`);
    }

    return response.json();
  }
}

export function createMercadoPagoClient() {
  return new MercadoPagoClient(getMercadoPagoEnv().MERCADO_PAGO_ACCESS_TOKEN);
}
