import "server-only";
import { createOpenAIClient, getSalesAgentOpenAIModel } from "@/lib/openai/client";
import { executeObservedOpenAICall } from "@/services/ai/openai-call-observer";

export type SpecialistInterventionAnalysis = {
  inferred_intent: string;
  inferred_stage: string;
  inferred_objection: string;
  inferred_customer_state: string;
  inferred_specialist_action: string;
  why_specialist_intervened: string;
  style_notes: string;
  summary: string;
  next_best_action: string;
  learned_pattern: string;
};

type AnalyzeSpecialistInterventionInput = {
  conversationId?: string | null;
  customerLastMessage?: string | null;
  botPreviousMessage?: string | null;
  specialistMessage: string;
  conversationExcerpt: string;
  leadProfile: Record<string, unknown>;
};

const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    inferred_intent: { type: "string" },
    inferred_stage: { type: "string" },
    inferred_objection: { type: "string" },
    inferred_customer_state: { type: "string" },
    inferred_specialist_action: { type: "string" },
    why_specialist_intervened: { type: "string" },
    style_notes: { type: "string" },
    summary: { type: "string" },
    next_best_action: { type: "string" },
    learned_pattern: { type: "string" }
  },
  required: [
    "inferred_intent",
    "inferred_stage",
    "inferred_objection",
    "inferred_customer_state",
    "inferred_specialist_action",
    "why_specialist_intervened",
    "style_notes",
    "summary",
    "next_best_action",
    "learned_pattern"
  ]
} as const;

const ANALYSIS_PROMPT = [
  "Analise esta intervencao humana em uma conversa de vendas da UNITV.",
  "Identifique o que o especialista fez, por que provavelmente interveio e quais padroes de escrita devem ser aprendidos.",
  "Nao invente fatos. Retorne JSON curto.",
  "Use categorias comerciais simples para intencao, etapa, acao e motivo.",
  "As notas de estilo devem ensinar a logica, sem recomendar copia literal."
].join("\n");

export class SpecialistInterventionAnalysisService {
  async analyzeSpecialistIntervention(input: AnalyzeSpecialistInterventionInput): Promise<SpecialistInterventionAnalysis> {
    const fallback = inferSpecialistInterventionLocally(input);
    if (!process.env.OPENAI_API_KEY) {
      return fallback;
    }

    try {
      const model = getSalesAgentOpenAIModel();
      const response = await executeObservedOpenAICall(
        { callType: "specialist_intervention_analysis", model, conversationId: input.conversationId },
        () => createOpenAIClient().responses.create({
        model,
        input: [
          { role: "system", content: [{ type: "input_text", text: ANALYSIS_PROMPT }] },
          { role: "user", content: [{ type: "input_text", text: JSON.stringify(input) }] }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "unitv_specialist_intervention",
            schema: ANALYSIS_SCHEMA,
            strict: true
          }
        },
        max_output_tokens: 240
      })
      );
      if (!response) {
        return fallback;
      }
      return { ...fallback, ...(JSON.parse(response.output_text || "{}") as SpecialistInterventionAnalysis) };
    } catch {
      return fallback;
    }
  }
}

export function inferSpecialistInterventionLocally(input: AnalyzeSpecialistInterventionInput): SpecialistInterventionAnalysis {
  const customer = normalize(input.customerLastMessage || "");
  const bot = normalize(input.botPreviousMessage || "");
  const specialist = normalize(input.specialistMessage);
  const downloaded = /ja baixei|baixei|ja instalei|instalei/.test(customer);
  const notPaid = /nao paguei|ainda nao paguei/.test(customer);
  const monthly = /\bmensal\b/.test(customer);
  const tvbox = /tv box|android tv/.test(customer);
  const alreadyUsed = /ja usei|ja conheco|ja tenho/.test(customer);
  const rechargeLater = /\b(mais tarde|depois|daqui a pouco|quando eu chegar)\b/.test(customer) &&
    /\b(faco|fazer|pago|pagar|recarga|fecho|fechar)\b/.test(customer);
  const specialOffer = /\b(condicao especial|adquirir novos clientes|fechar pra voce|17[,.]90|17[,.]9|3 telas|tres telas)\b/.test(specialist);
  const repeatedQuestion = downloaded && /ja baixou|voce baixou|baixou\?/.test(bot);
  const improperReceipt = notPaid && /comprovante|se ja pagou/.test(bot);

  let intent = "outro";
  let stage = String(input.leadProfile.stage || input.leadProfile.etapa_atual || "qualificacao");
  let action = "respondeu_duvida";
  let why = "outro";
  let pattern = "reconhecer_contexto_e_avancar";
  let nextBestAction = "continuar_conversa_com_pergunta_unica";

  if (rechargeLater || specialOffer) {
    intent = "pre_venda_recarga";
    stage = "pre_sale_recharge_intent";
    action = specialOffer ? "ofereceu_condicao_especial_baixa_pressao" : "manteve_venda_aberta";
    why = "cliente_quente_faria_depois";
    pattern = "cliente_faz_depois_pedir_permissao_pix_4h";
    nextBestAction = "agendar_followup_4h_pedir_permissao_pix";
  } else if (downloaded) {
    intent = "ativacao";
    stage = "ativacao";
    action = "confirmou_proximo_passo";
    why = repeatedQuestion ? "bot_repetiu_pergunta" : "bot_nao_entendeu_contexto";
    pattern = "cliente_ja_baixou_ir_para_ativacao";
    nextBestAction = "cliente_escolher_teste_ou_plano";
  } else if (notPaid) {
    intent = "pagamento";
    stage = "escolha_plano";
    action = "corrigiu_bot";
    why = improperReceipt ? "bot_pediu_comprovante_indevido" : "bot_nao_entendeu_contexto";
    pattern = "cliente_nao_pagou_oferecer_plano_ou_teste";
    nextBestAction = "cliente_escolher_plano_ou_teste";
  } else if (monthly) {
    intent = "pagamento";
    stage = "pagamento";
    action = /pix|cartao/.test(specialist) ? "conduziu_pagamento" : "confirmou_proximo_passo";
    why = "cliente_quente";
    pattern = "plano_escolhido_avancar_para_pagamento";
    nextBestAction = "cliente_escolher_pix_ou_cartao";
  } else if (tvbox) {
    intent = "instalacao";
    stage = "instalacao";
    action = "explicou_instalacao";
    why = "suporte_tecnico";
    pattern = "aparelho_informado_personalizar_instalacao";
    nextBestAction = "cliente_escolher_apk_ou_downloader";
  } else if (alreadyUsed) {
    intent = "recarga";
    stage = "ativacao";
    action = "confirmou_proximo_passo";
    why = "cliente_quente";
    pattern = "cliente_ja_conhece_ir_para_renovacao_ou_ativacao";
    nextBestAction = "cliente_escolher_renovacao_ou_novo_plano";
  }

  return {
    inferred_intent: intent,
    inferred_stage: stage,
    inferred_objection: String(input.leadProfile.main_objection || input.leadProfile.objecao_principal || "nenhuma"),
    inferred_customer_state: downloaded ? "app_baixado" : notPaid ? "nao_pagou" : monthly ? "plano_escolhido" : "em_atendimento",
    inferred_specialist_action: action,
    why_specialist_intervened: why,
    style_notes: "Reconhece o que o cliente disse, usa frases curtas, evita menu e faz uma pergunta por vez.",
    summary: `Especialista ${action.replace(/_/g, " ")} e conduziu a conversa para o proximo passo.`,
    next_best_action: nextBestAction,
    learned_pattern: pattern
  };
}

function normalize(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
