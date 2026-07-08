import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type TrainingMessageRole = "customer" | "assistant" | "system" | "human_agent" | "tool";

export type TrainingMessage = {
  id?: string | null;
  role: TrainingMessageRole;
  content?: string | null;
  content_type?: string | null;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type TrainingConversationRecord = {
  id: string;
  customer_id?: string | null;
  labels: string[];
  first_message_at?: string | null;
  payment_confirmed_at?: string | null;
  metadata?: Record<string, unknown> | null;
  customer?: {
    id?: string | null;
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
  orders: Array<Record<string, unknown>>;
  messages: TrainingMessage[];
};

export type TrainingExample = {
  source_conversation_id: string;
  quality: "approved_candidate" | "needs_human_review" | "bad_agent_example";
  tags: string[];
  lead_stage: string;
  context_summary: string;
  customer_message: string;
  ideal_response: string;
  why_this_is_good: string;
  review_status: "pending" | "approved" | "rejected";
  reviewer_notes: string | null;
  approved_by: string | null;
  approved_at: string | null;
};

export type TrainingArtifacts = {
  raw: TrainingConversationRecord[];
  sanitized: Array<Record<string, unknown>>;
  fineTuningJsonl: string;
  review: TrainingExample[];
  bad: TrainingExample[];
  report: {
    total_paid_conversations: number;
    total_messages_analyzed: number;
    total_candidates_generated: number;
    total_rejected: number;
    total_needs_human_review: number;
    patterns: string[];
    bot_errors: string[];
  };
};

type PaidConversationsSource = {
  fetchPaidConversationRecords(input: { limit: number; pageSize: number }): Promise<TrainingConversationRecord[]>;
};

const PAID_ORDER_STATUSES = new Set(["paid", "code_reserved", "code_sent"]);
const MUTABLE_FACT_PLACEHOLDER = "{{DADO_MUTAVEL}}";

export class PaidConversationsExporter {
  constructor(private readonly source: PaidConversationsSource) {}

  async export(input: { outputRoot?: string; date?: Date; limit?: number; pageSize?: number } = {}) {
    const date = input.date || new Date();
    const dateStamp = toDateStamp(date);
    const outputRoot = input.outputRoot || path.join(process.cwd(), "data", "training");
    const records = await this.source.fetchPaidConversationRecords({
      limit: input.limit || 500,
      pageSize: input.pageSize || 100
    });
    const artifacts = buildTrainingArtifacts(records);
    const paths = {
      raw: path.join(outputRoot, "raw", `paid-conversations-${dateStamp}.json`),
      sanitized: path.join(outputRoot, "processed", `paid-conversations-sanitized-${dateStamp}.json`),
      jsonl: path.join(outputRoot, "datasets", `fine-tuning-candidates-${dateStamp}.jsonl`),
      review: path.join(outputRoot, "review", `needs-human-review-${dateStamp}.json`),
      bad: path.join(outputRoot, "errors", `bad-agent-examples-${dateStamp}.json`)
    };

    await Promise.all(Object.values(paths).map((filePath) => mkdir(path.dirname(filePath), { recursive: true })));
    await writeFile(paths.raw, JSON.stringify(artifacts.raw, null, 2), "utf8");
    await writeFile(paths.sanitized, JSON.stringify(artifacts.sanitized, null, 2), "utf8");
    await writeFile(paths.jsonl, artifacts.fineTuningJsonl, "utf8");
    await writeFile(paths.review, JSON.stringify(artifacts.review, null, 2), "utf8");
    await writeFile(paths.bad, JSON.stringify(artifacts.bad, null, 2), "utf8");

    return { paths, report: artifacts.report };
  }
}

export class SupabasePaidConversationsSource implements PaidConversationsSource {
  constructor(private readonly supabase: SupabaseReadClient) {}

  async fetchPaidConversationRecords(input: { limit: number; pageSize: number }) {
    const paidCustomerIds = await this.fetchPaidCustomerIds(input.limit, input.pageSize);
    const paidConversations = await this.fetchConversationsForCustomers(paidCustomerIds, input.limit);
    const labeledConversations = await this.fetchMetadataPaidConversations(input.limit, input.pageSize);
    const byId = new Map<string, TrainingConversationRecord>();
    for (const record of [...paidConversations, ...labeledConversations]) {
      byId.set(record.id, record);
    }
    return Array.from(byId.values()).slice(0, input.limit);
  }

  private async fetchPaidCustomerIds(limit: number, pageSize: number) {
    const ids = new Set<string>();
    for (let from = 0; ids.size < limit; from += pageSize) {
      const { data, error } = await this.supabase
        .from("orders")
        .select("customer_id,status")
        .in("status", Array.from(PAID_ORDER_STATUSES))
        .range(from, from + pageSize - 1);
      if (error) throw error;
      const rows = (data || []) as Array<{ customer_id?: string | null }>;
      rows.forEach((row) => {
        if (row.customer_id) ids.add(row.customer_id);
      });
      if (rows.length < pageSize) break;
    }
    return Array.from(ids).slice(0, limit);
  }

  private async fetchConversationsForCustomers(customerIds: string[], limit: number) {
    const records: TrainingConversationRecord[] = [];
    for (const chunk of chunkArray(customerIds, 50)) {
      const { data, error } = await this.supabase
        .from("conversations")
        .select("*, customers(id,name,phone,email,metadata)")
        .in("customer_id", chunk)
        .eq("channel", "whatsapp")
        .order("created_at", { ascending: true });
      if (error) throw error;
      for (const conversation of (data || []) as Array<Record<string, unknown>>) {
        records.push(await this.hydrateConversation(conversation));
        if (records.length >= limit) return records;
      }
    }
    return records;
  }

  private async fetchMetadataPaidConversations(limit: number, pageSize: number) {
    const records: TrainingConversationRecord[] = [];
    for (let from = 0; records.length < limit; from += pageSize) {
      const { data, error } = await this.supabase
        .from("conversations")
        .select("*, customers(id,name,phone,email,metadata)")
        .eq("channel", "whatsapp")
        .order("updated_at", { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      const rows = (data || []) as Array<Record<string, unknown>>;
      for (const conversation of rows) {
        if (hasPaidLabel(conversation, conversation.customers as Record<string, unknown> | undefined)) {
          records.push(await this.hydrateConversation(conversation));
          if (records.length >= limit) return records;
        }
      }
      if (rows.length < pageSize) break;
    }
    return records;
  }

  private async hydrateConversation(conversation: Record<string, unknown>): Promise<TrainingConversationRecord> {
    const conversationId = String(conversation.id);
    const customer = normalizeCustomer(conversation.customers as Record<string, unknown> | null | undefined);
    const customerId = String(conversation.customer_id || customer?.id || "");
    const [{ data: messages, error: messagesError }, { data: orders, error: ordersError }] = await Promise.all([
      this.supabase
        .from("messages")
        .select("id,role,content,content_type,created_at,metadata")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true }),
      this.supabase
        .from("orders")
        .select("id,status,paid_at,created_at,amount_cents,currency,payment_provider,payment_reference,metadata,plan_id")
        .eq("customer_id", customerId)
        .in("status", Array.from(PAID_ORDER_STATUSES))
        .order("paid_at", { ascending: false, nullsFirst: false })
    ]);
    if (messagesError) throw messagesError;
    if (ordersError) throw ordersError;
    const normalizedMessages = ((messages || []) as Array<Record<string, unknown>>).map(normalizeMessage);
    const normalizedOrders = (orders || []) as Array<Record<string, unknown>>;
    return {
      id: conversationId,
      customer_id: customerId || null,
      labels: extractLabels(conversation, customer || undefined),
      first_message_at: normalizedMessages[0]?.created_at || String(conversation.created_at || "") || null,
      payment_confirmed_at: String(normalizedOrders[0]?.paid_at || "") || null,
      metadata: (conversation.metadata as Record<string, unknown>) || {},
      customer,
      orders: normalizedOrders,
      messages: normalizedMessages
    };
  }
}

type SupabaseReadClient = {
  from(table: string): any;
};

export function buildTrainingArtifacts(records: TrainingConversationRecord[]): TrainingArtifacts {
  const paidRecords = records.filter(isPaidConversation);
  const sanitized = paidRecords.map(sanitizeConversationRecord);
  const examples = paidRecords.flatMap(buildExamplesForConversation);
  const bad = examples.filter((example) => example.quality === "bad_agent_example");
  const review = examples.filter((example) => example.quality === "needs_human_review" || example.review_status === "pending");
  const candidates = examples.filter((example) => example.quality === "approved_candidate");
  const fineTuningJsonl = candidates.map(toFineTuningLine).join("\n") + (candidates.length ? "\n" : "");
  return {
    raw: paidRecords,
    sanitized,
    fineTuningJsonl,
    review,
    bad,
    report: {
      total_paid_conversations: paidRecords.length,
      total_messages_analyzed: paidRecords.reduce((sum, record) => sum + record.messages.length, 0),
      total_candidates_generated: candidates.length,
      total_rejected: bad.length,
      total_needs_human_review: review.length,
      patterns: summarizePatterns(examples),
      bot_errors: summarizeErrors(bad)
    }
  };
}

export function isPaidConversation(record: TrainingConversationRecord) {
  return record.labels.some((label) => normalize(label) === "pago") ||
    record.orders.some((order) => PAID_ORDER_STATUSES.has(String(order.status || "").toLowerCase())) ||
    hasPaidLabel({ metadata: record.metadata || {} }, record.customer?.metadata ? { metadata: record.customer.metadata } : undefined);
}

export function sanitizeTrainingText(value: string, record?: TrainingConversationRecord) {
  let text = value || "";
  text = text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "{{EMAIL_CLIENTE}}")
    .replace(/\b(?:\+?55\s?)?\(?\d{2}\)?\s?\d{4,5}[-\s]?\d{4}\b/g, "{{TELEFONE_CLIENTE}}")
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "{{CPF_CLIENTE}}")
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "{{CNPJ}}")
    .replace(/000201[0-9A-Za-z.\-_/+=:;?&%]{40,}/g, "{{PIX_COPIA_E_COLA}}")
    .replace(/https?:\/\/(?:www\.)?mercadopago\.com\.br\/\S+/gi, "{{LINK_PAGAMENTO}}")
    .replace(/https?:\/\/\S+/gi, "{{LINK_PRIVADO}}")
    .replace(/\b(?:payment|pagamento)[_-]?(?:id|reference|ref)?[:\s#-]+[A-Za-z0-9_-]{8,}\b/gi, "{{ID_PAGAMENTO}}")
    .replace(/\bR\$\s?\d+(?:[,.]\d{2})?\b/g, "{{PRECO_PLANO}}")
    .replace(/\b\d{13,20}\b/g, "{{CODIGO_RECARGA}}")
    .replace(/\b(?:codigo|c[oó]digo|chave)\s*[:#-]?\s*\d{6,20}\b/gi, "{{CODIGO_RECARGA}}");
  const names = [record?.customer?.name, record?.customer?.metadata?.pushName]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 1);
  for (const name of names) {
    text = replaceNameParts(text, name);
  }
  const phone = record?.customer?.phone;
  if (phone) {
    text = replaceAllLoose(text, phone, "{{TELEFONE_CLIENTE}}");
  }
  return text.trim();
}

function buildExamplesForConversation(record: TrainingConversationRecord): TrainingExample[] {
  const examples: TrainingExample[] = [];
  const messages = record.messages.filter((message) => message.content?.trim());
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "customer" || !message.content) continue;
    const response = findNextResponse(messages, index);
    if (!response?.content) continue;
    const contextMessages = messages.slice(Math.max(0, index - 6), index);
    const assistantRepeated = response.role === "assistant" && isRepeatedAssistantResponse(messages, index, response.content);
    const unsafeMutable = containsMutableFacts(response.content);
    const hasHumanResponse = response.role === "human_agent";
    const quality = assistantRepeated || unsafeMutable ? "bad_agent_example" : hasHumanResponse ? "needs_human_review" : "approved_candidate";
    const leadStage = inferLeadStage(record, message.content);
    examples.push({
      source_conversation_id: record.id,
      quality,
      tags: buildTags(record, response.role, leadStage, assistantRepeated, unsafeMutable),
      lead_stage: leadStage,
      context_summary: buildContextSummary(record, contextMessages),
      customer_message: sanitizeTrainingText(message.content, record),
      ideal_response: sanitizeForFineTuning(response.content, record),
      why_this_is_good: explainExample(response.role, leadStage, assistantRepeated, unsafeMutable),
      review_status: "pending",
      reviewer_notes: null,
      approved_by: null,
      approved_at: null
    });
  }
  return examples;
}

