import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SDP_GITHUB_REPO_URL } from "@sdp/types/site";

import { expandDocsBlocks } from "@/lib/docs-blocks";
import { isPageSourcePublished, publicSurface } from "@/lib/release-channel";
import { docsPageSlugOf, getDocsMarkdownPath, getDocsPagePath } from "@/lib/site";
import { probeExternalUrl } from "./lib/external-link";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const docsContentDir = path.resolve(__dirname, "../content/docs");
const docsPublicDir = path.resolve(__dirname, "../public");
const docsMetaPath = path.resolve(docsContentDir, "meta.json");
const configPath = path.resolve(__dirname, "link-check.config.json");
const repoRoot = path.resolve(__dirname, "../../..");
const repoMainLink = new RegExp(`^${SDP_GITHUB_REPO_URL}/(?:tree|blob)/main/([^?#]+)`);

// Links are checked as the build for src/generated/public-surface.json renders
// them: pages a `module:` or `rampProvider:` tag leaves out do not exist, and
// generated blocks link only to published pages (src/lib/docs-blocks.ts). CI runs
// this per channel.
const releaseChannel = publicSurface.releaseChannel;
const excludedSlugs = new Set<string>();

type DocsMeta = {
  pages?: string[];
};

type LinkCheckConfig = {
  ignoredExternalHosts: string[];
  ignoredExternalUrls: string[];
};

type LinkReference = {
  sourcePath: string;
  sourceSlug: string;
  destination: string;
  line: number;
};

const DEFAULT_CONFIG: LinkCheckConfig = {
  ignoredExternalHosts: [],
  ignoredExternalUrls: [],
};

function isDividerEntry(entry: string): boolean {
  return entry.startsWith("---") && entry.endsWith("---");
}

function normalizePathname(value: string): string {
  if (value === "/") {
    return value;
  }

  return value.replace(/\/+$/, "");
}

function stripMarkdownSource(source: string): string {
  return source
    .replace(/^---\n[\s\S]*?\n---\n?/m, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "");
}

function extractMarkdownLinks(source: string): Array<{ destination: string; line: number }> {
  const links: Array<{ destination: string; line: number }> = [];
  const linkPattern = /\[[^\]]+\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g;

  for (const match of source.matchAll(linkPattern)) {
    const destination = match[1]?.split(/\s+"/)[0]?.trim();
    if (!destination) {
      continue;
    }

    const line = source.slice(0, match.index ?? 0).split("\n").length;
    links.push({ destination, line });
  }

  return links;
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

async function loadDocsMeta(): Promise<DocsMeta> {
  const json = await fs.readFile(docsMetaPath, "utf8");
  return JSON.parse(json) as DocsMeta;
}

async function loadConfig(): Promise<LinkCheckConfig> {
  const json = await fs.readFile(configPath, "utf8").catch(() => JSON.stringify(DEFAULT_CONFIG));
  return { ...DEFAULT_CONFIG, ...(JSON.parse(json) as Partial<LinkCheckConfig>) };
}

async function loadDocPages(): Promise<Map<string, string>> {
  const files = await listFiles(docsContentDir);
  const mdxFiles = files.filter((filePath) => filePath.endsWith(".mdx"));
  const pages = new Map<string, string>();

  const sources = await Promise.all(
    mdxFiles.map(async (filePath) => ({ filePath, raw: await fs.readFile(filePath, "utf8") }))
  );

  for (const { filePath, raw } of sources) {
    if (isPageSourcePublished(raw, filePath)) {
      pages.set(toPageSlug(filePath), filePath);
    } else {
      excludedSlugs.add(toPageSlug(filePath));
    }
  }

  return pages;
}

async function loadSectionDirs(): Promise<Set<string>> {
  const dirs = new Set<string>();

  async function walk(dirPath: string): Promise<void> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const subDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dirPath, entry.name));
    for (const fullPath of subDirs) {
      dirs.add(path.relative(docsContentDir, fullPath).replace(/\\/g, "/"));
    }
    await Promise.all(subDirs.map(walk));
  }

  await walk(docsContentDir);
  return dirs;
}

async function loadPublicAssetPaths(): Promise<Set<string>> {
  const files = await listFiles(docsPublicDir).catch(() => []);
  const paths = new Set<string>();

  for (const filePath of files) {
    const relativePath = path.relative(docsPublicDir, filePath).replace(/\\/g, "/");
    paths.add(`/${relativePath}`);
  }

  return paths;
}

function createAllowedInternalPaths(docSlugs: Iterable<string>): Set<string> {
  const allowed = new Set<string>([
    "/docs",
    "/docs/ai/llms.txt",
    "/docs/ai/llms-full.txt",
    "/llms.txt",
    "/llms-full.txt",
    "/robots.txt",
    "/docs/sitemap.xml",
  ]);

  // Every page also serves as Markdown at its `.md`, which the Markdown forms link (a family's
  // table of API operations, in docs-blocks.ts).
  for (const slug of docSlugs) {
    allowed.add(normalizePathname(getDocsPagePath(slug)));
    allowed.add(getDocsMarkdownPath(slug));
  }

  return allowed;
}

