import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { findUnitvAuthoritativeKnowledgeReply, findUnitvObjectionReply } from "@/lib/unitv/objection-map";
import { isSafeSpecialistExampleForReuse } from "@/repositories/specialist-training-examples.repository";
import { buildSpecialistLearningGuidance } from "@/services/agent/specialist-learning-guidance";
import { PlansService } from "@/services/plans.service";
import { isReceiptMessage } from "@/services/whatsapp/whatsapp-message.service";

describe("learning quality and objection guardrails", () => {
  it("reuses only semantic specialist examples without mutable commercial artifacts", () => {
    expect(isSafeSpecialistExampleForReuse({
      specialist_message: "Perfeito, como voce ja instalou vamos seguir com a ativacao",
      inferred_intent: "ativacao",
      inferred_specialist_action: "avancou_contexto"
    })).toBe(true);

    expect(isSafeSpecialistExampleForReuse({
      specialist_message: "Boa noite",
      inferred_intent: "outro",
      inferred_specialist_action: "respondeu_duvida"
    })).toBe(false);
    expect(isSafeSpecialistExampleForReuse({
      specialist_message: "Consigo fazer por R$ 19,99 via Pix",
      inferred_intent: "preco"
    })).toBe(false);
    expect(isSafeSpecialistExampleForReuse({
      specialist_message: "Entendi, vou verificar isso para voce",
      inferred_intent: "outro",
      inferred_specialist_action: "respondeu_duvida",
      metadata: { learned_pattern: "reconhecer_contexto_e_avancar" }
    })).toBe(false);
  });

  it("turns approved learning into compact principles without copying conversation text", () => {
    const guidance = buildSpecialistLearningGuidance([{
      customer_last_message: "texto privado do cliente",
      specialist_message: "texto privado do especialista",
      inferred_specialist_action: "reconhecer_instalacao_e_avancar",
      style_notes: "Responder curto, contextual e com uma acao.",
      metadata: { learned_pattern: "cliente_ja_instalou_nao_repetir_download" }
    }], []);

    expect(guidance).toEqual({
      pattern: "cliente_ja_instalou_nao_repetir_download",
      action: "reconhecer_instalacao_e_avancar",
      style: "Responder curto, contextual e com uma acao.",
      avoid: undefined
    });
    expect(JSON.stringify(guidance)).not.toContain("texto privado");
  });

  it("does not mistake the word mensalidades for the monthly plan", async () => {
    const monthly = { id: "monthly", name: "Plano Mensal", slug: "mensal", duration_days: 30 };
    const quarterly = { id: "quarterly", name: "Plano Trimestral", slug: "trimestral", duration_days: 90 };
    const service = new PlansService({ listActivePlans: vi.fn(async () => [monthly, quarterly]) } as never);

    const result = await service.findPlanMentionedInText("Qual valor das mensalidades de 3 meses?");

    expect(result.plan?.id).toBe("quarterly");
  });

  it("recognizes the official decimal monthly price and ships its database migration", async () => {
    const monthly = { id: "monthly", name: "Plano Mensal", slug: "mensal", duration_days: 30, price_cents: 2090 };
    const quarterly = { id: "quarterly", name: "Plano Trimestral", slug: "trimestral", duration_days: 90, price_cents: 7000 };
    const service = new PlansService({ listActivePlans: vi.fn(async () => [monthly, quarterly]) } as never);

    const result = await service.findPlanMentionedInText("Quero o de R$ 20,90");
    const migration = readFileSync("supabase/migrations/20260713205000_update_monthly_plan_price_to_2090.sql", "utf8");

    expect(result.plan?.id).toBe("monthly");
    expect(migration).toContain("price_cents = 2090");
    expect(migration).toContain("where slug = 'mensal'");
  });

  it("acknowledges a known screen count instead of asking it again", () => {
    const result = findUnitvObjectionReply("Quero usar em duas telas");

    expect(result?.reply).toContain("2 telas");
    expect(result?.reply.toLowerCase()).not.toContain("quantas telas");
  });

  it("answers a screen coverage question with the official monthly limit", () => {
    const result = findUnitvObjectionReply("Quantas telas o plano mensal cobre?");

    expect(result?.reply).toContain("ate 3 telas");
    expect(result?.reply.toLowerCase()).not.toContain("quantas telas voce precisa");
  });

  it("keeps catalog facts authoritative without asking the model", () => {
    expect(findUnitvAuthoritativeKnowledgeReply("Tem canais e filmes em espanhol?")?.reply)
      .toBe("Tem sim. A UNITV possui canais e filmes em espanhol.");
    expect(findUnitvAuthoritativeKnowledgeReply("Tem ESPN?")?.reply)
      .toContain("nao possui ESPN como canal fixo");
    expect(findUnitvAuthoritativeKnowledgeReply("Tem ESPN?")?.reply)
      .toContain("jogos importantes exclusivos da ESPN");
    expect(findUnitvAuthoritativeKnowledgeReply("Tem Premiere?")?.reply)
      .toBe("Tem sim. A UNITV possui Premiere.");

    const combined = findUnitvAuthoritativeKnowledgeReply("Tem ESPN e Premiere?");
    expect(combined?.reply).toContain("nao possui ESPN como canal fixo");
    expect(combined?.reply).toContain("possui Premiere");
  });

  it("marks reseller questions for a real specialist handoff", () => {
    for (const question of ["Como faco para revender?", "Voce tem revenda do UNITV?"]) {
      const result = findUnitvAuthoritativeKnowledgeReply(question);
      expect(result?.needsHuman).toBe(true);
      expect(result?.reply).toContain("tratada diretamente pelo especialista");
      expect(result?.reply.toLowerCase()).not.toContain("plano mensal");
    }
  });

  it("treats media as receipt only inside a payment context", () => {
    const image: Record<string, unknown> = {
      text: "",
      messageType: "imageMessage",
      hasMedia: true,
      media: {}
    };

    expect(isReceiptMessage(image as never, { lead_profile: { stage: "technical_support" } })).toBe(false);
    expect(isReceiptMessage(image as never, { lead_profile: { stage: "awaiting_payment" } })).toBe(true);
    expect(isReceiptMessage({ ...image, text: "Segue o comprovante" } as never, {})).toBe(true);
  });
});
