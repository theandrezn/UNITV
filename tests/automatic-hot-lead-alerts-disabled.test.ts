import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("automatic hot-lead messages to Andre", () => {
  it("has no runtime detector, formatter or WhatsApp notification path", () => {
    const root = process.cwd();
    const whatsappSource = readFileSync(resolve(root, "src/services/whatsapp/whatsapp-message.service.ts"), "utf8");
    const envSource = readFileSync(resolve(root, "src/lib/env.ts"), "utf8");

    expect(whatsappSource).not.toContain("HotLeadAlertService");
    expect(whatsappSource).not.toContain("safeNotifyHotLead");
    expect(envSource).not.toContain("UNITV_HOT_LEAD_ALERT");
    expect(existsSync(resolve(root, "src/services/leads/hot-lead-alert.service.ts"))).toBe(false);
    expect(existsSync(resolve(root, "src/lib/unitv/hot-lead-rules.ts"))).toBe(false);
    expect(existsSync(resolve(root, "src/lib/unitv/hot-lead-admin-message.ts"))).toBe(false);
  });
});
