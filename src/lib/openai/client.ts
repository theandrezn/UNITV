import "server-only";
import OpenAI from "openai";
import { getOpenAIEnv, getOpenAIIntentModel, getOpenAIModel, getOpenAISalesAgentModel } from "@/lib/env";

export function createOpenAIClient() {
  const env = getOpenAIEnv();

  return new OpenAI({
    apiKey: env.OPENAI_API_KEY
  });
}

export function getDefaultOpenAIModel() {
  return getOpenAIModel();
}

export function getIntentOpenAIModel() {
  return getOpenAIIntentModel();
}

export function getSalesAgentOpenAIModel() {
  return getOpenAISalesAgentModel();
}
