export const DEFAULT_SDP_DOCS_URL = "https://platform.solana.com/docs";
export const DEFAULT_SDP_API_URL = "https://api.solana.com";
export const SDP_GITHUB_REPO_URL = "https://github.com/solana-foundation/solana-developer-platform";
export const SDP_GITHUB_REPO_BLOB_MAIN_URL = `${SDP_GITHUB_REPO_URL}/blob/main`;
export const SDP_GITHUB_REPO_RAW_MAIN_URL = `${SDP_GITHUB_REPO_URL}/raw/main`;
export const SDP_AGENTS_URL = `${SDP_GITHUB_REPO_BLOB_MAIN_URL}/AGENTS.md`;

export function getSdpDocsOrigin(url: string = DEFAULT_SDP_DOCS_URL): string {
  return new URL(url).origin;
}
