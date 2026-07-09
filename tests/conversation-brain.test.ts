import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  resolveConversationBrain,
  validateFollowupWithConversationBrain
} from "@/services/agent/conversation-brain.service";
import { extractDeterministicDecision, type CommercialContext } from "@/services/agent/contextual-intelligence.service";

function context(input: Partial<CommercialContext> = {}): CommercialContext {
  return {
    current_message: "",
    recent_messages: [],
    lead_profile: {},
    open_order: null,
    latest_order: null,
    last_bot_question: null,
    last_bot_message_at: null,
    last_specialist_message_at: null,
    followup_key: null,
    followup_due_at: null,
    human_hold_active: false,
    ...input
  };
}

function decide(input: Partial<CommercialContext> = {}, classificationIntent = "unknown") {
  const current = context(input);
  return resolveConversationBrain({
    context: current,
    contextualDecision: extractDeterministicDecision(current),
    classificationIntent,
    directHumanRequest: false
  });
}

describe("ConversationBrainService", () => {
  it("replays the full first-time journey and turns Testes into device qualification", () => {
    const lastQuestion = "Perfeito, entao e sua primeira vez. Voce prefere fazer o teste gratis de 3 dias primeiro ou quer ver os planos?";
    const decision = decide({
      current_message: "Testes",
      last_bot_question: lastQuestion,
      recent_messages: [{ role: "assistant", content: lastQuestion }],
      lead_profile: { stage: "trial_selection", first_time_user: true, last_bot_question: lastQuestion }
    });

    expect(decision.responseRule).toBe("conversation_brain_free_trial_device");
    expect(decision.directReply).toContain("qual aparelho");
    expect(decision.allowInitialGreeting).toBe(false);
    expect(decision.allowHumanHandoff).toBe(false);
    expect(decision.leadProfilePatch).toMatchObject({ stage: "device_qualification", wants_test: true });
  });

  it("uses the last bot question to understand a short nao as first time", () => {
    const lastQuestion = "Voce ja usou o UNITV? Se nao, posso liberar 3 dias gratis. Qual aparelho voce quer testar?";
    const decision = decide({
      current_message: "Nao",
      last_bot_question: lastQuestion,
      recent_messages: [{ role: "assistant", content: lastQuestion }],
      lead_profile: { stage: "first_time_check", last_bot_question: lastQuestion }
    }, "greeting");

    expect(decision.responseRule).toBe("conversation_brain_first_time_short_no");
    expect(decision.directReply).toContain("primeira vez usando o UNITV");
    expect(decision.directReply).not.toContain("Oi, tudo bem?");
    expect(decision.leadProfilePatch).toMatchObject({ stage: "device_qualification", first_time_user: true });
  });

  it("keeps installation context after a link when customer says E Android", () => {
    const lastQuestion = "Baixe por aqui: https://www.mediafire.com/app.apk";
    const decision = decide({
      current_message: "E Android",
      last_bot_question: lastQuestion,
      recent_messages: [{ role: "assistant", content: lastQuestion }],
      lead_profile: {
        stage: "awaiting_download_installation",
        install_status: "link_sent",
        last_download_url_sent: "https://www.mediafire.com/app.apk"
      }
    }, "greeting");

    expect(decision.responseRule).toBe("conversation_brain_download_android_confirmation");
    expect(decision.directReply).toContain("link e o correto para seu celular Android");
    expect(decision.directReply).not.toContain("Voce ja usa o aplicativo");
    expect(decision.allowHumanHandoff).toBe(false);
    expect(decision.leadProfilePatch).toMatchObject({ stage: "awaiting_download_installation", device: "android_phone" });
  });

  it("does not confuse device qualification with a download already sent", () => {
    const lastQuestion = "Qual aparelho voce quer baixar para fazer seu teste de 3 dias: celular Android, TV Box, Android TV/Google TV ou Fire Stick?";
    const decision = decide({
      current_message: "Celular Android",
      last_bot_question: lastQuestion,
      recent_messages: [{ role: "assistant", content: lastQuestion }],
      lead_profile: { stage: "device_qualification", wants_test: true, last_bot_question: lastQuestion }
    });

    expect(decision.responseRule).not.toBe("conversation_brain_download_android_confirmation");
    expect(decision.leadProfilePatch.stage).not.toBe("awaiting_download_installation");
  });

  it("blocks a new greeting in an active download conversation", () => {
    const decision = decide({
      current_message: "Oi",
      last_bot_question: "Voce conseguiu baixar?",
      recent_messages: [{ role: "assistant", content: "Voce conseguiu baixar?" }],
      lead_profile: { stage: "awaiting_download_installation", install_status: "link_sent" }
    }, "greeting");

    expect(decision.responseRule).toBe("conversation_brain_blocks_greeting_restart");
    expect(decision.directReply).toContain("instalacao");
    expect(decision.allowInitialGreeting).toBe(false);
    expect(decision.directReply).not.toContain("Voce ja usa o aplicativo UNITV");
  });

  it("blocks stale post-download follow-up after customer, human, or payment progression", () => {
    expect(validateFollowupWithConversationBrain({
      stage: "awaiting_download_installation",
      followupKey: "post_download_check_10min",
      humanHoldActive: false,
      lastBotMessage: "Baixe por aqui: https://www.mediafire.com/app.apk",
      customerRepliedAfterBaseMessage: true,
      humanRepliedAfterBaseMessage: false
    })).toMatchObject({ allowed: false, reason: "customer_replied_after_followup_base" });

    expect(validateFollowupWithConversationBrain({
      stage: "awaiting_download_installation",
      followupKey: "post_download_check_10min",
      humanHoldActive: false,
      lastBotMessage: "Baixe por aqui: https://www.mediafire.com/app.apk",
      customerRepliedAfterBaseMessage: false,
      humanRepliedAfterBaseMessage: true
    })).toMatchObject({ allowed: false, reason: "human_context_blocks_followup" });

    expect(validateFollowupWithConversationBrain({
      stage: "payment_pending",
      followupKey: "post_download_check_10min",
      humanHoldActive: false,
      lastBotMessage: "Baixe por aqui: https://www.mediafire.com/app.apk",
      customerRepliedAfterBaseMessage: false,
      humanRepliedAfterBaseMessage: false
    })).toMatchObject({ allowed: false, reason: "advanced_or_sensitive_stage_blocks_followup" });
  });

  it("allows a 10-minute download follow-up only while the original context remains valid", () => {
    expect(validateFollowupWithConversationBrain({
      stage: "awaiting_download_installation",
      followupKey: "post_download_check_10min",
      humanHoldActive: false,
      lastBotMessage: "Baixe por aqui: https://www.mediafire.com/app.apk",
      customerRepliedAfterBaseMessage: false,
      humanRepliedAfterBaseMessage: false
    })).toMatchObject({ allowed: true, reason: "conversation_brain_followup_allowed" });
  });

  it.each([
    ["Baixei", "Voce conseguiu baixar?", "awaiting_download_installation", "conversation_brain_download_confirmed"],
    ["Instalei", "Voce conseguiu instalar?", "awaiting_download_installation", "conversation_brain_download_confirmed"],
    ["Nao consegui baixar", "Voce conseguiu baixar?", "awaiting_download_installation", "conversation_brain_download_help"],
    ["Nao", "Voce conseguiu baixar?", "awaiting_download_installation", "conversation_brain_download_help"],
    ["Pronto", "Voce conseguiu instalar?", "awaiting_download_installation", "conversation_brain_download_confirmed"],
    ["Oi", "Voce prefere fazer o teste gratis de 3 dias primeiro ou quer ver os planos?", "trial_selection", "conversation_brain_blocks_greeting_restart"],
    ["Celular", "Qual aparelho voce quer usar: celular Android, TV Box, Android TV/Google TV ou Fire Stick?", "device_qualification", "conversation_brain_confirm_android_phone"]
  ])("keeps the expected journey for short answer %s", (message, lastQuestion, stage, expectedRule) => {
    const decision = decide({
      current_message: message,
      last_bot_question: lastQuestion,
      recent_messages: [{ role: "assistant", content: lastQuestion }],
      lead_profile: {
        stage,
        last_bot_question: lastQuestion,
        wants_test: true,
        ...(stage === "awaiting_download_installation" ? { install_status: "link_sent" } : {})
      }
    }, message === "Oi" ? "greeting" : "unknown");

    expect(decision.responseRule).toBe(expectedRule);
    expect(decision.allowInitialGreeting).toBe(false);
    expect(decision.allowHumanHandoff).toBe(false);
  });

  it("keeps initial greeting available only when no conversation context exists", () => {
    const decision = decide({ current_message: "Ola! Posso ter mais informacoes sobre isso?" }, "greeting");

    expect(decision.contextActive).toBe(false);
    expect(decision.allowInitialGreeting).toBe(true);
    expect(decision.directReply).toBeNull();
  });
});
