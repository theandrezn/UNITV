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
  hasMedia: z.boolean().default(false),
  media: z
    .object({
      mimeType: z.string().nullable().optional(),
      fileName: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
      caption: z.string().nullable().optional()
    })
    .default({}),
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
  const imageMessage = asRecord(message.imageMessage);
  const documentMessage = asRecord(message.documentMessage);
  const videoMessage = asRecord(message.videoMessage);
  const audioMessage = asRecord(message.audioMessage);
  const mediaMessage = imageMessage.url
    ? imageMessage
    : documentMessage.url
      ? documentMessage
      : videoMessage.url
        ? videoMessage
        : audioMessage.url
          ? audioMessage
          : {};
  const pushName = firstString(data.pushName, root.pushName, data.notifyName);
  const remoteJid = firstString(key.remoteJid, data.remoteJid, root.remoteJid);
  const externalMessageId = firstString(key.id, data.id, root.id, root.messageId);
  const fromMe = Boolean(key.fromMe ?? data.fromMe ?? root.fromMe);
  const isGroup = remoteJid.endsWith("@g.us");
  const text = firstString(
    message.conversation,
    asRecord(message.extendedTextMessage).text,
    imageMessage.caption,
    videoMessage.caption,
    documentMessage.caption,
    data.text,
    root.text,
    asRecord(root.message).text
  );
  const messageType = firstString(data.messageType, root.messageType, Object.keys(message)[0], text ? "text" : "unknown");
  const timestamp = firstNumber(data.messageTimestamp, root.messageTimestamp, data.timestamp, root.timestamp);
  const hasMedia = ["imageMessage", "documentMessage", "videoMessage", "audioMessage"].includes(messageType) || Boolean(mediaMessage.url);

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
    hasMedia,
    media: {
      mimeType: firstString(mediaMessage.mimetype, mediaMessage.mimeType) || null,
      fileName: firstString(mediaMessage.fileName, mediaMessage.title) || null,
      url: firstString(mediaMessage.url, data.mediaUrl, root.mediaUrl) || null,
      caption: firstString(mediaMessage.caption) || null
    },
    timestamp,
    fromMe,
    isGroup
  });
}
