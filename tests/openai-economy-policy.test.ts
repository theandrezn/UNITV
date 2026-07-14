import { describe, expect, it } from "vitest";

import { OPENAI_ECONOMY_POLICY } from "@/lib/openai/economy-policy";

describe("OpenAI economy policy", () => {
  it("enforces the ultra-low token budget for the only ambiguous-turn call", () => {
    expect(OPENAI_ECONOMY_POLICY.contextualDecision).toMatchObject({
      currentMessageCharacters: 180,
      profileValueCharacters: 90,
      specialistGuidanceCharacters: 70,
      recentMessages: 2,
      messageCharacters: 140,
      knowledgeArticles: 1,
      knowledgeCharacters: 240,
      maxOutputTokens: 180
    });
    expect(OPENAI_ECONOMY_POLICY.contextualResponse).toMatchObject({
      recentMessages: 4,
      messageCharacters: 240,
      knowledgeArticles: 2,
      knowledgeCharacters: 420,
      defaultOutputTokens: 100,
      complexOutputTokens: 140
    });
  });
});
