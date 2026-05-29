import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDocsPagePath } from "../src/lib/site";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const docsContentDir = path.resolve(__dirname, "../content/docs");
const docsPublicDir = path.resolve(__dirname, "../public");
const docsMetaPath = path.resolve(docsContentDir, "meta.json");
const configPath = path.resolve(__dirname, "link-check.config.json");
const EXTERNAL_URL_TIMEOUT_MS = 10_000;

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
  const relativePath = path.relative(docsContentDir, filePath).replace(/\\/g, "/");
  return relativePath.replace(/\.mdx$/, "");
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

  for (const filePath of mdxFiles) {
    pages.set(toPageSlug(filePath), filePath);
  }

  return pages;
}

async function loadSectionDirs(): Promise<Set<string>> {
  const dirs = new Set<string>();

  async function walk(dirPath: string): Promise<void> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const fullPath = path.join(dirPath, entry.name);
      dirs.add(path.relative(docsContentDir, fullPath).replace(/\\/g, "/"));
      await walk(fullPath);
    }
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
    "/sitemap.xml",
  ]);

  for (const slug of docSlugs) {
    allowed.add(normalizePathname(getDocsPagePath(slug)));
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

function shouldIgnoreExternalUrl(url: URL, config: LinkCheckConfig): boolean {
  return (
    config.ignoredExternalUrls.includes(url.toString()) ||
    config.ignoredExternalHosts.includes(url.host)
  );
}

async function probeExternalUrl(
  url: string
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const attempt = async (method: "HEAD" | "GET") => {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      signal: AbortSignal.timeout(EXTERNAL_URL_TIMEOUT_MS),
      headers: {
        "user-agent": "sdp-docs-link-checker/1.0",
      },
    });

    return response.status;
  };

  try {
    const headStatus = await attempt("HEAD");
    if ([401, 403, 429].includes(headStatus) || (headStatus >= 200 && headStatus < 400)) {
      return { ok: true, status: headStatus };
    }
    if (headStatus !== 405) {
      return { ok: false, status: headStatus };
    }
  } catch {
    try {
      const getStatus = await attempt("GET");
      if ([401, 403, 429].includes(getStatus) || (getStatus >= 200 && getStatus < 400)) {
        return { ok: true, status: getStatus };
      }
      return { ok: false, status: getStatus };
    } catch (nestedError) {
      return {
        ok: false,
        error: nestedError instanceof Error ? nestedError.message : String(nestedError),
      };
    }
  }

  try {
    const getStatus = await attempt("GET");
    if ([401, 403, 429].includes(getStatus) || (getStatus >= 200 && getStatus < 400)) {
      return { ok: true, status: getStatus };
    }
    return { ok: false, status: getStatus };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function collectLinks(pages: Map<string, string>): Promise<LinkReference[]> {
  const references: LinkReference[] = [];

  for (const [slug, filePath] of pages) {
    const raw = await fs.readFile(filePath, "utf8");
    const source = stripMarkdownSource(raw);

    for (const link of extractMarkdownLinks(source)) {
      references.push({
        sourcePath: filePath,
        sourceSlug: slug,
        destination: link.destination,
        line: link.line,
      });
    }
  }

  return references;
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
    if (!pages.has(entry) && !sectionDirs.has(entry)) {
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
      if (shouldIgnoreExternalUrl(url, config)) {
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
    `Docs link integrity passed: ${pages.size} pages, ${links.length} markdown links, ${externalUrls.size} external URLs checked.`
  );
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
