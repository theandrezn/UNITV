import type { CommercialContext, ContextualDecision } from "./contextual-intelligence.service";
import { normalizeConversationState, type ConversationState } from "@/lib/conversation-state";
import {
  UNITV_ANDROID_APK_URL,
  UNITV_DOWNLOADER_CODE,
  UNITV_TUTORIAL_URL,
  UNITV_TV_APK_URL
} from "@/lib/unitv/device-compatibility";

export type AgentActionKind = "reply" | "silent" | "wait" | "handoff" | "backend_action";

export type AgentFollowupAction = {
  type: "none" | "schedule" | "cancel" | "shadow";
  key: string | null;
  dueAt: string | null;
};

export type AgentBackendArtifact = {
  type: "pix" | "payment_check" | "activation_code" | "download" | "menu";
  present: boolean;
};

export type ConversationAgentAction = {
  action: AgentActionKind;
  next_state: ConversationState;
  reason: string;
  reply: string | null;
  followup_action: AgentFollowupAction;
  backend_artifact: AgentBackendArtifact | null;
  response_rule: string;
};

export type ConversationBrainDecision = ConversationAgentAction & {
  stage: string;
  contextActive: boolean;
  allowInitialGreeting: boolean;
  allowHumanHandoff: boolean;
  allowFollowup: boolean;
  shouldReply: boolean;
  directReply: string | null;
  responseRule: string;
  leadProfilePatch: Record<string, unknown>;
  evidence: string[];
};

export type ConversationBrainInput = {
  context: CommercialContext;
  contextualDecision: ContextualDecision;
  classificationIntent: string;
  directHumanRequest: boolean;
};

const TRIAL_DEVICE_REPLY =
  "Perfeito! Como e sua primeira vez, voce consegue fazer o teste gratis de 3 dias sim.\n\n" +
  "Me fala so qual aparelho voce vai usar: celular Android, TV Box, Android TV/Google TV ou Fire Stick?";
const FIRST_TIME_NO_REPLY =
  "Entendi, entao seria sua primeira vez usando o UNITV. Qual aparelho voce quer baixar para fazer seu teste de 3 dias? Pode ser celular Android, TV Box, Android TV/Google TV ou Fire Stick.";
const ASK_DEVICE_AGAIN_REPLY =
  "Sem problema. Voce quer testar em qual aparelho? Celular Android, TV Box, Android TV/Google TV ou Fire Stick?";
const ANDROID_PHONE_CONFIRMATION_REPLY = "So me confirma: esse celular e Android?";
const DOWNLOAD_HELP_REPLY = "Tudo bem, me fala onde travou: no link, no Downloader ou na instalacao?";
const DOWNLOAD_CONFIRMED_REPLY =
  "Perfeito. Agora abre o aplicativo e me avisa se aparecer a tela de login/cadastro para seguirmos com a liberacao do teste.";
const DOWNLOAD_ANDROID_CONFIRMATION_REPLY =
  "Perfeito, entao esse link e o correto para seu celular Android.\n\n" +
  "Pode baixar por ele e, quando terminar de instalar, me avisa por aqui que seguimos com a liberacao do teste.";

const ACTIVE_STAGES = new Set([
  "welcome_sent",
  "welcome_activation",
  "test_requested",
  "test_offer",
  "first_time_check",
  "first_time_qualification",
  "trial_selection",
  "device_qualification",
  "download_link_sent",
  "download_instructions",
  "download_instructions_sent",
  "awaiting_download_installation",
  "download_support",
  "install_support",
  "price_discovery",
  "plan_preference",
  "plan_selected",
  "pix_permission",
  "pix_sent",
  "payment_pending",
  "awaiting_payment",
  "payment_approved",
  "code_delivered",
  "post_sale",
  "pre_sale_recharge_intent",
  "incompatible_device"
]);

const DOWNLOAD_STAGES = new Set([
  "download_link_sent",
  "download_instructions",
  "download_instructions_sent",
  "awaiting_download_installation",
  "download_support",
  "install_support"
]);

