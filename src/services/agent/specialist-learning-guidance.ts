export type SpecialistLearningGuidance = {
  pattern?: string;
  action?: string;
  style?: string;
  avoid?: string;
};

export function buildSpecialistLearningGuidance(
  examples: Array<Record<string, unknown>> = [],
  memories: Array<Record<string, unknown>> = []
): SpecialistLearningGuidance | null {
  const example = examples[0] || {};
  const metadata = example.metadata && typeof example.metadata === "object"
    ? example.metadata as Record<string, unknown>
    : {};
  const memory = memories[0] || {};
  const pattern = safePrinciple(memory.rule || metadata.learned_pattern || metadata.learnedPattern, 240);
  const action = safePrinciple(example.inferred_specialist_action || metadata.next_best_action || metadata.nextBestAction, 140);
  const style = safePrinciple(memory.style_directive || example.style_notes, 180);
  const avoid = Array.isArray(memory.avoid)
    ? safePrinciple(memory.avoid.slice(0, 3).join("; "), 180)
    : undefined;
  const guidance = { pattern, action, style, avoid };
  return Object.values(guidance).some(Boolean) ? guidance : null;
}

function safePrinciple(value: unknown, maxLength: number) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) return undefined;
  if (/(https?:\/\/|r\$|\b\d+[,.]\d{2}\b|\bpix\b|chave|\bUTV-|\b\d{5,}\b)/i.test(text)) return undefined;
  return text.slice(0, maxLength);
}
