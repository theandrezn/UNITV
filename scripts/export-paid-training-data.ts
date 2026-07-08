import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { PaidConversationsExporter, SupabasePaidConversationsSource } from "../src/services/training/paid-conversations-exporter";

function loadEnv(filePath: string) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] ||= value;
  }
}

function readArg(name: string, fallback: string) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

async function main() {
  loadEnv(path.join(process.cwd(), ".env.local"));
  loadEnv(path.join(process.cwd(), ".env"));

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to export paid training data.");
  }

  const outputRoot = readArg("out", path.join(process.cwd(), "data", "training"));
  const limit = Number(readArg("limit", "500"));
  const pageSize = Number(readArg("page-size", "100"));
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const exporter = new PaidConversationsExporter(new SupabasePaidConversationsSource(supabase));
  const result = await exporter.export({
    outputRoot,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 500,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 100
  });

  console.log("UNITV paid-conversation training export completed.");
  console.log(`Raw: ${result.paths.raw}`);
  console.log(`Sanitized: ${result.paths.sanitized}`);
  console.log(`JSONL candidates: ${result.paths.jsonl}`);
  console.log(`Needs review: ${result.paths.review}`);
  console.log(`Bad examples: ${result.paths.bad}`);
  console.log("");
  console.log(`Total conversas PAGO: ${result.report.total_paid_conversations}`);
  console.log(`Total mensagens analisadas: ${result.report.total_messages_analyzed}`);
  console.log(`Total candidatos gerados: ${result.report.total_candidates_generated}`);
  console.log(`Total rejeitados: ${result.report.total_rejected}`);
  console.log(`Total para revisao humana: ${result.report.total_needs_human_review}`);
  console.log("Principais padroes:");
  for (const item of result.report.patterns) console.log(`- ${item}`);
  console.log("Principais erros do bot:");
  for (const item of result.report.bot_errors) console.log(`- ${item}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
