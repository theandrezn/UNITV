# Mercado Pago Webhook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate one Checkout Pro preference per UNITV order and confirm signed Mercado Pago payment notifications without releasing activation codes.

**Architecture:** The chat agent creates the UNITV order first and then asks a server-only Mercado Pago service for an order-specific preference. The webhook route validates and persists the notification before returning `200`, then Next.js `after()` invokes an idempotent confirmation service that upserts payments, conditionally transitions orders, audits results, and uses the existing Evolution service for one confirmation message.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase, native `fetch`, Node `crypto`, Zod, Vitest.

---

### Task 1: Environment And Signature Validation

**Files:**
- Modify: `.env.example`
- Modify: `src/lib/env.ts`
- Create: `src/lib/mercadopago/signature.ts`
- Create: `tests/mercadopago-signature.test.ts`

- [ ] **Step 1: Write failing signature tests**

```ts
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
    expect(validateMercadoPagoSignature({
      dataId,
      requestId,
      signature: `ts=${timestamp},v1=${digest}`,
      secret
    })).toBe(true);
  });

  it("rejects missing and invalid signatures", () => {
    expect(validateMercadoPagoSignature({ dataId, requestId, signature: "", secret })).toBe(false);
    expect(validateMercadoPagoSignature({
      dataId,
      requestId,
      signature: `ts=${timestamp},v1=${"0".repeat(64)}`,
      secret
    })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/mercadopago-signature.test.ts`

Expected: FAIL because `@/lib/mercadopago/signature` does not exist.

- [ ] **Step 3: Implement server env and signature validation**

Add to `.env.example` and `serverEnvSchema`:

```env
MERCADO_PAGO_ACCESS_TOKEN=
MERCADO_PAGO_WEBHOOK_SECRET=
MERCADO_PAGO_PUBLIC_KEY=
MERCADO_PAGO_WEBHOOK_URL=
```

Implement `validateMercadoPagoSignature` with `createHmac`, strict parsing of `ts` and `v1`, lowercase alphanumeric `data.id`, equal buffer length checks, and `timingSafeEqual`.

- [ ] **Step 4: Run the signature test and verify GREEN**

Run: `npm test -- tests/mercadopago-signature.test.ts`

Expected: PASS.

### Task 2: Mercado Pago API Boundary

**Files:**
- Create: `src/lib/mercadopago/client.ts`
- Create: `src/services/payments/mercadopago.service.ts`
- Create: `tests/mercadopago.service.test.ts`

- [ ] **Step 1: Write failing preference and payment tests**

Test a dependency-injected `fetch` function. Assert that `createOrderPreference` posts to `/checkout/preferences` with one BRL item, `external_reference`, all four metadata identifiers, `notification_url`, and a unique idempotency header. Assert that `getPayment` calls `/v1/payments/{id}` and parses status, amount, currency, reference, metadata, and approval date.

- [ ] **Step 2: Run the service test and verify RED**

