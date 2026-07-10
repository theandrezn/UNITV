import "server-only";
import { getDailyAuditConfig } from "@/lib/env";
import { buildAuditRecommendations } from "@/lib/unitv/audit-recommendations";
import { excerptAuditText, maskAuditPhone } from "@/lib/unitv/audit-privacy";
import { formatDailyAuditFullReport, formatDailyAuditShortReport } from "@/lib/unitv/audit-report-format";
import { AgentDailyAuditsRepository } from "@/repositories/agent-daily-audits.repository";
import { AgentEventLogsRepository } from "@/repositories/agent-event-logs.repository";
import { ConversationsRepository } from "@/repositories/conversations.repository";
import { MessagesRepository } from "@/repositories/messages.repository";
import { SpecialistTrainingExamplesRepository } from "@/repositories/specialist-training-examples.repository";
import { EvolutionService } from "@/services/evolution/evolution.service";

type DailyAuditDependencies = {
  conversationsRepository?: Pick<ConversationsRepository, "listTouchedBetween">;
  messagesRepository?: Pick<MessagesRepository, "listMessagesBetween">;
  eventLogsRepository?: Pick<AgentEventLogsRepository, "listEventsBetween" | "createEvent">;
  dailyAuditsRepository?: Pick<AgentDailyAuditsRepository, "upsertAudit" | "findByDate" | "findById" | "findPrevious" | "markSent">;
  specialistTrainingExamplesRepository?: Pick<SpecialistTrainingExamplesRepository, "listExamplesBetween">;
  evolutionService?: Pick<EvolutionService, "sendTextMessage">;
  now?: Date;
};

type BuildDailyAgentAuditInput = {
  date?: string | null;
  dryRun?: boolean;
};

type SendDailyAgentAuditInput = {
  auditId: string;
  forceSend?: boolean;
};

const ABANDONED_AFTER_MS = 30 * 60 * 1000;

export class DailyAgentAuditService {
  private readonly conversationsRepository: Pick<ConversationsRepository, "listTouchedBetween">;
  private readonly messagesRepository: Pick<MessagesRepository, "listMessagesBetween">;
  private readonly eventLogsRepository: Pick<AgentEventLogsRepository, "listEventsBetween" | "createEvent">;
  private readonly dailyAuditsRepository: Pick<AgentDailyAuditsRepository, "upsertAudit" | "findByDate" | "findById" | "findPrevious" | "markSent">;
  private readonly specialistTrainingExamplesRepository: Pick<SpecialistTrainingExamplesRepository, "listExamplesBetween">;
  private readonly evolutionService: Pick<EvolutionService, "sendTextMessage">;
  private readonly now: Date;

  constructor(dependencies: DailyAuditDependencies = {}) {
    this.conversationsRepository = dependencies.conversationsRepository || new ConversationsRepository();
    this.messagesRepository = dependencies.messagesRepository || new MessagesRepository();
    this.eventLogsRepository = dependencies.eventLogsRepository || new AgentEventLogsRepository();
    this.dailyAuditsRepository = dependencies.dailyAuditsRepository || new AgentDailyAuditsRepository();
    this.specialistTrainingExamplesRepository =
      dependencies.specialistTrainingExamplesRepository || new SpecialistTrainingExamplesRepository();
    this.evolutionService = dependencies.evolutionService || new EvolutionService();
    this.now = dependencies.now || new Date();
  }

  async buildDailyAgentAudit(input: BuildDailyAgentAuditInput = {}) {
    const config = getDailyAuditConfig();
    const period = resolveAuditPeriod(input.date || undefined, config.timezone, this.now);
    const [conversations, messages, events, specialistExamples, previousAudit, currentAudit] = await Promise.all([
      this.conversationsRepository.listTouchedBetween(period.periodStart, period.periodEnd),
      this.messagesRepository.listMessagesBetween(period.periodStart, period.periodEnd),
      this.eventLogsRepository.listEventsBetween(period.periodStart, period.periodEnd),
      this.specialistTrainingExamplesRepository.listExamplesBetween(period.periodStart, period.periodEnd),
      this.dailyAuditsRepository.findPrevious(period.auditDate, config.timezone),
      this.dailyAuditsRepository.findByDate(period.auditDate, config.timezone)
    ]);

    const audit = buildAuditRecord({
      period,
      timezone: config.timezone,
      conversations,
      messages,
      events,
      specialistExamples,
      previousAudit,
      currentAudit,
      now: this.now
    });

    if (input.dryRun) {
      return audit;
    }

    return this.upsertDailyAudit(audit);
  }