function findNextResponse(messages: TrainingMessage[], customerIndex: number) {
  for (let index = customerIndex + 1; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "customer") return null;
    if ((message.role === "assistant" || message.role === "human_agent") && message.content?.trim()) {
      return message;
    }
  }
  return null;
}

function sanitizeConversationRecord(record: TrainingConversationRecord) {
  return {
    id: record.id,
    customer_id: "{{CUSTOMER_ID}}",
    labels: record.labels,
    first_message_at: record.first_message_at,
    payment_confirmed_at: record.payment_confirmed_at,
    funnel: sanitizeMetadata(record.metadata || {}),
    customer: {
      id: "{{CUSTOMER_ID}}",
      name: record.customer?.name ? "{{NOME_CLIENTE}}" : null,
      phone: record.customer?.phone ? "{{TELEFONE_CLIENTE}}" : null,
      email: record.customer?.email ? "{{EMAIL_CLIENTE}}" : null
    },
    orders: record.orders.map((order) => ({
      status: order.status,
      paid_at: order.paid_at || null,
      plan_id: order.plan_id ? "{{PLAN_ID}}" : null,
      payment_provider: order.payment_provider || null,
      payment_reference: order.payment_reference ? "{{ID_PAGAMENTO}}" : null
    })),
    messages: record.messages.map((message) => ({
      role: message.role,
      content_type: message.content_type || "text",
      created_at: message.created_at || null,
      content: sanitizeTrainingText(message.content || "", record),
      metadata: sanitizeMetadata(message.metadata || {})
    }))
  };
}

