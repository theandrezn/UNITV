import "server-only";
import { randomUUID } from "node:crypto";
import { ConversationsRepository } from "@/repositories/conversations.repository";
import { MessagesRepository } from "@/repositories/messages.repository";
import { EvolutionService } from "@/services/evolution/evolution.service";
import { AuditService } from "@/services/audit.service";

const MAX_FOLLOWUP_COUNT_PER_STAGE = 1;
const HUMAN_SILENCE_WINDOW_MS = 5 * 60 * 1000;

type ConversationRow = {
  id: string;
  customer_id?: string | null;
  external_conversation_id?: string | null;
  metadata?: Record<string, unknown> | null;
  customers?: { id?: string; phone?: string | null; name?: string | null } | null;
};

type FollowupResult = {
  checked: number;
  sent: number;
  skipped: number;
};

export class WhatsappFollowupService {
  constructor(
    private readonly conversationsRepository = new ConversationsRepository(),
    private readonly messagesRepository = new MessagesRepository(),
    private readonly evolutionService = new EvolutionService(),
    private readonly auditService = new AuditService()
  ) {}

  async processDueFollowups(now = new Date()): Promise<FollowupResult> {
    const conversations = (await this.conversationsRepository.listOpenConversations(200)) as ConversationRow[];
    let sent = 0;
    let skipped = 0;

    for (const conversation of conversations) {
      const metadata = conversation.metadata || {};
      if (!isDue(metadata.followup_due_at, now)) {
        continue;
      }

      const skipReason = getSkipReason(metadata, now);
      if (skipReason) {
        skipped++;
        await this.auditService.createAuditLog({
          actor_type: "system",
          action: "whatsapp_followup_skipped",
          entity_type: "conversations",
          entity_id: conversation.id,
          metadata: { reason: skipReason, followup_due_at: metadata.followup_due_at }
        });
        continue;
      }

      const phone = readCustomerPhone(conversation);
      if (!phone) {
        skipped++;
        continue;
      }

      const stageId = String(metadata.last_followup_stage_id || randomUUID());
      const followupText = buildFollowupText(metadata);
      const sendResult = await this.evolutionService.sendTextMessage({ phone, text: followupText });
      const nextMetadata = {
        ...metadata,
        followup_due_at: null,
        followup_sent_at: now.toISOString(),
        followup_sent_stage_id: stageId,
        followup_count: Number(metadata.followup_count || 0) + 1,
        last_followup_stage_id: stageId
      };

      await this.messagesRepository.createMessage({
        conversation_id: conversation.id,
        customer_id: conversation.customer_id || conversation.customers?.id || null,
        role: "assistant",
        content: followupText,
        content_type: "text",
        external_message_id: `followup:${conversation.id}:${stageId}`,
        metadata: { sendResult, followup_key: metadata.followup_key, stageId }
      });
      await this.conversationsRepository.updateConversationMetadata(conversation.id, nextMetadata);
      await this.conversationsRepository.touchConversation(conversation.id, now.toISOString());
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: "whatsapp_followup_sent",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: { followup_key: metadata.followup_key, stageId, sendResult }
      });

      sent++;
    }

    return { checked: conversations.length, sent, skipped };
  }
}

export function buildFollowupText(metadata: Record<string, unknown>) {
  const key = String(metadata.followup_key || "generic");
  const planInterest = formatPlanInterest(metadata.plan_interest);
  const device = String(metadata.device || "");

  if (key === "welcome_activation") {
    return "Você quer que eu te passe os valores ou prefere fazer o teste grátis de 3 dias?";
  }

  if (key === "values") {
    if (planInterest) {
      return `Você quer seguir com o plano ${planInterest} ou prefere fazer o teste grátis de 3 dias primeiro?`;
    }
    return "Você se interessou pelos valores? Posso te indicar o melhor plano para começar?";
  }

  if (key === "plan_choice") {
    return "Conseguiu escolher o plano? O mensal é R$ 25 para começar, e o anual é o melhor custo-benefício. Qual você prefere?";
  }

  if (key === "download") {
    if (/celular/i.test(device)) {
      return "Conseguiu fazer o download no celular? Se travou em alguma etapa, me fala onde parou que eu te ajudo?";
    }
    if (/tv box|android tv/i.test(device)) {
      return "Conseguiu fazer o download na TV Box? Se travou em alguma etapa, me fala onde parou que eu te ajudo?";
    }
    return "Conseguiu fazer o download? Se travou em alguma etapa, me fala onde parou que eu te ajudo?";
  }

  if (key === "install") {
    return "Conseguiu instalar? Se travou em alguma etapa, me fala qual apareceu?";
  }

  if (key === "test") {
    return "Você conseguiu instalar o app para liberar o teste grátis de 3 dias?";
  }

  if (key === "pix") {
    return "Conseguiu fazer o pagamento? Depois você consegue enviar o comprovante aqui para validar?";
  }

  if (key === "proof") {
    return "Pode me enviar o comprovante por aqui? Assim consigo encaminhar para validação.";
  }

  if (key === "screens") {
    return "Você quer usar em quantos aparelhos ao mesmo tempo?";
  }

  if (key === "support") {
    return "Ainda precisa de ajuda? Me mande o erro ou o aparelho que está usando?";
  }

  return "Você ainda precisa de ajuda com valores, download ou ativação?";
}

function isDue(value: unknown, now: Date) {
  if (typeof value !== "string" || !value) {
    return false;
  }
  const dueAt = new Date(value);
  return !Number.isNaN(dueAt.getTime()) && dueAt.getTime() <= now.getTime();
}

function getSkipReason(metadata: Record<string, unknown>, now: Date) {
  if (metadata.requires_human && isRecentDate(metadata.last_specialist_message_at, now, HUMAN_SILENCE_WINDOW_MS)) {
    return "human_takeover_recent";
  }

  if (isAfter(metadata.last_customer_message_at, metadata.last_bot_message_at)) {
    return "customer_replied";
  }

  if (metadata.followup_sent_at && metadata.followup_sent_stage_id === metadata.last_followup_stage_id) {
    return "already_sent_for_stage";
  }

  if (Number(metadata.followup_count || 0) >= MAX_FOLLOWUP_COUNT_PER_STAGE) {
    return "followup_limit_reached";
  }

  return null;
}

function readCustomerPhone(conversation: ConversationRow) {
  const phone = conversation.customers?.phone || conversation.external_conversation_id || "";
  return phone.split("@")[0]?.replace(/\D/g, "") || null;
}

function formatPlanInterest(value: unknown) {
  if (typeof value !== "string" || !value || value === "unknown") {
    return "";
  }
  return value.replace(/_/g, " ");
}

function isRecentDate(value: unknown, now: Date, windowMs: number) {
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && now.getTime() - date.getTime() < windowMs;
}

function isAfter(left: unknown, right: unknown) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const leftDate = new Date(left);
  const rightDate = new Date(right);
  return !Number.isNaN(leftDate.getTime()) && !Number.isNaN(rightDate.getTime()) && leftDate > rightDate;
}
