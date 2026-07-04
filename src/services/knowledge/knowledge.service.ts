import "server-only";
import { KnowledgeArticlesRepository } from "@/repositories/knowledge-articles.repository";

export class KnowledgeService {
  constructor(private readonly knowledgeArticlesRepository = new KnowledgeArticlesRepository()) {}

  searchKnowledge(query: string) {
    return this.knowledgeArticlesRepository.searchKnowledge(query);
  }

  getKnowledgeByCategory(category: string) {
    return this.knowledgeArticlesRepository.getKnowledgeByCategory(category);
  }

  getActiveKnowledge() {
    return this.knowledgeArticlesRepository.getActiveKnowledge();
  }
}
