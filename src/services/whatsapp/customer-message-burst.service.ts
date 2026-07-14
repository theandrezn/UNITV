type PendingBurst = { token: symbol };

export type RecentBurstMessage = {
  role?: string;
  content?: string | null;
  external_message_id?: string | null;
  created_at?: string | null;
};

const pendingBursts = new Map<string, PendingBurst>();

export class CustomerMessageBurstService {
  constructor(private readonly delayMs = readDelay()) {}

  async isLatestMessageInBurst(conversationId: string) {
    if (this.delayMs <= 0) return true;

    const token = Symbol(conversationId);
    pendingBursts.set(conversationId, { token });
    await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    const current = pendingBursts.get(conversationId);
    const isLatest = current?.token === token;
    if (isLatest) pendingBursts.delete(conversationId);
    return isLatest;
  }
}

export function buildEffectiveCustomerBurstMessage(input: {
  currentMessage: string;
  currentMessageId: string;
  recentMessages: RecentBurstMessage[];
  windowMs?: number;
  maxMessages?: number;
  maxCharacters?: number;
}) {
  const currentMessage = normalizeBurstText(input.currentMessage);
  const windowMs = Math.max(0, input.windowMs ?? 30_000);
  const maxMessages = Math.max(1, input.maxMessages ?? 4);
  const maxCharacters = Math.max(1, input.maxCharacters ?? 500);
  const currentIndex = input.recentMessages.findIndex(
    (item) => item.external_message_id === input.currentMessageId
  );

  // The repository normally already contains the current WhatsApp bubble. If a
  // test double or temporary persistence failure cannot return it, stay
  // conservative and process only the webhook text instead of joining old chat.
  if (currentIndex < 0) return currentMessage;

  const current = input.recentMessages[currentIndex];
  const currentCreatedAt = parseMessageTime(current.created_at);
  const parts: string[] = [];
  for (let index = currentIndex; index >= 0 && parts.length < maxMessages; index -= 1) {
    const item = input.recentMessages[index];
    if (item.role !== "customer") break;

    const itemCreatedAt = parseMessageTime(item.created_at);
    if (
      currentCreatedAt !== null &&
      itemCreatedAt !== null &&
      currentCreatedAt - itemCreatedAt > windowMs
    ) {
      break;
    }

    const content = item.external_message_id === input.currentMessageId
      ? currentMessage
      : normalizeBurstText(item.content || "");
    if (content) parts.unshift(content);
  }

  const merged = normalizeBurstText(parts.join(" "));
  if (!merged) return currentMessage;
  return merged.slice(0, maxCharacters).trim();
}

function normalizeBurstText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function parseMessageTime(value?: string | null) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readDelay() {
  const configured = Number(process.env.UNITV_MESSAGE_BURST_DEBOUNCE_MS || 5000);
  return Number.isFinite(configured) ? Math.max(0, Math.min(configured, 10000)) : 5000;
}
