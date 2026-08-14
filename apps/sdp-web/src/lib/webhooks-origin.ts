/**
 * The webhooks section is not in the sidebar — it is reached from an asset's Workflows tab,
 * which passes the asset it came from as `?from=`, so the page can offer a way back to that
 * tab. That value ends up in an href, so it is validated against the id shape the issuance
 * routes use rather than trusted: a caller-supplied string must never be able to point the
 * back link somewhere else.
 */
const TOKEN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function webhooksOriginTokenId(from: string | null | undefined): string | null {
  return typeof from === "string" && TOKEN_ID_RE.test(from) ? from : null;
}

export function webhooksOriginHref(tokenId: string): string {
  return `/dashboard/issuance/${encodeURIComponent(tokenId)}/asset-profile?tab=workflows`;
}
