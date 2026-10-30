import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiDiscoveryDocumentSchema, renderLlmsTxt } from "@sdp/api-catalog/ai-discovery";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DOCS_SKILL_NAME } from "@/lib/agent-setup";
import { expandDocsBlocks, stripMdxEsm } from "@/lib/docs-blocks";
import { DOCS_MODULES } from "@/lib/docs-catalog";
import {
  frontmatterOf,
  isModulePublished,
  isPageSourcePublished,
  pageGateOf,
} from "@/lib/release-channel";
import { canonicalSite, docsPageSlugOf, isDocsFolderGroup } from "@/lib/site";

const {
  aiGuideUrl,
  aiLlmsFullUrl,
  aiLlmsUrl,
  apiOpenApiUrl,
  apiUrl,
  docsUrl,
  getDocsMarkdownUrl,
  getDocsPageUrl,
} = canonicalSite;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const docsContentDir = path.resolve(__dirname, "../content/docs");
const docsMetaPath = path.resolve(docsContentDir, "meta.json");
const publicDir = path.resolve(__dirname, "../public");
const llmsPath = path.resolve(publicDir, "llms.txt");
const llmsFullPath = path.resolve(publicDir, "llms-full.txt");
const openApiPath = path.resolve(__dirname, "../../sdp-api/generated/openapi.json");
// The same skill twice: public/ is what the docs serve at /SKILL.md, and the repo's skills/
// is what `npx skills add` installs. The docs image never sees the second copy.
const skillPaths = [
  path.resolve(publicDir, "SKILL.md"),
  path.resolve(__dirname, `../../../skills/${DOCS_SKILL_NAME}/SKILL.md`),
];

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
  /** No `module` or `rampProvider` gate: every release channel publishes it. */
  shared: boolean;
};

type Section = {
  title: string;
  pages: DocsPage[];
};

// The llms files describe only what this build's release channel publishes.

// One capability line per published module, from the same catalog as the
// AI guide's <ModuleCapabilities /> block.
const FEATURE_SUMMARY = DOCS_MODULES.filter(
  (entry) => entry.module === "core" || isModulePublished(entry.module)
).map((entry) => entry.capability);

const KEY_PAGE_SLUGS = [
  "introduction",
  "guides/setup-organization",
  "guides/setup-wallets",
  "developing-with-sdp/manage-api-keys",
  "tokens/tokenize-an-asset",
  "tokens/create-a-token",
  "tokens/deploy-a-token",
  "tokens/mint-and-burn",
  "payments/index",
  "payments/send-basic-payment",
  "reference/issuance-token-types",
  "tutorials/end-to-end-payment-flow",
  "reference/provider-onboarding",
  "reference/docs-for-ai",
  "reference/conventions/index",
  "reference/postman-collection",
];