const SENSITIVE_STAGES = /(^|[_\s-])(pix|payment|pagamento|paid|approved|codigo|code_delivered|human_support|human_handoff|post_sale)([_\s-]|$)/;

/**
 * Single, deterministic response arbiter. It interprets short customer answers
 * from the persisted stage and the question the bot actually asked before any
 * intent classifier, template, AI response, greeting, handoff, or follow-up can win.
 */
export class ConversationBrainService {
  decide(input: ConversationBrainInput): ConversationBrainDecision {
    return resolveConversationBrain(input);
  }

  finalize(input: FinalizeConversationActionInput): ConversationAgentAction {
    return finalizeConversationAction(input);
  }
}

export type FinalizeConversationActionInput = {
  preliminary: ConversationBrainDecision;
  contextualDecision: ContextualDecision;
  candidate: {
    reply?: string | null;
    requiresHuman?: boolean;
    responseRule?: string;
    leadProfilePatch?: Record<string, unknown>;
    copyText?: string;
    media?: unknown;
    menu?: unknown;
  };
};

export function resolveConversationBrain(input: ConversationBrainInput): ConversationBrainDecision {
  const profile = input.context.lead_profile || {};
  const message = normalize(input.context.current_message);
  const lastQuestion = normalize(String(input.context.last_bot_question || profile.last_bot_question || lastAssistantMessage(input.context.recent_messages)));
  const stage = normalizeStage(
    profile.conversation_state || profile.stage || profile.commercial_stage || profile.etapa_atual || input.contextualDecision.stage
  );
  const downloadActive = isDownloadContext(stage, profile, lastQuestion, input.context.recent_messages);
  const active = isActiveContext(stage, profile, lastQuestion, input.context.recent_messages, input.context.followup_key);
  const sensitive = SENSITIVE_STAGES.test(stage);
  const evidence = [
    `stage=${stage || "new_lead"}`,
    `last_bot_question_kind=${classifyQuestion(lastQuestion)}`,
    input.context.followup_key ? `followup_key=${input.context.followup_key}` : "followup_key=none"
  ];
  const base = (overrides: Partial<ConversationBrainDecision> = {}): ConversationBrainDecision => ({
    action: "wait",
    next_state: normalizeConversationState(stage) || "new_lead",
    reason: "Aguardando a proposta contextual antes da arbitragem final.",
    reply: null,
    followup_action: { type: "none", key: null, dueAt: null },
    backend_artifact: null,
    response_rule: "conversation_brain_continue",
    stage: stage || "new_lead",
    contextActive: active,
    allowInitialGreeting: !active,
    allowHumanHandoff: !active || input.directHumanRequest || sensitive,
    allowFollowup: !input.context.human_hold_active && !sensitive,
    shouldReply: !input.context.human_hold_active,
    directReply: null,
    responseRule: "conversation_brain_continue",
    leadProfilePatch: {},
    evidence,
    ...overrides
  });

  if (input.context.human_hold_active) {
    return base({
      action: "wait",
      reason: "Especialista humano esta conduzindo a conversa.",
      response_rule: "conversation_brain_human_hold",
      shouldReply: false,
      allowInitialGreeting: false,
      allowHumanHandoff: false,
      allowFollowup: false,
      responseRule: "conversation_brain_human_hold"
    });
  }

  if (isLegacyLgWithoutCompatibleSystem(message)) {
    return base({
      action: "silent",
      next_state: "incompatible_device",
      reason: "Aparelho incompatível ja confirmado; insistir na instalacao pioraria o atendimento.",
      response_rule: "conversation_brain_legacy_lg_incompatible_silent",
      stage: "incompatible_device",
      contextActive: true,
      allowInitialGreeting: false,
      allowHumanHandoff: false,
      allowFollowup: false,
      shouldReply: false,
      responseRule: "conversation_brain_legacy_lg_incompatible_silent",
      leadProfilePatch: incompatibleDevicePatch("lg_tv", "LG antiga")
    });
  }

  if (isConfirmedIncompatibleDevice(profile, stage) && isDownloadProblem(message, lastQuestion)) {
    return base({
      action: "silent",
      next_state: "incompatible_device",
      reason: "Falha de instalacao ocorreu em aparelho ja confirmado como incompativel.",
      response_rule: "conversation_brain_incompatible_installation_failure_silent",
      stage: "incompatible_device",
      contextActive: true,
      allowInitialGreeting: false,
      allowHumanHandoff: false,
      allowFollowup: false,
      shouldReply: false,
      responseRule: "conversation_brain_incompatible_installation_failure_silent",
      leadProfilePatch: incompatibleDevicePatch(
        String(profile.device || "unknown"),
        String(profile.aparelho || "Aparelho incompatível")
      )
    });
  }

  if (stage === "pre_sale_recharge_intent" && isClosingAcknowledgement(message)) {
    return base({
      action: "silent",
      next_state: "pre_sale_recharge_intent",
      reason: "Agradecimento encerra o turno sem exigir nova mensagem.",
      response_rule: "conversation_brain_pre_sale_acknowledgement_silent",
      contextActive: true,
      allowInitialGreeting: false,
      allowHumanHandoff: false,
      shouldReply: false,
      responseRule: "conversation_brain_pre_sale_acknowledgement_silent",
      leadProfilePatch: {
        commercial_stage: "pre_sale_recharge_intent",
        stage: "pre_sale_recharge_intent",
        last_customer_intent: "closing_acknowledgement",
        next_expected_reply: "customer_returns_for_recharge"
      }
    });
  }

  if (downloadActive) {
    if (isDownloadProblem(message, lastQuestion)) {
      return base({
        action: "reply",
        reason: "Cliente informou dificuldade durante o fluxo ativo de download.",
        reply: DOWNLOAD_HELP_REPLY,
        response_rule: "conversation_brain_download_help",
        directReply: DOWNLOAD_HELP_REPLY,
        responseRule: "conversation_brain_download_help",
        leadProfilePatch: downloadPatch("download_support", {
          install_status: "failed",
          download_status: "failed",
          last_customer_intent: "download_issue",
          last_bot_question: DOWNLOAD_HELP_REPLY
        })
      });
    }

    if (isDownloaded(message, lastQuestion)) {
      return base({
        action: "reply",
        reason: "Cliente confirmou o download e deve avancar para abertura do aplicativo.",
        reply: DOWNLOAD_CONFIRMED_REPLY,
        response_rule: "conversation_brain_download_confirmed",
        directReply: DOWNLOAD_CONFIRMED_REPLY,
        responseRule: "conversation_brain_download_confirmed",
        leadProfilePatch: downloadPatch("awaiting_download_installation", {
          downloaded_app: true,
          install_status: "downloaded",
          download_status: "downloaded",
          next_expected_reply: "install_confirmation",
          last_customer_intent: "download_confirmed",
          last_bot_question: DOWNLOAD_CONFIRMED_REPLY
        })
      });
    }

    if (mentionsAndroid(message)) {
      return base({
        action: "reply",
        reason: "Cliente confirmou Android dentro do fluxo de download ativo.",
        reply: DOWNLOAD_ANDROID_CONFIRMATION_REPLY,
        response_rule: "conversation_brain_download_android_confirmation",
        directReply: DOWNLOAD_ANDROID_CONFIRMATION_REPLY,
        responseRule: "conversation_brain_download_android_confirmation",
        leadProfilePatch: downloadPatch("awaiting_download_installation", {
          device: "android_phone",
          aparelho: "Celular Android",
          device_compatible: true,
          install_status: "link_sent",
          download_status: "link_sent",
          last_customer_intent: "download_android_confirmation",
          last_bot_question: DOWNLOAD_ANDROID_CONFIRMATION_REPLY
        })
      });
    }
  }

  if (
    input.contextualDecision.detected_intent === "FREE_TRIAL_REQUEST" &&
    input.contextualDecision.next_action === "ask_device_for_trial"
  ) {
    return base({
      action: "reply",
      reason: "Pedido de teste precisa avancar para qualificacao do aparelho.",
      reply: safeReply(input.contextualDecision.recommended_response, TRIAL_DEVICE_REPLY),
      response_rule: "conversation_brain_free_trial_device",
      directReply: safeReply(input.contextualDecision.recommended_response, TRIAL_DEVICE_REPLY),
      responseRule: "conversation_brain_free_trial_device",
      leadProfilePatch: awaitingPatch("device_qualification", {
        wants_test: true,
        first_time_user: profile.first_time_user ?? true,
        last_customer_intent: "free_trial_request",
        next_expected_reply: "device",
        last_bot_question: "Me fala so qual aparelho voce vai usar: celular Android, TV Box, Android TV/Google TV ou Fire Stick?"
      })
    });
  }

  if (
    input.contextualDecision.detected_intent === "DEVICE_ANDROID_PHONE_NEEDS_CONFIRMATION" &&
    input.contextualDecision.next_action === "confirm_android_phone"
  ) {
    return base({
      action: "reply",
      reason: "Celular informado sem confirmacao do sistema operacional.",
      reply: safeReply(input.contextualDecision.recommended_response, ANDROID_PHONE_CONFIRMATION_REPLY),
      response_rule: "conversation_brain_confirm_android_phone",
      directReply: safeReply(input.contextualDecision.recommended_response, ANDROID_PHONE_CONFIRMATION_REPLY),
      responseRule: "conversation_brain_confirm_android_phone",
      leadProfilePatch: awaitingPatch("device_qualification", {
        wants_test: profile.wants_test ?? true,
        last_customer_intent: "device_android_phone_needs_confirmation",
        next_expected_reply: "device",
        last_bot_question: ANDROID_PHONE_CONFIRMATION_REPLY
      })
    });
  }

  if (isFirstTimeNo(message) && asksFirstTimeOrTrial(lastQuestion)) {
    return base({
      action: "reply",
      reason: "Resposta curta foi interpretada pela ultima pergunta sobre primeira utilizacao.",
      reply: FIRST_TIME_NO_REPLY,
      response_rule: "conversation_brain_first_time_short_no",
      directReply: FIRST_TIME_NO_REPLY,
      responseRule: "conversation_brain_first_time_short_no",
      leadProfilePatch: awaitingPatch("device_qualification", {
        wants_test: true,
        first_time_user: true,
        last_customer_intent: "first_time_user",
        next_expected_reply: "device",
        last_bot_question: "Qual aparelho voce quer baixar para fazer seu teste de 3 dias: celular Android, TV Box, Android TV/Google TV ou Fire Stick?"
      })
    });
  }

  if (isFirstTimeNo(message) && asksDevice(lastQuestion)) {
    return base({
      action: "reply",
      reason: "Cliente ainda nao informou o aparelho solicitado.",
      reply: ASK_DEVICE_AGAIN_REPLY,
      response_rule: "conversation_brain_device_not_provided",
      directReply: ASK_DEVICE_AGAIN_REPLY,
      responseRule: "conversation_brain_device_not_provided",
      leadProfilePatch: awaitingPatch("device_qualification", {
        wants_test: profile.wants_test ?? true,
        last_customer_intent: "device_not_provided",
        next_expected_reply: "device",
        last_bot_question: ASK_DEVICE_AGAIN_REPLY
      })
    });
  }

  if (active && isGreeting(input.classificationIntent, message)) {
    return base({
      action: "reply",
      reason: "Saudacao em conversa ativa deve continuar do ponto atual, sem reiniciar o funil.",
      reply: activeGreetingReply(stage, lastQuestion),
      response_rule: "conversation_brain_blocks_greeting_restart",
      directReply: activeGreetingReply(stage, lastQuestion),
      responseRule: "conversation_brain_blocks_greeting_restart",
      leadProfilePatch: {
        ...(profile.stage ? {} : awaitingPatch("qualified", {})),
        last_customer_intent: "active_conversation_greeting",
        context_guard: "initial_greeting_blocked"
      }
    });
  }

  return base();
}

