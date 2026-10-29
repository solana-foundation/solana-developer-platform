import {
  DEFAULT_SDP_API_URL,
  DEFAULT_SDP_DOCS_URL,
  SDP_AI_GUIDE_DOCS_SLUG,
  SDP_GITHUB_REPO_URL,
} from "@sdp/types/site";

export function normalizeDocsPageSlug(pageSlug: string): string {
  return pageSlug.replace(/\/index$/, "");
}

/** A `(name)` folder: Fumadocs shows it in the sidebar and leaves it out of its pages' URLs. */
const FOLDER_GROUP = /^\(.+\)$/;

/**
 * A page's slug from its path in `content/docs` (`reference/api/payments/(transfers)/list.mdx`):
 * as Fumadocs makes it, without the extension or any `(name)` folder.
 */
export function docsPageSlugOf(relativePath: string): string {
  return relativePath
    .replace(/\.mdx$/, "")
    .split("/")
    .filter((segment) => !FOLDER_GROUP.test(segment))
    .join("/");
}

/** Whether a folder in `content/docs` is a `(name)` folder, a group of its parent's pages. */
export function isDocsFolderGroup(folderName: string): boolean {
  return FOLDER_GROUP.test(folderName);
}

export function getDocsPagePath(pageSlug: string): string {
  const normalized = normalizeDocsPageSlug(pageSlug);
  return normalized ? `/docs/${normalized}` : "/docs";
}

/** The page's Markdown, as the `.md` route serves it: `/docs.md` for the home. */
export function getDocsMarkdownPath(pageSlug: string): string {
  return `${getDocsPagePath(pageSlug)}.md`;
}

/**
 * Derives the full URL set from a docs/api base pair, so the env-aware site
 * and the canonical constants below can never drift in shape.
 */
function buildSiteUrls(docsUrl: string, apiUrl: string) {
  const docsOrigin = new URL(docsUrl).origin;
  const aiGuidePath = getDocsPagePath(SDP_AI_GUIDE_DOCS_SLUG);
  const aiLlmsPath = "/docs/ai/llms.txt";
  const aiLlmsFullPath = "/docs/ai/llms-full.txt";
  // Served from public/ at the docs root, and by sdp-web at the site root.
  const aiSkillPath = "/SKILL.md";
  return {
    docsUrl,
    docsOrigin,
    apiUrl,
    apiOpenApiUrl: `${apiUrl}/openapi.json`,
    apiDocsUrl: `${apiUrl}/docs`,
    aiGuidePath,
    aiGuideUrl: `${docsOrigin}${aiGuidePath}`,
    aiLlmsPath,
    aiLlmsUrl: `${docsOrigin}${aiLlmsPath}`,
    aiLlmsFullPath,
    aiLlmsFullUrl: `${docsOrigin}${aiLlmsFullPath}`,
    aiSkillPath,
    aiSkillUrl: `${docsOrigin}${aiSkillPath}`,
    getDocsPageUrl: (pageSlug: string): string => `${docsOrigin}${getDocsPagePath(pageSlug)}`,
    getDocsMarkdownUrl: (pageSlug: string): string =>
      `${docsOrigin}${getDocsMarkdownPath(pageSlug)}`,
  };
}

/**
 * Canonical production URLs for committed artifacts (llms.txt, llms-full.txt).
 * Always built from the @sdp/types defaults so a local or staging
 * NEXT_PUBLIC_SDP_DOCS_URL/NEXT_PUBLIC_SDP_API_URL never leaks into files
 * that get committed and served from every deployment.
 */
export const canonicalSite = buildSiteUrls(DEFAULT_SDP_DOCS_URL, DEFAULT_SDP_API_URL);

const site = buildSiteUrls(
  process.env.NEXT_PUBLIC_SDP_DOCS_URL || DEFAULT_SDP_DOCS_URL,
  process.env.NEXT_PUBLIC_SDP_API_URL || DEFAULT_SDP_API_URL
);

export const repositoryUrl = SDP_GITHUB_REPO_URL;
export const {
  docsUrl,
  docsOrigin,
  apiUrl,
  apiOpenApiUrl,
  apiDocsUrl,
  aiGuidePath,
  aiGuideUrl,
  aiLlmsPath,
  aiLlmsUrl,
  aiLlmsFullPath,
  aiLlmsFullUrl,
  aiSkillPath,
  aiSkillUrl,
  getDocsPageUrl,
  getDocsMarkdownUrl,
} = site;
