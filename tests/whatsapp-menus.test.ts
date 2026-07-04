import { describe, expect, it } from "vitest";

import {
  buildPlansMenu,
  CONTINUATION_MENU,
  DEVICE_MENU,
  MAIN_MENU,
  resolveMenuSelection
} from "@/lib/whatsapp/menus";

const plans = [
  { name: "Teste gratis", slug: "teste", price_cents: 0, currency: "BRL", duration_days: 3 },
  { name: "Mensal", slug: "mensal", price_cents: 2500, currency: "BRL", duration_days: 30 },
  { name: "3 meses", slug: "trimestral", price_cents: 7000, currency: "BRL", duration_days: 90 },
  { name: "6 meses", slug: "semestral", price_cents: 12000, currency: "BRL", duration_days: 180 },
  { name: "Anual", slug: "anual", price_cents: 20000, currency: "BRL", duration_days: 365 }
];

describe("WhatsApp interactive menus", () => {
  it("defines clear commercial labels instead of generic option names", () => {
    const labels = MAIN_MENU.sections.flatMap((section) => section.rows.map((row) => row.title));

    expect(labels).toEqual([
      "Ver planos",
      "Fazer teste grátis",
      "Comprar agora",
      "Aprender a instalar",
      "Enviar comprovante",
      "Falar com especialista"
    ]);
    expect(labels.join(" ")).not.toMatch(/Opcao|Item/i);
  });

  it("builds the plans menu from the authoritative Supabase values", () => {
    const menu = buildPlansMenu(plans);

    expect(menu.id).toBe("plans");
    expect(menu.sections[0].rows).toEqual([
      expect.objectContaining({ title: "Mensal - R$ 25,00", rowId: "menu:plans:mensal" }),
      expect.objectContaining({ title: "3 meses - R$ 70,00", rowId: "menu:plans:trimestral" }),
      expect.objectContaining({ title: "6 meses - R$ 120,00", rowId: "menu:plans:semestral" }),
      expect.objectContaining({ title: "Anual - R$ 200,00", rowId: "menu:plans:anual" })
    ]);
    expect(menu.fallbackText).toContain("1️⃣ Mensal - R$ 25,00");
    expect(menu.fallbackText).not.toContain("Teste gratis");
  });

  it("maps interactive row ids directly to commercial intents", () => {
    expect(resolveMenuSelection("menu:main:view_plans", {})).toMatchObject({ intent: "ask_price" });
    expect(resolveMenuSelection("menu:plans:anual", {})).toEqual({
      intent: "buy_plan",
      message: "quero comprar o plano anual"
    });
    expect(resolveMenuSelection("menu:payment:pix", {})).toMatchObject({ intent: "pix_payment" });
  });

  it("maps numeric fallbacks according to the last displayed menu", () => {
    expect(resolveMenuSelection("4", { last_menu_id: "main" })).toMatchObject({ intent: "technical_support" });
    expect(resolveMenuSelection("2", { last_menu_id: "plans" })).toEqual({
      intent: "buy_plan",
      message: "quero comprar o plano 3 meses"
    });
    expect(resolveMenuSelection("1", { last_menu_id: "payment" })).toMatchObject({ intent: "pix_payment" });
  });

  it("keeps device and continuation menus within six choices", () => {
    expect(DEVICE_MENU.sections[0].rows).toHaveLength(6);
    expect(CONTINUATION_MENU.sections[0].rows).toHaveLength(4);
  });
});
