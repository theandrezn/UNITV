import compiledKnowledge from "@/generated/unitv-knowledge.compiled.json";

type CompiledRule = {
  id: string;
  text: string;
  source_file: string;
  heading: string;
  stages: string[];
};

export function getStructuredKnowledgeContext(input: { query: string; stage?: string | null; limit?: number }) {
  const terms = tokenize(input.query);
  const stage = String(input.stage || "");
  const candidates = [
    ...((compiledKnowledge.stage_rules as Record<string, CompiledRule[]>)[stage] || []),
    ...(compiledKnowledge.facts as CompiledRule[]),
    ...(compiledKnowledge.forbidden_responses as CompiledRule[]),
    ...(compiledKnowledge.handoff_conditions as CompiledRule[]),
    ...(compiledKnowledge.compatibility as CompiledRule[]),
    ...(compiledKnowledge.commercial_rules as CompiledRule[]),
    ...(compiledKnowledge.style_examples as CompiledRule[])
  ];
  const unique = new Map(candidates.map((rule) => [rule.id, rule]));
  return [...unique.values()]
    .map((rule) => ({ rule, score: scoreRule(rule, terms, stage) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, input.limit || 8)
    .map(({ rule }) => ({ id: rule.id, guidance: rule.text, source: rule.source_file, heading: rule.heading }));
}

export function getStructuredKnowledgeMetadata() {
  return {
    schema_version: compiledKnowledge.schema_version,
    source_hash: compiledKnowledge.source_hash,
    validation_errors: compiledKnowledge.validation.errors.length,
    validation_warnings: compiledKnowledge.validation.warnings.length
  };
}

function scoreRule(rule: CompiledRule, terms: Set<string>, stage: string) {
  const textTerms = tokenize(`${rule.heading} ${rule.text}`);
  let score = stage && rule.stages.includes(stage) ? 20 : 0;
  for (const term of terms) if (textTerms.has(term)) score += 3;
  if (/nunca|nao deve|proibid/i.test(rule.text)) score += 1;
  return score;
}

function tokenize(value: string) {
  return new Set(value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/\W+/).filter((term) => term.length >= 4));
}