export function finalizeConversationAction(input: FinalizeConversationActionInput): ConversationAgentAction {
  const preliminary = input.preliminary;
  const candidate = input.candidate;
  const explicitStop = preliminary.action === "silent" ||
    (preliminary.action === "wait" && preliminary.responseRule !== "conversation_brain_continue");
  if (explicitStop) {
    return {
      action: preliminary.action,
      next_state: preliminary.next_state,
      reason: preliminary.reason,
      reply: null,
      followup_action: { type: "cancel", key: null, dueAt: null },
      backend_artifact: null,
      response_rule: preliminary.response_rule
    };
  }

  const patch = candidate.leadProfilePatch || {};
  const nextState = normalizeConversationState(
    patch.conversation_state || patch.stage || patch.commercial_stage
  ) || preliminary.next_state || normalizeConversationState(input.contextualDecision.next_state || input.contextualDecision.stage) || "new_lead";
  const reply = String(candidate.reply || "").trim() || null;
  const responseRule = candidate.responseRule || preliminary.responseRule || "conversation_brain_finalized";
  if (candidate.requiresHuman) {
    return {
      action: "handoff",
      next_state: "human_handoff",
      reason: responseRule,
      reply,
      followup_action: { type: "cancel", key: null, dueAt: null },
      backend_artifact: null,
      response_rule: responseRule
    };
  }

  const backendArtifact = detectBackendArtifact(candidate, input.contextualDecision);
  if (backendArtifact) {
    return {
      action: "backend_action",
      next_state: nextState,
      reason: responseRule,
      reply,
      followup_action: followupFromPatch(patch),
      backend_artifact: backendArtifact,
      response_rule: responseRule
    };
  }

  if (!reply) {
    return {
      action: input.contextualDecision.should_reply === false ? "silent" : "wait",
      next_state: nextState,
      reason: responseRule,
      reply: null,
      followup_action: { type: "none", key: null, dueAt: null },
      backend_artifact: null,
      response_rule: responseRule
    };
  }

  return {
    action: "reply",
    next_state: nextState,
    reason: responseRule,
    reply,
    followup_action: followupFromPatch(patch),
    backend_artifact: null,
    response_rule: responseRule
  };
}

