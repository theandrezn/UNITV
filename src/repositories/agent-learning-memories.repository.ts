import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { assertSupabaseSuccess } from "./errors";

export type AgentLearningMemory = {
  id?: string;
  learning_date: string;
  timezone: string;
  intent?: string | null;
  stage?: string | null;
  rule: string;
  style_directive: string;
  avoid: string[];
  evidence_count: number;
  confidence: number;
  source_example_ids?: string[];
  status?: "candidate" | "active" | "superseded" | "rejected";
  metadata?: Record<string, unknown>;
  created_at?: string;
};

export type RelevantLearningMemoriesInput = {
  intent?: string | null;
  stage?: string | null;
  customerMessage?: string | null;
  recentContext?: string | null;
  limit?: number;
};

export class AgentLearningMemoriesRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async upsertMemories(memories: AgentLearningMemory[]) {
    if (!memories.length) return [];
    const payload = memories.map((memory) => ({
      ...memory,
      avoid: memory.avoid,
      rule_hash: hashRule(memory),
      status: memory.status || "active"
    }));
    const { data, error } = await this.supabase
      .from("agent_learning_memories")
      .upsert(payload, { onConflict: "rule_hash" })
      .select("*");
    return assertSupabaseSuccess(data || [], error) as Array<Record<string, unknown>>;
  }

  async getRelevantMemories(input: RelevantLearningMemoriesInput) {
    const { data, error } = await this.supabase
      .from("agent_learning_memories")
      .select("*")
      .eq("status", "active")
      .order("learning_date", { ascending: false })
      .limit(80);
    const candidates = assertSupabaseSuccess(data || [], error) as Array<Record<string, unknown>>;
    const keywords = tokenize(`${input.customerMessage || ""} ${input.recentContext || ""}`);
    return candidates
      .map((memory) => ({ memory, score: scoreMemory(memory, input, keywords) }))
      .filter((item) => item.score > 0 || candidates.length <= 3)
      .sort((left, right) => right.score - left.score || dateValue(right.memory.created_at) - dateValue(left.memory.created_at))
      .slice(0, input.limit || 4)
      .map((item) => item.memory);
  }
}

function hashRule(memory: AgentLearningMemory) {
  return createHash("sha256")
    .update([memory.intent || "", memory.stage || "", memory.rule, memory.style_directive].join("\n"))
    .digest("hex");
}

function scoreMemory(memory: Record<string, unknown>, input: RelevantLearningMemoriesInput, keywords: Set<string>) {
  let score = Number(memory.confidence || 0) * 20;
  if (input.intent && memory.intent === input.intent) score += 25;
  if (input.stage && memory.stage === input.stage) score += 20;
  const memoryKeywords = tokenize([memory.rule, memory.style_directive, memory.intent, memory.stage].filter(Boolean).join(" "));
  score += [...keywords].filter((keyword) => memoryKeywords.has(keyword)).length * 4;
  return score;
}

function tokenize(value: string) {
  return new Set(value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/\W+/).filter((word) => word.length >= 3));
}

function dateValue(value: unknown) {
  const parsed = typeof value === "string" ? new Date(value).getTime() : 0;
  return Number.isNaN(parsed) ? 0 : parsed;
}
