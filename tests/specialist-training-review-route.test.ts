import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

import { handleTrainingExamplesList as listReviewQueue } from "@/app/api/admin/training-examples/route";
import { handleTrainingExampleReview as reviewExample } from "@/app/api/admin/training-examples/[exampleId]/route";

describe("specialist training review routes", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.ADMIN_API_KEY = "secret";
  });

  it("keeps the review queue behind the admin key", async () => {
    const response = await listReviewQueue(
      new NextRequest("https://unitv.test/api/admin/training-examples"),
      { repository: { listReviewQueue: vi.fn() } }
    );

    expect(response.status).toBe(401);
  });

  it("returns only reviewable context and approves a positive example", async () => {
    const listRepository = {
      listReviewQueue: vi.fn(async () => [{
        id: "example-1",
        customer_phone: "5511999998888",
        inferred_intent: "ativacao",
        inferred_stage: "awaiting_download_installation",
        specialist_message: "Abre o app e me avisa quando aparecer login.",
        success_signal: "positive",
        outcome_status: "positive"
      }])
    };
    const listResponse = await listReviewQueue(
      new NextRequest("https://unitv.test/api/admin/training-examples", { headers: { "x-admin-api-key": "secret" } }),
      { repository: listRepository }
    );
    const listBody = await listResponse.json();

    expect(listBody.examples[0]).toMatchObject({ id: "example-1", inferred_intent: "ativacao" });
    expect(JSON.stringify(listBody)).not.toContain("5511999998888");

    const reviewRepository = {
      reviewExample: vi.fn(async (_id: string, input: Record<string, unknown>) => ({ id: "example-1", ...input }))
    };
    const reviewResponse = await reviewExample(
      new NextRequest("https://unitv.test/api/admin/training-examples/example-1", {
        method: "PATCH",
        headers: { "x-admin-api-key": "secret", "x-admin-reviewer": "andre", "content-type": "application/json" },
        body: JSON.stringify({ review_status: "approved", outcome_status: "positive", approval_reason: "cliente avancou" })
      }),
      Promise.resolve({ exampleId: "example-1" }),
      { repository: reviewRepository }
    );
    const reviewBody = await reviewResponse.json();

    expect(reviewResponse.status).toBe(200);
    expect(reviewBody.example).toMatchObject({ review_status: "approved", outcome_status: "positive", reviewed_by: "andre" });
    expect(reviewRepository.reviewExample).toHaveBeenCalledWith("example-1", expect.objectContaining({ reviewed_by: "andre" }));
  });
});
