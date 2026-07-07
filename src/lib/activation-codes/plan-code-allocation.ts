export type PlanCodeAllocation =
  | { supported: true; codeCount: number; planKey: "mensal" | "trimestral" | "semestral" | "generic" }
  | { supported: false; codeCount: 0; planKey: "anual" | "unknown"; reason: string };

export function getPlanCodeAllocation(order: Record<string, unknown>): PlanCodeAllocation {
  const planKey = readPlanKey(order);
  const durationDays = readPlanDurationDays(order);

  if (planKey.includes("anual") || durationDays >= 360) {
    return {
      supported: false,
      codeCount: 0,
      planKey: "anual",
      reason: "annual_access_not_registered"
    };
  }

  if (planKey.includes("trimestral") || planKey.includes("3_meses") || durationDays === 90) {
    return { supported: true, codeCount: 3, planKey: "trimestral" };
  }

  if (planKey.includes("semestral") || planKey.includes("6_meses") || durationDays === 180) {
    return { supported: true, codeCount: 6, planKey: "semestral" };
  }

  if (planKey.includes("mensal") || durationDays === 30) {
    return { supported: true, codeCount: 1, planKey: "mensal" };
  }

  return { supported: true, codeCount: 1, planKey: "generic" };
}

function readPlanKey(order: Record<string, unknown>) {
  const plans = order.plans;
  const planText =
    plans && typeof plans === "object" && !Array.isArray(plans)
      ? `${String((plans as { slug?: unknown }).slug || "")} ${String((plans as { name?: unknown }).name || "")}`
      : String(order.plan_slug || order.plan_name || order.plan_id || "");

  return normalize(planText);
}

function readPlanDurationDays(order: Record<string, unknown>) {
  const plans = order.plans;
  const rawDuration =
    plans && typeof plans === "object" && !Array.isArray(plans)
      ? (plans as { duration_days?: unknown }).duration_days
      : order.duration_days;

  return Number(rawDuration || 0);
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
