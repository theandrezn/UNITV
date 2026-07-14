import "server-only";
import { createHash } from "node:crypto";
import type { ConversationAgentAction, AgentActionKind } from "./conversation-brain.service";
import { AgentShadowDecisionsRepository } from "@/repositories/agent-shadow-decisions.repository";

type LegacyCandidate = {
  reply?: string | null;
  requiresHuman?: boolean;
  copyText?: string;
  media?: unknown;
  responseRule?: string;
  leadProfilePatch?: Record<string, unknown>;
};

export class ShadowDecisionService {
  constructor(private readonly repository = new AgentShadowDecisionsRepository()) {}

  async compareReply(input: {
    conversationId: string;
    messageId: string;
    currentState: string;
    legacyCandidate: LegacyCandidate;
    unifiedAction: ConversationAgentAction;
  }) {
    const activeAction = inferLegacyAction(input.legacyCandidate);
    const activeState = String(
      input.legacyCandidate.leadProfilePatch?.stage ||
      input.legacyCandidate.leadProfilePatch?.commercial_stage ||
      input.currentState
    );
    const divergences = detectDivergences({
      activeAction,
      shadowAction: input.unifiedAction.action,
      activeState,
      shadowState: input.unifiedAction.next_state,
      activeReply: input.legacyCandidate.reply || null,
      currentState: input.currentState
    });
    return this.repository.upsertDecision({
      conversation_id: input.conversationId,
      message_id: input.messageId,
      decision_key: hashKey(["reply", input.conversationId, input.messageId]),
      channel: "reply",
      active_action: activeAction,
      shadow_action: input.unifiedAction.action,
      active_next_state: activeState || null,
      shadow_next_state: input.unifiedAction.next_state,
      active_reason: input.legacyCandidate.responseRule || null,
      shadow_reason: input.unifiedAction.reason,
      divergence_types: divergences,
      comparison_status: divergences.length ? "divergent" : "match",
      would_send: Boolean(input.unifiedAction.reply),
      blocked_before_ai: input.unifiedAction.action !== "reply" && input.unifiedAction.action !== "backend_action",
      metadata: { response_rule: input.unifiedAction.response_rule }
    });
  }

  async recordFollowup(input: {
    conversationId: string;
    decisionKey: string;
    currentState: string;
    wouldSend: boolean;
    blockedBeforeAI: boolean;
    reason: string;
    followupType: string;
    contextHash: string;
  }) {
    const action: AgentActionKind = input.wouldSend ? "reply" : "silent";
    return this.repository.upsertDecision({
      conversation_id: input.conversationId,
      message_id: null,
      decision_key: hashKey(["followup", input.conversationId, input.decisionKey, input.contextHash]),
      channel: "followup",
      active_action: "wait",
      shadow_action: action,
      active_next_state: input.currentState || null,
      shadow_next_state: input.currentState || null,
      active_reason: "followup_worker_send_disabled",
      shadow_reason: input.reason,
      divergence_types: input.wouldSend ? ["shadow_followup_candidate"] : [],
      comparison_status: input.wouldSend ? "pending_review" : "match",
      would_send: input.wouldSend,
      blocked_before_ai: input.blockedBeforeAI,
      ai_call_count: 0,
      metadata: { followup_type: input.followupType, context_hash: input.contextHash, send_disabled: true }
    });
  }
}

export function summarizeShadowDecisions(rows: Array<Record<string, unknown>>) {
  const summary = {
    total: rows.length,
    matches: 0,
    divergences: 0,
    would_send: 0,
    blocked_before_ai: 0,
    ai_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    by_divergence: {} as Record<string, number>
  };
  for (const row of rows) {
    if (row.comparison_status === "match") summary.matches++;
    if (row.comparison_status === "divergent") summary.divergences++;
    if (row.would_send === true) summary.would_send++;
    if (row.blocked_before_ai === true) summary.blocked_before_ai++;
    summary.ai_calls += Number(row.ai_call_count || 0);
    summary.input_tokens += Number(row.input_tokens || 0);
    summary.output_tokens += Number(row.output_tokens || 0);
    for (const value of Array.isArray(row.divergence_types) ? row.divergence_types : []) {
      const key = String(value);
      summary.by_divergence[key] = (summary.by_divergence[key] || 0) + 1;
    }
  }
  return summary;
}

function inferLegacyAction(candidate: LegacyCandidate): AgentActionKind {
  if (candidate.requiresHuman) return "handoff";
  if (candidate.copyText || candidate.media) return "backend_action";
  return String(candidate.reply || "").trim() ? "reply" : "silent";
}

function detectDivergences(input: {
  activeAction: AgentActionKind;
  shadowAction: AgentActionKind;
  activeState: string;
  shadowState: string;
  activeReply: string | null;
  currentState: string;
}) {
  const values = new Set<string>();
  const reply = normalize(input.activeReply || "");
  if (input.activeAction !== input.shadowAction) values.add("action_changed");
  if (input.activeState !== input.shadowState) values.add("next_state_changed");
  if (input.shadowAction === "silent" && input.activeAction === "reply") values.add("reply_when_should_be_silent");
  if (input.activeAction === "handoff" && input.shadowAction !== "handoff") values.add("false_handoff");
  if (/^(ola|oi).*(bem-vindo|meu nome e andre)/.test(reply) && input.currentState !== "new_lead") values.add("improper_greeting");
  if (/voce ja usa|seria sua primeira vez/.test(reply) && input.currentState !== "new_lead") values.add("repeated_initial_question");
  if (input.currentState === "incompatible_device" && /(baixe|downloader|instal)/.test(reply)) values.add("installation_for_incompatible_device");
  return [...values];
}

function hashKey(parts: string[]) {
  return createHash("sha256").update(parts.join(":"), "utf8").digest("hex");
}

function normalize(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
