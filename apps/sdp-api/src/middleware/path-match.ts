/**
 * Shared matcher for the KV-free / rate-limit-free path lists (KV_FREE_PATHS).
 *
 * An entry matches a request path when it is:
 *  - exact (`spec === path`),
 *  - a segment prefix (`spec` matches `spec/...` but NOT `spec<other>`), or
 *  - a single-segment wildcard: a `*` matches exactly one path segment (no
 *    slash). Used to scope the public token-metadata route precisely (the
 *    token-id segment of `/v1/issuance/tokens/<tokenId>/metadata.json`), so it
 *    skips KV + rate-limit without freeing the sibling authed
 *    `/v1/issuance/tokens/:id/...` routes a coarse prefix would match, nor a
 *    hypothetical future `/admin/.../metadata.json` a bare suffix glob would
 *    silently free.
 *
 * Used by both kvStoreMiddleware and skipRateLimitPaths so the two lists can
 * never diverge on matching semantics.
 */
export function matchesFreePath(path: string, specs: readonly string[]): boolean {
  return specs.some((spec) =>
    spec.includes("*") ? matchesWildcard(path, spec) : path === spec || path.startsWith(`${spec}/`)
  );
}

/**
 * Match a path against a spec containing `*` segments, where each `*` stands
 * for exactly one path segment (it never spans a `/`). Anchored at both ends.
 */
function matchesWildcard(path: string, spec: string): boolean {
  const pattern = spec
    .split("/")
    .map((segment) => (segment === "*" ? "[^/]+" : escapeRegExp(segment)))
    .join("/");
  return new RegExp(`^${pattern}$`).test(path);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
