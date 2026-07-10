type PendingBurst = { token: symbol };

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

function readDelay() {
  const configured = Number(process.env.UNITV_MESSAGE_BURST_DEBOUNCE_MS || 1200);
  return Number.isFinite(configured) ? Math.max(0, Math.min(configured, 5000)) : 1200;
}
