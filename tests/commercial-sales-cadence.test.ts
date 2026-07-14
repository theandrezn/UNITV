import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ChatAgentService } from "@/services/agent/chat-agent.service";
import { validateResponseAgainstLeadProfile } from "@/lib/whatsapp/customer-message-safety";

const plan = {
  id: "11111111-1111-4111-8111-111111111111",
  product_id: "22222222-2222-4222-8222-222222222222",
  name: "Plano Mensal",
  slug: "mensal",
  duration_days: 30,
  price_cents: 2090,
  currency: "BRL"
};

function createChatAgent(salesResponseAIService: { generateResponse: ReturnType<typeof vi.fn> }) {
  const plansService = {
    listActivePlans: vi.fn(async () => [plan]),
    findPlanMentionedInText: vi.fn(async () => ({ plan, plans: [plan] }))
  };
  const knowledgeService = {
    searchKnowledge: vi.fn(async () => [])
  };
  const ordersService = {
    createOrder: vi.fn(),
    findLatestOpenOrderByCustomerId: vi.fn(async () => null),
    findLatestOrderByCustomerId: vi.fn(async () => null),
    updateOrder: vi.fn(),
    transitionStatus: vi.fn(),
    transitionToPaid: vi.fn()
  };
  const appSettingsService = {
    getPaymentInstructions: vi.fn(),
    getPixInstructions: vi.fn()
  };
  const agentActionsService = {
    createAgentAction: vi.fn()
  };
  const auditService = {
    createAuditLog: vi.fn()
  };
  const mercadoPagoService = {
    createOrderPreference: vi.fn(),
    createPixPayment: vi.fn(),
    getPayment: vi.fn()
  };
  const activationCodesService = {
    findAvailableCode: vi.fn(),
    findAvailableCodes: vi.fn(async () => []),
    reserveCode: vi.fn(),
    markCodeAsSent: vi.fn(),
    releaseReservedCodesForOrder: vi.fn()
  };

  return new ChatAgentService(
    plansService as never,
    knowledgeService as never,
    ordersService as never,
    appSettingsService as never,
    agentActionsService as never,
    auditService as never,
    mercadoPagoService as never,
    activationCodesService as never,
    salesResponseAIService as never
  );
}

describe("commercial sales cadence", () => {
  it("blocks purchase-assumption language before customer confirms payment intent", () => {
    expect(validateResponseAgainstLeadProfile(
      "Perfeito, entao vamos liberar no celular Android mesmo.",
      { selected_plan: "mensal", next_expected_reply: "promo_confirmation" }
    )).toMatchObject({ valid: false, reason: "assumes_purchase_before_confirmation" });

    expect(validateResponseAgainstLeadProfile(
      "Perfeito, vou gerar o Pix pra voce agora.",
      { selected_plan: "mensal", accepted_special_promo: true }
    ).valid).toBe(true);
  });

  it("falls back to the fixed monthly offer when AI tries to rush activation", async () => {
    const salesResponseAIService = {
      generateResponse: vi.fn(async () => "Perfeito, entao vamos liberar no celular Android mesmo.")
    };
    const service = createChatAgent(salesResponseAIService);

    const result = await service.generateCommercialReply({
      message: "So feito o teste",
      classification: { intent: "unknown", confidence: 0.95, summary: "primeira recarga", suggested_reply: "" },
      customer: { id: "customer-id" },
      conversation: {
        id: "conversation-id",
        metadata: {
          lead_profile: {
            selected_plan: "mensal",
            device: "android_phone",
            last_bot_question: "Voce ja faz a recarga? Se sim, faz a quanto?"
          }
        }
      },
      webhookEventId: "webhook-id"
    });

    expect(salesResponseAIService.generateResponse).toHaveBeenCalled();
    expect(result.responseRule).toBe("contextual_reply");
    expect(result.reply).toContain("R$ 20,90");
    expect(result.reply).toContain("Voce tem interesse?");
    expect(result.reply.toLowerCase()).not.toContain("tela");
    expect(result.reply.toLowerCase()).not.toContain("aparelho");
    expect(result.reply).not.toContain("vamos liberar");
  });
});