function stripMarkdownFormatting(value: string): string {
  return value.replace(/[`*_]/g, "").trim();
}

function stripMdxContent(source: string, where: string): string {
  let content = source.replace(/^---\n[\s\S]*?\n---\n?/, "");
  content = stripMdxEsm(content, where);
  return content.replace(/\n{3,}/g, "\n\n").trim();
}

const pageFrontmatterSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
});

/** A page's title and description, read as YAML: a generated value may be quoted. */
function parseFrontmatter(source: string): { title: string; description: string } {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (match?.[1] === undefined) return { title: "", description: "" };
  const { title, description } = pageFrontmatterSchema.parse(parseYaml(match[1]));
  return {
    title: title === undefined ? "" : stripMarkdownFormatting(title),
    description: description === undefined ? "" : stripMarkdownFormatting(description),
  };
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
  return docsPageSlugOf(path.relative(docsContentDir, filePath).replace(/\\/g, "/"));
}

/** Pages a `module:` tag leaves out of this release channel. */
const excludedSlugs = new Set<string>();

async function loadPages(): Promise<Map<string, DocsPage>> {
  const files = await listFiles(docsContentDir);
  const mdxFiles = files.filter((filePath) => filePath.endsWith(".mdx"));
  const pages = new Map<string, DocsPage>();

  const sources = await Promise.all(
    mdxFiles.map(async (filePath) => ({ filePath, raw: await fs.readFile(filePath, "utf8") }))
  );

  for (const { filePath, raw } of sources) {
    const slug = toPageSlug(filePath);
    if (!isPageSourcePublished(raw, filePath)) {
      excludedSlugs.add(slug);
      continue;
    }
    const source = expandDocsBlocks(raw, filePath);
    const { title, description } = parseFrontmatter(source);

    pages.set(slug, {
      slug,
      title: title || slug.split("/").at(-1)?.replace(/-/g, " ") || slug,
      description,
      url: getDocsPageUrl(slug),
      content: stripMdxContent(source, filePath),
      shared: pageGateOf(frontmatterOf(raw, filePath).data, filePath) === undefined,
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

    // The entry's path, `(name)` folders included, and the slug its page would have.
    const fullSlug = slugPrefix ? `${slugPrefix}/${entry}` : entry;
    const pageSlug = docsPageSlugOf(fullSlug);

    const page = pages.get(pageSlug);
    if (page) {
      if (!emitted.has(pageSlug)) {
        currentSection.pages.push(page);
        emitted.add(pageSlug);
      }
      return;
    }

    if (excludedSlugs.has(pageSlug)) {
      return;
    }

    const folderMeta = folderMetas.get(fullSlug);
    if (!folderMeta) {
      console.warn(`generate-ai-resources: no page or folder for entry "${fullSlug}" — skipping`);
      return;
    }

    flush();
    // A `(name)` folder groups its parent's pages (an API family's operations), so its section
    // names the parent too, and it has no index of its own.
    const group = isDocsFolderGroup(entry);
    const sectionTitle =
      group && parentLabel
        ? `${parentLabel}: ${folderMeta.title || entry}`
        : folderMeta.title || entry;
    currentSection = { title: sectionTitle, pages: [] };
    // A folder's index is the folder's own page even where its meta lists only the rest, as an
    // API family lists its operations.
    const folderIndex = group ? undefined : pages.get(docsPageSlugOf(`${fullSlug}/index`));
    if (
      folderIndex &&
      !(folderMeta.pages ?? []).includes("index") &&
      !emitted.has(folderIndex.slug)
    ) {
      currentSection.pages.push(folderIndex);
      emitted.add(folderIndex.slug);
    }
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

/**
 * The API reference pages `generate:api` wrote for this release channel, in its
 * order. They come from the channel's public OpenAPI document, so no module gate
 * applies to them.
 */
function apiReferenceSlugs(folderMetas: Map<string, DocsMeta>): string[] {
  const pages = folderMetas.get("reference/api")?.pages;
  if (!pages) {
    throw new Error('Missing content/docs/reference/api/meta.json; run "pnpm generate:api" first');
  }
  // A family is a folder: its table is the folder's index.
  return pages.map((page) =>
    folderMetas.has(`reference/api/${page}`)
      ? `reference/api/${page}/index`
      : `reference/api/${page}`
  );
}

function buildKeyPages(
  pages: Map<string, DocsPage>,
  folderMetas: Map<string, DocsMeta>
): DocsPage[] {
  const guides = KEY_PAGE_SLUGS.filter((slug) => !excludedSlugs.has(slug));
  return [...guides, ...apiReferenceSlugs(folderMetas)].map((slug) => {
    const page = pages.get(slug);
    if (!page) {
      throw new Error(`Missing required key docs page "${slug}" for llms.txt generation`);
    }
    return page;
  });
}

async function loadAiDiscoveryDocument() {
  const source = await fs.readFile(openApiPath, "utf8");
  const parsed: unknown = JSON.parse(source);
  return aiDiscoveryDocumentSchema.parse(parsed);
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
    `- API reference: ${getDocsPageUrl("reference/api")}`,
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

/**
 * A page the skill links, as its Markdown URL. It must be a shared page, so the skill reads
 * the same on every release channel: the repo copy is built at experimental and installed
 * against any deployment.
 */
function skillLink(pages: Map<string, DocsPage>, slug: string, label?: string): string {
  const page = pages.get(slug);
  if (!page?.shared) {
    throw new Error(`SKILL.md links "${slug}", which is not a shared docs page`);
  }
  return `[${label ?? page.title}](${getDocsMarkdownUrl(slug)})`;
}

/**
 * The read-only docs skill. It names no module (the published ones are in llms.txt), so one
 * copy is right for every release channel.
 */
function renderSkill(pages: Map<string, DocsPage>): string {
  const overview = (label: string) => skillLink(pages, "developing-with-sdp/index", label);
  const authentication = skillLink(pages, "developing-with-sdp/authentication");
  return [
    "---",
    `name: ${DOCS_SKILL_NAME}`,
    "description: Answer questions and write code for Solana Developer Platform (SDP) from its public docs and OpenAPI contract. Use when building against the SDP REST API at api.solana.com, or when asked how SDP environments, API keys, idempotency or transaction signing work.",
    "---",
    "",
    "# Solana Developer Platform docs",
    "",
    "Read the published SDP docs before you answer or write code. This skill only reads: it never calls the SDP API or handles an API key, and the user runs every request with their own key.",
    "",
    "## Where to read",
    "",
    `- [Docs index](${getDocsMarkdownUrl("")}): every published page, with a line on each. Find the page for the task here.`,
    `- [llms.txt](${aiLlmsUrl}): the key pages and the API reference.`,
    `- Any docs page as Markdown: add \`.md\` to its URL, as in ${getDocsMarkdownUrl("developing-with-sdp/idempotency")}.`,
    `- [llms-full.txt](${aiLlmsFullUrl}): every page in one file.`,
    `- [OpenAPI](${apiOpenApiUrl}): every public route, field and error code. Take paths, fields and enum values from it, never from memory.`,
    "",
    "These files list what the platform publishes. A route or page they leave out is not public: don't use it, and don't infer one from SDP's source code.",
    "",
    "## Grounding rules",
    "",
    `1. **The project picks the network.** A sandbox project runs on devnet and a production project on mainnet-beta. An API key belongs to one project and reaches only its network; no request field or key format names the network. Build against a sandbox key, then go live by swapping in a production key. ${overview("Environments")}`,
    `2. **Keys hold explicit grants.** Every route performs one action, \`module.verb\`, and a key may call it only when it holds that action: there are no roles and no wildcards. \`manage\` and \`execute\` include the same module's \`read\`, and nothing else implies another action. A missing grant is \`403 INSUFFICIENT_PERMISSIONS\`, with \`error.details.action\` naming it. A key never administers keys, members, the organization or projects, and its wallet scope limits which custody wallets SDP signs with for it. ${skillLink(pages, "developing-with-sdp/manage-api-keys")}, ${authentication}`,
    `3. **Send an \`Idempotency-Key\` on every mutation that accepts one.** Routes that move money require it (\`400 IDEMPOTENCY_KEY_REQUIRED\`). Make one key per logical operation, store it before the first send and reuse it on every retry; a new operation gets a new key. A different request under the same key is \`422 IDEMPOTENCY_KEY_REUSED\`, and \`409 IDEMPOTENCY_KEY_IN_FLIGHT\` means wait, then retry with the same key. To learn an outcome, read the resource with \`GET\`: never resend a request to find out. ${skillLink(pages, "developing-with-sdp/idempotency")}`,
    `4. **Execute signs inside SDP; prepare hands you a transaction.** An execute route builds the transaction, signs it with a custody wallet in the project and submits it. A \`prepare\` route returns an unsigned transaction for a signer outside SDP to sign and submit. It carries a recent blockhash and soon expires, so sign and submit it right away, and prepare again instead of reusing an old one. Use execute unless the signer must stay outside SDP. ${overview("Execution model")}`,
    "",
    "## API basics",
    "",
    `- Base URL \`${apiUrl}\`. Send the key as \`Authorization: Bearer <key>\`; current keys start with \`sf_\`.`,
    '- A success wraps its payload as `{ "data": ..., "meta": { "requestId": ... } }`, and an error is `{ "error": { "code": ..., "message": ... } }`. Branch on `error.code`, and quote `meta.requestId` when reporting a problem.',
    "- Keep the key out of code, prompts and logs: read it from an environment variable such as `SDP_API_KEY`.",
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
  const [meta, pages, folderMetas, document] = await Promise.all([
    loadMeta(),
    loadPages(),
    loadFolderMetas(),
    loadAiDiscoveryDocument(),
  ]);
  const sections = buildSections(meta, pages, folderMetas);
  const keyPages = buildKeyPages(pages, folderMetas);

  const skill = renderSkill(pages);

  await Promise.all(
    [publicDir, ...skillPaths.map((skillPath) => path.dirname(skillPath))].map((dir) =>
      fs.mkdir(dir, { recursive: true })
    )
  );

  await Promise.all([
    writeFileIfChanged(
      llmsPath,
      renderLlmsTxt({
        audience: "docs",
        document,
        supportedSurfaces: FEATURE_SUMMARY,
        startHere: keyPages,
      })
    ),
    writeFileIfChanged(llmsFullPath, renderLlmsFull(sections)),
    ...skillPaths.map((skillPath) => writeFileIfChanged(skillPath, skill)),
  ]);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
