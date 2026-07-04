import { z } from "zod";

export const incomingEvolutionMessageSchema = z.object({
  event: z.string().default("messages.upsert"),
  instance: z.string().nullable().optional(),
  externalMessageId: z.string().min(1),
  remoteJid: z.string().min(1),
  phone: z.string().min(1),
  contactName: z.string().nullable().optional(),
  text: z.string().default(""),
  messageType: z.string().default("unknown"),
  timestamp: z.number().nullable().optional(),
  fromMe: z.boolean().default(false),
  isGroup: z.boolean().default(false)
});

export type IncomingEvolutionMessage = z.infer<typeof incomingEvolutionMessageSchema>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function firstNumber(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value))) {
      return Number(value);
    }
  }

  return null;
}

export function normalizePhone(value: string) {
  const withoutJid = value.split("@")[0] ?? value;
  const digits = withoutJid.replace(/\D/g, "");
  return digits;
}

export function getEvolutionIdempotencyKey(externalMessageId: string) {
  return `evolution:${externalMessageId}`;
}

export function extractIncomingMessageFromWebhook(payload: unknown) {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const key = asRecord(data.key);
  const message = asRecord(data.message);
  const pushName = firstString(data.pushName, root.pushName, data.notifyName);
  const remoteJid = firstString(key.remoteJid, data.remoteJid, root.remoteJid);
  const externalMessageId = firstString(key.id, data.id, root.id, root.messageId);
  const fromMe = Boolean(key.fromMe ?? data.fromMe ?? root.fromMe);
  const isGroup = remoteJid.endsWith("@g.us");
  const text = firstString(
    message.conversation,
    asRecord(message.extendedTextMessage).text,
    asRecord(message.imageMessage).caption,
    asRecord(message.videoMessage).caption,
    data.text,
    root.text,
    asRecord(root.message).text
  );
  const messageType = firstString(data.messageType, root.messageType, Object.keys(message)[0], text ? "text" : "unknown");
  const timestamp = firstNumber(data.messageTimestamp, root.messageTimestamp, data.timestamp, root.timestamp);

  if (!externalMessageId || !remoteJid) {
    return null;
  }

  return incomingEvolutionMessageSchema.parse({
    event: firstString(root.event, data.event, "messages.upsert"),
    instance: firstString(root.instance, data.instance) || null,
    externalMessageId,
    remoteJid,
    phone: normalizePhone(remoteJid),
    contactName: pushName || null,
    text,
    messageType,
    timestamp,
    fromMe,
    isGroup
  });
}