function resolveRelativeDocsPath(sourceSlug: string, destination: string): string {
  const sourceDir =
    path.posix.basename(sourceSlug) === "index"
      ? getDocsPagePath(sourceSlug)
      : path.posix.dirname(getDocsPagePath(sourceSlug));
  const resolved = path.posix.normalize(path.posix.join(sourceDir, destination));
  return resolved.startsWith("/") ? resolved : `/${resolved}`;
}

function stripQueryAndFragment(destination: string): string {
  return destination.split("#")[0]?.split("?")[0] ?? destination;
}

/**
 * This repository's `main` links resolve against the checkout, so a page can
 * link a file its own change adds, and a wrong path fails without a network call.
 */
async function findMissingRepoMainPaths(links: LinkReference[]): Promise<string[]> {
  const findings = await Promise.all(
    links.map(async (link) => {
      const repoPath = repoMainLink.exec(link.destination.trim())?.[1];
      if (repoPath === undefined) return null;
      const exists = await fs.access(path.join(repoRoot, decodeURIComponent(repoPath))).then(
        () => true,
        () => false
      );
      return exists
        ? null
        : `${link.sourcePath}:${link.line} links "${repoPath}", which is not in this checkout`;
    })
  );
  return findings.filter((finding): finding is string => finding !== null);
}

function shouldIgnoreExternalUrl(url: URL, config: LinkCheckConfig): boolean {
  return (
    config.ignoredExternalUrls.includes(url.toString()) ||
    config.ignoredExternalHosts.includes(url.host)
  );
}

async function collectLinks(pages: Map<string, string>): Promise<LinkReference[]> {
  const perPage = await Promise.all(
    [...pages].map(async ([slug, filePath]) => {
      const raw = await fs.readFile(filePath, "utf8");
      const source = stripMarkdownSource(expandDocsBlocks(raw, filePath));
      return extractMarkdownLinks(source).map((link) => ({
        sourcePath: filePath,
        sourceSlug: slug,
        destination: link.destination,
        line: link.line,
      }));
    })
  );

  return perPage.flat();
}

function findMissingNavEntries(
  meta: DocsMeta,
  pages: Map<string, string>,
  sectionDirs: Set<string>
): string[] {
  const findings: string[] = [];

  for (const entry of meta.pages ?? []) {
    if (isDividerEntry(entry)) {
      continue;
    }
    if (!pages.has(entry) && !sectionDirs.has(entry) && !excludedSlugs.has(entry)) {
      findings.push(`Missing docs page for navigation entry "${entry}" in ${docsMetaPath}`);
    }
  }

  return findings;
}

async function run(): Promise<void> {
  const [meta, config, pages, sectionDirs, publicAssetPaths] = await Promise.all([
    loadDocsMeta(),
    loadConfig(),
    loadDocPages(),
    loadSectionDirs(),
    loadPublicAssetPaths(),
  ]);
  const allowedInternalPaths = createAllowedInternalPaths(pages.keys());
  for (const assetPath of publicAssetPaths) {
    allowedInternalPaths.add(normalizePathname(assetPath));
  }
  const findings: string[] = [...findMissingNavEntries(meta, pages, sectionDirs)];

  const links = await collectLinks(pages);
  findings.push(...(await findMissingRepoMainPaths(links)));
  const externalUrls = new Map<string, LinkReference[]>();

  for (const link of links) {
    const destination = link.destination.trim();
    if (!destination || destination.startsWith("#") || destination.startsWith("mailto:")) {
      continue;
    }
    if (destination.startsWith("tel:")) {
      continue;
    }

    if (destination.startsWith("http://") || destination.startsWith("https://")) {
      const url = new URL(destination);
      if (shouldIgnoreExternalUrl(url, config) || repoMainLink.test(url.toString())) {
        continue;
      }
      const refs = externalUrls.get(url.toString()) ?? [];
      refs.push(link);
      externalUrls.set(url.toString(), refs);
      continue;
    }

    const normalizedDestination = stripQueryAndFragment(destination);
    const resolvedInternalPath = normalizedDestination.startsWith("/")
      ? normalizedDestination
      : resolveRelativeDocsPath(link.sourceSlug, normalizedDestination);
    const normalizedInternalPath = normalizePathname(resolvedInternalPath);

    if (!allowedInternalPaths.has(normalizedInternalPath)) {
      findings.push(
        `${link.sourcePath}:${link.line} references missing docs path "${destination}" (resolved to "${normalizedInternalPath}")`
      );
    }
  }

  const externalProbeResults = await Promise.all(
    [...externalUrls.entries()].map(async ([url, refs]) => ({
      url,
      refs,
      result: await probeExternalUrl(url),
    }))
  );

  for (const { url, refs, result } of externalProbeResults) {
    if (result.ok) {
      continue;
    }

    const locations = refs.map((ref) => `${ref.sourcePath}:${ref.line}`).join(", ");
    const detail = result.error ? result.error : `HTTP ${result.status}`;
    findings.push(`External URL check failed for ${url} (${detail}) referenced at ${locations}`);
  }

  if (findings.length > 0) {
    throw new Error(`Docs link integrity failed:\n- ${findings.join("\n- ")}`);
  }

  console.log(
    `Docs link integrity passed (${releaseChannel}): ${pages.size} pages, ${links.length} markdown links, ${externalUrls.size} external URLs checked.`
  );
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
