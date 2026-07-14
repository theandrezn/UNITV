import "server-only";
import { PlansRepository } from "@/repositories/plans.repository";

export class PlansService {
  constructor(private readonly plansRepository = new PlansRepository()) {}

  listActivePlans() {
    return this.plansRepository.listActivePlans();
  }

  async findPlanMentionedInText(text: string) {
    const plans = await this.listActivePlans();
    const normalizedText = normalize(text);

    const candidates = plans
      .map((plan) => {
        const name = normalize(String(plan.name || ""));
        const slug = normalize(String(plan.slug || ""));
        const duration = plan.duration_days ? String(plan.duration_days) : "";
        const price = Number(plan.price_cents || 0);
        const priceNumber = price > 0
          ? price % 100 === 0
            ? String(price / 100)
            : `${Math.floor(price / 100)} ${String(price % 100).padStart(2, "0")}`
          : "";
        const matchingAliases = getPlanAliases(plan).filter((alias) => containsNormalizedPhrase(normalizedText, alias));
        const aliasMatches = matchingAliases.length > 0;
        const matchedName = Boolean(name && containsNormalizedPhrase(normalizedText, name));
        const matchedSlug = Boolean(slug && containsNormalizedPhrase(normalizedText, slug));
        const matchedDuration = Boolean(duration && normalizedText.includes(duration));
        const matchedPrice = Boolean(priceNumber && containsNormalizedPhrase(normalizedText, priceNumber));

        return {
          plan,
          matched: matchedName || matchedSlug || matchedDuration || matchedPrice || aliasMatches,
          score:
            (matchedName ? name.length * 10 + 100 : 0) +
            (matchedSlug ? slug.length + 50 : 0) +
            (matchedDuration ? 10 : 0) +
            (matchedPrice ? 80 : 0) +
            (aliasMatches ? 70 + Math.max(...matchingAliases.map((alias) => alias.length), 0) : 0)
        };
      })
      .filter((candidate) => candidate.matched)
      .sort((a, b) => b.score - a.score);

    return { plan: candidates[0]?.plan || null, plans };
  }
}

function containsNormalizedPhrase(text: string, phrase: string) {
  return new RegExp(`(?:^| )${escapeRegExp(phrase)}(?: |$)`).test(text);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getPlanAliases(plan: Record<string, unknown>) {
  const name = normalize(String(plan.name || ""));
  const slug = normalize(String(plan.slug || ""));
  const durationDays = Number(plan.duration_days || 0);
  const base = `${name} ${slug}`;

  if (durationDays === 30 || /\bmensal\b/.test(base)) {
    return ["mensal", "mes", "1 mes", "30 dias"];
  }
  if (durationDays === 90 || /\b(3 meses|trimestral)\b/.test(base)) {
    return ["3 meses", "trimestral", "90 dias", "de 70"];
  }
  if (durationDays === 180 || /\b(6 meses|semestral)\b/.test(base)) {
    return ["6 meses", "semestral", "180 dias", "de 120"];
  }
  if (durationDays === 365 || /\b(anual|1 ano)\b/.test(base)) {
    return ["anual", "1 ano", "12 meses", "365 dias", "de 200"];
  }
  return [];
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
