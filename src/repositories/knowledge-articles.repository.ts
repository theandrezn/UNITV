import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { assertSupabaseSuccess } from "./errors";

export class KnowledgeArticlesRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async getActiveKnowledge() {
    const { data, error } = await this.supabase
      .from("knowledge_articles")
      .select("*")
      .eq("status", "active")
      .order("category", { ascending: true })
      .order("created_at", { ascending: true });

    return assertSupabaseSuccess(data || [], error);
  }

  async getKnowledgeByCategory(category: string) {
    const { data, error } = await this.supabase
      .from("knowledge_articles")
      .select("*")
      .eq("status", "active")
      .eq("category", category)
      .order("created_at", { ascending: true });

    return assertSupabaseSuccess(data || [], error);
  }

  async searchKnowledge(query: string) {
    const terms = query
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean)
      .slice(0, 6);

    if (!terms.length) {
      return this.getActiveKnowledge();
    }

    const filters = terms.flatMap((term) => {
      const safeTerm = term.replace(/[^a-zA-Z0-9\u00c0-\u024f_-]/g, "");
      return safeTerm
        ? [`title.ilike.%${safeTerm}%`, `category.ilike.%${safeTerm}%`, `content.ilike.%${safeTerm}%`]
        : [];
    });

    if (!filters.length) {
      return this.getActiveKnowledge();
    }

    const { data, error } = await this.supabase
      .from("knowledge_articles")
      .select("*")
      .eq("status", "active")
      .or(filters.join(","))
      .order("created_at", { ascending: true })
      .limit(8);

    return assertSupabaseSuccess(data || [], error);
  }
}
