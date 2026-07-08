import "server-only";
import { getHotLeadAlertConfig } from "@/lib/env";
import { buildHotLeadAdminMessage } from "@/lib/unitv/hot-lead-admin-message";
import {
  detectHotLeadSignal,
  isHotLeadTemperatureAllowed,
  type HotLeadSignal
} from "@/lib/unitv/hot-lead-rules";
import { excerptAuditText, maskAuditText } from "@/lib/unitv/audit-privacy";
import { ConversationsRepository } from "@/repositories/conversations.repository";
import {
  LeadHotAlertsRepository,
  type LeadHotAlertType
} from "@/repositories/lead-hot-alerts.repository";
import { AgentEventLogService } from "@/services/audit/agent-event-log.service";
import { EvolutionService } from "@/services/evolution/evolution.service";

type HotLeadContext = {
  conversation: { id: string; metadata?: Record<string, unknown> | null };
  customer: { phone?: string | null; name?: string | null };
  message: {
    text: string;
    externalMessageId?: string | null;
    hasMedia?: boolean;
    fromMe?: boolean;
  };
  intent?: string | null;
  recentMessages?: Array<{ role?: string; content?: string | null }>;
  leadProfile?: Record<string, unknown>;
};

export class HotLeadAlertService {
  constructor(
    private readonly alertsRepository = new LeadHotAlertsRepository(),
    private readonly conversationsRepository = new ConversationsRepository(),
    private readonly evolutionService = new EvolutionService(),
    private readonly agentEventLogService = new AgentEventLogService()
  ) {}

  detectHotLeadSignal(context: HotLeadContext) {
    return detectHotLeadSignal({
      message: context.message.text,
      intent: context.intent,
      leadProfile: context.leadProfile || readLeadProfile(context.conversation.metadata),
      stage: readStage(context.leadProfile || readLeadProfile(context.conversation.metadata), context.conversation.metadata),
      hasMedia: context.message.hasMedia,
      recentMessages: context.recentMessages
    });
  }

  async maybeNotifyHotLead(context: HotLeadContext) {
    try {
      const config = getHotLeadAlertConfig();
      if (!config.enabled || context.message.fromMe) {
        return null;
      }

      const leadProfile = context.leadProfile || readLeadProfile(context.conversation.metadata);
      const signal = this.detectHotLeadSignal({ ...context, leadProfile });
      if (!signal || signal.priority < 3 || !isHotLeadTemperatureAllowed(signal.lead_temperature, config.minTemperature)) {
        return null;
      }

      if (isConverted(leadProfile) && signal.alert_type !== "proof_sent") {
        return null;
      }
      if (isRecentHumanActivity(context.conversation.metadata) && signal.alert_type !== "proof_sent") {
        return null;
      }

      await this.agentEventLogService.safeCreateEvent({
        conversation_id: context.conversation.id,
        customer_phone: context.customer.phone || null,
        event_type: "hot_lead_detected",
        event_source: "chat_agent",
        intent: context.intent || null,
        stage: readStage(leadProfile, context.conversation.metadata),
        device: readString(leadProfile.device || leadProfile.aparelho),
        plan_interest: readString(leadProfile.selected_plan || leadProfile.plano_interesse),
        metadata: { alert_type: signal.alert_type, temperature: signal.lead_temperature, priority: signal.priority }
      });

      const shouldDedupe = signal.alert_type !== "proof_sent";
      if (shouldDedupe) {
        const customerPhone = readPhone(context.customer.phone);
        const recentByPhone = customerPhone
          ? await this.alertsRepository.findRecentAlertByPhone(
              customerPhone,
              new Date(Date.now() - config.dedupeMinutes * 60 * 1000).toISOString()
            )
          : null;
        if (recentByPhone) {
          await this.agentEventLogService.safeCreateEvent({
            conversation_id: context.conversation.id,
            customer_phone: context.customer.phone || null,
            event_type: "hot_lead_alert_deduped",
            event_source: "chat_agent",
            intent: context.intent || null,
            stage: readStage(leadProfile, context.conversation.metadata),
            metadata: {
              reason: "recent_alert_same_phone",
              existing_alert_id: recentByPhone.id,
              existing_alert_type: recentByPhone.alert_type,
              new_alert_type: signal.alert_type,
              dedupe_minutes: config.dedupeMinutes
            }
          });
          return null;
        }

        const recent = await this.alertsRepository.findRecentAlert(
          context.conversation.id,
          signal.alert_type,
          new Date(Date.now() - config.dedupeMinutes * 60 * 1000).toISOString()
        );
        if (recent && !(recent.lead_temperature === "quente" && signal.lead_temperature === "muito_quente")) {
          return null;
        }
      }

      const alert = await this.createHotLeadAlert(context, signal, config.format);
      if (!alert) {
        return null;
      }

      await this.updateLeadProfile(context, signal);
      await this.sendHotLeadAlertToAdmin(alert, signal);
      return alert;
    } catch {
      return null;
    }
  }

