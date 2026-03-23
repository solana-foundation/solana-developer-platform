import { DEFAULT_SDP_API_URL, DEFAULT_SDP_DOCS_URL, SDP_GITHUB_REPO_URL } from "@sdp/types";

export const docsUrl = process.env.NEXT_PUBLIC_SDP_DOCS_URL || DEFAULT_SDP_DOCS_URL;
export const docsOrigin = new URL(docsUrl).origin;
export const apiUrl = process.env.NEXT_PUBLIC_SDP_API_URL || DEFAULT_SDP_API_URL;
export const apiOpenApiUrl = `${apiUrl}/openapi.json`;
export const apiDocsUrl = `${apiUrl}/docs`;
export const repositoryUrl = SDP_GITHUB_REPO_URL;
export const aiGuidePath = getDocsPagePath("reference/ai-consumption");
export const aiGuideUrl = `${docsOrigin}${aiGuidePath}`;
export const aiLlmsPath = "/docs/ai/llms.txt";
export const aiLlmsUrl = `${docsOrigin}${aiLlmsPath}`;
export const aiLlmsFullPath = "/docs/ai/llms-full.txt";
export const aiLlmsFullUrl = `${docsOrigin}${aiLlmsFullPath}`;

export function normalizeDocsPageSlug(pageSlug: string): string {
  return pageSlug.replace(/\/index$/, "");
}

export function getDocsPagePath(pageSlug: string): string {
  const normalized = normalizeDocsPageSlug(pageSlug);
  return normalized ? `/docs/${normalized}` : "/docs";
}

export function getDocsPageUrl(pageSlug: string): string {
  return `${docsOrigin}${getDocsPagePath(pageSlug)}`;
}
