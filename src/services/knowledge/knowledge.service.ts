import "server-only";
import { ObsidianKnowledgeRepository } from "@/repositories/obsidian-knowledge.repository";

export class KnowledgeService {
  constructor(
    private readonly obsidianKnowledgeRepository = new ObsidianKnowledgeRepository()
  ) {}

  async searchKnowledge(query: string) {
    return this.safeReadObsidianKnowledge(() => this.obsidianKnowledgeRepository.searchKnowledge(query));
  }

  async getKnowledgeByCategory(category: string) {
    return this.safeReadObsidianKnowledge(() => this.obsidianKnowledgeRepository.getKnowledgeByCategory(category));
  }

  async getActiveKnowledge() {
    return this.safeReadObsidianKnowledge(() => this.obsidianKnowledgeRepository.getActiveKnowledge());
  }

  private async safeReadObsidianKnowledge<T extends Array<Record<string, unknown>>>(read: () => Promise<T>) {
    try {
      return await read();
    } catch {
      return [] as unknown as T;
    }
  }
}