function detectBackendArtifact(
  candidate: FinalizeConversationActionInput["candidate"],
  decision: ContextualDecision
): AgentBackendArtifact | null {
  if (candidate.copyText || (decision.should_generate_pix && candidate.reply)) return { type: "pix", present: Boolean(candidate.copyText) };
  if (decision.next_action === "verify_payment") return { type: "payment_check", present: true };
  if (containsAuthorizedDownloadArtifact(candidate.reply, candidate.responseRule, decision)) {
    return { type: "download", present: true };
  }
  if (candidate.media) return { type: decision.should_send_download ? "download" : "menu", present: true };
  if (candidate.menu) return { type: "menu", present: true };
  return null;
}

function containsAuthorizedDownloadArtifact(
  reply: string | null | undefined,
  responseRule: string | undefined,
  decision: ContextualDecision
) {
  const text = String(reply || "");
  const containsOfficialArtifact = [
    UNITV_ANDROID_APK_URL,
    UNITV_TV_APK_URL,
    UNITV_TUTORIAL_URL,
    UNITV_DOWNLOADER_CODE
  ].some((artifact) => text.includes(artifact));
  if (!containsOfficialArtifact) return false;

  return decision.should_send_download === true ||
    /(?:download|installation|expected_device_answer|active_download_flow)/i.test(String(responseRule || ""));
}

