import type { CommercialContext, ContextualDecision } from "./contextual-intelligence.service";

export type ConversationBrainDecision = {
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
}

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
      shouldReply: false,
      allowInitialGreeting: false,
      allowHumanHandoff: false,
      allowFollowup: false,
      responseRule: "conversation_brain_human_hold"
    });
  }

  if (isLegacyLgWithoutCompatibleSystem(message)) {
    return base({
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
  return /^(sim(?: sim)?(?: obrigado| obrigada)?|obrigado|obrigada|valeu|ta bom|tudo bem|beleza|blz|ok)[!?.\s]*$/.test(message);
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
