import { DEFAULT_SDP_API_URL, DEFAULT_SDP_DOCS_URL, SDP_GITHUB_REPO_URL } from "@sdp/types";

export function normalizeDocsPageSlug(pageSlug: string): string {
  return pageSlug.replace(/\/index$/, "");
}

export function getDocsPagePath(pageSlug: string): string {
  const normalized = normalizeDocsPageSlug(pageSlug);
  return normalized ? `/docs/${normalized}` : "/docs";
}

/**
 * Derives the full URL set from a docs/api base pair, so the env-aware site
 * and the canonical constants below can never drift in shape.
 */
function buildSiteUrls(docsUrl: string, apiUrl: string) {
  const docsOrigin = new URL(docsUrl).origin;
  const aiGuidePath = getDocsPagePath("reference/ai-consumption");
  const aiLlmsPath = "/docs/ai/llms.txt";
  const aiLlmsFullPath = "/docs/ai/llms-full.txt";
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
    getDocsPageUrl: (pageSlug: string): string => `${docsOrigin}${getDocsPagePath(pageSlug)}`,
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
  getDocsPageUrl,
} = site;
