import "server-only";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

type ObsidianKnowledgeArticle = {
  id: string;
  title: string;
  category: string;
  content: string;
  status: "active";
  metadata: Record<string, unknown>;
};

const DEFAULT_OBSIDIAN_KNOWLEDGE_BASE_PATH = "C:\\Users\\games\\Documents\\UNITV - AGENTE\\UNITV-KNOWLEDGE-BASE";
const MAX_ACTIVE_ARTICLES = 40;
const MAX_SEARCH_ARTICLES = 12;

export class ObsidianKnowledgeRepository {
  constructor(private readonly basePath = getObsidianKnowledgeBasePath()) {}

  async getActiveKnowledge() {
    const articles = await this.readArticles();
    return articles.slice(0, MAX_ACTIVE_ARTICLES);
  }

  async getKnowledgeByCategory(category: string) {
    const normalizedCategory = normalizeSearchText(category);
    const articles = await this.readArticles();
    return articles.filter((article) => normalizeSearchText(article.category) === normalizedCategory);
  }

  async searchKnowledge(query: string) {
    const articles = await this.readArticles();
    const terms = extractSearchTerms(query);
    if (!terms.length) {
      return articles.slice(0, MAX_SEARCH_ARTICLES);
    }

    return articles
      .map((article) => ({ article, score: scoreArticle(article, terms) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SEARCH_ARTICLES)
      .map((item) => item.article);
  }

  private async readArticles(): Promise<ObsidianKnowledgeArticle[]> {
    if (!this.basePath) {
      return [];
    }

    try {
      const info = await stat(this.basePath);
      if (!info.isDirectory()) {
        return [];
      }
      const entries = await readdir(this.basePath, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));

      const articles = await Promise.all(files.map((fileName) => this.readArticle(fileName)));
      return articles.filter((article): article is ObsidianKnowledgeArticle => Boolean(article));
    } catch {
      return [];
    }
  }

  private async readArticle(fileName: string): Promise<ObsidianKnowledgeArticle | null> {
    try {
      const filePath = path.join(this.basePath, fileName);
      const rawContent = await readFile(filePath, "utf8");
      const title = extractTitle(rawContent) || titleFromFileName(fileName);
      const body = stripTitle(rawContent).trim();
      if (!body) {
        return null;
      }

      return {
        id: `obsidian:${fileName}`,
        title,
        category: categoryFromFileName(fileName),
        content: body,
        status: "active",
        metadata: {
          source: "obsidian",
          file_name: fileName,
          file_path: filePath
        }
      };
    } catch {
      return null;
    }
  }
}

function getObsidianKnowledgeBasePath() {
  const configuredPath = process.env.OBSIDIAN_KNOWLEDGE_BASE_PATH || process.env.UNITV_OBSIDIAN_KNOWLEDGE_BASE_PATH;
  return configuredPath || DEFAULT_OBSIDIAN_KNOWLEDGE_BASE_PATH;
}

function extractTitle(content: string) {
  const firstHeading = content.split(/\r?\n/).find((line) => /^#\s+/.test(line.trim()));
  return firstHeading ? firstHeading.replace(/^#\s+/, "").trim() : null;
}

function stripTitle(content: string) {
  const lines = content.split(/\r?\n/);
  const firstHeadingIndex = lines.findIndex((line) => /^#\s+/.test(line.trim()));
  if (firstHeadingIndex === -1) {
    return content;
  }

  return [...lines.slice(0, firstHeadingIndex), ...lines.slice(firstHeadingIndex + 1)].join("\n");
}

function titleFromFileName(fileName: string) {
  return fileName
    .replace(/\.md$/i, "")
    .replace(/^\d+_/, "")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function categoryFromFileName(fileName: string) {
  return fileName
    .replace(/\.md$/i, "")
    .replace(/^\d+_?/, "")
    .toLowerCase();
}

function extractSearchTerms(query: string) {
  return normalizeSearchText(query)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .slice(0, 10);
}

function scoreArticle(article: ObsidianKnowledgeArticle, terms: string[]) {
  const title = normalizeSearchText(article.title);
  const category = normalizeSearchText(article.category);
  const content = normalizeSearchText(article.content);

  return terms.reduce((score, term) => {
    if (title.includes(term)) return score + 5;
    if (category.includes(term)) return score + 4;
    if (content.includes(term)) return score + 1;
    return score;
  }, 0);
}

function normalizeSearchText(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