function sanitizeMetadata(metadata: Record<string, unknown>) {
  const allowedKeys = [
    "stage",
    "commercial_stage",
    "etapa_atual",
    "selected_plan",
    "plano_interesse",
    "payment_method",
    "payment_status",
    "device",
    "aparelho",
    "lead_temperature",
    "nivel_interesse",
    "meta_entry_point",
    "meta_ad_source_id",
    "conversation_stage",
    "followup_key"
  ];
  const source = { ...metadata, ...(metadata.lead_profile && typeof metadata.lead_profile === "object" ? metadata.lead_profile as Record<string, unknown> : {}) };
  return Object.fromEntries(
    allowedKeys
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, sanitizeTrainingText(String(source[key]))])
  );
}

function toFineTuningLine(example: TrainingExample) {
  return JSON.stringify({
    messages: [
      {
        role: "system",
        content: [
          "Voce e o agente comercial UNITV.",
          "Responda curto, humano, consultivo e contextual.",
          "Nao coloque precos, links, codigos ou dados mutaveis aprendidos do treino.",
          "Use backend, banco e Obsidian para fatos atuais."
        ].join(" ")
      },
      {
        role: "user",
        content: `Contexto: ${example.context_summary}\nEtapa: ${example.lead_stage}\nMensagem do cliente: ${example.customer_message}`
      },
      { role: "assistant", content: example.ideal_response }
    ],
    metadata: {
      source_conversation_id: example.source_conversation_id,
      tags: example.tags,
      review_status: example.review_status
    }
  });
}

