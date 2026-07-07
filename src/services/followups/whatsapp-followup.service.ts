import "server-only";
import { randomUUID } from "node:crypto";
import { ConversationsRepository } from "@/repositories/conversations.repository";
import { MessagesRepository } from "@/repositories/messages.repository";
import { EvolutionService } from "@/services/evolution/evolution.service";
import { AuditService } from "@/services/audit.service";
import { AgentEventLogService } from "@/services/audit/agent-event-log.service";

const MAX_FOLLOWUP_COUNT_PER_STAGE = 1;
const MAX_LEAD_RECOVERY_FOLLOWUPS = 4;
const HUMAN_SILENCE_WINDOW_MS = 5 * 60 * 1000;
const SPECIAL_PROMO_OFFER_ID = "mensal_19_99_first_2_months";
const LEAD_RECOVERY_DELAYS_AFTER_SEND_MS = [
  45 * 60 * 1000,
  4 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000
];

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
    private readonly auditService = new AuditService(),
    private readonly agentEventLogService?: AgentEventLogService
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

      const leadRecovery = getLeadRecoveryFollowup(metadata);
      const stageId = leadRecovery
        ? leadRecovery.stageId
        : String(metadata.last_followup_stage_id || randomUUID());
      const promoRecovery = !leadRecovery && shouldSendPromoRecoveryFollowup(metadata);
      const followupText = leadRecovery
        ? buildLeadRecoveryFollowupText(leadRecovery.step, metadata, conversation)
        : promoRecovery
          ? buildPromoRecoveryFollowupText(metadata, conversation)
          : buildFollowupText(metadata);
      const sendResult = await this.evolutionService.sendTextMessage({ phone, text: followupText });
      const leadProfile = readLeadProfile(metadata);
      const nextLeadRecoveryDueAt = leadRecovery ? getNextLeadRecoveryDueAt(leadRecovery.step, now) : null;
      const sentSpecialOffer = promoRecovery || (leadRecovery && [2, 4].includes(leadRecovery.step));
      const nextMetadata = {
        ...metadata,
        followup_due_at: nextLeadRecoveryDueAt,
        followup_sent_at: now.toISOString(),
        followup_sent_stage_id: stageId,
        followup_count: Number(metadata.followup_count || 0) + 1,
        last_followup_stage_id: leadRecovery && nextLeadRecoveryDueAt
          ? `${leadRecovery.baseStageId}:recovery:${leadRecovery.step + 1}`
          : stageId,
        last_bot_message_at: now.toISOString(),
        ...(leadRecovery
          ? {
              lead_recovery_followup_step: leadRecovery.step,
              lead_recovery_followup_last_sent_at: now.toISOString(),
              lead_recovery_followup_completed: leadRecovery.step >= MAX_LEAD_RECOVERY_FOLLOWUPS,
              lead_recovery_followup_base_stage_id: leadRecovery.baseStageId
            }
          : {}),
        ...(sentSpecialOffer
          ? {
              promo_followup_sent_at: now.toISOString(),
              promo_followup_stage_id: stageId,
              lead_profile: {
                ...leadProfile,
                special_promo_followup_sent: true,
                special_promo_followup_sent_at: now.toISOString(),
                special_promo_offer: SPECIAL_PROMO_OFFER_ID,
                next_best_action: "cliente_confirmar_promocao_para_receber_pix",
                proxima_acao: "cliente confirmar promocao para receber Pix"
              }
            }
          : {})
      };

      await this.messagesRepository.createMessage({
        conversation_id: conversation.id,
        customer_id: conversation.customer_id || conversation.customers?.id || null,
        role: "assistant",
        content: followupText,
        content_type: "text",
        external_message_id: `followup:${conversation.id}:${stageId}`,
        metadata: {
          sendResult,
          followup_key: metadata.followup_key,
          stageId,
          promo_recovery: promoRecovery,
          lead_recovery_step: leadRecovery?.step || null
        }
      });
      await this.conversationsRepository.updateConversationMetadata(conversation.id, nextMetadata);
      await this.conversationsRepository.touchConversation(conversation.id, now.toISOString());
      await this.auditService.createAuditLog({
        actor_type: "system",
        action: "whatsapp_followup_sent",
        entity_type: "conversations",
        entity_id: conversation.id,
        metadata: {
          followup_key: metadata.followup_key,
          stageId,
          sendResult,
          promo_recovery: promoRecovery,
          lead_recovery_step: leadRecovery?.step || null
        }
      });
      await this.safeCreateAgentEvent({
        conversation_id: conversation.id,
        customer_phone: phone,
        event_type: "followup_sent",
        event_source: "followup_job",
        stage: typeof metadata.conversation_stage === "string" ? metadata.conversation_stage : null,
        device: typeof metadata.device === "string" ? metadata.device : null,
        plan_interest: typeof metadata.plan_interest === "string" ? metadata.plan_interest : null,
        message_id: `followup:${conversation.id}:${stageId}`,
        metadata: {
          followup_key: metadata.followup_key,
          followup_count: nextMetadata.followup_count,
          stageId,
          promo_recovery: promoRecovery,
          lead_recovery_step: leadRecovery?.step || null
        }
      });

      sent++;
    }

    return { checked: conversations.length, sent, skipped };
  }

  private safeCreateAgentEvent(input: Parameters<AgentEventLogService["safeCreateEvent"]>[0]) {
    try {
      return (this.agentEventLogService || new AgentEventLogService()).safeCreateEvent(input);
    } catch {
      return null;
    }
  }
}

