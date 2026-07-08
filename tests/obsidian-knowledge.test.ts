import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ObsidianKnowledgeRepository } from "@/repositories/obsidian-knowledge.repository";
import { KnowledgeService } from "@/services/knowledge/knowledge.service";

let tempDirs: string[] = [];

describe("Obsidian knowledge base", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it("ignores notes that only contain a title", async () => {
    const dir = await createTempKnowledgeBase();
    await writeFile(path.join(dir, "00_INDEX.md"), "# Index\n", "utf8");

    const repository = new ObsidianKnowledgeRepository(dir);

    await expect(repository.getActiveKnowledge()).resolves.toEqual([]);
  });

  it("searches filled Obsidian notes by title, category and content", async () => {
    const dir = await createTempKnowledgeBase();
    await writeFile(path.join(dir, "06_PAGAMENTO_MERCADO_PAGO.md"), "# Pagamento Mercado Pago\nSempre gerar Pix pelo Mercado Pago.\n", "utf8");

    const repository = new ObsidianKnowledgeRepository(dir);
    const result = await repository.searchKnowledge("pix mercado pago");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: "Pagamento Mercado Pago",
      category: "pagamento_mercado_pago",
      content: "Sempre gerar Pix pelo Mercado Pago."
    });
  });

  it("uses Obsidian as the only agent knowledge source", async () => {
    const obsidianRepository = {
      searchKnowledge: vi.fn(async () => [{
        id: "obsidian:06_PAGAMENTO_MERCADO_PAGO.md",
        title: "Pagamento Mercado Pago",
        category: "pagamento_mercado_pago",
        content: "Conteudo do Obsidian",
        status: "active",
        metadata: { source: "obsidian" }
      }]),
      getKnowledgeByCategory: vi.fn(async () => []),
      getActiveKnowledge: vi.fn(async () => [])
    };
    const service = new KnowledgeService(obsidianRepository as never);

    const result = await service.searchKnowledge("pix");

    expect(result.map((article) => article.content)).toEqual(["Conteudo do Obsidian"]);
  });
});

async function createTempKnowledgeBase() {
  const dir = await mkdtemp(path.join(tmpdir(), "unitv-obsidian-kb-"));
  tempDirs.push(dir);
  return dir;
}
