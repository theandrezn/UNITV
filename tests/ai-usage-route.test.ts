import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { summarizeUsage } from "@/app/api/admin/ai-usage/route";

describe("OpenAI usage summary", () => {
  it("groups token usage by call type and model without exposing conversation content", () => {
    const summary = summarizeUsage([
      { metadata: { call_type: "sales_response", model: "gpt-5.4-mini", outcome: "success", input_tokens: 120, cached_input_tokens: 20, output_tokens: 30, reasoning_tokens: 0, total_tokens: 150 } },
      { metadata: { call_type: "sales_response", model: "gpt-5.4-mini", outcome: "error", input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
      { metadata: { call_type: "sales_response", model: "gpt-5.4-mini", outcome: "circuit_open", input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
      { metadata: { call_type: "daily_specialist_learning", model: "gpt-5.5", outcome: "success", input_tokens: 400, cached_input_tokens: 0, output_tokens: 90, reasoning_tokens: 30, total_tokens: 490 } }
    ]);

    expect(summary.totals).toMatchObject({ calls: 4, provider_requests: 3, successful_requests: 2, blocked_attempts: 1, input_tokens: 520, output_tokens: 120, total_tokens: 640, errors: 1 });
    expect(summary.by_call_type.sales_response).toMatchObject({ calls: 3, provider_requests: 2, successful_requests: 1, blocked_attempts: 1, input_tokens: 120, errors: 1 });
    expect(summary.by_model["gpt-5.5"]).toMatchObject({ calls: 1, reasoning_tokens: 30 });
  });
});