export function getLeadRecoveryFollowup(metadata: Record<string, unknown>) {
  if (!shouldUseLeadRecoverySequence(metadata)) {
    return null;
  }

  const nextStep = Number(metadata.lead_recovery_followup_step || 0) + 1;
  if (nextStep < 1 || nextStep > MAX_LEAD_RECOVERY_FOLLOWUPS) {
    return null;
  }

  const baseStageId = String(metadata.lead_recovery_followup_base_stage_id || metadata.last_followup_stage_id || randomUUID());
  return {
    step: nextStep,
    baseStageId,
    stageId: `${baseStageId}:recovery:${nextStep}`
  };
}

export function shouldUseLeadRecoverySequence(metadata: Record<string, unknown>) {
  const key = String(metadata.followup_key || "");
  if (!["welcome_activation", "plan_choice"].includes(key)) {
    return false;
  }

  if (metadata.lead_recovery_followup_completed) {
    return false;
  }

  const profile = readLeadProfile(metadata);
  if (
    profile.selected_plan ||
    profile.plano_interesse ||
    metadata.plan_interest ||
    profile.pediu_pix ||
    profile.payment_status === "paid" ||
    profile.payment_status === "confirmed" ||
    profile.codigo_enviado === true
  ) {
    return false;
  }

  return true;
}

export function buildLeadRecoveryFollowupText(
  step: number,
  metadata: Record<string, unknown>,
  conversation?: Pick<ConversationRow, "customers">
) {
  const firstName = readFirstName(conversation?.customers?.name || readLeadProfile(metadata).nome);
  const namePrefix = firstName ? `${firstName}, ` : "";

  if (step === 1) {
    return [
      firstName ? `${namePrefix}só pra eu te ajudar melhor:` : "Só pra eu te ajudar melhor:",
      "Você teria interesse em algum plano UNITV hoje? ✅"
    ].join("\n\n");
  }

  if (step === 2) {
    return [
      firstName ? `${namePrefix}consigo uma condição especial pra você hoje.` : "Consigo uma condição especial pra você hoje.",
      "O mensal é R$ 25, mas pra você começar agora consigo liberar por R$ 19,99.",
      "Se quiser, me confirma aqui que já te explico como ativar ✅"
    ].join("\n\n");
  }

  if (step === 3) {
    return [
      "Com a UNITV você já fica com filmes, séries e canais em um só lugar ✅",
      "A ativação é rápida e eu te ajudo por aqui mesmo.",
      "Quer que eu deixe seu acesso encaminhado hoje?"
    ].join("\n\n");
  }

  return [
    firstName ? `Oi, ${firstName} ✅` : "Oi ✅",
    "Ainda quer aproveitar a condição especial da UNITV?",
    "Consigo deixar o mensal por R$ 19,99 pra você começar, mas essa condição é só pra fechar hoje."
  ].join("\n\n");
}

export function shouldSendPromoRecoveryFollowup(metadata: Record<string, unknown>) {
  const key = String(metadata.followup_key || "");
  if (key !== "payment_choice") {
    return false;
  }

  const profile = readLeadProfile(metadata);
  if (metadata.promo_followup_sent_at || profile.special_promo_followup_sent) {
    return false;
  }

  if (
    profile.payment_status === "confirmed" ||
    profile.payment_status === "paid" ||
    profile.order_status === "paid" ||
    profile.codigo_enviado === true ||
    profile.converted === true
  ) {
    return false;
  }

  return Boolean(
    profile.nivel_interesse === "quente" ||
      profile.nivel_interesse === "muito_quente" ||
      profile.pediu_pix ||
      profile.wants_activation ||
      profile.wants_recharge ||
      profile.selected_plan ||
      profile.plano_interesse ||
      metadata.plan_interest
  );
}