Run: `npm test -- tests/mercadopago.service.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement the minimal API client and service**

```ts
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
    if (!response.ok) throw new Error(`Mercado Pago API failed with HTTP ${response.status}.`);
    return response.json();
  }
}
```

Use Zod response schemas. Return only the preference/payment fields needed by downstream services, and never include the access token in errors.

- [ ] **Step 4: Run the service test and verify GREEN**

Run: `npm test -- tests/mercadopago.service.test.ts`

Expected: PASS.

### Task 3: Idempotent Persistence And State Transitions

**Files:**
- Create: `src/repositories/payments.repository.ts`
- Create: `src/services/payments.service.ts`
- Modify: `src/repositories/orders.repository.ts`
- Modify: `src/services/orders.service.ts`
- Modify: `src/repositories/webhook-events.repository.ts`
- Modify: `src/services/webhooks.service.ts`
- Create: `src/services/payments/payment-confirmation.service.ts`
- Create: `tests/payment-confirmation.test.ts`

- [ ] **Step 1: Write failing confirmation tests**

Cover these independent behaviors with injected repositories/services:

```ts
it("marks an exact approved payment paid and sends one WhatsApp message");
it("upserts a duplicate payment without sending a second message");
it("moves an amount mismatch to manual review");
it("finds orders by external reference, metadata order number, then metadata order id");
it("fails safely when no order exists");
it("maps pending, rejected, refunded, and charged back statuses");
it("never invokes activation code behavior");
```

The approved fixture must contain `transaction_amount: 25`, `currency_id: "BRL"`, an order reference, and a stable payment ID.

- [ ] **Step 2: Run the confirmation test and verify RED**

Run: `npm test -- tests/payment-confirmation.test.ts`

Expected: FAIL because `PaymentConfirmationService` and persistence methods do not exist.

- [ ] **Step 3: Add persistence operations**

Implement:

```ts
PaymentsRepository.upsertProviderPayment(data)
OrdersRepository.findOrderForPayment({ orderNumber, orderId })
OrdersRepository.transitionToPaid(orderId, paidAt)
OrdersRepository.transitionStatus(orderId, fromStatuses, toStatus, data)
WebhookEventsRepository.findByProviderEventId(provider, eventId)
```

`transitionToPaid` must update only rows whose current status is not `paid` and return `null` when another delivery already completed the transition.

- [ ] **Step 4: Implement confirmation orchestration**

`PaymentConfirmationService.process` must:

1. mark the webhook processing
2. retrieve the payment from Mercado Pago
3. resolve the order by the approved priority
4. upsert the payment
5. apply the state table from the design
6. audit expected and received values
7. send WhatsApp only after the first transition to paid
8. mark the webhook processed or failed

The service constructor contains no activation-code dependency.

- [ ] **Step 5: Run the confirmation tests and verify GREEN**

Run: `npm test -- tests/payment-confirmation.test.ts`

Expected: PASS.

### Task 4: Fast Signed Webhook Route

**Files:**
- Create: `src/app/api/webhooks/mercadopago/route.ts`
- Create: `tests/mercadopago-webhook.test.ts`

- [ ] **Step 1: Write failing route tests**

Test exported request handling with dependency injection or route-level mocks:

```ts
it("returns 401 when x-signature is missing");
it("returns 401 when x-signature is invalid");
it("stores and ignores a signed non-payment event");
it("stores a signed payment event and schedules processing");
it("acknowledges a duplicate notification without scheduling twice");
```

- [ ] **Step 2: Run the route test and verify RED**

Run: `npm test -- tests/mercadopago-webhook.test.ts`

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement intake and `after()` scheduling**

The route must parse both query and JSON body variants, validate before database writes, use the notification ID or request ID as the event ID, persist the raw body, and call:

```ts
after(async () => {
  await paymentConfirmationService.process({ webhookEventId, paymentId });
});
```

Return `200` for valid duplicates and ignored event types, and `401` only for failed authentication.

- [ ] **Step 4: Run the route tests and verify GREEN**

Run: `npm test -- tests/mercadopago-webhook.test.ts`

Expected: PASS.

### Task 5: Replace Static Links In The Agent

**Files:**
- Modify: `src/services/agent/chat-agent.service.ts`
- Modify: `tests/commercial-agent.test.ts`

- [ ] **Step 1: Write failing commercial-flow tests**

Assert that a purchase:

- creates the order first
- creates a Mercado Pago preference from that exact order
- updates `payment_provider`, `payment_reference`, and checkout metadata
- sends the dynamic checkout URL
- does not call `AppSettingsService` for a static card URL
- falls back to human handling when preference creation fails

- [ ] **Step 2: Run the commercial test and verify RED**

Run: `npm test -- tests/commercial-agent.test.ts`

Expected: FAIL because the chat agent still reads static payment links.

- [ ] **Step 3: Implement dynamic preference creation**

Inject `MercadoPagoService` into `ChatAgentService`. After order creation, call it with order, customer, and plan identifiers, update the order with the preference, and compose a short WhatsApp reply with PIX instructions plus the dynamic card URL.

On API failure, create a `handoff_to_human` action and audit entry while leaving the order `pending_payment`.

- [ ] **Step 4: Run commercial tests and verify GREEN**

Run: `npm test -- tests/commercial-agent.test.ts`

Expected: PASS.

### Task 6: Full Verification, Production Configuration, And Deployment

**Files:**
- Modify: VPS `/var/www/unitv/.env.local` outside git
- Modify: Mercado Pago application webhook configuration through the official MCP or dashboard

- [ ] **Step 1: Run the complete local gate**

Run:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
git diff --check
```

Expected: every command exits `0`.

- [ ] **Step 2: Configure production secrets**

Set the production Access Token, Public Key, webhook secret, and:

```env
MERCADO_PAGO_WEBHOOK_URL=http://76.13.231.244/api/webhooks/mercadopago
```

Prefer HTTPS once a production domain is available. Keep file mode `600` and never print secret values.

- [ ] **Step 3: Configure Mercado Pago webhook**

Set the production callback to the webhook URL and subscribe to `payment` through the official Mercado Pago MCP `save_webhook` tool or the application dashboard.

- [ ] **Step 4: Commit, push, and deploy**

```powershell
git add .env.example src/lib/env.ts src/lib/mercadopago src/repositories/orders.repository.ts src/repositories/payments.repository.ts src/repositories/webhook-events.repository.ts src/services/orders.service.ts src/services/payments.service.ts src/services/payments src/services/webhooks.service.ts src/services/agent/chat-agent.service.ts src/app/api/webhooks/mercadopago tests
git commit -m "Add Mercado Pago payment confirmation webhook"
git push origin main
ssh root@76.13.231.244 "cd /var/www/unitv && bash scripts/vps-deploy.sh"
```

- [ ] **Step 5: Run signed production-safe validation**

Create a controlled pending order, generate its dynamic preference, submit a signed mock approved-payment fixture through the route with a mocked Mercado Pago retrieval boundary, verify the order becomes `paid`, `code_id` remains null, one payment exists, and one WhatsApp send is recorded by the test double. Remove controlled test records afterward.

- [ ] **Step 6: Run live health and authentication checks**

```powershell
Invoke-WebRequest http://76.13.231.244/api/health
Invoke-WebRequest http://76.13.231.244/api/health/db
Invoke-WebRequest http://76.13.231.244/api/health/ai
Invoke-WebRequest -Method Post http://76.13.231.244/api/webhooks/mercadopago
```

Expected: health routes return `200`; unsigned webhook returns `401`; PM2 reports `unitv-agent` online.
