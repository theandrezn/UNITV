import { describe, expect, it } from "vitest";

import { getUnitvAgentRuntimeMode, isUnitvPixOnlyMode } from "@/lib/unitv/agent-runtime-mode";

describe("UNITV agent runtime mode", () => {
  it("defaults to the complete agent when the temporary mode is absent", () => {
    expect(getUnitvAgentRuntimeMode({ UNITV_AGENT_MODE: undefined })).toBe("active");
    expect(isUnitvPixOnlyMode({ UNITV_AGENT_MODE: undefined })).toBe(false);
  });

  it("recognizes the temporary Pix-only mode", () => {
    expect(getUnitvAgentRuntimeMode({ UNITV_AGENT_MODE: "pix_only" })).toBe("pix_only");
    expect(isUnitvPixOnlyMode({ UNITV_AGENT_MODE: "pix_only" })).toBe(true);
  });
});
