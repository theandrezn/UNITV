import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const INTERVAL_MS = Number(process.env.FOLLOWUPS_WORKER_INTERVAL_MS || 60_000);
const JOB_URL = process.env.FOLLOWUPS_JOB_URL || "http://127.0.0.1:3000/api/jobs/followups";
const START_DELAY_MS = Number(process.env.FOLLOWUPS_WORKER_START_DELAY_MS || 15_000);
const REQUEST_TIMEOUT_MS = Number(process.env.FOLLOWUPS_WORKER_REQUEST_TIMEOUT_MS || 50_000);

let running = false;

loadLocalEnv();

async function runFollowups() {
  if (running) {
    console.warn("[followups-worker] previous job is still running; skipping this tick.");
    return;
  }

  const adminApiKey = process.env.ADMIN_API_KEY;
  if (!adminApiKey) {
    console.error("[followups-worker] ADMIN_API_KEY is not configured.");
    return;
  }

  running = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(JOB_URL, {
      method: "POST",
      headers: { "x-admin-api-key": adminApiKey },
      signal: controller.signal
    });
    const body = await response.text();

    if (!response.ok) {
      console.error(`[followups-worker] job failed with ${response.status}: ${body}`);
      return;
    }

    console.log(`[followups-worker] job ok: ${body}`);
  } catch (error) {
    console.error("[followups-worker] job request failed:", error);
  } finally {
    clearTimeout(timeout);
    running = false;
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

console.log(`[followups-worker] started. interval=${INTERVAL_MS}ms timeout=${REQUEST_TIMEOUT_MS}ms url=${JOB_URL}`);
setTimeout(() => void runFollowups(), START_DELAY_MS);
setInterval(() => void runFollowups(), INTERVAL_MS);