function sanitizeForFineTuning(value: string, record: TrainingConversationRecord) {
  return sanitizeTrainingText(value, record)
    .replace(/\b862585\b/g, "{{CODIGO_DOWNLOADER_ATUAL}}")
    .replace(/\b\d{4,8}\b/g, MUTABLE_FACT_PLACEHOLDER);
}

function containsMutableFacts(value: string) {
  return /https?:\/\/|000201|mercado\s*pago|chave pix|pix copia|R\$\s?\d+|\b\d{13,20}\b/i.test(value);
}

function isRepeatedAssistantResponse(messages: TrainingMessage[], customerIndex: number, response: string) {
  const normalized = normalize(response);
  return messages
    .slice(Math.max(0, customerIndex - 8), customerIndex)
    .some((message) => message.role === "assistant" && normalize(message.content || "") === normalized);
}

function inferLeadStage(record: TrainingConversationRecord, customerMessage: string) {
  const text = normalize(`${customerMessage} ${JSON.stringify(record.metadata || {})}`);
  if (/\bpix|pagamento|pagar|cartao|cartão\b/.test(text)) return "checkout_pagamento";
  if (/\bmensal|trimestral|semestral|anual|plano\b/.test(text)) return "cliente_escolheu_plano";
  if (/\bbaix|instal|downloader|login|senha\b/.test(text)) return "instalacao_suporte";
  if (/\bteste|gratis|gratuito\b/.test(text)) return "teste_gratis";
  if (/\bvalor|quanto|preco|preço\b/.test(text)) return "pergunta_preco";
  if (/\brenovar|recarga|recarregar\b/.test(text)) return "recarga";
  return "conversa_comercial";
}

function buildTags(record: TrainingConversationRecord, responseRole: TrainingMessageRole, leadStage: string, repeated: boolean, mutable: boolean) {
  return [
    "pago",
    leadStage,
    responseRole === "human_agent" ? "intervencao_humana_valiosa" : "resposta_bot",
    record.orders.length ? "pagamento_confirmado" : "etiqueta_pago",
    repeated ? "erro_repeticao" : null,
    mutable ? "contem_dado_mutavel" : null
  ].filter((tag): tag is string => Boolean(tag));
}

