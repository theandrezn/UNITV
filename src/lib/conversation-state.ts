export const CANONICAL_CONVERSATION_STATES = [
  "new_lead",
  "welcome_sent",
  "test_requested",
  "first_time_check",
  "device_qualification",
  "download_link_sent",
  "awaiting_download_installation",
  "awaiting_test_activation",
  "price_discovery",
  "monthly_offer_pending",
  "plan_preference",
  "plan_selected",
  "pre_sale_recharge_intent",
  "pix_permission",
  "pix_sent",
  "payment_pending",
  "payment_approved",
  "code_delivered",
  "post_sale",
  "incompatible_device",
  "human_handoff"
] as const;

export type ConversationState = (typeof CANONICAL_CONVERSATION_STATES)[number];

const STATE_SET = new Set<string>(CANONICAL_CONVERSATION_STATES);
const STATE_RANK = new Map<ConversationState, number>(
  CANONICAL_CONVERSATION_STATES.map((state, index) => [state, index])
);

const STATE_ALIASES: Record<string, ConversationState> = {
  new: "new_lead",
  new_lead: "new_lead",
  initial_qualification: "new_lead",
  welcome_activation: "welcome_sent",
  welcome_sent: "welcome_sent",
  test_offer: "test_requested",
  trial_selection: "test_requested",
  test_requested: "test_requested",
  first_time_qualification: "first_time_check",
  first_time_check: "first_time_check",
  device_qualification: "device_qualification",
  download_instructions: "download_link_sent",
  download_instructions_sent: "download_link_sent",
  download_link_sent: "download_link_sent",
  download_sent: "download_link_sent",
  instalacao: "download_link_sent",
  awaiting_installation: "awaiting_download_installation",
  download_support: "awaiting_download_installation",
  install_support: "awaiting_download_installation",
  awaiting_download_installation: "awaiting_download_installation",
  awaiting_test_activation: "awaiting_test_activation",
  qualified: "price_discovery",
  price_discovery: "price_discovery",
  special_promo_offered: "monthly_offer_pending",
  monthly_offer_pending: "monthly_offer_pending",
  payment_choice: "plan_preference",
  plan_preference: "plan_preference",
  plan_selected: "plan_selected",
  pre_sale_commitment_pending_payment: "pre_sale_recharge_intent",
  payment_intent_delayed: "pre_sale_recharge_intent",
  pre_sale_recharge_intent: "pre_sale_recharge_intent",
  checkout: "pix_permission",
  pix_permission: "pix_permission",
  pix_sent: "pix_sent",
  awaiting_payment: "payment_pending",
  receipt_under_review: "payment_pending",
  payment_pending: "payment_pending",
  paid: "payment_approved",
  payment_approved: "payment_approved",
  code_delivered: "code_delivered",
  active: "post_sale",
  post_sale: "post_sale",
  incompatible_device: "incompatible_device",
  human_support: "human_handoff",
  human_support_activation: "human_handoff",
  human_support_reseller: "human_handoff",
  human_handoff: "human_handoff"
};

const ALTERNATE_TRANSITIONS = new Set<string>([
  "price_discovery:test_requested",
  "price_discovery:first_time_check",
  "price_discovery:device_qualification",
  "monthly_offer_pending:test_requested",
  "monthly_offer_pending:device_qualification",
  "plan_preference:test_requested",
  "plan_preference:device_qualification",
  "plan_selected:test_requested",
  "plan_selected:device_qualification",
  "pre_sale_recharge_intent:test_requested",
  "pre_sale_recharge_intent:device_qualification",
  "download_link_sent:device_qualification",
  "awaiting_download_installation:device_qualification",
  "awaiting_test_activation:device_qualification",
  "incompatible_device:device_qualification",
  "incompatible_device:download_link_sent",
  "incompatible_device:price_discovery",
  "incompatible_device:monthly_offer_pending",
  "incompatible_device:plan_preference",
  "incompatible_device:plan_selected",
  "incompatible_device:human_handoff",
  "post_sale:price_discovery",
  "post_sale:monthly_offer_pending",
  "post_sale:plan_preference",
  "post_sale:plan_selected",
  "post_sale:pre_sale_recharge_intent"
]);

export function normalizeConversationState(value: unknown): ConversationState | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) return null;
  return STATE_ALIASES[normalized] || (STATE_SET.has(normalized) ? normalized as ConversationState : null);
}

export function resolveConversationState(input: {
  conversationState?: unknown;
  metadata?: Record<string, unknown> | null;
  leadProfile?: Record<string, unknown> | null;
  fallback?: ConversationState;
}): ConversationState {
  const metadata = asRecord(input.metadata);
  const profile = input.leadProfile || asRecord(metadata.lead_profile);
  const candidates = [
    input.conversationState,
    metadata.conversation_state,
    profile.conversation_state,
    profile.stage,
    profile.commercial_stage,
    profile.customer_stage,
    profile.etapa_atual,
    metadata.conversation_stage,
    metadata.customer_stage
  ];
  for (const candidate of candidates) {
    const state = normalizeConversationState(candidate);
    if (state) return state;
  }
  return input.fallback || "new_lead";
}

export function resolveRequestedConversationState(metadata: Record<string, unknown>): ConversationState {
  const profile = asRecord(metadata.lead_profile);
  const requestedCandidates = [
    metadata.state_transition_target,
    profile.stage,
    profile.commercial_stage,
    profile.customer_stage,
    profile.etapa_atual,
    metadata.conversation_stage,
    metadata.customer_stage,
    metadata.conversation_state
  ];
  for (const candidate of requestedCandidates) {
    const state = normalizeConversationState(candidate);
    if (state) return state;
  }
  return "new_lead";
}

export function prepareConversationStatePersistence(metadata: Record<string, unknown>) {
  const state = resolveRequestedConversationState(metadata);
  const profile = asRecord(metadata.lead_profile);
  const event = firstText(
    metadata.state_transition_event,
    profile.last_customer_intent,
    metadata.last_detected_intent,
    metadata.followup_key,
    "metadata_update"
  );
  return {
    state,
    metadata: {
      ...metadata,
      conversation_state: state,
      state_transition_event: event
    }
  };
}

export function isAllowedConversationStateTransition(from: ConversationState, to: ConversationState) {
  if (from === to) return true;
  if (from === "human_handoff") return !["new_lead", "welcome_sent", "human_handoff"].includes(to);
  if (from !== "incompatible_device") {
    const fromRank = STATE_RANK.get(from) ?? -1;
    const toRank = STATE_RANK.get(to) ?? -1;
    if (toRank > fromRank) return true;
  }
  return ALTERNATE_TRANSITIONS.has(`${from}:${to}`);
}

export function withCanonicalConversationState(
  leadProfile: Record<string, unknown>,
  state: ConversationState
): Record<string, unknown> & {
  conversation_state: ConversationState;
  stage: ConversationState;
  commercial_stage: ConversationState;
  customer_stage: ConversationState;
} {
  return {
    ...leadProfile,
    conversation_state: state,
    // Compatibility mirror for code paths that still read the legacy field.
    stage: state,
    commercial_stage: state,
    customer_stage: state
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 160);
  }
  return "metadata_update";
}
