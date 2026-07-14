import { describe, expect, it } from "vitest";

import { OPENAI_ECONOMY_POLICY } from "@/lib/openai/economy-policy";

describe("OpenAI economy policy", () => {
  it("keeps customer turns compact without removing recent state or knowledge", () => {
    expect(OPENAI_ECONOMY_POLICY.contextualDecision).toMatchObject({
      recentMessages: 4,
      messageCharacters: 240,
      knowledgeArticles: 2,
      knowledgeCharacters: 420,
      maxOutputTokens: 200
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
