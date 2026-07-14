import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shouldRunDailyAudit } from "./daily-audit-schedule.mjs";

loadLocalEnv();

const INTERVAL_MS = Number(process.env.FOLLOWUPS_WORKER_INTERVAL_MS || 60_000);
const JOB_URL = process.env.FOLLOWUPS_JOB_URL || "http://127.0.0.1:3000/api/jobs/followups";
const START_DELAY_MS = Number(process.env.FOLLOWUPS_WORKER_START_DELAY_MS || 15_000);
const REQUEST_TIMEOUT_MS = Number(process.env.FOLLOWUPS_WORKER_REQUEST_TIMEOUT_MS || 50_000);
const DAILY_AUDIT_JOB_URL = process.env.DAILY_AUDIT_JOB_URL || "http://127.0.0.1:3000/api/jobs/daily-agent-audit";
const DAILY_AUDIT_TIMEZONE = process.env.UNITV_AUDIT_TIMEZONE || "America/Sao_Paulo";
const DAILY_AUDIT_HOUR = Number(process.env.UNITV_DAILY_AUDIT_HOUR || 23);
const DAILY_AUDIT_MINUTE = Number(process.env.UNITV_DAILY_AUDIT_MINUTE || 55);
const DAILY_AUDIT_ENABLED = process.env.UNITV_DAILY_AUDIT_ENABLED !== "false";
const FOLLOWUP_MODE = process.env.UNITV_FOLLOWUP_MODE === "send" ? "send" : "shadow";

let running = false;
let dailyAuditRunning = false;
let lastDailyAuditRunKey = null;

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
      headers: { "x-admin-api-key": adminApiKey, "x-unitv-followup-mode": FOLLOWUP_MODE },
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

async function runDailyAudit(now = new Date()) {
  if (!DAILY_AUDIT_ENABLED) {
    return;
  }
  if (dailyAuditRunning) {
    console.warn("[daily-audit-worker] previous audit is still running; skipping this tick.");
    return;
  }

  const schedule = shouldRunDailyAudit({
    now,
    timezone: DAILY_AUDIT_TIMEZONE,
    hour: DAILY_AUDIT_HOUR,
    minute: DAILY_AUDIT_MINUTE,
    lastRunKey: lastDailyAuditRunKey
  });
  if (!schedule.shouldRun) {
    return;
  }

  const adminApiKey = process.env.ADMIN_API_KEY;
  if (!adminApiKey) {
    console.error("[daily-audit-worker] ADMIN_API_KEY is not configured.");
    return;
  }

  dailyAuditRunning = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${DAILY_AUDIT_JOB_URL}?send=true`, {
      method: "POST",
      headers: { "x-admin-api-key": adminApiKey },
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) {
      console.error(`[daily-audit-worker] job failed with ${response.status}: ${body}`);
      return;
    }

    lastDailyAuditRunKey = schedule.runKey;
    console.log(`[daily-audit-worker] job ok: ${body}`);
  } catch (error) {
    console.error("[daily-audit-worker] job request failed:", error);
  } finally {
    clearTimeout(timeout);
    dailyAuditRunning = false;
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

async function runJobs() {
  await Promise.all([runFollowups(), runDailyAudit()]);
}

console.log(
  `[followups-worker] started. interval=${INTERVAL_MS}ms timeout=${REQUEST_TIMEOUT_MS}ms url=${JOB_URL} ` +
  `mode=${FOLLOWUP_MODE} ` +
  `daily_audit=${DAILY_AUDIT_ENABLED ? `${DAILY_AUDIT_TIMEZONE} ${String(DAILY_AUDIT_HOUR).padStart(2, "0")}:${String(DAILY_AUDIT_MINUTE).padStart(2, "0")}` : "disabled"}`
);
setTimeout(() => void runJobs(), START_DELAY_MS);
setInterval(() => void runJobs(), INTERVAL_MS);
