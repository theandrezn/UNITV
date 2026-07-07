import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const INTERVAL_MS = Number(process.env.FOLLOWUPS_WORKER_INTERVAL_MS || 60_000);
const JOB_URL = process.env.FOLLOWUPS_JOB_URL || "http://127.0.0.1:3000/api/jobs/followups";

loadLocalEnv();

async function runFollowups() {
  const adminApiKey = process.env.ADMIN_API_KEY;
  if (!adminApiKey) {
    console.error("[followups-worker] ADMIN_API_KEY is not configured.");
    return;
  }

  try {
    const response = await fetch(JOB_URL, {
      method: "POST",
      headers: { "x-admin-api-key": adminApiKey }
    });
    const body = await response.text();

    if (!response.ok) {
      console.error(`[followups-worker] job failed with ${response.status}: ${body}`);
      return;
    }

    console.log(`[followups-worker] job ok: ${body}`);
  } catch (error) {
    console.error("[followups-worker] job request failed:", error);
  }
}

function loadLocalEnv() {
  const envPath = process.env.FOLLOWUPS_ENV_FILE || resolve(process.cwd(), ".env.local");

  try {
    const envFile = readFileSync(envPath, "utf8");
    for (const line of envFile.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }

      const [rawKey, ...rawValueParts] = trimmed.split("=");
      const key = rawKey.trim();
      if (!key || process.env[key] !== undefined) {
        continue;
      }

      process.env[key] = rawValueParts.join("=").trim().replace(/^['"]|['"]$/g, "");
    }
  } catch (error) {
    console.error(`[followups-worker] could not load ${envPath}:`, error);
  }
}

console.log(`[followups-worker] started. interval=${INTERVAL_MS}ms url=${JOB_URL}`);
void runFollowups();
setInterval(() => void runFollowups(), INTERVAL_MS);
