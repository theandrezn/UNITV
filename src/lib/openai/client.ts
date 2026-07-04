import "server-only";
import OpenAI from "openai";
import { getOpenAIModel, getServerEnv } from "@/lib/env";

export function createOpenAIClient() {
  const env = getServerEnv();

  return new OpenAI({
    apiKey: env.OPENAI_API_KEY
  });
}

export function getDefaultOpenAIModel() {
  return getOpenAIModel();
}
