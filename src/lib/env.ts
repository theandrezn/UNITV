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
  APP_ENV: appEnvSchema.default("development"),
  APP_BASE_URL: z.string().url("APP_BASE_URL must be a valid URL").optional().or(z.literal("")),
  WEBHOOK_SECRET: z.string().optional(),
  ADMIN_API_KEY: z.string().optional(),
  PAYMENT_INSTRUCTIONS: z.string().optional(),
  MERCADO_PAGO_ACCESS_TOKEN: z.string().optional(),
  MERCADO_PAGO_WEBHOOK_SECRET: z.string().optional(),
  MERCADO_PAGO_PUBLIC_KEY: z.string().optional(),
  MERCADO_PAGO_WEBHOOK_URL: z.string().url("MERCADO_PAGO_WEBHOOK_URL must be a valid URL").optional().or(z.literal("")),
  EVOLUTION_API_URL: z.string().url("EVOLUTION_API_URL must be a valid URL").optional().or(z.literal("")),
  EVOLUTION_API_KEY: z.string().optional(),
  EVOLUTION_INSTANCE_NAME: z.string().optional(),
  EVOLUTION_WEBHOOK_SECRET: z.string().optional(),
  EVOLUTION_WEBHOOK_VERIFY_TOKEN: z.string().optional()
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

export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

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
