import { describe, expect, it } from "vitest";
import {
  GREETING_FIRST_FOLLOWUP_DELAY_MS,
  GREETING_MAX_FOLLOWUPS,
  getNextGreetingBusinessOpening,
  getNextGreetingRecoveryDueAt,
  isGreetingBusinessHours
} from "@/lib/greeting-followup-policy";

describe("greeting follow-up zero-token policy", () => {
  it("uses a 30 minute first delay and at most two attempts", () => {
    expect(GREETING_FIRST_FOLLOWUP_DELAY_MS).toBe(30 * 60 * 1000);
    expect(GREETING_MAX_FOLLOWUPS).toBe(2);
  });

  it("schedules the second attempt for 10:00 in Sao Paulo on the next day", () => {
    expect(getNextGreetingRecoveryDueAt(1, new Date("2026-07-06T12:00:00.000Z")))
      .toBe("2026-07-07T13:00:00.000Z");
    expect(getNextGreetingRecoveryDueAt(2, new Date("2026-07-06T12:00:00.000Z"))).toBeNull();
  });

  it("enforces the 09:00 to 20:30 Sao Paulo business window", () => {
    expect(isGreetingBusinessHours(new Date("2026-07-06T11:59:59.000Z"))).toBe(false);
    expect(isGreetingBusinessHours(new Date("2026-07-06T12:00:00.000Z"))).toBe(true);
    expect(isGreetingBusinessHours(new Date("2026-07-06T23:30:00.000Z"))).toBe(true);
    expect(isGreetingBusinessHours(new Date("2026-07-06T23:31:00.000Z"))).toBe(false);
    expect(getNextGreetingBusinessOpening(new Date("2026-07-07T00:00:00.000Z")).toISOString())
      .toBe("2026-07-07T12:00:00.000Z");
  });
});
