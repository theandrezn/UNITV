import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminApiKey } from "@/lib/admin/auth";
import { SpecialistTrainingExamplesRepository } from "@/repositories/specialist-training-examples.repository";

export const dynamic = "force-dynamic";

const reviewSchema = z.object({
  review_status: z.enum(["approved", "rejected"]),
  outcome_status: z.enum(["positive", "neutral", "negative"]).optional(),
  approval_reason: z.string().trim().max(500).optional().nullable(),
  outcome_notes: z.string().trim().max(500).optional().nullable()
});

type Dependencies = {
  repository?: Pick<SpecialistTrainingExamplesRepository, "reviewExample">;
};

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ exampleId: string }> }
) {
  return handleTrainingExampleReview(request, params);
}

export async function handleTrainingExampleReview(
  request: NextRequest,
  params: Promise<{ exampleId: string }>,
  dependencies: Dependencies = {}
) {
  const unauthorized = requireAdminApiKey(request);
  if (unauthorized) return unauthorized;

  const payload = reviewSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ status: "error", message: "invalid_review_payload" }, { status: 400 });
  }

  const { exampleId } = await params;
  const reviewer = request.headers.get("x-admin-reviewer")?.trim() || "admin_api";
  const example = await (dependencies.repository || new SpecialistTrainingExamplesRepository()).reviewExample(exampleId, {
    ...payload.data,
    reviewed_by: reviewer
  });

  return NextResponse.json({ status: "ok", example });
}
