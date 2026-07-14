import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getStructuredKnowledgeContext, getStructuredKnowledgeMetadata } from "@/lib/unitv/structured-knowledge";

describe("compiled Obsidian knowledge", () => {
  it("loads a valid structured artifact and retrieves capability guidance", () => {
    expect(getStructuredKnowledgeMetadata()).toMatchObject({ schema_version: 1, validation_errors: 0 });

    const guidance = getStructuredKnowledgeContext({
      query: "LG antiga sem Android e sem Play Store nao deu certo",
      stage: "awaiting_download_installation",
      limit: 8
    });

    expect(guidance.length).toBeGreaterThan(0);
    expect(guidance.some((item) => /android|play store|incompati|instala/i.test(item.guidance))).toBe(true);
  });
});
