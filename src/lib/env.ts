import "server-only";
import { z } from "zod";

const appEnvSchema = z.enum(["development", "test", "staging", "production"]);

const serverEnvSchema = z.object({
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL"),
  SUPABASE_ANON_KEY: z.string().min(1, "SUPABASE_ANON_KEY is required"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
  SUPABASE_DB_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  OPENAI_MODEL_SALES_AGENT: z.string().optional(),
  OPENAI_MODEL_SALES_AGENT_STRONG: z.string().optional(),
  OPENAI_MODEL_INTENT: z.string().optional(),
  OPENAI_MODEL_TRANSCRIPTION: z.string().optional(),
  UNITV_AUDIO_TRANSCRIPTION_ENABLED: z.string().optional(),
  UNITV_AUDIO_MAX_BYTES: z.string().optional(),
  UNITV_AUDIO_TRANSCRIPT_MAX_CHARS: z.string().optional(),
  UNITV_AI_INTENT_CLASSIFIER_ENABLED: z.string().optional(),
  WHATSAPP_ENABLE_MAIN_MENU: z.string().optional(),
  APP_ENV: appEnvSchema.default("development"),
  APP_BASE_URL: z.string().url("APP_BASE_URL must be a valid URL").optional().or(z.literal("")),
  WEBHOOK_SECRET: z.string().optional(),
  ADMIN_API_KEY: z.string().optional(),
  PAYMENT_INSTRUCTIONS: z.string().optional(),
  MERCADO_PAGO_ACCESS_TOKEN: z.string().optional(),
  MERCADO_PAGO_WEBHOOK_SECRET: z.string().optional(),
  MERCADO_PAGO_PUBLIC_KEY: z.string().optional(),
  MERCADO_PAGO_WEBHOOK_URL: z.string().url("MERCADO_PAGO_WEBHOOK_URL must be a valid URL").optional().or(z.literal("")),
  PIPEBOARD_API_TOKEN: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  META_PIXEL_ID: z.string().optional(),
  META_PAGE_ID: z.string().optional(),
  META_WHATSAPP_PAGE_ID: z.string().optional(),
  DATASET_ID: z.string().optional(),
  META_API_VERSION: z.string().optional(),
  META_TRACKING_ENABLED: z.string().optional(),
  META_TEST_EVENT_CODE: z.string().optional(),
  EVOLUTION_API_URL: z.string().url("EVOLUTION_API_URL must be a valid URL").optional().or(z.literal("")),
  EVOLUTION_API_KEY: z.string().optional(),
  EVOLUTION_INSTANCE_NAME: z.string().optional(),
  EVOLUTION_WEBHOOK_SECRET: z.string().optional(),
  EVOLUTION_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  UNITV_AUDIT_TIMEZONE: z.string().optional(),
  UNITV_DAILY_AUDIT_ENABLED: z.string().optional(),
  UNITV_DAILY_AUDIT_ADMIN_PHONE: z.string().optional(),
  UNITV_DAILY_AUDIT_HOUR: z.string().optional(),
  UNITV_DAILY_AUDIT_MINUTE: z.string().optional(),
  UNITV_MIDDAY_AUDIT_ENABLED: z.string().optional(),
  UNITV_AUDIT_USE_AI_SUMMARY: z.string().optional(),
  OPENAI_MODEL_AUDIT_SUMMARY: z.string().optional(),
  UNITV_MESSAGE_BURST_DEBOUNCE_MS: z.string().optional(),
  UNITV_DAILY_LEARNING_STRONG_MODEL_ENABLED: z.string().optional(),
  UNITV_DAILY_LEARNING_ENABLED: z.string().optional(),
  UNITV_SPECIALIST_AI_ANALYSIS_ENABLED: z.string().optional(),
  OBSIDIAN_KNOWLEDGE_BASE_PATH: z.string().optional(),
  UNITV_OBSIDIAN_KNOWLEDGE_BASE_PATH: z.string().optional()
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type SupabaseServerEnv = Pick<ServerEnv, "SUPABASE_URL" | "SUPABASE_ANON_KEY" | "SUPABASE_SERVICE_ROLE_KEY">;
export type OpenAIEnv = ServerEnv & { OPENAI_API_KEY: string };
export type EvolutionEnv = ServerEnv & {
  EVOLUTION_API_URL: string;
  EVOLUTION_API_KEY: string;
  EVOLUTION_INSTANCE_NAME: string;
};
export type MercadoPagoEnv = ServerEnv & {
  MERCADO_PAGO_ACCESS_TOKEN: string;
  MERCADO_PAGO_WEBHOOK_SECRET: string;
  MERCADO_PAGO_PUBLIC_KEY: string;
  MERCADO_PAGO_WEBHOOK_URL: string;
};
export type MetaConversionsConfig = {
  enabled: boolean;
  accessToken: string | null;
  datasetId: string | null;
  pageId: string | null;
  apiVersion: string | null;
  testEventCode: string | null;
};

export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
export const DEFAULT_STRONG_OPENAI_MODEL = DEFAULT_OPENAI_MODEL;
export const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

let cachedEnv: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const parsed = serverEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid server environment: ${details}`);
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}

export function getSupabaseServerEnv(): SupabaseServerEnv {
  const env = getServerEnv();

  return {
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY
  };
}

export function getOpenAIEnv(): OpenAIEnv {
  const env = getServerEnv();

  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to use the OpenAI server client.");
  }

  return {
    ...env,
    OPENAI_API_KEY: env.OPENAI_API_KEY
  };
}

export function getEvolutionEnv(): EvolutionEnv {
  const env = getServerEnv();

  if (!env.EVOLUTION_API_URL || !env.EVOLUTION_API_KEY || !env.EVOLUTION_INSTANCE_NAME) {
    throw new Error("EVOLUTION_API_URL, EVOLUTION_API_KEY, and EVOLUTION_INSTANCE_NAME are required.");
  }

  return {
    ...env,
    EVOLUTION_API_URL: env.EVOLUTION_API_URL,
    EVOLUTION_API_KEY: env.EVOLUTION_API_KEY,
    EVOLUTION_INSTANCE_NAME: env.EVOLUTION_INSTANCE_NAME
  };
}

export function getMercadoPagoEnv(): MercadoPagoEnv {
  const env = getServerEnv();

  if (
    !env.MERCADO_PAGO_ACCESS_TOKEN ||
    !env.MERCADO_PAGO_WEBHOOK_SECRET ||
    !env.MERCADO_PAGO_PUBLIC_KEY ||
    !env.MERCADO_PAGO_WEBHOOK_URL
  ) {
    throw new Error(
      "MERCADO_PAGO_ACCESS_TOKEN, MERCADO_PAGO_WEBHOOK_SECRET, MERCADO_PAGO_PUBLIC_KEY, and MERCADO_PAGO_WEBHOOK_URL are required."
    );
  }

  return {
    ...env,
    MERCADO_PAGO_ACCESS_TOKEN: env.MERCADO_PAGO_ACCESS_TOKEN,
    MERCADO_PAGO_WEBHOOK_SECRET: env.MERCADO_PAGO_WEBHOOK_SECRET,
    MERCADO_PAGO_PUBLIC_KEY: env.MERCADO_PAGO_PUBLIC_KEY,
    MERCADO_PAGO_WEBHOOK_URL: env.MERCADO_PAGO_WEBHOOK_URL
  };
}

export function getAppEnv() {
  return process.env.APP_ENV || "development";
}

export function getOpenAIModel() {
  return getServerEnv().OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
}

export function getMetaConversionsConfig(): MetaConversionsConfig {
  const env = getServerEnv();
  return {
    enabled: env.META_TRACKING_ENABLED === "true" || env.META_TRACKING_ENABLED === "1",
    accessToken: env.META_ACCESS_TOKEN || null,
    datasetId: env.META_PIXEL_ID || env.DATASET_ID || null,
    pageId: env.META_WHATSAPP_PAGE_ID || env.META_PAGE_ID || null,
    apiVersion: env.META_API_VERSION || null,
    testEventCode: env.META_TEST_EVENT_CODE || null
  };
}

export function getOpenAIIntentModel() {
  const env = getServerEnv();
  return env.OPENAI_MODEL_INTENT || env.OPENAI_MODEL_SALES_AGENT || env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
}

export function getOpenAISalesAgentModel() {
  const env = getServerEnv();
  return env.OPENAI_MODEL_SALES_AGENT || env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
}

export function getOpenAIStrongSalesAgentModel() {
  const env = getServerEnv();
  return env.OPENAI_MODEL_SALES_AGENT_STRONG || env.OPENAI_MODEL_SALES_AGENT || env.OPENAI_MODEL || DEFAULT_STRONG_OPENAI_MODEL;
}

export function getAudioTranscriptionConfig() {
  const env = getServerEnv();
  return {
    enabled: env.UNITV_AUDIO_TRANSCRIPTION_ENABLED !== "false" && env.UNITV_AUDIO_TRANSCRIPTION_ENABLED !== "0",
    model: env.OPENAI_MODEL_TRANSCRIPTION || DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
    maxBytes: clamp(parseIntegerEnv(env.UNITV_AUDIO_MAX_BYTES, 8 * 1024 * 1024), 64 * 1024, 25 * 1024 * 1024),
    maxCharacters: clamp(parseIntegerEnv(env.UNITV_AUDIO_TRANSCRIPT_MAX_CHARS, 2_000), 200, 4_000)
  };
}

export function isWhatsAppMainMenuEnabled() {
  const value = process.env.WHATSAPP_ENABLE_MAIN_MENU;
  return value === "true" || value === "1";
}

export function getDailyAuditConfig() {
  const env = getServerEnv();
  return {
    timezone: env.UNITV_AUDIT_TIMEZONE || "America/Sao_Paulo",
    enabled: env.UNITV_DAILY_AUDIT_ENABLED !== "false",
    adminPhone: env.UNITV_DAILY_AUDIT_ADMIN_PHONE || "558699802602",
    hour: parseIntegerEnv(env.UNITV_DAILY_AUDIT_HOUR, 23),
    minute: parseIntegerEnv(env.UNITV_DAILY_AUDIT_MINUTE, 55),
    middayEnabled: env.UNITV_MIDDAY_AUDIT_ENABLED === "true" || env.UNITV_MIDDAY_AUDIT_ENABLED === "1",
    useAiSummary: env.UNITV_AUDIT_USE_AI_SUMMARY === "true" || env.UNITV_AUDIT_USE_AI_SUMMARY === "1",
    aiSummaryModel: env.OPENAI_MODEL_AUDIT_SUMMARY || DEFAULT_OPENAI_MODEL
  };
}

function parseIntegerEnv(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