  async upsertDailyAudit(audit: Record<string, unknown>) {
    return this.dailyAuditsRepository.upsertAudit(audit as { audit_date: string; timezone: string } & Record<string, unknown>);
  }

  async sendDailyAgentAuditToAdmin(input: SendDailyAgentAuditInput) {
    const config = getDailyAuditConfig();
    const audit = await this.dailyAuditsRepository.findById(input.auditId);
    if (!audit) {
      throw new Error(`Daily audit not found: ${input.auditId}`);
    }

    if (audit.sent_to_admin && !input.forceSend) {
      return { sent: false, reason: "already_sent", audit };
    }

    const result = await this.evolutionService.sendTextMessage({
      phone: config.adminPhone,
      text: String(audit.short_report || "Auditoria diaria UNITV sem dados.")
    });
    const adminMessageId = extractProviderMessageId(result);
    const updated = await this.dailyAuditsRepository.markSent(String(audit.id), { admin_message_id: adminMessageId });

    await this.safeCreateEvent({
      event_type: "bot_message",
      event_source: "audit_job",
      metadata: { audit_id: audit.id, adminMessageId }
    });

    return { sent: true, result, audit: updated };
  }

  async sendAuditRecordToAdmin(audit: Record<string, unknown>, forceSend = false) {
    const config = getDailyAuditConfig();
    if (audit.sent_to_admin && !forceSend) {
      return { sent: false, reason: "already_sent", audit };
    }

    const result = await this.evolutionService.sendTextMessage({
      phone: config.adminPhone,
      text: String(audit.short_report || "Auditoria diaria UNITV sem dados.")
    });
    const adminMessageId = extractProviderMessageId(result);
    const updated = await this.dailyAuditsRepository.markSent(String(audit.id), { admin_message_id: adminMessageId });
    return { sent: true, result, audit: updated };
  }

  private async safeCreateEvent(input: Parameters<AgentEventLogsRepository["createEvent"]>[0]) {
    try {
      await this.eventLogsRepository.createEvent(input);
    } catch {
      // Audit telemetry cannot break the audit job itself.
    }
  }
}