export function buildPromoRecoveryFollowupText(
  metadata: Record<string, unknown>,
  conversation?: Pick<ConversationRow, "customers">
) {
  const firstName = readFirstName(conversation?.customers?.name || readLeadProfile(metadata).nome);
  const prefix = firstName ? `${firstName}, consigo` : "Consigo";
  return [
    `${prefix} fazer uma condição especial pra você começar hoje.`,
    "Pra ter você como nosso cliente, libero os 2 primeiros meses por R$ 19,99 cada.",
    "Se quiser aproveitar, me confirma aqui que já te mando a chave PIX e deixo sua ativação pronta ✅"
  ].join("\n\n");
}

export function buildFollowupText(metadata: Record<string, unknown>) {
  const key = String(metadata.followup_key || "generic");
  const device = String(metadata.device || "");
  const profile = readLeadProfile(metadata);

  if (key === "welcome_activation") {
    return "Você quer que eu te passe os valores ou prefere fazer o teste grátis de 3 dias?";
  }

  if (key === "values") {
    if (isRenewalFollowup(metadata, profile)) {
      return "Você se interessou pelos valores? Posso te indicar o melhor plano pra renovar ✅";
    }
    return "Você se interessou pelos valores? Posso te indicar o melhor plano pra começar ✅";
  }

  if (key === "plan_choice") {
    return "Conseguiu escolher o plano? O mensal é R$ 25 para começar, e o anual é o melhor custo-benefício. Qual você prefere?";
  }

  if (key === "payment_choice") {
    return "Fechado ✅ Vou te passar a chave PIX agora. Assim que fizer o pagamento, me envia o comprovante por aqui que já libero sua recarga.";
  }

  if (key === "download" || key === "install") {
    if (/android_phone|celular/i.test(device)) {
      return "Conseguiu baixar no celular Android? Se aparecer aviso de segurança, me fala que eu te oriento?";
    }
    if (/tvbox_android|tv box/i.test(device)) {
      return "Conseguiu instalar na TV Box? Se travou, me diga se foi no link APK ou no Downloader?";
    }
    if (/android_tv_google_tv|android tv|google tv/i.test(device)) {
      return "Conseguiu encontrar o Downloader na Play Store da TV?";
    }
    if (/firestick|fire stick/i.test(device)) {
      return "Conseguiu abrir o Downloader no Fire Stick e digitar o código 8322904?";
    }
    return "Conseguiu confirmar se seu aparelho tem Android ou Play Store?";
  }

  if (key === "test") {
    return "Você conseguiu instalar o app para liberar o teste grátis de 3 dias?";
  }

  if (key === "pix") {
    return "Conseguiu fazer o pagamento? Assim que enviar o comprovante por aqui, eu já valido e libero sua recarga ✅";
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

  const maxFollowups = shouldUseLeadRecoverySequence(metadata) ? MAX_LEAD_RECOVERY_FOLLOWUPS : MAX_FOLLOWUP_COUNT_PER_STAGE;
  if (Number(metadata.followup_count || 0) >= maxFollowups) {
    return "followup_limit_reached";
  }

  return null;
}

function readCustomerPhone(conversation: ConversationRow) {
  const phone = conversation.customers?.phone || conversation.external_conversation_id || "";
  return phone.split("@")[0]?.replace(/\D/g, "") || null;
}

function getNextLeadRecoveryDueAt(step: number, now: Date) {
  const delay = LEAD_RECOVERY_DELAYS_AFTER_SEND_MS[step - 1];
  if (!delay) {
    return null;
  }
  return new Date(now.getTime() + delay).toISOString();
}

function readLeadProfile(metadata: Record<string, unknown> | null | undefined) {
  const profile = metadata?.lead_profile;
  return profile && typeof profile === "object" && !Array.isArray(profile) ? (profile as Record<string, unknown>) : {};
}

function isRenewalFollowup(metadata: Record<string, unknown>, profile: Record<string, unknown>) {
  return Boolean(
    profile.wants_recharge ||
      profile.wants_renewal ||
      profile.renovacao ||
      profile.ultima_intencao === "renew_plan" ||
      metadata.conversation_stage === "recarga" ||
      metadata.awaiting_customer_action === "renew_plan"
  );
}

function readFirstName(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  const firstName = value.trim().split(/\s+/)[0] || "";
  return firstName.replace(/[^\p{L}'-]/gu, "");
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
