import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  executeObservedOpenAICall,
  getOpenAICircuitOpenUntil,
  resetOpenAICircuitForTests
} from "@/services/ai/openai-call-observer";

describe("OpenAI call observer", () => {
  afterEach(() => resetOpenAICircuitForTests());

  it("opens a quota circuit after 429 and prevents repeated paid attempts", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("quota exhausted"), { status: 429, code: "insufficient_quota" });
    });

    await expect(
      executeObservedOpenAICall({ callType: "sales_response", model: "gpt-5.4-mini" }, request)
    ).rejects.toThrow("quota exhausted");
    expect(getOpenAICircuitOpenUntil()).toBeGreaterThan(Date.now());

    await expect(
      executeObservedOpenAICall({ callType: "sales_response", model: "gpt-5.4-mini" }, request)
    ).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps the usage payload available to the caller after a successful request", async () => {
    const response = {
      output_text: "{}",
      usage: {
        input_tokens: 120,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens: 25,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 145
      }
    };

    await expect(
      executeObservedOpenAICall({ callType: "context_interpretation", model: "gpt-5.4-mini" }, async () => response)
    ).resolves.toBe(response);
  });
});
