# Mercado Pago Payment Confirmation Design

## Goal

Create one Mercado Pago Checkout Pro preference per UNITV order and confirm approved payments through an authenticated, idempotent webhook without reserving or releasing activation codes.

## Current State And Risk

The current production links are static per plan. They contain the plan amount but no unique UNITV order reference. A payment made through one of those links cannot be matched safely to an `orders.order_number` when multiple customers buy the same plan.

The purchase flow must stop sending static links. Existing static preferences may remain in Mercado Pago and `app_settings` for historical reference, but they are not a valid source for automatic payment confirmation.

## Architecture

### Dynamic Checkout Per Order

After the agent creates a UNITV order, `MercadoPagoService` creates a Checkout Pro preference containing:

- `external_reference = order.order_number`
- `metadata.order_id`
- `metadata.order_number`
- `metadata.customer_id`
- `metadata.plan_id`
- one item with the order amount and BRL currency
- `notification_url = MERCADO_PAGO_WEBHOOK_URL`

The returned preference ID is stored in `orders.payment_reference`, `orders.payment_provider` is set to `mercado_pago`, and the checkout URL is stored in order metadata. The agent sends this order-specific URL.

If preference creation fails, the order remains `pending_payment`, no static card link is sent, and the conversation is handed to a human. PIX instructions may remain available because PIX confirmation is still manual in this phase.

### Webhook Intake

`POST /api/webhooks/mercadopago` reads `x-signature`, `x-request-id`, `data.id`, and `type`. Signature validation follows Mercado Pago's HMAC-SHA256 manifest:

```text
id:{data.id};request-id:{x-request-id};ts:{ts};
```

The expected hexadecimal digest is compared to `v1` from `x-signature` with a constant-time comparison. Missing or invalid signature data returns `401` and is not processed.

For a valid signature, the route persists a `webhook_events` row before acknowledging the request. Non-payment events are stored as `ignored` and return `200`. Payment events are scheduled through Next.js `after()` and return `200` immediately.

The notification event ID uses the webhook body notification ID when present, falling back to `x-request-id`. The payment ID alone is not used as the webhook event ID because the same payment can emit multiple status transitions.

### Background Processing

`PaymentConfirmationService` loads the authoritative payment from `GET /v1/payments/{data.id}`. It identifies the UNITV order in this order:

1. `payment.external_reference`
2. `payment.metadata.order_number`
3. `payment.metadata.order_id`

No fallback by customer, plan, phone, amount, or timestamp is allowed.

The service upserts `public.payments` by `(provider, provider_payment_id)`. Retried notifications therefore update one payment row. Order updates are conditional so only the first real transition to `paid` sends the WhatsApp confirmation.

## State Mapping

| Mercado Pago status | Payment status | Order result |
| --- | --- | --- |
| `approved`, exact BRL amount | `confirmed` | `paid`, with `paid_at` |
| `approved`, wrong amount or currency | `confirmed` | `manual_review` |
| `pending`, `in_process` | `pending` | remains `pending_payment` |
| `rejected`, `cancelled` | `rejected` | remains open for another attempt |
| `refunded` | `refunded` | `refunded` |
| `charged_back` | `chargeback` | `manual_review` |
| unknown terminal status | `failed` | unchanged, audited |

An approved payment with no matching order marks the webhook event `failed`. It is never guessed or attached to another order.

## WhatsApp Behavior

Only a successful conditional transition to `paid` sends:

```text
Pagamento confirmado. Seu pedido {order_number} foi aprovado. Agora vou encaminhar para liberacao do acesso.
```

The existing `EvolutionService` is reused. A WhatsApp failure does not roll back the confirmed payment or paid order; it creates a separate audit entry.

No payment path invokes activation-code services, changes `orders.code_id`, reserves inventory, or sends an activation code.

## Failure And Recovery

- Invalid signatures return `401`.
- Valid notifications return `200` after persistence, even if later processing fails.
- Mercado Pago API, database, or mapping failures mark the event `failed` with a sanitized error.
- Duplicate delivery is safe through webhook event uniqueness, payment upsert, and conditional order transitions.
- `after()` is intentionally not a durable queue. Persisted event state supports auditing and later reprocessing, while Mercado Pago redelivery provides immediate retry behavior.
- Secrets are server-only environment variables and are never stored in the repository, logs, webhook payload metadata, or API responses.

## Components

- `src/lib/mercadopago/client.ts`: authenticated HTTP client and response validation.
- `src/lib/mercadopago/signature.ts`: signature parsing and constant-time HMAC validation.
- `src/services/payments/mercadopago.service.ts`: preference creation and payment retrieval.
- `src/services/payments/payment-confirmation.service.ts`: order lookup, payment upsert, state transition, audit, and WhatsApp notification.
- `src/app/api/webhooks/mercadopago/route.ts`: signature gate, persistence, fast acknowledgement, and `after()` scheduling.
- Payment repository: provider-payment upsert.
- Order repository: lookup with customer/plan and conditional status transition.
- Existing webhook, audit, and Evolution services remain the integration boundaries.

## Environment

```env
MERCADO_PAGO_ACCESS_TOKEN=
MERCADO_PAGO_WEBHOOK_SECRET=
MERCADO_PAGO_PUBLIC_KEY=
MERCADO_PAGO_WEBHOOK_URL=
```

`MERCADO_PAGO_PUBLIC_KEY` is validated for operational completeness but remains unused by the server-only Checkout Pro flow in this phase.

## Test Strategy

Tests are written before implementation and must prove:

- missing and invalid signatures return `401`
- valid non-payment events are ignored with `200`
- dynamic preferences carry the exact order reference, metadata, and notification URL
- approved matching payments create one payment and mark the order paid
- duplicate notifications do not duplicate payments or WhatsApp messages
- amount or currency mismatch moves the order to manual review
- order lookup supports external reference, metadata order number, and metadata order ID
- missing orders fail safely
- pending, rejected, refunded, and chargeback mappings are deterministic
- no approved flow invokes activation-code reservation or release

The final gate runs typecheck, lint, all tests, production build, signed webhook simulation, database rereads, live health checks, and PM2 verification.
