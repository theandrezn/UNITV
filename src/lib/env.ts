import "server-only";
import { z } from "zod";

const appEnvSchema = z.enum(["development", "test", "staging", "production"]);

const serverEnvSchema = z.object({
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL"),
  SUPABASE_ANON_KEY: z.string().min(1, "SUPABASE_ANON_KEY is required"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
  SUPABASE_DB_URL: z.string().min(1, "SUPABASE_DB_URL is required"),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_MODEL: z.string().optional(),
  APP_ENV: appEnvSchema.default("development"),
  APP_BASE_URL: z.string().url("APP_BASE_URL must be a valid URL").optional().or(z.literal("")),
  WEBHOOK_SECRET: z.string().min(1, "WEBHOOK_SECRET is required")
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

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

export function getAppEnv() {
  return process.env.APP_ENV || "development";
}

export function getOpenAIModel() {
  return getServerEnv().OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
}
