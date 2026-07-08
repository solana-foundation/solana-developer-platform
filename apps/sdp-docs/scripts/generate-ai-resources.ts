import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  aiGuideUrl,
  aiLlmsFullUrl,
  aiLlmsUrl,
  apiDocsUrl,
  apiOpenApiUrl,
  apiUrl,
  docsUrl,
  getDocsPageUrl,
} from "../src/lib/site";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const docsContentDir = path.resolve(__dirname, "../content/docs");
const docsMetaPath = path.resolve(docsContentDir, "meta.json");
const publicDir = path.resolve(__dirname, "../public");
const llmsPath = path.resolve(publicDir, "llms.txt");
const llmsFullPath = path.resolve(publicDir, "llms-full.txt");

type DocsMeta = {
  title?: string;
  pages?: string[];
};

type DocsPage = {
  slug: string;
  title: string;
  description: string;
  url: string;
  content: string;
};

type Section = {
  title: string;
  pages: DocsPage[];
};

const FEATURE_SUMMARY = [
  "Wallets and custody",
  "API key management",
  "Projects",
  "Token issuance and lifecycle operations",
  "Payments, transfers, and ramps",
  "Compliance screening",
  "Asset profiles and public token metadata",
];

const KEY_PAGE_SLUGS = [
  "introduction",
  "guides/setup-organization",
  "guides/setup-wallets",
  "guides/manage-api-keys",
  "guides/tokenize-an-asset",
  "guides/create-a-token",
  "guides/deploy-a-token",
  "guides/mint-and-burn",
  "payments/index",
  "payments/send-basic-payment",
  "reference/issuance-token-types",
  "tutorials/end-to-end-payment-flow",
  "reference/provider-onboarding",
  "reference/ai-consumption",
  "reference/postman-collection",
  "reference/api/index",
  "reference/api/health",
  "reference/api/api-keys",
  "reference/api/wallets",
  "reference/api/projects",
  "reference/api/issuance",
  "reference/api/payments",
  "reference/api/compliance",
  "reference/api/asset-profiles",
];