  async createHotLeadAlert(context: HotLeadContext, signal: HotLeadSignal, format: "full" | "compact" = "full") {
    const leadProfile = context.leadProfile || readLeadProfile(context.conversation.metadata);
    const lastBotMessage = findLastMessage(context.recentMessages, "assistant");
    const customerPhone = readPhone(context.customer.phone);
    const adminMessage = buildHotLeadAdminMessage({
      signal,
      customerPhone,
      customerName: context.customer.name || null,
      planInterest: readString(leadProfile.selected_plan || leadProfile.plano_interesse),
      device: readString(leadProfile.device || leadProfile.aparelho),
      stage: readStage(leadProfile, context.conversation.metadata),
      mainObjection: readString(leadProfile.main_objection || leadProfile.objecao_principal),
      lastCustomerMessage: context.message.text,
      lastBotMessage,
      format
    });

    return this.alertsRepository.createAlert({
      conversation_id: context.conversation.id,
      customer_phone: customerPhone,
      customer_name: context.customer.name || null,
      alert_type: signal.alert_type,
      lead_temperature: signal.lead_temperature,
      trigger_message: excerptAuditText(maskAuditText(context.message.text), 300),
      trigger_intent: context.intent || null,
      trigger_stage: readStage(leadProfile, context.conversation.metadata),
      plan_interest: readString(leadProfile.selected_plan || leadProfile.plano_interesse),
      device: readString(leadProfile.device || leadProfile.aparelho),
      main_objection: readString(leadProfile.main_objection || leadProfile.objecao_principal),
      last_customer_message: excerptAuditText(maskAuditText(context.message.text), 300),
      last_bot_message: excerptAuditText(maskAuditText(lastBotMessage), 300),
      next_best_action: signal.next_best_action,
      admin_message: adminMessage,
      dedupe_key: buildDedupeKey(
        context.conversation.id,
        customerPhone,
        signal.alert_type,
        context.message.externalMessageId
      ),
      metadata: {
        reason: signal.reason,
        priority: signal.priority,
        externalMessageId: context.message.externalMessageId || null
      }
    });
  }

  async sendHotLeadAlertToAdmin(alert: Record<string, unknown>, signal?: HotLeadSignal) {
    const config = getHotLeadAlertConfig();
    try {
      const result = await this.evolutionService.sendTextMessage({
        phone: config.adminPhone,
        text: String(alert.admin_message || "Lead quente UNITV")
      });
      const adminMessageId = extractProviderMessageId(result);
      const updated = await this.alertsRepository.markSent(String(alert.id), adminMessageId);
      await this.agentEventLogService.safeCreateEvent({
        conversation_id: String(alert.conversation_id),
        customer_phone: String(alert.customer_phone || ""),
        event_type: "hot_lead_alert_sent",
        event_source: "chat_agent",
        metadata: { alert_id: alert.id, alert_type: alert.alert_type, temperature: signal?.lead_temperature || alert.lead_temperature }
      });
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      await this.alertsRepository.markFailed(String(alert.id), message, Number(alert.send_attempts || 0));
      await this.agentEventLogService.safeCreateEvent({
        conversation_id: String(alert.conversation_id),
        customer_phone: String(alert.customer_phone || ""),
        event_type: "hot_lead_alert_failed",
        event_source: "chat_agent",
        metadata: { alert_id: alert.id, error: message }
      });
      return null;
    }
  }

  private async updateLeadProfile(context: HotLeadContext, signal: HotLeadSignal) {
    const current = readLeadProfile(context.conversation.metadata);
    const nextMetadata = {
      ...(context.conversation.metadata || {}),
      lead_profile: {
        ...current,
        lead_temperature: signal.lead_temperature,
        hot_lead: true,
        last_hot_alert_type: signal.alert_type,
        last_hot_alert_at: new Date().toISOString(),
        last_hot_alert_reason: signal.reason,
        next_best_action: signal.next_best_action,
        proxima_acao: signal.next_best_action,
        updated_at: new Date().toISOString()
      }
    };
    await this.conversationsRepository.updateConversationMetadata(context.conversation.id, nextMetadata);
    context.conversation.metadata = nextMetadata;
  }
}

function buildDedupeKey(
  conversationId: string,
  customerPhone: string,
  alertType: LeadHotAlertType,
  messageId?: string | null
) {
  if (alertType === "proof_sent" && messageId) {
    return `${conversationId}:${alertType}:${messageId}`;
  }
  const bucket = Math.floor(Date.now() / (30 * 60 * 1000));
  return `${customerPhone || conversationId}:hot_lead:${bucket}`;
}

function readLeadProfile(metadata: Record<string, unknown> | null | undefined) {
  const profile = metadata?.lead_profile;
  return profile && typeof profile === "object" && !Array.isArray(profile) ? profile as Record<string, unknown> : {};
}

function readStage(profile: Record<string, unknown>, metadata: Record<string, unknown> | null | undefined) {
  return readString(profile.stage || profile.etapa_atual || metadata?.conversation_stage) || null;
}

function findLastMessage(messages: Array<{ role?: string; content?: string | null }> | undefined, role: string) {
  return [...(messages || [])].reverse().find((message) => message.role === role && typeof message.content === "string")?.content || null;
}

function readPhone(phone: unknown) {
  return typeof phone === "string" ? phone.replace(/\D/g, "") : "";
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isConverted(profile: Record<string, unknown>) {
  return profile.payment_status === "confirmed" || profile.order_status === "code_sent" || profile.converted === true;
}

function isRecentHumanActivity(metadata: Record<string, unknown> | null | undefined, now = new Date()) {
  const value = metadata?.last_specialist_message_at;
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && now.getTime() - date.getTime() < 5 * 60 * 1000;
}

function extractProviderMessageId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["id", "messageId", "message_id"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return null;
}
