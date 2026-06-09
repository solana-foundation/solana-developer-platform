/**
 * Shared matcher for the KV-free / rate-limit-free path lists (KV_FREE_PATHS).
 *
 * An entry matches a request path when it is:
 *  - exact (`spec === path`),
 *  - a segment prefix (`spec` matches `spec/...` but NOT `spec<other>`), or
 *  - a suffix glob: an entry beginning with `*` matches any path ending in the
 *    remainder. Used for the public token-metadata route (`*​/metadata.json`),
 *    which must skip KV + rate-limit without freeing the sibling authed
 *    `/v1/issuance/tokens/:id/...` routes a coarse prefix would also match.
 *
 * Used by both kvStoreMiddleware and skipRateLimitPaths so the two lists can
 * never diverge on matching semantics.
 */
export function matchesFreePath(path: string, specs: readonly string[]): boolean {
  return specs.some((spec) =>
    spec.startsWith("*")
      ? path.endsWith(spec.slice(1))
      : path === spec || path.startsWith(`${spec}/`)
  );
}
