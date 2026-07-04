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

    const exact = plans.find((plan) => {
      const name = normalize(String(plan.name || ""));
      const slug = normalize(String(plan.slug || ""));
      const duration = plan.duration_days ? String(plan.duration_days) : "";

      return (
        (name && normalizedText.includes(name)) ||
        (slug && normalizedText.includes(slug)) ||
        (duration && normalizedText.includes(duration))
      );
    });

    return { plan: exact || null, plans };
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
