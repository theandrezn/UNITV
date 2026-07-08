import "server-only";
import { KnowledgeArticlesRepository } from "@/repositories/knowledge-articles.repository";
import { ObsidianKnowledgeRepository } from "@/repositories/obsidian-knowledge.repository";

export class KnowledgeService {
  constructor(
    private readonly knowledgeArticlesRepository = new KnowledgeArticlesRepository(),
    private readonly obsidianKnowledgeRepository = new ObsidianKnowledgeRepository()
  ) {}

  async searchKnowledge(query: string) {
    const [obsidianKnowledge, databaseKnowledge] = await Promise.all([
      this.safeReadObsidianKnowledge(() => this.obsidianKnowledgeRepository.searchKnowledge(query)),
      this.knowledgeArticlesRepository.searchKnowledge(query)
    ]);
    return mergeKnowledge(obsidianKnowledge, databaseKnowledge);
  }

  async getKnowledgeByCategory(category: string) {
    const [obsidianKnowledge, databaseKnowledge] = await Promise.all([
      this.safeReadObsidianKnowledge(() => this.obsidianKnowledgeRepository.getKnowledgeByCategory(category)),
      this.knowledgeArticlesRepository.getKnowledgeByCategory(category)
    ]);
    return mergeKnowledge(obsidianKnowledge, databaseKnowledge);
  }

  async getActiveKnowledge() {
    const [obsidianKnowledge, databaseKnowledge] = await Promise.all([
      this.safeReadObsidianKnowledge(() => this.obsidianKnowledgeRepository.getActiveKnowledge()),
      this.knowledgeArticlesRepository.getActiveKnowledge()
    ]);
    return mergeKnowledge(obsidianKnowledge, databaseKnowledge);
  }

  private async safeReadObsidianKnowledge<T extends Array<Record<string, unknown>>>(read: () => Promise<T>) {
    try {
      return await read();
    } catch {
      return [] as unknown as T;
    }
  }
}

function mergeKnowledge<T extends Record<string, unknown>>(primary: T[], fallback: T[]) {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const article of [...primary, ...fallback]) {
    const key = String(article.id || `${article.category || ""}:${article.title || ""}:${article.content || ""}`);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(article);
  }

  return merged;
}