export function buildAuditRecord(input: {
  period: ReturnType<typeof resolveAuditPeriod>;
  timezone: string;
  conversations: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  specialistExamples: Array<Record<string, unknown>>;
  previousAudit?: Record<string, unknown> | null;
  currentAudit?: Record<string, unknown> | null;
  now: Date;
}) {
  const messagesByConversation = groupBy(input.messages, (message) => String(message.conversation_id || ""));
  const eventsByConversation = groupBy(input.events, (event) => String(event.conversation_id || ""));
  const conversationIds = new Set([
    ...input.conversations.map((conversation) => String(conversation.id || "")),
    ...input.messages.map((message) => String(message.conversation_id || "")),
    ...input.events.map((event) => String(event.conversation_id || ""))
  ].filter(Boolean));

  const totalCustomerMessages = input.messages.filter((message) => message.role === "customer").length;
  const totalBotMessages = input.messages.filter((message) => message.role === "assistant").length;
  const totalSpecialistMessages =
    input.messages.filter((message) => message.role === "human_agent").length +
    input.events.filter((event) => event.event_type === "specialist_message").length;

  const eventCounts = countBy(input.events, (event) => String(event.event_type || ""));
  const objectionsSummary = countValues([
    ...input.events.map((event) => event.objection),
    ...input.conversations.map((conversation) => readLeadProfile(conversation).main_objection || readLeadProfile(conversation).objecao_principal)
  ]);
  const devicesSummary = countValues([
    ...input.events.map((event) => event.device),
    ...input.conversations.map((conversation) => readLeadProfile(conversation).device || readLeadProfile(conversation).aparelho)
  ]);
  const stagesSummary = countValues([
    ...input.events.map((event) => event.stage),
    ...input.conversations.map((conversation) => readLeadProfile(conversation).stage || readLeadProfile(conversation).etapa_atual)
  ]);
  const aiIntentsSummary = countValues(input.events.filter((event) => event.event_type === "ai_called").map((event) => event.intent));
  const humanReasons = countValues([
    ...input.events
      .filter((event) => event.event_type === "human_intervention")
      .map((event) => readMetadata(event).why_specialist_intervened || readMetadata(event).reason),
    ...input.specialistExamples.map((example) => example.why_specialist_intervened)
  ]);

  const problemConversations = buildTopProblemConversations({
    conversations: input.conversations,
    messagesByConversation,
    eventsByConversation,
    now: input.now
  });
  const problemCounts = countProblemTypes(problemConversations);
  const salesConcludedConversationIds = new Set(
    input.events
      .filter((event) => ["converted", "payment_confirmed"].includes(String(event.event_type || "")))
      .map((event) => String(event.conversation_id || ""))
      .filter(Boolean)
  );
  const abandonedConversationIds = new Set([
    ...input.events
      .filter((event) => event.event_type === "customer_abandoned")
      .map((event) => String(event.conversation_id || "")),
    ...problemConversations
      .filter((problem) => /^abandoned_after_/.test(String(problem.problem_key || "")))
      .map((problem) => String(problem.conversation_id || ""))
  ].filter(Boolean));
  const approvedSpecialistExamples = input.specialistExamples.filter((example) => example.review_status === "approved");
  const pendingSpecialistExamples = input.specialistExamples.filter((example) => example.review_status === "pending_review");

  const metrics = {
    audit_date: input.period.auditDate,
    timezone: input.timezone,
    period_start: input.period.periodStart,
    period_end: input.period.periodEnd,
    total_conversations: conversationIds.size,
    total_customer_messages: totalCustomerMessages,
    total_bot_messages: totalBotMessages,
    total_specialist_messages: totalSpecialistMessages,
    total_ai_calls: eventCounts.ai_called || 0,
    total_local_rule_responses: eventCounts.local_rule_used || 0,
    total_human_interventions:
      (eventCounts.human_intervention || 0) + input.specialistExamples.filter((example) => example.human_intervention_detected).length,
    total_repetition_blocks: eventCounts.repetition_blocked || 0,
    total_followups_sent: eventCounts.followup_sent || 0,
    asked_price_count: eventCounts.price_asked || 0,
    asked_download_count: eventCounts.download_asked || 0,
    asked_installation_count: eventCounts.installation_asked || 0,
    asked_test_count: eventCounts.test_asked || 0,
    asked_pix_count: eventCounts.pix_asked || 0,
    selected_plan_count: eventCounts.plan_selected || 0,
    sent_proof_count: eventCounts.proof_sent || 0,
    payment_confirmed_count: eventCounts.payment_confirmed || 0,
    converted_count: eventCounts.converted || 0,
    sales_concluded_count: salesConcludedConversationIds.size,
    customer_abandoned_count: abandonedConversationIds.size,
    human_takeover_count: eventCounts.human_intervention || 0,
    repeated_question_count: eventCounts.repetition_blocked || 0,
    greeting_blocked_count: eventCounts.greeting_blocked || 0,
    download_stuck_count: Math.max(eventCounts.install_stuck || 0, problemCounts.install_stuck || 0),
    followup_cancelled_count: eventCounts.followup_cancelled || 0,
    approved_specialist_examples_count: approvedSpecialistExamples.length,
    pending_specialist_examples_count: pendingSpecialistExamples.length,
    abandoned_after_price_count: problemCounts.abandoned_after_price || 0,
    abandoned_after_download_count: problemCounts.abandoned_after_download || 0,
    abandoned_after_pix_count: problemCounts.abandoned_after_pix || 0,
    stuck_installation_count: (eventCounts.install_stuck || 0) + (problemCounts.install_stuck || 0),
    support_requested_count: eventCounts.support_requested || 0,
    pix_requested_not_paid_count: problemCounts.pix_requested_not_paid || 0,
    objections_summary: objectionsSummary,
    devices_summary: devicesSummary,
    stages_summary: stagesSummary,
    ai_intents_summary: aiIntentsSummary,
    human_intervention_reasons: humanReasons,
    lead_loss_summary: {
      abandoned_after_price: problemCounts.abandoned_after_price || 0,
      abandoned_after_download: problemCounts.abandoned_after_download || 0,
      abandoned_after_pix: problemCounts.abandoned_after_pix || 0,
      customer_abandoned: abandonedConversationIds.size,
      download_stuck: Math.max(eventCounts.install_stuck || 0, problemCounts.install_stuck || 0),
      followup_cancelled: eventCounts.followup_cancelled || 0
    },
    top_problem_conversations: problemConversations.slice(0, 10)
  };

  const recommendations = buildAuditRecommendations(metrics);
  const previousComparison = buildPreviousComparison(metrics, input.previousAudit);
  const reportInput = { ...metrics, recommendations };
  const shortReport = formatDailyAuditShortReport(reportInput);
  const fullReport = formatDailyAuditFullReport({ ...reportInput, previous_comparison: previousComparison });

  return {
    ...metrics,
    recommendations,
    short_report: shortReport,
    full_report: fullReport,
    sent_to_admin: Boolean(input.currentAudit?.sent_to_admin),
    sent_to_admin_at: input.currentAudit?.sent_to_admin_at || null,
    admin_message_id: input.currentAudit?.admin_message_id || null
  };
}

