import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type StructuredRule = {
  id: string;
  text: string;
  source_file: string;
  heading: string;
  stages: string[];
};

export type CompiledUnitvKnowledge = {
  schema_version: 1;
  source_hash: string;
  generated_at: string;
  facts: StructuredRule[];
  stage_rules: Record<string, StructuredRule[]>;
  forbidden_responses: StructuredRule[];
  handoff_conditions: StructuredRule[];
  compatibility: StructuredRule[];
  commercial_rules: StructuredRule[];
  style_examples: StructuredRule[];
  validation: { errors: string[]; warnings: string[] };
};

const DEFAULT_VAULT = "C:\\Users\\games\\Documents\\UNITV - AGENTE\\UNITV-KNOWLEDGE-BASE";
const OUTPUT = path.resolve(process.cwd(), "src/generated/unitv-knowledge.compiled.json");
const KNOWN_STATES = [
  "new_lead", "welcome_sent", "test_requested", "first_time_check", "device_qualification",
  "download_link_sent", "awaiting_download_installation", "awaiting_test_activation", "price_discovery",
  "monthly_offer_pending", "plan_preference", "plan_selected", "pre_sale_recharge_intent", "pix_permission",
  "pix_sent", "payment_pending", "payment_approved", "code_delivered", "post_sale", "incompatible_device", "human_handoff"
];

export async function compileObsidianKnowledge(basePath = process.env.UNITV_OBSIDIAN_KNOWLEDGE_BASE_PATH || DEFAULT_VAULT) {
  const fileNames = (await readdir(basePath)).filter((name) => name.endsWith(".md")).sort();
  const sources = await Promise.all(fileNames.map(async (fileName) => ({
    fileName,
    content: await readFile(path.join(basePath, fileName), "utf8")
  })));
  const sourceHash = createHash("sha256").update(sources.map((item) => `${item.fileName}\n${item.content}`).join("\n"), "utf8").digest("hex");
  const rules = sources.flatMap(({ fileName, content }) => parseRules(fileName, content));
  const validation = validateRules(rules);
  const stageRules = Object.fromEntries(KNOWN_STATES.map((stage) => [stage, rules.filter((rule) => rule.stages.includes(stage))]));
  const compiled: CompiledUnitvKnowledge = {
    schema_version: 1,
    source_hash: sourceHash,
    generated_at: new Date().toISOString(),
    facts: rules.filter((rule) => isFact(rule) && !isForbidden(rule)),
    stage_rules: stageRules,
    forbidden_responses: rules.filter(isForbidden),
    handoff_conditions: rules.filter((rule) => /10_INTERVENCAO|revenda|revendedor|handoff|atendimento humano|especialista/i.test(`${rule.source_file} ${rule.heading} ${rule.text}`)),
    compatibility: rules.filter((rule) => /08_DOWNLOAD|android|play store|tv box|fire stick|samsung|lg|hq|iphone|roku|compatib/i.test(`${rule.source_file} ${rule.heading} ${rule.text}`)),
    commercial_rules: rules.filter((rule) => /04_FLUXO|05_PLANOS|06_PAGAMENTO|07_CODIGOS|11_OBJECOES/i.test(rule.source_file)),
    style_examples: rules.filter((rule) => /01_IDENTIDADE|12_EXEMPLOS/i.test(rule.source_file)),
    validation
  };
  return compiled;
}

function parseRules(fileName: string, content: string) {
  let heading = "Geral";
  const rules: StructuredRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^#{1,4}\s+/.test(line)) {
      heading = line.replace(/^#{1,4}\s+/, "").trim();
      continue;
    }
    if (!/^(- |\d+\. |> )/.test(line)) continue;
    const text = line.replace(/^(- |\d+\. |> )/, "").trim();
    if (text.length < 8 || containsSensitiveRawData(text)) continue;
    const normalized = normalize(text);
    rules.push({
      id: createHash("sha256").update(`${fileName}|${heading}|${normalized}`, "utf8").digest("hex").slice(0, 20),
      text,
      source_file: fileName,
      heading,
      stages: KNOWN_STATES.filter((stage) => normalized.includes(stage))
    });
  }
  return rules;
}

