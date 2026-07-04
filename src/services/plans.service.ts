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
        const matchedName = Boolean(name && normalizedText.includes(name));
        const matchedSlug = Boolean(slug && normalizedText.includes(slug));
        const matchedDuration = Boolean(duration && normalizedText.includes(duration));

        return {
          plan,
          matched: matchedName || matchedSlug || matchedDuration,
          score:
            (matchedName ? name.length * 10 + 100 : 0) +
            (matchedSlug ? slug.length + 50 : 0) +
            (matchedDuration ? 10 : 0)
        };
      })
      .filter((candidate) => candidate.matched)
      .sort((a, b) => b.score - a.score);

    return { plan: candidates[0]?.plan || null, plans };
  }
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