export function resolveAuditPeriod(date: string | undefined, timezone: string, now = new Date()) {
  const localNow = getZonedParts(now, timezone);
  const auditDate = date || (localNow.hour < 6 ? shiftDate(localNow.date, -1) : localNow.date);
  return {
    auditDate,
    periodStart: zonedLocalToUtc(`${auditDate}T00:00:00`, timezone).toISOString(),
    periodEnd: zonedLocalToUtc(`${auditDate}T23:59:59.999`, timezone).toISOString()
  };
}

function buildTopProblemConversations(input: {
  conversations: Array<Record<string, unknown>>;
  messagesByConversation: Map<string, Array<Record<string, unknown>>>;
  eventsByConversation: Map<string, Array<Record<string, unknown>>>;
  now: Date;
}) {
  const problems: Array<Record<string, unknown> & { priority: number; problem_key: string }> = [];
  for (const conversation of input.conversations) {
    const conversationId = String(conversation.id || "");
    const metadata = readConversationMetadata(conversation);
    const leadProfile = readLeadProfile(conversation);
    const messages = input.messagesByConversation.get(conversationId) || [];
    const events = input.eventsByConversation.get(conversationId) || [];
    const lastCustomer = [...messages].reverse().find((message) => message.role === "customer");
    const lastBot = [...messages].reverse().find((message) => message.role === "assistant");
    const lastActivityAt = latestDate([
      conversation.last_message_at,
      conversation.updated_at,
      lastCustomer?.created_at,
      lastBot?.created_at,
      ...events.map((event) => event.created_at)
    ]);
    const converted = events.some((event) => event.event_type === "converted") || ["paid", "code_sent"].includes(String(metadata.order_status || ""));
    const requiresHuman = metadata.requires_human && isRecent(metadata.last_specialist_message_at, input.now, 5 * 60 * 1000);
    const inactive = lastActivityAt ? input.now.getTime() - lastActivityAt.getTime() >= ABANDONED_AFTER_MS : false;
    const eventTypes = new Set(events.map((event) => String(event.event_type || "")));
    const stage = String(leadProfile.stage || leadProfile.etapa_atual || metadata.conversation_stage || "");
    const phone = readConversationPhone(conversation);

    const addProblem = (problemKey: string, priority: number, problem: string, recommendedAction: string) => {
      problems.push({
        priority,
        problem_key: problemKey,
        conversation_id: conversationId,
        phone,
        stage,
        last_intent: leadProfile.ultima_intencao || null,
        plan_interest: leadProfile.selected_plan || leadProfile.plano_interesse || null,
        device: leadProfile.device || leadProfile.aparelho || null,
        main_objection: leadProfile.main_objection || leadProfile.objecao_principal || null,
        last_customer_message: excerptAuditText(lastCustomer?.content),
        last_bot_message: excerptAuditText(lastBot?.content),
        problem,
        recommended_action: recommendedAction
      });
    };

    if (converted || requiresHuman) {
      continue;
    }
    if ((eventTypes.has("pix_asked") || stage === "pagamento_pix" || metadata.followup_key === "pix") && !eventTypes.has("payment_confirmed")) {
      addProblem("pix_requested_not_paid", 100, "pediu Pix e nao pagou", "chamar manualmente e reforcar forma de pagamento");
    }
    if (eventTypes.has("human_intervention")) {
      addProblem("human_intervention", 90, "humano interrompeu", "revisar resposta do especialista");
    }
    if (eventTypes.has("repetition_blocked")) {
      addProblem("repetition_blocked", 80, "repeticao bloqueada", "revisar contexto e resposta proposta");
    }
    if (eventTypes.has("install_stuck") || /instala|download/i.test(stage) && hasDifficulty(messages)) {
      addProblem("install_stuck", 70, "travou na instalacao", "entrar com suporte tecnico");
    }
    if (inactive && (eventTypes.has("price_asked") || leadProfile.asked_price)) {
      addProblem("abandoned_after_price", 50, "sumiu apos valores", "oferecer teste gratis ou melhor custo-beneficio");
    }
    if (inactive && (eventTypes.has("download_asked") || metadata.followup_key === "download")) {
      addProblem("abandoned_after_download", 45, "sumiu apos download", "confirmar se conseguiu instalar");
    }
    if (inactive && (eventTypes.has("pix_asked") || metadata.followup_key === "pix")) {
      addProblem("abandoned_after_pix", 40, "sumiu apos Pix", "confirmar pagamento e remover duvidas");
    }
    if (inactive && leadProfile.wants_test) {
      addProblem("abandoned_after_test", 35, "sumiu apos teste", "retomar liberacao do teste");
    }
  }

  return problems
    .sort((a, b) => b.priority - a.priority)
    .filter((problem, index, list) => list.findIndex((item) => item.phone === problem.phone && item.problem_key === problem.problem_key) === index)
    .map(({ priority: _priority, ...problem }) => problem);
}