function validateRules(rules: StructuredRule[]) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, StructuredRule>();
  const polarity = new Map<string, { forbidden: boolean; rule: StructuredRule }>();
  for (const rule of rules) {
    const fingerprint = normalize(rule.text).replace(/\b(nunca|nao|jamais|deve|pode)\b/g, "").replace(/\s+/g, " ").trim();
    const duplicate = seen.get(fingerprint);
    if (duplicate && duplicate.source_file !== rule.source_file) {
      warnings.push(`duplicate_rule:${duplicate.source_file}:${rule.source_file}:${rule.id}`);
    } else {
      seen.set(fingerprint, rule);
    }
    const forbidden = isForbidden(rule);
    const opposite = polarity.get(fingerprint);
    if (opposite && opposite.forbidden !== forbidden && opposite.rule.source_file !== rule.source_file) {
      warnings.push(`contradictory_rule:${opposite.rule.source_file}:${rule.source_file}:${rule.id}`);
    } else if (!opposite) {
      polarity.set(fingerprint, { forbidden, rule });
    }
    if (/(?:r\$\s*)?(?:19[,.]99|25(?:[,.]00)?)(?:\s*reais)?/i.test(rule.text) && !/antig|desativ|nunca|bug|histor|exemplo incorreto|nao usar/i.test(`${rule.heading} ${rule.text}`)) {
      errors.push(`stale_monthly_price:${rule.source_file}:${rule.id}`);
    }
    if (/https?:\/\//i.test(rule.text) && !/(mediafire\.com|youtube\.com|mercadopago)/i.test(rule.text)) {
      warnings.push(`unrecognized_link:${rule.source_file}:${rule.id}`);
    }
    if (/^['"“].+[?!.]['"”]$/.test(rule.text) && !/exemplo|resposta correta/i.test(rule.heading)) {
      warnings.push(`possible_fixed_message:${rule.source_file}:${rule.id}`);
    }
    if (/regra|nunca|obrigatori/i.test(`${rule.heading} ${rule.text}`) && !hasNearbyTestMarker(rule, rules)) {
      warnings.push(`rule_without_test_reference:${rule.source_file}:${rule.id}`);
    }
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

function hasNearbyTestMarker(rule: StructuredRule, rules: StructuredRule[]) {
  return /teste/i.test(`${rule.heading} ${rule.text}`) || rules.some((candidate) =>
    candidate.source_file === rule.source_file && /teste de regressao/i.test(candidate.heading)
  );
}

function isForbidden(rule: StructuredRule) {
  return /nunca|nao deve|proibid|o que nunca fazer/i.test(`${rule.heading} ${rule.text}`);
}

function isFact(rule: StructuredRule) {
  return /03_PERGUNTAS|05_PLANOS|06_PAGAMENTO|07_CODIGOS|08_DOWNLOAD|14_MEMORIA/i.test(rule.source_file);
}

function containsSensitiveRawData(value: string) {
  return /\bsk-proj-|\b\d{11,}\b|@[a-z0-9._-]+\.[a-z]{2,}\b/i.test(value);
}

function normalize(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_]+/g, " ").trim();
}

async function main() {
  const compiled = await compileObsidianKnowledge();
  if (!process.argv.includes("--validate-only")) {
    await mkdir(path.dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, `${JSON.stringify(compiled, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify({
    output: process.argv.includes("--validate-only") ? null : OUTPUT,
    facts: compiled.facts.length,
    forbidden: compiled.forbidden_responses.length,
    compatibility: compiled.compatibility.length,
    errors: compiled.validation.errors,
    warnings: compiled.validation.warnings.length,
    source_hash: compiled.source_hash
  })}\n`);
  if (compiled.validation.errors.length) process.exitCode = 1;
}

void main();
