import { NextRequest, NextResponse } from "next/server";
import { requireAdminApiKey } from "@/lib/admin/auth";
import { maskSpecialistTrainingText } from "@/lib/whatsapp/specialist-training-privacy";
import { SpecialistTrainingExamplesRepository } from "@/repositories/specialist-training-examples.repository";

export const dynamic = "force-dynamic";

type Dependencies = {
  repository?: Pick<SpecialistTrainingExamplesRepository, "listReviewQueue">;
};

export async function GET(request: NextRequest) {
  return handleTrainingExamplesList(request);
}

export async function handleTrainingExamplesList(request: NextRequest, dependencies: Dependencies = {}) {
  const unauthorized = requireAdminApiKey(request);
  if (unauthorized) return unauthorized;

  const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get("limit") || 50), 1), 100);
  const examples = await (dependencies.repository || new SpecialistTrainingExamplesRepository()).listReviewQueue(limit);

  return NextResponse.json({
    status: "ok",
    examples: examples.map(toReviewableExample)
  });
}

function toReviewableExample(example: Record<string, unknown>) {
  return {
    id: typeof example.id === "string" ? example.id : null,
    created_at: typeof example.created_at === "string" ? example.created_at : null,
    inferred_intent: typeof example.inferred_intent === "string" ? example.inferred_intent : null,
    inferred_stage: typeof example.inferred_stage === "string" ? example.inferred_stage : null,
    inferred_specialist_action: typeof example.inferred_specialist_action === "string" ? example.inferred_specialist_action : null,
    why_specialist_intervened: typeof example.why_specialist_intervened === "string" ? example.why_specialist_intervened : null,
    style_notes: typeof example.style_notes === "string" ? example.style_notes : null,
    success_signal: typeof example.success_signal === "string" ? example.success_signal : null,
    outcome_status: typeof example.outcome_status === "string" ? example.outcome_status : null,
    customer_last_message: maskValue(example.customer_last_message),
    bot_previous_message: maskValue(example.bot_previous_message),
    specialist_message: maskValue(example.specialist_message)
  };
}

function maskValue(value: unknown) {
  return typeof value === "string" ? maskSpecialistTrainingText(value) : null;
}