function followupFromPatch(patch: Record<string, unknown>): AgentFollowupAction {
  const key = typeof patch.followup_key === "string" ? patch.followup_key : null;
  const dueAt = typeof patch.followup_due_at === "string" ? patch.followup_due_at : null;
  return key || dueAt
    ? { type: "schedule", key, dueAt }
    : { type: "none", key: null, dueAt: null };
}

export function validateFollowupWithConversationBrain(input: {
  stage: string | null | undefined;
  followupKey: string | null | undefined;
  humanHoldActive: boolean;
  lastBotMessage: string | null | undefined;
  customerRepliedAfterBaseMessage: boolean;
  humanRepliedAfterBaseMessage: boolean;
}): { allowed: boolean; reason: string } {
  const stage = normalizeStage(input.stage || "");
  const key = String(input.followupKey || "");
  if (input.humanHoldActive) return { allowed: false, reason: "human_context_blocks_followup" };
  if (SENSITIVE_STAGES.test(stage)) return { allowed: false, reason: "advanced_or_sensitive_stage_blocks_followup" };
  if (stage === "incompatible_device") return { allowed: false, reason: "incompatible_device_blocks_followup" };
  if (key === "post_download_check_10min") {
    if (input.customerRepliedAfterBaseMessage) return { allowed: false, reason: "customer_replied_after_followup_base" };
    if (input.humanRepliedAfterBaseMessage) return { allowed: false, reason: "human_context_blocks_followup" };
    if (!isDownloadInstruction(String(input.lastBotMessage || ""))) {
      return { allowed: false, reason: "post_download_without_latest_download_instruction" };
    }
  }
  if (key === "monthly_promo_19_99_check") {
    return { allowed: false, reason: "legacy_monthly_promotion_disabled" };
  }
  return { allowed: true, reason: "conversation_brain_followup_allowed" };
}

