import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("VPS deploy follow-up worker state", () => {
  it("preserves a manually stopped worker across deploys", () => {
    const script = readFileSync(join(process.cwd(), "scripts", "vps-deploy.sh"), "utf8");
    const captureState = script.indexOf("FOLLOWUPS_WAS_RUNNING");
    const reloadApps = script.indexOf("pm2 startOrReload");
    const restoreStoppedState = script.indexOf("pm2 stop unitv-followups-worker");

    expect(captureState).toBeGreaterThan(-1);
    expect(reloadApps).toBeGreaterThan(captureState);
    expect(restoreStoppedState).toBeGreaterThan(reloadApps);
    expect(script).toContain('if [[ "$FOLLOWUPS_WAS_RUNNING" != "true" ]]');
    expect(script.indexOf("pm2 save")).toBeGreaterThan(restoreStoppedState);
  });
});
