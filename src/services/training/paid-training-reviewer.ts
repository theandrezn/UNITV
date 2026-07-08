import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TrainingExample } from "@/services/training/paid-conversations-exporter";

export type ReviewDecision = "approved" | "rejected" | "needs_edit";

export type ReviewableTrainingExample = TrainingExample & {
  source_file: string;
  source_bucket: "candidate" | "review" | "bad";
  bot_response?: string | null;
  human_response?: string | null;
  safety: SafetyCheckResult;
};

export type ReviewedTrainingExample = ReviewableTrainingExample & {
  decision: ReviewDecision;
  final_ideal_response: string;
  reviewed_at: string;
  rejection_reasons: string[];
};

export type SafetyCheckResult = {
  safe: boolean;
  reasons: string[];
};

export type ReviewOutputs = {
  approvedJsonl: string;
  rejectedJson: string;
  editedJson: string;
};

export type ReviewReport = {
  total_reviewed: number;
  total_approved: number;
  total_rejected: number;
  total_edited: number;
  main_rejection_reasons: string[];
  good_patterns: string[];
};

export type ReviewResult = {
  outputs: ReviewOutputs;
  report: ReviewReport;
};

type FineTuningLine = {
  messages?: Array<{ role?: string; content?: string }>;
  metadata?: Record<string, unknown>;
};

export async function loadLatestPaidTrainingReviewSet(input: { root?: string } = {}) {
  const root = input.root || path.join(process.cwd(), "data", "training");
  const [candidateFile, reviewFile, badFile] = await Promise.all([
    findLatestFile(path.join(root, "datasets"), /^fine-tuning-candidates-\d{4}-\d{2}-\d{2}\.jsonl$/),
    findLatestFile(path.join(root, "review"), /^needs-human-review-\d{4}-\d{2}-\d{2}\.json$/),
    findLatestFile(path.join(root, "errors"), /^bad-agent-examples-\d{4}-\d{2}-\d{2}\.json$/)
  ]);

  const examples = [
    ...(candidateFile ? await loadCandidateJsonl(candidateFile) : []),
    ...(reviewFile ? await loadTrainingExamplesJson(reviewFile, "review") : []),
    ...(badFile ? await loadTrainingExamplesJson(badFile, "bad") : [])
  ];

  return examples.map((example) => ({
    ...example,
    safety: validateTrainingExampleForApproval(example)
  }));
}

export function validateTrainingExampleForApproval(example: Pick<TrainingExample, "context_summary" | "customer_message" | "ideal_response" | "tags">) {
  const text = [
    example.context_summary,
    example.customer_message,
    example.ideal_response,
    ...(example.tags || [])
  ].join("\n");
  return validateTrainingTextForApproval(text);
}

