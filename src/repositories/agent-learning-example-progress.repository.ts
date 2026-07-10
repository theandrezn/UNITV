import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { assertSupabaseSuccess } from "./errors";

type LearningExample = Record<string, unknown>;

export class AgentLearningExampleProgressRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async filterUnprocessedExamples(examples: LearningExample[]) {
    const ids = examples.map((example) => String(example.id || "")).filter(Boolean);
    if (!ids.length) return [];

    const { data, error } = await this.supabase
      .from("agent_learning_example_progress")
      .select("example_id, source_updated_at")
      .in("example_id", ids);
    const progressRows = assertSupabaseSuccess(data || [], error) as Array<Record<string, unknown>>;
    const progressById = new Map(progressRows.map((row) => [String(row.example_id), String(row.source_updated_at || "")]));

    return examples.filter((example) => {
      const updatedAt = String(example.updated_at || example.reviewed_at || example.created_at || "");
      const processedAt = progressById.get(String(example.id || ""));
      return !processedAt || processedAt < updatedAt;
    });
  }

  async markExamplesProcessed(examples: LearningExample[], memoriesCreatedCount: number) {
    const rows = examples
      .map((example) => ({
        example_id: String(example.id || ""),
        source_updated_at: String(example.updated_at || example.reviewed_at || example.created_at || ""),
        result: memoriesCreatedCount > 0 ? "synthesized" : "no_safe_directive",
        memories_created_count: memoriesCreatedCount,
        metadata: { source: "daily_specialist_learning" }
      }))
      .filter((row) => row.example_id && row.source_updated_at);
    if (!rows.length) return [];

    const { data, error } = await this.supabase
      .from("agent_learning_example_progress")
      .upsert(rows, { onConflict: "example_id" })
      .select("example_id");
    return assertSupabaseSuccess(data || [], error);
  }
}
