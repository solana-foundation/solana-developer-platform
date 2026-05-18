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
];

const KEY_PAGE_SLUGS = [
  "what-is-solana-developer-platform",
  "getting-started",
  "guides/setup-organization",
  "guides/setup-wallets",
  "guides/manage-api-keys",
  "guides/tokenize-an-asset",
  "guides/create-a-token",
  "guides/deploy-a-token",
  "guides/mint-and-burn",
  "guides/transfer-tokens",
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
];

function stripMarkdownFormatting(value: string): string {
  return value.replace(/[`*_]/g, "").trim();
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
    });
  }

  return pages;
}

async function loadMeta(): Promise<DocsMeta> {
  const json = await fs.readFile(docsMetaPath, "utf8");
  return JSON.parse(json) as DocsMeta;
}

function renderLink(page: DocsPage): string {
  const description = page.description ? `: ${normalizeLine(page.description)}` : "";
  return `- [${page.title}](${page.url})${description}`;
}

function renderSection(section: Section): string {
  const rows = section.pages.map(renderLink).join("\n");
  return `## ${section.title}\n${rows}`;
}

function buildSections(meta: DocsMeta, pages: Map<string, DocsPage>): Section[] {
  const sections: Section[] = [];
  let currentSection: Section = { title: "Docs", pages: [] };

  for (const entry of meta.pages || []) {
    if (entry.startsWith("---") && entry.endsWith("---")) {
      if (currentSection.pages.length > 0) {
        sections.push(currentSection);
      }
      currentSection = {
        title: entry.replace(/---/g, "").trim(),
        pages: [],
      };
      continue;
    }

    const page = pages.get(entry);
    if (!page) continue;
    currentSection.pages.push(page);
  }

  if (currentSection.pages.length > 0) {
    sections.push(currentSection);
  }

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

function renderLlmsFull(sections: Section[]): string {
  return [
    "# Solana Developer Platform",
    "",
    "> Full public docs map for Solana Developer Platform, generated from the docs navigation and public API reference.",
    "",
    "## Canonical URLs",
    `- Docs: ${docsUrl}`,
    `- API: ${apiUrl}`,
    `- Interactive API docs: ${apiDocsUrl}`,
    `- OpenAPI: ${apiOpenApiUrl}`,
    `- AI guide: ${aiGuideUrl}`,
    "",
    sections.map(renderSection).join("\n\n"),
    "",
    "## Notes",
    "- Generated from docs navigation and public API reference pages.",
    "- Hidden or internal-only APIs are intentionally excluded.",
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
  const [meta, pages] = await Promise.all([loadMeta(), loadPages()]);
  const sections = buildSections(meta, pages);
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