function countProblemTypes(problems: Array<Record<string, unknown>>) {
  const counts: Record<string, number> = {};
  for (const problem of problems) {
    const key = String(problem.problem || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, "_");
    if (key.includes("pix_e_nao_pagou")) counts.pix_requested_not_paid = (counts.pix_requested_not_paid || 0) + 1;
    if (key.includes("sumiu_apos_valores")) counts.abandoned_after_price = (counts.abandoned_after_price || 0) + 1;
    if (key.includes("sumiu_apos_download")) counts.abandoned_after_download = (counts.abandoned_after_download || 0) + 1;
    if (key.includes("sumiu_apos_pix")) counts.abandoned_after_pix = (counts.abandoned_after_pix || 0) + 1;
    if (key.includes("travou_na_instalacao")) counts.install_stuck = (counts.install_stuck || 0) + 1;
  }
  return counts;
}

function buildPreviousComparison(metrics: Record<string, unknown>, previousAudit?: Record<string, unknown> | null) {
  if (!previousAudit) {
    return null;
  }
  const changes = [
    compareMetric("Chamadas de IA", Number(metrics.total_ai_calls || 0), Number(previousAudit.total_ai_calls || 0)),
    compareMetric("Conversoes", Number(metrics.converted_count || 0), Number(previousAudit.converted_count || 0)),
    compareMetric("Pix sem pagamento", Number(metrics.pix_requested_not_paid_count || 0), Number(previousAudit.pix_requested_not_paid_count || 0))
  ].filter(Boolean);
  return changes.length ? changes.join(" ") : "sem variacao relevante.";
}

