import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const openAIResponsesCreate = vi.fn(async (_request: unknown) => ({ output_text: JSON.stringify({ reply: "Perfeito. Vamos seguir com a ativação?" }) }));
vi.mock("@/lib/openai/client", () => ({
  createOpenAIClient: () => ({ responses: { create: openAIResponsesCreate } }),
  getSalesAgentOpenAIModel: () => "gpt-5.5-mini",
  getStrongSalesAgentOpenAIModel: () => "gpt-5.5-mini"
}));

import { buildMaskedConversationExcerpt, maskSpecialistTrainingText } from "@/lib/whatsapp/specialist-training-privacy";
import { SpecialistTrainingExamplesRepository } from "@/repositories/specialist-training-examples.repository";
import { SalesResponseAIService, shouldUseAIResponse } from "@/services/agent/sales-response-ai.service";
import { inferSpecialistInterventionLocally } from "@/services/agent/specialist-intervention-analysis.service";
import { WhatsappMessageService } from "@/services/whatsapp/whatsapp-message.service";

describe("specialist operational learning", () => {
  it("masks documents, Pix keys and access codes before training storage", () => {
    const masked = maskSpecialistTrainingText(
      "CPF 123.456.789-09, CNPJ 67.070.222/0001-51, Pix: 67070222000151, código: ABC12345"
    );

    expect(masked).not.toContain("123.456.789-09");
    expect(masked).not.toContain("67.070.222/0001-51");
    expect(masked).not.toContain("67070222000151");
    expect(masked).not.toContain("ABC12345");
    expect(masked).toContain("[DOCUMENTO_MASCARADO]");
    expect(masked).toContain("[PIX_MASCARADO]");
    expect(masked).toContain("[CODIGO_MASCARADO]");
  });

  it("builds a short masked excerpt with the last eight messages", () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 ? "assistant" : "customer",
      content: index === 9 ? "Pix: 67070222000151" : `mensagem ${index}`
    }));
    const excerpt = buildMaskedConversationExcerpt(messages, "Código: ABC12345");

    expect(excerpt.split("\n")).toHaveLength(9);
    expect(excerpt).not.toContain("67070222000151");
    expect(excerpt).not.toContain("ABC12345");
  });

  it.each([
    ["Já baixei", "Você já baixou?", "ativacao", "bot_repetiu_pergunta", "cliente_ja_baixou_ir_para_ativacao"],
    ["Não paguei ainda", "Se já pagou, envie o comprovante", "pagamento", "bot_pediu_comprovante_indevido", "cliente_nao_pagou_oferecer_plano_ou_teste"],
    ["Mensal", "Qual plano?", "pagamento", "cliente_quente", "plano_escolhido_avancar_para_pagamento"],
    ["TV Box", "Qual aparelho?", "instalacao", "suporte_tecnico", "aparelho_informado_personalizar_instalacao"],
    ["Já usei", "Como instalar?", "recarga", "cliente_quente", "cliente_ja_conhece_ir_para_renovacao_ou_ativacao"]
  ])("learns the expected pattern for %s", (customer, bot, intent, reason, pattern) => {
    const result = inferSpecialistInterventionLocally({
      customerLastMessage: customer,
      botPreviousMessage: bot,
      specialistMessage: "Perfeito. Vou te orientar no próximo passo.",
      conversationExcerpt: "",
      leadProfile: {}
    });

    expect(result.inferred_intent).toBe(intent);
    expect(result.why_specialist_intervened).toBe(reason);
    expect(result.learned_pattern).toBe(pattern);
  });

  it("learns the recharge-later pre-sale pattern from Andre's negotiation", () => {
    const result = inferSpecialistInterventionLocally({
      customerLastMessage: "Mais tarde eu faco",
      botPreviousMessage: "Posso mandar o Pix?",
      specialistMessage: "Fabio, nos estamos com bastante interesse em adquirir novos clientes, consigo fechar pra voce o plano por 17,90 por 3 Telas, o que voce acha?",
      conversationExcerpt: "",
      leadProfile: {}
    });

    expect(result.inferred_intent).toBe("pre_venda_recarga");
    expect(result.why_specialist_intervened).toBe("cliente_quente_faria_depois");
    expect(result.learned_pattern).toBe("cliente_faz_depois_pedir_permissao_pix_4h");
    expect(result.next_best_action).toBe("agendar_followup_4h_pedir_permissao_pix");
  });

  it("stores an analyzed manual message and updates the learned lead profile", async () => {
    const updateConversationMetadata = vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata }));
    const createExample = vi.fn(async (data) => data);
    const analyzeSpecialistIntervention = vi.fn(async () => ({
      inferred_intent: "ativacao",
      inferred_stage: "ativacao",
      inferred_objection: "nenhuma",
      inferred_customer_state: "app_baixado",
      inferred_specialist_action: "corrigiu_bot",
      why_specialist_intervened: "bot_repetiu_pergunta",
      style_notes: "Reconhece o contexto e avança.",
      summary: "Especialista corrigiu repetição.",
      next_best_action: "cliente_escolher_teste_ou_plano",
      learned_pattern: "cliente_ja_baixou_ir_para_ativacao"
    }));
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id", phone: "5511999998888" })) } as never,
      {
        findByExternalConversationId: vi.fn(async () => ({ id: "conversation-id", metadata: { lead_profile: {} } })),
        createConversation: vi.fn(),
        updateConversationMetadata,
        touchConversation: vi.fn(async () => ({}))
      } as never,
      {
        findByExternalMessageId: vi.fn(async () => null),
        createMessage: vi.fn(async (data) => ({ id: "message-id", ...data })),
        listMessagesByConversationId: vi.fn(async () => [
          { role: "customer", content: "Já baixei", created_at: "2026-07-06T18:00:00.000Z" },
          { role: "assistant", content: "Você já baixou?", created_at: "2026-07-06T18:01:00.000Z" }
        ])
      } as never,
      { classify: vi.fn() } as never,
      { generateCommercialReply: vi.fn() } as never,
      { sendTextMessage: vi.fn() } as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      {} as never,
      {} as never,
      {} as never,
      { createExample } as never,
      { analyzeSpecialistIntervention } as never
    );

    const result = await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "manual-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Cliente",
        text: "Perfeito. Então agora vamos ativar. Código: ABC12345",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1783360920,
        fromMe: true,
        isGroup: false
      }
    });

    expect(result.status).toBe("ignored");
    expect(analyzeSpecialistIntervention).toHaveBeenCalledWith(expect.objectContaining({ customerLastMessage: "Já baixei" }));
    expect(createExample).toHaveBeenCalledWith(expect.objectContaining({
      inferred_specialist_action: "corrigiu_bot",
      why_specialist_intervened: "bot_repetiu_pergunta",
      human_intervention_detected: true,
      success_signal: "positive",
      specialist_message: expect.stringContaining("[CODIGO_MASCARADO]")
    }));
    expect(createExample).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        fast_learning: true,
        global_reusable_example: true,
        human_style: "curto_direto_uma_acao",
        max_reply_sentences: 2
      })
    }));
    expect(updateConversationMetadata).toHaveBeenCalledWith("conversation-id", expect.objectContaining({
      lead_profile: expect.objectContaining({
        learned_from_specialist: true,
        learned_pattern: "cliente_ja_baixou_ir_para_ativacao",
        next_best_action: "cliente_escolher_teste_ou_plano"
      })
    }));
  });

  it("stores Andre's low-pressure pre-sale negotiation as a reviewable operational example", async () => {
    const updateConversationMetadata = vi.fn(async (_id, metadata) => ({ id: "conversation-id", metadata }));
    const createExample = vi.fn(async (data) => data);
    const analyzeSpecialistIntervention = vi.fn(async () => ({
      inferred_intent: "pre_venda_recarga",
      inferred_stage: "pre_sale_recharge_intent",
      inferred_objection: "preco",
      inferred_customer_state: "cliente_quente_faria_depois",
      inferred_specialist_action: "ofereceu_condicao_especial_baixa_pressao",
      why_specialist_intervened: "cliente_quente_faria_depois",
      style_notes: "Chamou pelo nome, ofereceu condicao especial e manteve baixa pressao.",
      summary: "Especialista manteve venda aberta.",
      next_best_action: "agendar_followup_4h_pedir_permissao_pix",
      learned_pattern: "cliente_faz_depois_pedir_permissao_pix_4h"
    }));
    const service = new WhatsappMessageService(
      { upsertCustomerByPhone: vi.fn(async () => ({ id: "customer-id", phone: "5511999998888" })) } as never,
      {
        findByExternalConversationId: vi.fn(async () => ({
          id: "conversation-id",
          metadata: { lead_profile: { selected_plan: "mensal", requested_screens: 2 } }
        })),
        createConversation: vi.fn(),
        updateConversationMetadata,
        touchConversation: vi.fn(async () => ({}))
      } as never,
      {
        findByExternalMessageId: vi.fn(async () => null),
        createMessage: vi.fn(async (data) => ({ id: "message-id", ...data })),
        listMessagesByConversationId: vi.fn(async () => [
          { role: "customer", content: "Mais tarde eu faco", created_at: "2026-07-09T15:35:00.000Z" },
          { role: "assistant", content: "?", created_at: "2026-07-09T15:35:30.000Z" }
        ])
      } as never,
      { classify: vi.fn() } as never,
      { generateCommercialReply: vi.fn() } as never,
      { sendTextMessage: vi.fn() } as never,
      { createAuditLog: vi.fn(async () => ({})) } as never,
      {} as never,
      {} as never,
      {} as never,
      { createExample } as never,
      { analyzeSpecialistIntervention } as never
    );

    await service.processIncomingMessage({
      webhookEventId: "webhook-id",
      message: {
        event: "messages.upsert",
        instance: "unitv",
        externalMessageId: "manual-pre-sale-id",
        remoteJid: "5511999998888@s.whatsapp.net",
        phone: "5511999998888",
        contactName: "Fabio",
        text: "Fabio, nos estamos com bastante interesse em adquirir novos clientes, consigo fechar pra voce o plano por 17,90 por 3 Telas, o que voce acha?",
        messageType: "conversation",
        hasMedia: false,
        media: {},
        timestamp: 1783611360,
        fromMe: true,
        isGroup: false
      }
    });

    expect(createExample).toHaveBeenCalledWith(expect.objectContaining({
      inferred_intent: "pre_venda_recarga",
      inferred_stage: "pre_sale_recharge_intent",
      inferred_specialist_action: "ofereceu_condicao_especial_baixa_pressao",
      metadata: expect.objectContaining({
        review_status: "pending_review",
        learnedPattern: "cliente_faz_depois_pedir_permissao_pix_4h",
        tags: expect.arrayContaining(["PRE_SALE", "RECHARGE_LATER", "HUMAN_NEGOTIATION", "SPECIAL_OFFER"])
      })
    }));
    expect(updateConversationMetadata).toHaveBeenCalledWith("conversation-id", expect.objectContaining({
      followup_key: "pre_sale_recharge_later_4h",
      conversation_stage: "pre_sale_recharge_intent",
      payment_intent_status: "later",
      last_detected_intent: "pre_sale_commitment_pending_payment",
      followup_due_at: expect.any(String),
      reason_for_schedule: "manual_pre_sale_negotiation",
      lead_profile: expect.objectContaining({
        stage: "pre_sale_recharge_intent"
      })
    }));
    expect(updateConversationMetadata).toHaveBeenCalledWith("conversation-id", expect.objectContaining({
      lead_profile: expect.objectContaining({
        learned_pattern: "cliente_faz_depois_pedir_permissao_pix_4h",
        next_best_action: "agendar_followup_4h_pedir_permissao_pix"
      })
    }));
  });

  it("ranks a matching positive specialist example first and marks it as used", async () => {
    const candidates = [
      { id: "generic", inferred_intent: "saudacao", success_signal: "neutral", review_status: "approved", outcome_status: "neutral", customer_last_message: "oi", used_count: 0, created_at: "2026-07-06T10:00:00Z" },
      { id: "downloaded", inferred_intent: "ativacao", inferred_stage: "ativacao", success_signal: "positive", customer_last_message: "Já baixei", used_count: 2, created_at: "2026-07-06T09:00:00Z" }
    ].map((example) => example.id === "downloaded"
      ? { ...example, review_status: "approved", outcome_status: "positive" }
      : example);
    const updates: unknown[] = [];
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order", "limit"]) query[method] = vi.fn(() => query);
    query.update = vi.fn((value) => { updates.push(value); return query; });
    query.then = (resolve: (value: unknown) => void) => resolve({ data: candidates, error: null });
    const repository = new SpecialistTrainingExamplesRepository({ from: vi.fn(() => query) } as never);

    const result = await repository.getRelevantSpecialistExamples({
      intent: "ativacao",
      stage: "ativacao",
      customerMessage: "já baixei o aplicativo",
      limit: 1
    });

    expect(result[0].id).toBe("downloaded");
    expect(updates).toContainEqual(expect.objectContaining({ used_count: 3, last_used_at: expect.any(String) }));
  });

  it("uses recent conversation context to retrieve specialist examples for short replies", async () => {
    const candidates = [
      {
        id: "generic",
        inferred_intent: "saudacao",
        success_signal: "neutral",
        review_status: "approved",
        outcome_status: "neutral",
        customer_last_message: "oi",
        conversation_excerpt: "Cliente: oi\nEspecialista: ola",
        used_count: 0,
        created_at: "2026-07-06T10:00:00Z"
      },
      {
        id: "password-support",
        inferred_intent: "instalacao",
        inferred_stage: "active_trial",
        success_signal: "positive",
        review_status: "approved",
        outcome_status: "positive",
        customer_last_message: "Qual e o formato da senha?",
        bot_previous_message: "Voce conseguiu?",
        specialist_message: "Coloca so numero e crie sua senha",
        conversation_excerpt: "Cliente: Ta pedindo senha\nCliente: Vou comecar a testar agora\nEspecialista: Coloca so numero",
        inferred_specialist_action: "orientou_senha",
        style_notes: "Responde a duvida especifica e evita pergunta generica.",
        used_count: 1,
        created_at: "2026-07-06T09:00:00Z"
      }
    ];
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order", "limit"]) query[method] = vi.fn(() => query);
    query.update = vi.fn(() => query);
    query.then = (resolve: (value: unknown) => void) => resolve({ data: candidates, error: null });
    const repository = new SpecialistTrainingExamplesRepository({ from: vi.fn(() => query) } as never);

    const result = await repository.getRelevantSpecialistExamples({
      customerMessage: "ok",
      recentContext: [
        "customer: Ta pedindo senha",
        "customer: Qual e o formato da senha",
        "human_agent: Coloca so numero",
        "customer: Vou comecar a testar agora"
      ].join("\n"),
      limit: 1
    });

    expect(result[0].id).toBe("password-support");
  });

  it("passes only one compact specialist example under the economy policy", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    openAIResponsesCreate.mockClear();
    const examples = Array.from({ length: 5 }, (_, index) => ({
      customer_last_message: `Cliente ${index}`,
      specialist_message: `Especialista ${index}`,
      style_notes: "Pergunta única."
    }));

    await new SalesResponseAIService().generateResponse({
      message: "Já baixei",
      intent: "activation_help",
      leadProfile: { downloaded_app: true },
      specialistExamples: examples
    });

    const request = openAIResponsesCreate.mock.calls[0][0] as { input: Array<{ role: string; content: Array<{ text: string }> }> };
    const context = JSON.parse(request.input[1].content[0].text);
    expect(context.specialist_examples).toHaveLength(1);
  });

  it("passes daily operational learning as principles instead of canned replies", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    openAIResponsesCreate.mockClear();

    await new SalesResponseAIService().generateResponse({
      message: "ok",
      intent: "technical_support",
      leadProfile: { stage: "awaiting_download_installation" },
      learningMemories: [{
        intent: "technical_support",
        stage: "awaiting_download_installation",
        rule: "Interpretar resposta curta pela ultima pergunta e manter a etapa atual.",
        style_directive: "Uma frase curta e um proximo passo claro.",
        avoid: ["reiniciar saudacao"],
        confidence: 0.94
      }]
    });

    const request = openAIResponsesCreate.mock.calls[0][0] as { input: Array<{ role: string; content: Array<{ text: string }> }> };
    const context = JSON.parse(request.input[1].content[0].text);
    expect(context.learned_operational_directives).toEqual([
      expect.objectContaining({ rule: "Interpretar resposta curta pela ultima pergunta e manter a etapa atual." })
    ]);
    expect(context.learned_operational_directives[0]).not.toHaveProperty("specialist_message");
  });

  it("passes fast specialist style directives to avoid long template replies", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    openAIResponsesCreate.mockClear();

    await new SalesResponseAIService().generateResponse({
      message: "ok",
      intent: "activation_help",
      leadProfile: {},
      specialistExamples: [{
        customer_last_message: "Ta pedindo senha",
        specialist_message: "Coloca so numero",
        style_notes: "Resposta curta.",
        success_signal: "positive",
        metadata: {
          fast_learning: true,
          human_style: "curto_direto_uma_acao",
          specialist_message_is_short: true
        }
      }]
    });

    const request = openAIResponsesCreate.mock.calls[0][0] as { input: Array<{ role: string; content: Array<{ text: string }> }> };
    const context = JSON.parse(request.input[1].content[0].text);
    expect(context.specialist_style_directives).toEqual(expect.objectContaining({
      use_fast_learning_examples: true,
      preferred_style: "curto_direto_contextual",
      max_sentences: 2
    }));
  });

  it("activates AI response generation when a relevant specialist example exists", () => {
    expect(shouldUseAIResponse({
      message: "beleza",
      intent: "renewal",
      leadProfile: {},
      recentMessages: [],
      specialistExamplesCount: 1
    })).toBe(true);
  });

  it("keeps the migration private and indexed for relevance lookup", () => {
    const migration = readFileSync("supabase/migrations/20260706192901_enhance_specialist_training_examples.sql", "utf8");
    expect(migration).toContain("specialist_training_examples_relevance_idx");
    expect(migration).toContain("to service_role");
    expect(migration).toContain("revoke all on table public.specialist_training_examples from anon, authenticated");
  });
});
