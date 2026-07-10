import { describe, expect, it } from "vitest";
import { shouldRunDailyAudit } from "../scripts/daily-audit-schedule.mjs";

describe("daily audit schedule", () => {
  it("runs once at the configured Sao Paulo minute", () => {
    const result = shouldRunDailyAudit({
      now: new Date("2026-07-10T02:55:00.000Z"),
      timezone: "America/Sao_Paulo",
      hour: 23,
      minute: 55
    });

    expect(result).toEqual({ runKey: "2026-07-09:23:55", shouldRun: true });
  });

  it("does not run twice for the same daily key or outside the scheduled minute", () => {
    expect(shouldRunDailyAudit({
      now: new Date("2026-07-10T02:55:00.000Z"),
      timezone: "America/Sao_Paulo",
      hour: 23,
      minute: 55,
      lastRunKey: "2026-07-09:23:55"
    }).shouldRun).toBe(false);

    expect(shouldRunDailyAudit({
      now: new Date("2026-07-10T02:54:00.000Z"),
      timezone: "America/Sao_Paulo",
      hour: 23,
      minute: 55
    }).shouldRun).toBe(false);
  });
});