function awaitingPatch(stage: string, extra: Record<string, unknown>) {
  return {
    commercial_stage: stage,
    stage,
    state: "awaiting_customer_response",
    contextual_response_owner: "conversation_brain",
    ...extra
  };
}

function downloadPatch(stage: string, extra: Record<string, unknown>) {
  return awaitingPatch(stage, {
    state: "awaiting_download_installation",
    contextual_response_owner: "conversation_brain",
    ...extra
  });
}

function incompatibleDevicePatch(device: string, label: string) {
  return {
    commercial_stage: "incompatible_device",
    stage: "incompatible_device",
    state: "closed_incompatible_device",
    device,
    aparelho: label,
    device_compatible: false,
    compatibility_status: "incompatible",
    installation_attempt_status: "failed",
    android_confirmed: false,
    install_status: "failed",
    download_status: "failed",
    last_customer_intent: "incompatible_device_confirmed",
    next_expected_reply: null,
    last_bot_question: null,
    contextual_response_owner: "conversation_brain"
  };
}

function isActiveContext(stage: string, profile: Record<string, unknown>, lastQuestion: string, recent: CommercialContext["recent_messages"], followupKey: string | null) {
  const hasDefinedStage = Boolean(stage) && !["new", "new_lead"].includes(stage);
  return (
    ACTIVE_STAGES.has(stage) ||
    hasDefinedStage ||
    Boolean(lastQuestion) ||
    Boolean(profile.last_bot_question) ||
    Boolean(profile.last_download_url_sent) ||
    Boolean(profile.selected_plan || profile.plano_interesse) ||
    Boolean(followupKey) ||
    recent.filter((message) => message.role === "assistant" || message.role === "human_agent").length > 0 ||
    recent.filter((message) => message.role === "customer").length > 1
  );
}

function isDownloadContext(stage: string, profile: Record<string, unknown>, lastQuestion: string, recent: CommercialContext["recent_messages"]) {
  return (
    DOWNLOAD_STAGES.has(stage) ||
    Boolean(profile.last_download_url_sent) ||
    /\b(link_sent|downloaded|installed|failed)\b/.test(normalize(String(profile.install_status || profile.download_status || ""))) ||
    isDownloadSentInstruction(lastQuestion) ||
    isDownloadSentInstruction(lastAssistantMessage(recent))
  );
}

function isDownloadSentInstruction(text: string) {
  return /\b(mediafire|apk|downloader|862585|tutorial|youtube|baixe por aqui|link para baixar|voce conseguiu baixar|conseguiu instalar)\b/.test(normalize(text));
}

function isDownloadInstruction(text: string) {
  return /\b(mediafire|apk|download|baixar|baixe|downloader|862585|tutorial|youtube|instalar|instalacao)\b/.test(normalize(text));
}

function asksFirstTimeOrTrial(question: string) {
  return /\b(ja usou|ja usa|uso do app|faz o uso|primeira vez|3 dias gratis|teste gratis|liberar 3 dias|libero 3 dias)\b/.test(question);
}