function compareMetric(label: string, current: number, previous: number) {
  if (previous === current) return null;
  if (previous === 0) return `${label}: ${current} hoje contra 0 ontem.`;
  const percentage = Math.round(((current - previous) / previous) * 100);
  return `${label}: ${percentage > 0 ? "subiu" : "caiu"} ${Math.abs(percentage)}%.`;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) || []), item]);
  }
  return grouped;
}

function countBy(items: Array<Record<string, unknown>>, keyFn: (item: Record<string, unknown>) => string) {
  const output: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (key) output[key] = (output[key] || 0) + 1;
  }
  return output;
}

function countValues(values: unknown[]) {
  const output: Record<string, number> = {};
  for (const value of values) {
    const key = typeof value === "string" && value.trim() ? value.trim() : "";
    if (key && key !== "unknown") output[key] = (output[key] || 0) + 1;
  }
  return output;
}

function readConversationMetadata(conversation: Record<string, unknown>) {
  return conversation.metadata && typeof conversation.metadata === "object" && !Array.isArray(conversation.metadata)
    ? conversation.metadata as Record<string, unknown>
    : {};
}

function readLeadProfile(conversation: Record<string, unknown>) {
  const metadata = readConversationMetadata(conversation);
  const profile = metadata.lead_profile;
  return profile && typeof profile === "object" && !Array.isArray(profile) ? profile as Record<string, unknown> : {};
}

function readMetadata(row: Record<string, unknown>) {
  return row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};
}

function readConversationPhone(conversation: Record<string, unknown>) {
  const customers = conversation.customers;
  if (customers && typeof customers === "object" && !Array.isArray(customers)) {
    const phone = (customers as Record<string, unknown>).phone;
    if (typeof phone === "string") return phone;
  }
  return String(conversation.external_conversation_id || "").split("@")[0];
}

function latestDate(values: unknown[]) {
  const timestamps = values
    .map((value) => typeof value === "string" ? new Date(value).getTime() : 0)
    .filter((value) => Number.isFinite(value) && value > 0);
  return timestamps.length ? new Date(Math.max(...timestamps)) : null;
}

function isRecent(value: unknown, now: Date, windowMs: number) {
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && now.getTime() - date.getTime() < windowMs;
}

function hasDifficulty(messages: Array<Record<string, unknown>>) {
  return messages.some((message) => {
    if (message.role !== "customer" || typeof message.content !== "string") return false;
    return /\b(erro|nao consigo|nao baixa|nao abre|travou|nao instala|link nao funciona)\b/i.test(message.content);
  });
}

function getZonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour || 0)
  };
}

function shiftDate(date: string, deltaDays: number) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return shifted.toISOString().slice(0, 10);
}

function zonedLocalToUtc(localIso: string, timezone: string) {
  const [date, time] = localIso.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, secondWithMs] = time.split(":");
  const [second, millisecond = "0"] = secondWithMs.split(".");
  const desiredUtc = Date.UTC(year, month - 1, day, Number(hour), Number(minute), Number(second), Number(millisecond.padEnd(3, "0")));
  const formatted = getZonedDateTimeParts(new Date(desiredUtc), timezone);
  const formattedAsUtc = Date.UTC(
    formatted.year,
    formatted.month - 1,
    formatted.day,
    formatted.hour,
    formatted.minute,
    formatted.second,
    formatted.millisecond
  );
  return new Date(desiredUtc + (desiredUtc - formattedAsUtc));
}

function getZonedDateTimeParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    millisecond: date.getUTCMilliseconds()
  };
}

function extractProviderMessageId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["id", "messageId", "message_id"]) {
    if (typeof record[key] === "string") {
      return record[key];
    }
  }
  return null;
}
