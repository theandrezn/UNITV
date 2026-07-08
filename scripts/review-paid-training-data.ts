import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import {
  approveReviewDecision,
  loadLatestPaidTrainingReviewSet,
  saveReviewedPaidTrainingExamples,
  type ReviewDecision,
  type ReviewableTrainingExample
} from "../src/services/training/paid-training-reviewer";

function readArg(name: string, fallback: string) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

async function main() {
  const root = process.env.TRAINING_REVIEW_ROOT ||
    readArg("data-root", readArg("root", path.join(process.cwd(), "data", "training")));
  const examples = await loadLatestPaidTrainingReviewSet({ root });
  if (!examples.length) {
    console.log("Nenhum exemplo encontrado. Rode primeiro: npm run training:export-paid");
    return;
  }

  const rl = createInterface({ input, output });
  const reviewed = [];
  try {
    for (let index = 0; index < examples.length; index++) {
      const example = examples[index];
      printExample(example, index + 1, examples.length);
      const decision = await askDecision(rl, example);
      if (decision === "quit") {
        break;
      }
      if (decision === "skip") {
        continue;
      }
      let editedIdealResponse: string | null = null;
      if (decision === "needs_edit") {
        editedIdealResponse = await rl.question("Digite a resposta ideal editada: ");
      }
      reviewed.push(approveReviewDecision({
        example,
        decision,
        editedIdealResponse
      }));
    }
  } finally {
    rl.close();
  }

  const result = await saveReviewedPaidTrainingExamples({ reviewed, root });
  console.log("");
  console.log("Revisao concluida.");
  console.log(`Approved JSONL: ${result.outputs.approvedJsonl}`);
  console.log(`Rejected JSON: ${result.outputs.rejectedJson}`);
  console.log(`Edited JSON: ${result.outputs.editedJson}`);
  console.log("");
  console.log(`Total revisado: ${result.report.total_reviewed}`);
  console.log(`Total aprovado: ${result.report.total_approved}`);
  console.log(`Total rejeitado: ${result.report.total_rejected}`);
  console.log(`Total editado: ${result.report.total_edited}`);
  console.log("Principais motivos de rejeicao:");
  for (const reason of result.report.main_rejection_reasons) console.log(`- ${reason}`);
  console.log("Principais padroes bons:");
  for (const pattern of result.report.good_patterns) console.log(`- ${pattern}`);
}

function printExample(example: ReviewableTrainingExample, index: number, total: number) {
  console.log("");
  console.log("=".repeat(80));
  console.log(`Exemplo ${index}/${total} | origem: ${example.source_bucket}`);
  console.log("-".repeat(80));
  console.log(`Contexto: ${example.context_summary || "(sem contexto)"}`);
  console.log(`Mensagem cliente: ${example.customer_message || "(vazia)"}`);
  if (example.bot_response) console.log(`Resposta do bot: ${example.bot_response}`);
  if (example.human_response) console.log(`Resposta humana/Andre: ${example.human_response}`);
  console.log(`Resposta ideal sugerida: ${example.ideal_response || "(vazia)"}`);
  console.log(`Motivo: ${example.why_this_is_good || "(sem motivo)"}`);
  console.log(`Tags: ${(example.tags || []).join(", ") || "(sem tags)"}`);
  if (!example.safety.safe) {
    console.log(`ALERTA: nao pode aprovar sem editar/rejeitar. Motivos: ${example.safety.reasons.join(", ")}`);
  }
}

async function askDecision(rl: ReturnType<typeof createInterface>, example: ReviewableTrainingExample): Promise<ReviewDecision | "skip" | "quit"> {
  while (true) {
    const raw = (await rl.question("Marcar como [a]pproved, [r]ejected, [e]ditar, [s]kip, [q]uit? ")).trim().toLowerCase();
    if (raw === "q" || raw === "quit") {
      return "quit";
    }
    if (raw === "s" || raw === "skip" || raw === "") return "skip";
    if (raw === "r" || raw === "rejected") return "rejected";
    if (raw === "e" || raw === "edit" || raw === "needs_edit") return "needs_edit";
    if (raw === "a" || raw === "approved") {
      if (!example.safety.safe) {
        console.log(`Bloqueado: exemplo contem ${example.safety.reasons.join(", ")}. Edite ou rejeite.`);
        continue;
      }
      return "approved";
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
