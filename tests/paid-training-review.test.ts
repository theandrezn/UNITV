import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  approveReviewDecision,
  loadLatestPaidTrainingReviewSet,
  saveReviewedPaidTrainingExamples,
  toApprovedFineTuningLine,
  validateTrainingTextForApproval,
  type ReviewableTrainingExample
} from "@/services/training/paid-training-reviewer";

vi.mock("@/lib/openai/client", () => ({
  createOpenAIClient: vi.fn(() => {
    throw new Error("OpenAI must not be called by training review");
  })
}));

const root = path.join(process.cwd(), "work", "paid-training-review-test");

function example(overrides: Partial<ReviewableTrainingExample> = {}): ReviewableTrainingExample {
  const base: ReviewableTrainingExample = {
    source_conversation_id: "conversation-1",
    quality: "approved_candidate",
    tags: ["pago", "resposta_bot"],
    lead_stage: "pergunta_preco",
    context_summary: "Cliente pago. Etapa qualified.",
    customer_message: "Quanto fica o mensal?",
    ideal_response: "Voce teria interesse no mensal mesmo?",
    why_this_is_good: "Resposta curta e contextual.",
    review_status: "pending",
    reviewer_notes: null,
    approved_by: null,
    approved_at: null,
    source_file: "memory",
    source_bucket: "candidate",
    bot_response: "Voce teria interesse no mensal mesmo?",
    human_response: null,
    safety: { safe: true, reasons: [] }
  };
  return { ...base, ...overrides };
}

describe("paid training review", () => {
  it("blocks approval for examples with sensitive or mutable data", () => {
    const unsafe = example({
      ideal_response: "Pague no link https://www.mercadopago.com.br/payments/abc R$ 25 codigo 1279320638952037"
    });
    unsafe.safety = validateTrainingTextForApproval(unsafe.ideal_response);

    const reviewed = approveReviewDecision({
      example: unsafe,
      decision: "approved",
      reviewedAt: "2026-07-08T00:00:00.000Z"
    });

    expect(reviewed.decision).toBe("rejected");
    expect(reviewed.rejection_reasons).toContain("link_pagamento_real");
    expect(reviewed.rejection_reasons).toContain("preco_fixo");
    expect(reviewed.rejection_reasons).toContain("codigo_ou_id_real");
  });

  it("keeps edited examples as valid fine-tuning JSONL", () => {
    const reviewed = approveReviewDecision({
      example: example(),
      decision: "needs_edit",
      editedIdealResponse: "Me confirma se voce quer seguir pelo mensal ou prefere testar primeiro?",
      reviewedAt: "2026-07-08T00:00:00.000Z"
    });

    expect(reviewed.decision).toBe("needs_edit");
    const parsed = JSON.parse(toApprovedFineTuningLine({ ...reviewed, decision: "approved" }));
    expect(parsed.messages).toEqual([
      expect.objectContaining({ role: "system" }),
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ role: "assistant", content: "Me confirma se voce quer seguir pelo mensal ou prefere testar primeiro?" })
    ]);
  });

  it("does not include rejected examples in the approved output", async () => {
    await rm(root, { recursive: true, force: true });
    const approved = approveReviewDecision({
      example: example({ source_conversation_id: "approved-1" }),
      decision: "approved",
      reviewedAt: "2026-07-08T00:00:00.000Z"
    });
    const rejected = approveReviewDecision({
      example: example({ source_conversation_id: "rejected-1" }),
      decision: "rejected",
      reviewedAt: "2026-07-08T00:00:00.000Z"
    });

    const result = await saveReviewedPaidTrainingExamples({
      reviewed: [approved, rejected],
      root,
      date: new Date("2026-07-08T00:00:00.000Z")
    });
    const approvedText = await import("node:fs/promises").then((fs) => fs.readFile(result.outputs.approvedJsonl, "utf8"));
    const rejectedText = await import("node:fs/promises").then((fs) => fs.readFile(result.outputs.rejectedJson, "utf8"));

    expect(approvedText).toContain("approved-1");
    expect(approvedText).not.toContain("rejected-1");
    expect(rejectedText).toContain("rejected-1");
    expect(result.report.total_approved).toBe(1);
    expect(result.report.total_rejected).toBe(1);
  });

  it("loads latest exported files without calling OpenAI or database writes", async () => {
    await rm(root, { recursive: true, force: true });
    await mkdir(path.join(root, "datasets"), { recursive: true });
    await mkdir(path.join(root, "review"), { recursive: true });
    await mkdir(path.join(root, "errors"), { recursive: true });
    await writeFile(
      path.join(root, "datasets", "fine-tuning-candidates-2026-07-08.jsonl"),
      `${toApprovedFineTuningLine({ ...approveReviewDecision({ example: example(), decision: "approved", reviewedAt: "2026-07-08T00:00:00.000Z" }), decision: "approved" })}\n`,
      "utf8"
    );
    await writeFile(path.join(root, "review", "needs-human-review-2026-07-08.json"), JSON.stringify([example({ source_conversation_id: "review-1" })]), "utf8");
    await writeFile(path.join(root, "errors", "bad-agent-examples-2026-07-08.json"), JSON.stringify([example({ source_conversation_id: "bad-1", quality: "bad_agent_example" })]), "utf8");

    const loaded = await loadLatestPaidTrainingReviewSet({ root });

    expect(loaded.map((item) => item.source_bucket).sort()).toEqual(["bad", "candidate", "review"]);
    expect(loaded).toHaveLength(3);
  });
});