function stripMarkdownFormatting(value: string): string {
  return value.replace(/[`*_]/g, "").trim();
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripMdxContent(source: string): string {
  let content = source.replace(/^---\n[\s\S]*?\n---\n?/, "");
  content = content.replace(/^import\s+[^\n]*\n?/gm, "");
  return content.replace(/\n{3,}/g, "\n\n").trim();
}

function parseFrontmatter(source: string): { title: string; description: string } {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?/);
  const frontmatter = match?.[1] ?? "";

  const title = stripMarkdownFormatting(frontmatter.match(/^title:\s*(.+)$/m)?.[1] ?? "");
  const description = stripMarkdownFormatting(
    frontmatter.match(/^description:\s*(.+)$/m)?.[1] ?? ""
  );

  return { title, description };
}

async function listFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        return listFiles(fullPath);
      }
      return [fullPath];
    })
  );

  return nested.flat();
}

function toPageSlug(filePath: string): string {
  const relativePath = path.relative(docsContentDir, filePath).replace(/\\/g, "/");
  return relativePath.replace(/\.mdx$/, "");
}

async function loadPages(): Promise<Map<string, DocsPage>> {
  const files = await listFiles(docsContentDir);
  const mdxFiles = files.filter((filePath) => filePath.endsWith(".mdx"));
  const pages = new Map<string, DocsPage>();

  for (const filePath of mdxFiles) {
    const slug = toPageSlug(filePath);
    const source = await fs.readFile(filePath, "utf8");
    const { title, description } = parseFrontmatter(source);

    pages.set(slug, {
      slug,
      title: title || slug.split("/").at(-1)?.replace(/-/g, " ") || slug,
      description,
      url: getDocsPageUrl(slug),
      content: stripMdxContent(source),
    });
  }

  return pages;
}

async function loadMeta(): Promise<DocsMeta> {
  const json = await fs.readFile(docsMetaPath, "utf8");
  return JSON.parse(json) as DocsMeta;
}

async function loadFolderMetas(): Promise<Map<string, DocsMeta>> {
  const result = new Map<string, DocsMeta>();

  async function walk(dirPath: string): Promise<void> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory()) return;
        const subDir = path.join(dirPath, entry.name);
        try {
          const json = await fs.readFile(path.join(subDir, "meta.json"), "utf8");
          const rel = path.relative(docsContentDir, subDir).replace(/\\/g, "/");
          result.set(rel, JSON.parse(json) as DocsMeta);
        } catch {
          // folder without meta.json — skip
        }
        await walk(subDir);
      })
    );
  }

  await walk(docsContentDir);
  return result;
}

function renderLink(page: DocsPage): string {
  const description = page.description ? `: ${normalizeLine(page.description)}` : "";
  return `- [${page.title}](${page.url})${description}`;
}

function buildSections(
  meta: DocsMeta,
  pages: Map<string, DocsPage>,
  folderMetas: Map<string, DocsMeta>
): Section[] {
  const sections: Section[] = [];
  const emitted = new Set<string>();
  let currentSection: Section = { title: "Docs", pages: [] };

  const flush = () => {
    if (currentSection.pages.length > 0) {
      sections.push(currentSection);
    }
  };

  const isSeparator = (entry: string): boolean => entry.startsWith("---") && entry.endsWith("---");

  const visit = (entry: string, slugPrefix: string, parentLabel: string | null): void => {
    if (isSeparator(entry)) {
      flush();
      const label = entry.replace(/---/g, "").trim();
      currentSection = {
        title: parentLabel ? `${parentLabel} — ${label}` : label,
        pages: [],
      };
      return;
    }

    const fullSlug = slugPrefix ? `${slugPrefix}/${entry}` : entry;

    const page = pages.get(fullSlug);
    if (page) {
      if (!emitted.has(fullSlug)) {
        currentSection.pages.push(page);
        emitted.add(fullSlug);
      }
      return;
    }

    const folderMeta = folderMetas.get(fullSlug);
    if (!folderMeta) {
      console.warn(`generate-ai-resources: no page or folder for entry "${fullSlug}" — skipping`);
      return;
    }

    flush();
    const sectionTitle = folderMeta.title || entry;
    currentSection = { title: sectionTitle, pages: [] };
    for (const subEntry of folderMeta.pages || []) {
      visit(subEntry, fullSlug, sectionTitle);
    }
    flush();
    currentSection = { title: "Docs", pages: [] };
  };

  for (const entry of meta.pages || []) {
    visit(entry, "", null);
  }

  flush();
  return sections;
}

function buildKeyPages(pages: Map<string, DocsPage>): DocsPage[] {
  return KEY_PAGE_SLUGS.map((slug) => {
    const page = pages.get(slug);
    if (!page) {
      throw new Error(`Missing required key docs page "${slug}" for llms.txt generation`);
    }
    return page;
  });
}

function renderLlms(keyPages: DocsPage[]): string {
  return [
    "# Solana Developer Platform",
    "",
    "> Public documentation and API discovery resources for Solana Developer Platform.",
    "",
    "## Canonical URLs",
    `- Docs: ${docsUrl}`,
    `- API: ${apiUrl}`,
    `- Interactive API docs: ${apiDocsUrl}`,
    `- OpenAPI: ${apiOpenApiUrl}`,
    `- AI guide: ${aiGuideUrl}`,
    "",
    "## Supported surfaces",
    ...FEATURE_SUMMARY.map((feature) => `- ${feature}`),
    "",
    "## Start here",
    ...keyPages.map(renderLink),
    "",
    "## AI guide",
    `- [AI Consumption](${aiGuideUrl}): Human-readable landing page for machine-readable SDP docs resources, usage guidance, and public AI scope.`,
    "",
    "## Machine-readable resources",
    `- [llms.txt](${aiLlmsUrl})`,
    `- [llms-full.txt](${aiLlmsFullUrl})`,
    `- [OpenAPI](${apiOpenApiUrl})`,
    `- [Swagger UI](${apiDocsUrl})`,
    "",
    "## Scope",
    "- Public AI artifacts intentionally exclude hidden or internal-only API families.",
    "",
  ].join("\n");
}

function renderPageFull(page: DocsPage): string {
  const parts: string[] = [`### ${page.title}`, `Source: ${page.url}`];
  if (page.description) parts.push(``, `> ${page.description}`);
  if (page.content) parts.push(``, page.content);
  return parts.join("\n");
}

function renderSectionFull(section: Section): string {
  const pages = section.pages.map(renderPageFull).join("\n\n---\n\n");
  return `## ${section.title}\n\n${pages}`;
}

function renderLlmsFull(sections: Section[]): string {
  return [
    "# Solana Developer Platform",
    "",
    "> Full public documentation for Solana Developer Platform — all page content for AI and agent ingestion.",
    "",
    "## Canonical URLs",
    `- Docs: ${docsUrl}`,
    `- API: ${apiUrl}`,
    `- Interactive API docs: ${apiDocsUrl}`,
    `- OpenAPI: ${apiOpenApiUrl}`,
    `- AI guide: ${aiGuideUrl}`,
    "",
    sections.map(renderSectionFull).join("\n\n---\n\n"),
    "",
    "## Notes",
    "- Generated from docs source. Hidden or internal-only APIs are intentionally excluded.",
    "",
  ].join("\n");
}

async function writeFileIfChanged(filePath: string, content: string): Promise<void> {
  const normalized = `${content.trim()}\n`;
  const existing = await fs.readFile(filePath, "utf8").catch(() => null);
  if (existing === normalized) {
    return;
  }
  await fs.writeFile(filePath, normalized, "utf8");
}

async function run(): Promise<void> {
  const [meta, pages, folderMetas] = await Promise.all([
    loadMeta(),
    loadPages(),
    loadFolderMetas(),
  ]);
  const sections = buildSections(meta, pages, folderMetas);
  const keyPages = buildKeyPages(pages);

  await fs.mkdir(publicDir, { recursive: true });

  await Promise.all([
    writeFileIfChanged(llmsPath, renderLlms(keyPages)),
    writeFileIfChanged(llmsFullPath, renderLlmsFull(sections)),
  ]);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
