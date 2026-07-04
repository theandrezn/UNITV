import "server-only";
import OpenAI from "openai";
import { getOpenAIEnv, getOpenAIModel } from "@/lib/env";

export function createOpenAIClient() {
  const env = getOpenAIEnv();

  return new OpenAI({
    apiKey: env.OPENAI_API_KEY
  });
}

export function getDefaultOpenAIModel() {
  return getOpenAIModel();
}
