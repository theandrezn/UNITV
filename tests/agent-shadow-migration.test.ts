import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("agent shadow and device migration", () => {
  const sql = readFileSync(path.resolve(process.cwd(), "supabase/migrations/20260714163056_agent_shadow_device_and_learning_quality.sql"), "utf8");

  it("creates capability fields, a protected shadow table and the learning quality gate", () => {
    for (const field of [
      "device_brand", "device_type", "operating_system", "has_play_store", "android_confirmed",
      "compatibility_status", "installation_attempt_status"
    ]) expect(sql).toContain(field);
    expect(sql).toContain("create table if not exists public.agent_shadow_decisions");
    expect(sql).toContain("alter table public.agent_shadow_decisions enable row level security");
    expect(sql).toContain("revoke all on table public.agent_shadow_decisions from anon, authenticated");
    expect(sql).toContain("quality_gate_status");
    expect(sql).toContain("status in ('candidate', 'active', 'superseded', 'rejected')");
  });
});
