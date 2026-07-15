export type UnitvAgentRuntimeMode = "active" | "pix_only";

type UnitvAgentRuntimeEnv = { UNITV_AGENT_MODE?: string };

export function getUnitvAgentRuntimeMode(
  env: UnitvAgentRuntimeEnv = { UNITV_AGENT_MODE: process.env.UNITV_AGENT_MODE }
): UnitvAgentRuntimeMode {
  return env.UNITV_AGENT_MODE?.trim().toLowerCase() === "pix_only" ? "pix_only" : "active";
}

export function isUnitvPixOnlyMode(
  env: UnitvAgentRuntimeEnv = { UNITV_AGENT_MODE: process.env.UNITV_AGENT_MODE }
) {
  return getUnitvAgentRuntimeMode(env) === "pix_only";
}