export function validateTrainingTextForApproval(text: string): SafetyCheckResult {
  const reasons = new Set<string>();
  const value = text || "";

  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)) reasons.add("email_real");
  if (/\b(?:\+?55\s?)?\(?\d{2}\)?\s?\d{4,5}[-\s]?\d{4}\b/.test(value)) reasons.add("telefone_real");
  if (/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(value)) reasons.add("cpf_real");
  if (/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/.test(value)) reasons.add("cnpj_real");
  if (/000201[0-9A-Za-z.\-_/+=:;?&%]{30,}/.test(value)) reasons.add("pix_copia_e_cola_real");
  if (/https?:\/\/(?:www\.)?mercadopago\.com\.br\/\S+/i.test(value)) reasons.add("link_pagamento_real");
  if (/https?:\/\/\S+/i.test(value)) reasons.add("link_real");
  if (/\bR\$\s?\d+(?:[,.]\d{2})?\b/i.test(value)) reasons.add("preco_fixo");
  if (/\b(?:19|20|25|70|120|200)[,.]\d{2}\b/.test(value)) reasons.add("preco_fixo");
  if (/\b\d{13,20}\b/.test(value)) reasons.add("codigo_ou_id_real");
  if (/\b(?:payment|pagamento)[_-]?(?:id|reference|ref)?[:\s#-]+[A-Za-z0-9_-]{8,}\b/i.test(value)) reasons.add("id_pagamento_real");
  if (/\b(chave pix|pix copia|copia e cola)\b/i.test(value)) reasons.add("dado_pix_mutavel");
  if (/\b(?:codigo|c[oó]digo|chave)\s*[:#-]?\s*\d{6,20}\b/i.test(value)) reasons.add("codigo_real");

  return {
    safe: reasons.size === 0,
    reasons: Array.from(reasons)
  };
}

export function approveReviewDecision(input: {
  example: ReviewableTrainingExample;
  decision: ReviewDecision;
  editedIdealResponse?: string | null;
  reviewedAt?: string;
}): ReviewedTrainingExample {
  const finalIdealResponse = input.decision === "needs_edit"
    ? String(input.editedIdealResponse || "").trim()
    : input.example.ideal_response;
  const reviewedAt = input.reviewedAt || new Date().toISOString();
  const reviewed: ReviewedTrainingExample = {
    ...input.example,
    decision: input.decision,
    final_ideal_response: finalIdealResponse,
    reviewed_at: reviewedAt,
    rejection_reasons: []
  };
  const safety = validateTrainingExampleForApproval({ ...input.example, ideal_response: finalIdealResponse });
  reviewed.safety = safety;

  if ((input.decision === "approved" || input.decision === "needs_edit") && !safety.safe) {
    reviewed.decision = "rejected";
    reviewed.rejection_reasons = safety.reasons;
    return reviewed;
  }

  if (input.decision === "needs_edit" && !finalIdealResponse) {
    reviewed.decision = "rejected";
    reviewed.rejection_reasons = ["edited_response_empty"];
  }

  return reviewed;
}

export async function saveReviewedPaidTrainingExamples(input: {
  reviewed: ReviewedTrainingExample[];
  root?: string;
  date?: Date;
}): Promise<ReviewResult> {
  const root = input.root || path.join(process.cwd(), "data", "training");
  const dateStamp = toDateStamp(input.date || new Date());
  const outputs = {
    approvedJsonl: path.join(root, "approved", `approved-fine-tuning-examples-${dateStamp}.jsonl`),
    rejectedJson: path.join(root, "rejected", `rejected-examples-${dateStamp}.json`),
    editedJson: path.join(root, "edited", `edited-examples-${dateStamp}.json`)
  };
  await Promise.all(Object.values(outputs).map((filePath) => mkdir(path.dirname(filePath), { recursive: true })));

  const approved = input.reviewed.filter((example) => example.decision === "approved");
  const rejected = input.reviewed.filter((example) => example.decision === "rejected");
  const edited = input.reviewed.filter((example) => example.decision === "needs_edit");

  await writeFile(outputs.approvedJsonl, approved.map(toApprovedFineTuningLine).join("\n") + (approved.length ? "\n" : ""), "utf8");
  await writeFile(outputs.rejectedJson, JSON.stringify(rejected, null, 2), "utf8");
  await writeFile(outputs.editedJson, JSON.stringify(edited, null, 2), "utf8");

  return {
    outputs,
    report: buildReviewReport(input.reviewed)
  };
}

export function toApprovedFineTuningLine(example: ReviewedTrainingExample) {
  return JSON.stringify({
    messages: [
      {
        role: "system",
        content: [
          "Voce e o agente comercial UNITV.",
          "Responda curto, humano, consultivo e contextual.",
          "Nao coloque precos, links, codigos ou dados mutaveis aprendidos do treino.",
          "Use backend, banco e Obsidian para fatos atuais."
        ].join(" ")
      },
      {
        role: "user",
        content: `Contexto: ${example.context_summary}\nEtapa: ${example.lead_stage}\nMensagem do cliente: ${example.customer_message}`
      },
      { role: "assistant", content: example.final_ideal_response }
    ],
    metadata: {
      source_conversation_id: example.source_conversation_id,
      tags: example.tags,
      review_status: "approved",
      reviewed_at: example.reviewed_at
    }
  });
}

function buildReviewReport(reviewed: ReviewedTrainingExample[]): ReviewReport {
  const rejected = reviewed.filter((example) => example.decision === "rejected");
  const approved = reviewed.filter((example) => example.decision === "approved");
  const edited = reviewed.filter((example) => example.decision === "needs_edit");
  return {
    total_reviewed: reviewed.length,
    total_approved: approved.length,
    total_rejected: rejected.length,
    total_edited: edited.length,
    main_rejection_reasons: countTop(rejected.flatMap((example) => example.rejection_reasons.length ? example.rejection_reasons : ["manual_rejected"])),
    good_patterns: countTop(approved.flatMap((example) => example.tags || []))
  };
}

async function loadCandidateJsonl(filePath: string): Promise<ReviewableTrainingExample[]> {
  const content = await readFile(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => candidateLineToExample(JSON.parse(line) as FineTuningLine, filePath, index));
}

async function loadTrainingExamplesJson(filePath: string, bucket: "review" | "bad"): Promise<ReviewableTrainingExample[]> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as TrainingExample[];
  return parsed.map((example) => ({
    ...example,
    source_file: filePath,
    source_bucket: bucket,
    bot_response: bucket === "bad" ? example.ideal_response : null,
    human_response: example.tags?.includes("intervencao_humana_valiosa") ? example.ideal_response : null,
    safety: validateTrainingExampleForApproval(example)
  }));
}

function candidateLineToExample(line: FineTuningLine, sourceFile: string, index: number): ReviewableTrainingExample {
  const messages = line.messages || [];
  const userContent = messages.find((message) => message.role === "user")?.content || "";
  const idealResponse = messages.find((message) => message.role === "assistant")?.content || "";
  const tags = Array.isArray(line.metadata?.tags) ? line.metadata.tags.map(String) : ["pago", "approved_candidate"];
  const sourceConversationId = String(line.metadata?.source_conversation_id || `jsonl-${index}`);
  const example: ReviewableTrainingExample = {
    source_conversation_id: sourceConversationId,
    quality: "approved_candidate",
    tags,
    lead_stage: extractUserField(userContent, "Etapa") || "conversa_comercial",
    context_summary: extractUserField(userContent, "Contexto") || userContent,
    customer_message: extractUserField(userContent, "Mensagem do cliente") || "",
    ideal_response: idealResponse,
    why_this_is_good: "Candidato exportado automaticamente para revisao humana.",
    review_status: "pending",
    reviewer_notes: null,
    approved_by: null,
    approved_at: null,
    source_file: sourceFile,
    source_bucket: "candidate",
    bot_response: idealResponse,
    human_response: null,
    safety: { safe: true, reasons: [] }
  };
  example.safety = validateTrainingExampleForApproval(example);
  return example;
}

async function findLatestFile(directory: string, pattern: RegExp) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => path.join(directory, entry.name))
      .sort();
    return files.at(-1) || null;
  } catch {
    return null;
  }
}

function extractUserField(content: string, label: string) {
  const pattern = new RegExp(`${escapeRegExp(label)}:\\s*([^\\n]+)`, "i");
  return content.match(pattern)?.[1]?.trim() || null;
}

function countTop(items: string[]) {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([item, count]) => `${item}: ${count}`);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toDateStamp(date: Date) {
  return date.toISOString().slice(0, 10);
}