function buildContextSummary(record: TrainingConversationRecord, contextMessages: TrainingMessage[]) {
  const stage = String((record.metadata?.lead_profile as Record<string, unknown> | undefined)?.stage || record.metadata?.conversation_stage || "sem_etapa");
  const plan = String((record.metadata?.lead_profile as Record<string, unknown> | undefined)?.selected_plan || record.metadata?.plan_interest || "sem_plano");
  const previous = contextMessages
    .slice(-3)
    .map((message) => `${message.role}: ${sanitizeTrainingText(message.content || "", record)}`)
    .join(" | ");
  return sanitizeTrainingText(`Cliente pago. Etapa ${stage}. Plano ${plan}. Historico recente: ${previous || "inicio da conversa"}.`, record);
}

function explainExample(role: TrainingMessageRole, leadStage: string, repeated: boolean, mutable: boolean) {
  if (repeated) return "Exemplo separado como erro porque repete uma mensagem anterior.";
  if (mutable) return "Exemplo precisa de revisao porque a resposta continha dado mutavel ou sensivel.";
  if (role === "human_agent") return "Resposta humana do especialista em conversa que resultou em pagamento; deve ser revisada antes de virar treino.";
  return `Resposta curta e contextual para a etapa ${leadStage}, em conversa que resultou em pagamento.`;
}

function summarizePatterns(examples: TrainingExample[]) {
  const tags = new Map<string, number>();
  for (const example of examples) {
    for (const tag of example.tags) {
      tags.set(tag, (tags.get(tag) || 0) + 1);
    }
  }
  return Array.from(tags.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag, count]) => `${tag}: ${count}`);
}

function summarizeErrors(examples: TrainingExample[]) {
  const errors = new Set<string>();
  for (const example of examples) {
    if (example.tags.includes("erro_repeticao")) errors.add("respostas repetidas do bot");
    if (example.tags.includes("contem_dado_mutavel")) errors.add("resposta com dado mutavel/sensivel precisa sair do treino");
  }
  return Array.from(errors);
}

function normalizeCustomer(customer?: Record<string, unknown> | null) {
  if (!customer) return null;
  return {
    id: typeof customer.id === "string" ? customer.id : null,
    name: typeof customer.name === "string" ? customer.name : null,
    phone: typeof customer.phone === "string" ? customer.phone : null,
    email: typeof customer.email === "string" ? customer.email : null,
    metadata: customer.metadata && typeof customer.metadata === "object" ? customer.metadata as Record<string, unknown> : {}
  };
}

function normalizeMessage(message: Record<string, unknown>): TrainingMessage {
  const role = String(message.role || "system") as TrainingMessageRole;
  return {
    id: typeof message.id === "string" ? message.id : null,
    role,
    content: typeof message.content === "string" ? message.content : "",
    content_type: typeof message.content_type === "string" ? message.content_type : "text",
    created_at: typeof message.created_at === "string" ? message.created_at : null,
    metadata: message.metadata && typeof message.metadata === "object" ? message.metadata as Record<string, unknown> : {}
  };
}

function extractLabels(conversation: Record<string, unknown>, customer?: Record<string, unknown>) {
  const labels = new Set<string>();
  collectLabels(conversation.metadata, labels);
  collectLabels(customer?.metadata, labels);
  if (hasPaidLabel(conversation, customer)) labels.add("PAGO");
  return Array.from(labels);
}

function collectLabels(value: unknown, labels: Set<string>) {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["labels", "label", "tags", "tag", "etiquetas", "etiqueta"]) {
    const raw = record[key];
    if (Array.isArray(raw)) raw.forEach((item) => typeof item === "string" && labels.add(item));
    if (typeof raw === "string") labels.add(raw);
  }
}

function hasPaidLabel(conversation: Record<string, unknown>, customer?: Record<string, unknown>) {
  const text = normalize(JSON.stringify([conversation.metadata || {}, customer?.metadata || {}]));
  return /\b(pago|paid)\b/.test(text) && /\b(label|labels|tag|tags|etiqueta|etiquetas|status)\b/.test(text);
}

function replaceNameParts(text: string, name: string) {
  let result = replaceAllLoose(text, name, "{{NOME_CLIENTE}}");
  for (const part of name.split(/\s+/).filter((item) => item.length >= 3 && normalize(item) !== "cliente")) {
    result = replaceAllLoose(result, part, "{{NOME_CLIENTE}}");
  }
  return result;
}

function replaceAllLoose(text: string, needle: string, replacement: string) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .split(/(\{\{[^{}]+}})/g)
    .map((part) => part.startsWith("{{") && part.endsWith("}}") ? part : part.replace(new RegExp(escaped, "gi"), replacement))
    .join("");
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function toDateStamp(date: Date) {
  return date.toISOString().slice(0, 10);
}
