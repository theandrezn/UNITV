import { describe, expect, it, vi } from "vitest";
import {
  buildTrainingArtifacts,
  isPaidConversation,
  PaidConversationsExporter,
  sanitizeTrainingText,
  type TrainingConversationRecord
} from "@/services/training/paid-conversations-exporter";

const paidConversation: TrainingConversationRecord = {
  id: "conversation-paid",
  customer_id: "customer-paid",
  labels: ["PAGO"],
  first_message_at: "2026-07-08T10:00:00.000Z",
  payment_confirmed_at: "2026-07-08T10:20:00.000Z",
  metadata: { lead_profile: { stage: "checkout", selected_plan: "mensal" } },
  customer: {
    id: "customer-paid",
    name: "Joao Cliente",
    phone: "5511999998888",
    email: "joao@example.com",
    metadata: { labels: ["PAGO"] }
  },
  orders: [{ id: "order-id", status: "code_sent", paid_at: "2026-07-08T10:20:00.000Z", payment_reference: "167711621908" }],
  messages: [
    { role: "customer", content: "Oi, sou Joao Cliente e quero renovar o mensal", created_at: "2026-07-08T10:00:00.000Z" },
    { role: "human_agent", content: "Perfeito, consigo te ajudar com a recarga mensal. Vou te passar o pagamento certinho.", created_at: "2026-07-08T10:01:00.000Z" },
    { role: "customer", content: "Meu email e joao@example.com e telefone 5511999998888", created_at: "2026-07-08T10:02:00.000Z" },
    { role: "assistant", content: "Pague aqui https://www.mercadopago.com.br/payments/abc R$ 25 codigo 1279320638952037", created_at: "2026-07-08T10:03:00.000Z" },
    { role: "customer", content: "Quero continuar pelo mensal", created_at: "2026-07-08T10:04:00.000Z" },
    { role: "assistant", content: "Boa, me confirma se voce ja tem o app instalado ai?", created_at: "2026-07-08T10:05:00.000Z" }
  ]
};

const unpaidConversation: TrainingConversationRecord = {
  id: "conversation-unpaid",
  labels: ["LEAD"],
  orders: [],
  messages: [
    { role: "customer", content: "quanto custa?", created_at: "2026-07-08T10:00:00.000Z" },
    { role: "assistant", content: "Qual plano voce prefere?", created_at: "2026-07-08T10:01:00.000Z" }
  ]
};

describe("paid conversation training export", () => {
  it("exports only conversations with PAGO label or paid orders", () => {
    expect(isPaidConversation(paidConversation)).toBe(true);
    expect(isPaidConversation(unpaidConversation)).toBe(false);

    const artifacts = buildTrainingArtifacts([paidConversation, unpaidConversation]);

    expect(artifacts.raw).toHaveLength(1);
    expect(artifacts.raw[0].id).toBe("conversation-paid");
    expect(artifacts.report.total_paid_conversations).toBe(1);
  });

  it("anonymizes phone, name, email, Pix/payment links, activation codes and prices", () => {
    const text = sanitizeTrainingText(
      "Joao Cliente 5511999998888 joao@example.com 00020126360014br.gov.bcb.pix011467070222000151520400005303986540519.99 https://www.mercadopago.com.br/payments/123 codigo 1279320638952037 R$ 25",
      paidConversation
    );

    expect(text).toContain("{{NOME_CLIENTE}}");
    expect(text).toContain("{{TELEFONE_CLIENTE}}");
    expect(text).toContain("{{EMAIL_CLIENTE}}");
    expect(text).toContain("{{PIX_COPIA_E_COLA}}");
    expect(text).toContain("{{LINK_PAGAMENTO}}");
    expect(text).toContain("{{CODIGO_RECARGA}}");
    expect(text).toContain("{{PRECO_PLANO}}");
    expect(text).not.toContain("Joao");
    expect(text).not.toContain("5511999998888");
    expect(text).not.toContain("joao@example.com");
    expect(text).not.toContain("1279320638952037");
  });

  it("does not include real activation codes in JSONL candidates", () => {
    const artifacts = buildTrainingArtifacts([paidConversation]);

    expect(artifacts.fineTuningJsonl).not.toContain("1279320638952037");
    expect(artifacts.fineTuningJsonl).not.toContain("https://www.mercadopago.com.br");
    expect(artifacts.fineTuningJsonl).not.toContain("R$ 25");
  });

  it("generates valid JSONL compatible with future fine-tuning review", () => {
    const artifacts = buildTrainingArtifacts([paidConversation]);
    const lines = artifacts.fineTuningJsonl.trim().split("\n").filter(Boolean);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.messages).toEqual([
        expect.objectContaining({ role: "system", content: expect.any(String) }),
        expect.objectContaining({ role: "user", content: expect.any(String) }),
        expect.objectContaining({ role: "assistant", content: expect.any(String) })
      ]);
      expect(parsed.metadata.review_status).toBe("pending");
    }
  });

  it("separates bad examples from approved candidates", () => {
    const artifacts = buildTrainingArtifacts([paidConversation]);

    expect(artifacts.bad.length).toBeGreaterThan(0);
    expect(artifacts.bad.some((example) => example.tags.includes("contem_dado_mutavel"))).toBe(true);
    expect(artifacts.report.total_rejected).toBe(artifacts.bad.length);
  });

  it("uses a read-only source contract without calling database writes", async () => {
    const fetchPaidConversationRecords = vi.fn(async () => [paidConversation]);
    const source = {
      fetchPaidConversationRecords,
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn()
    };
    const exporter = new PaidConversationsExporter(source);
    const result = await exporter.export({
      outputRoot: "work/test-training-export",
      date: new Date("2026-07-08T00:00:00.000Z")
    });

    expect(fetchPaidConversationRecords).toHaveBeenCalledWith({ limit: 500, pageSize: 100 });
    expect(source.insert).not.toHaveBeenCalled();
    expect(source.update).not.toHaveBeenCalled();
    expect(source.delete).not.toHaveBeenCalled();
    expect(result.report.total_paid_conversations).toBe(1);
  });
});