function classifyQuestion(question: string) {
  if (!question) return "none";
  if (isDownloadSentInstruction(question) || /\b(conseguiu baixar|conseguiu instalar)\b/.test(question)) return "download";
  if (asksDevice(question)) return "device";
  if (asksFirstTimeOrTrial(question)) return "trial_or_first_time";
  if (/\b(pix|pagamento|cartao)\b/.test(question)) return "payment";
  return "other";
}

function asksDevice(question: string) {
  return /\b(qual aparelho|aparelho voce quer testar|aparelho quer testar|celular android|tv box|android tv|fire stick|baixar|download)\b/.test(question);
}

function isFirstTimeNo(message: string) {
  return /^(nao|n|nunca|nunca usei|nao usei|nao uso|ainda nao|primeira vez)$/.test(message);
}

function isDownloadProblem(message: string, lastQuestion: string) {
  return /\b(nao consegui|nao deu|erro|nao abre|nao baixa|link nao funciona|codigo nao deu)\b/.test(message) ||
    (/^(nao|n)$/.test(message) && /\b(conseguiu baixar|conseguiu instalar|baixou|instalou)\b/.test(lastQuestion));
}

function isLegacyLgWithoutCompatibleSystem(message: string) {
  return /\b(lg|tv lg)\b.{0,24}\b(antiga|velha|sem android|nao tem android|sem play store|nao tem play store)\b/.test(message) ||
    /\b(antiga|velha|sem android|nao tem android|sem play store|nao tem play store)\b.{0,24}\b(lg|tv lg)\b/.test(message);
}

function isConfirmedIncompatibleDevice(profile: Record<string, unknown>, stage: string) {
  return stage === "incompatible_device" || profile.device_compatible === false;
}

function isClosingAcknowledgement(message: string) {
  return /^(sim(?:[,\s]+sim)?(?:[,\s]+obrigado|[,\s]+obrigada)?|obrigado|obrigada|valeu|ta bom|tudo bem|beleza|blz|ok)[!?,.\s]*$/.test(message);
}

function isDownloaded(message: string, lastQuestion: string) {
  return /\b(ja baixei|baixei|download feito|fiz o download|ja instalei|instalei|consegui instalar)\b/.test(message) ||
    (/^(sim|s|ok|feito|consegui|pronto)$/.test(message) && /\b(conseguiu baixar|conseguiu instalar|baixou|instalou)\b/.test(lastQuestion));
}

function mentionsAndroid(message: string) {
  return /\b(android|celular android|e android|meu celular)\b/.test(message);
}

function isGreeting(intent: string, message: string) {
  return intent === "greeting" || /^(oi|ola|bom dia|boa tarde|boa noite|tudo bem)[!?.\s]*$/.test(message);
}

function activeGreetingReply(stage: string, lastQuestion: string) {
  if (isDownloadContext(stage, {}, lastQuestion, [])) return "Oi, estou por aqui. Sobre a instalacao, voce conseguiu baixar?";
  if (asksDevice(lastQuestion) || stage === "device_qualification") return ASK_DEVICE_AGAIN_REPLY;
  if (asksFirstTimeOrTrial(lastQuestion) || stage === "trial_selection") return "Oi, estou por aqui. Voce prefere fazer o teste gratis de 3 dias ou quer ver os planos?";
  if (/\b(pix|pagamento)\b/.test(lastQuestion)) return "Oi, estou por aqui. Quer seguir com o pagamento que estavamos combinando?";
  return "Oi, estou por aqui. Vamos continuar de onde paramos?";
}

function lastAssistantMessage(messages: CommercialContext["recent_messages"]) {
  return [...messages].reverse().find((message) => message.role === "assistant")?.content || "";
}

function safeReply(candidate: string, fallback: string) {
  const trimmed = String(candidate || "").trim();
  return trimmed && !/\b(oi, tudo bem|voce ja usa o aplicativo)\b/.test(normalize(trimmed)) ? trimmed : fallback;
}

function normalizeStage(value: unknown) {
  return normalize(String(value || "")).replace(/\s+/g, "_");
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}
