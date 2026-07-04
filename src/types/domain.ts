import { z } from "zod";

export const customerStatusSchema = z.enum(["active", "inactive", "blocked"]);
export const productStatusSchema = z.enum(["active", "inactive", "archived"]);
export const activationCodeStatusSchema = z.enum(["available", "reserved", "sent", "cancelled", "invalid"]);
export const orderStatusSchema = z.enum([
  "draft",
  "pending_payment",
  "receipt_under_review",
  "paid",
  "code_reserved",
  "code_sent",
  "waiting_stock",
  "manual_review",
  "cancelled",
  "refunded",
  "failed"
]);
export const paymentStatusSchema = z.enum(["pending", "confirmed", "rejected", "refunded", "chargeback", "failed"]);
export const receiptStatusSchema = z.enum([
  "uploaded",
  "ai_processing",
  "ai_analyzed",
  "suspected_fraud",
  "approved_by_ai",
  "rejected_by_ai",
  "manual_review",
  "approved_by_human",
  "rejected_by_human"
]);
export const conversationChannelSchema = z.enum(["whatsapp", "webchat", "instagram", "manual"]);
export const messageRoleSchema = z.enum(["customer", "assistant", "system", "human_agent", "tool"]);
export const webhookEventStatusSchema = z.enum(["received", "processing", "processed", "ignored", "failed"]);
export const agentActionStatusSchema = z.enum(["requested", "approved", "rejected", "executed", "failed"]);
export const auditActorTypeSchema = z.enum(["system", "ai_agent", "human_admin", "webhook", "customer"]);
export const knowledgeArticleStatusSchema = z.enum(["active", "inactive", "archived"]);

const jsonRecordSchema = z.record(z.unknown());
const uuidSchema = z.string().uuid();

export const customerSchema = z.object({
  id: uuidSchema.optional(),
  name: z.string().nullable().optional(),
  phone: z.string().min(1),
  email: z.string().email().nullable().optional(),
  external_channel: z.string().nullable().optional(),
  external_user_id: z.string().nullable().optional(),
  status: customerStatusSchema.default("active"),
  metadata: jsonRecordSchema.default({})
});

export const productSchema = z.object({
  id: uuidSchema.optional(),
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().nullable().optional(),
  status: productStatusSchema.default("active"),
  metadata: jsonRecordSchema.default({})
});

export const planSchema = z.object({
  id: uuidSchema.optional(),
  product_id: uuidSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  duration_days: z.number().int().positive().nullable().optional(),
  price_cents: z.number().int().nonnegative(),
  currency: z.string().default("BRL"),
  status: productStatusSchema.default("active"),
  metadata: jsonRecordSchema.default({})
});

export const activationCodeSchema = z.object({
  id: uuidSchema.optional(),
  product_id: uuidSchema,
  plan_id: uuidSchema.nullable().optional(),
  code: z.string().min(1),
  status: activationCodeStatusSchema.default("available"),
  assigned_order_id: uuidSchema.nullable().optional(),
  assigned_customer_id: uuidSchema.nullable().optional(),
  metadata: jsonRecordSchema.default({})
});

export const orderSchema = z.object({
  id: uuidSchema.optional(),
  order_number: z.string().min(1).optional(),
  customer_id: uuidSchema,
  product_id: uuidSchema,
  plan_id: uuidSchema.nullable().optional(),
  status: orderStatusSchema.default("pending_payment"),
  amount_cents: z.number().int().positive(),
  currency: z.string().default("BRL"),
  payment_provider: z.string().nullable().optional(),
  payment_reference: z.string().nullable().optional(),
  code_id: uuidSchema.nullable().optional(),
  notes: z.string().nullable().optional(),
  metadata: jsonRecordSchema.default({})
});

export const paymentSchema = z.object({
  id: uuidSchema.optional(),
  order_id: uuidSchema,
  provider: z.string().min(1),
  provider_payment_id: z.string().nullable().optional(),
  transaction_id: z.string().nullable().optional(),
  status: paymentStatusSchema.default("pending"),
  amount_cents: z.number().int().positive(),
  currency: z.string().default("BRL"),
  raw_payload: jsonRecordSchema.default({})
});

export const receiptSchema = z.object({
  id: uuidSchema.optional(),
  order_id: uuidSchema,
  customer_id: uuidSchema,
  file_url: z.string().url().nullable().optional(),
  file_path: z.string().nullable().optional(),
  mime_type: z.string().nullable().optional(),
  status: receiptStatusSchema.default("uploaded"),
  extracted_amount_cents: z.number().int().positive().nullable().optional(),
  extracted_currency: z.string().nullable().optional(),
  extracted_transaction_id: z.string().nullable().optional(),
  ai_confidence: z.number().min(0).max(1).nullable().optional(),
  risk_score: z.number().min(0).max(1).nullable().optional(),
  ai_summary: z.string().nullable().optional(),
  ai_raw_response: jsonRecordSchema.default({})
});

export const webhookEventSchema = z.object({
  id: uuidSchema.optional(),
  provider: z.string().min(1),
  event_type: z.string().min(1),
  event_id: z.string().nullable().optional(),
  idempotency_key: z.string().nullable().optional(),
  status: webhookEventStatusSchema.default("received"),
  raw_payload: jsonRecordSchema.default({}),
  error_message: z.string().nullable().optional()
});

export const agentActionSchema = z.object({
  id: uuidSchema.optional(),
  conversation_id: uuidSchema.nullable().optional(),
  customer_id: uuidSchema.nullable().optional(),
  order_id: uuidSchema.nullable().optional(),
  action_name: z.string().min(1),
  status: agentActionStatusSchema.default("requested"),
  input_payload: jsonRecordSchema.default({}),
  output_payload: jsonRecordSchema.default({}),
  requires_human_approval: z.boolean().default(false),
  error_message: z.string().nullable().optional()
});

export const auditLogSchema = z.object({
  id: uuidSchema.optional(),
  actor_type: auditActorTypeSchema,
  actor_id: z.string().nullable().optional(),
  action: z.string().min(1),
  entity_type: z.string().nullable().optional(),
  entity_id: uuidSchema.nullable().optional(),
  before_data: jsonRecordSchema.nullable().optional(),
  after_data: jsonRecordSchema.nullable().optional(),
  metadata: jsonRecordSchema.default({})
});

export const knowledgeArticleSchema = z.object({
  id: uuidSchema.optional(),
  title: z.string().min(1),
  category: z.string().min(1),
  content: z.string().min(1),
  status: knowledgeArticleStatusSchema.default("active"),
  metadata: jsonRecordSchema.default({})
});

export type Customer = z.infer<typeof customerSchema>;
export type Product = z.infer<typeof productSchema>;
export type Plan = z.infer<typeof planSchema>;
export type ActivationCode = z.infer<typeof activationCodeSchema>;
export type Order = z.infer<typeof orderSchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type WebhookEvent = z.infer<typeof webhookEventSchema>;
export type AgentAction = z.infer<typeof agentActionSchema>;
export type AuditLog = z.infer<typeof auditLogSchema>;
export type KnowledgeArticle = z.infer<typeof knowledgeArticleSchema>;
