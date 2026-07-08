import type { Context } from "hono";
import { getDb } from "@/db";
import { createAssetProfilesRepository } from "@/db/repositories";
import { isAssetProfilesEnabled } from "@/lib/feature-flags";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

/**
 * Canonical URL of the SDP-hosted metadata JSON for a token.
 *
 * Derived from the request origin (not a hardcoded constant) so each
 * environment links to itself with zero config. The deploy handlers fall back
 * to this when the issuer didn't supply their own `uri`.
 */
export const canonicalMetadataUrl = (origin: string, tokenId: string): string =>
  `${origin}/v1/issuance/tokens/${tokenId}/metadata.json`;

/**
 * Origin to embed in the on-chain metadata URL.
 *
 * Prefers `env.PUBLIC_API_ORIGIN` so a deployment fronted by a proxy that
 * rewrites Host/scheme can pin the public origin — the URL is burned into the
 * on-chain MetadataPointer at deploy time, so an internal/unreachable origin
 * would be a permanent mistake. The configured value is normalized through
 * `URL.origin` so a stray trailing slash or path can't leak into the minted
 * URI. Falls back to the request origin (the public-facing origin on Cloudflare
 * Workers) when the env var is unset or malformed.
 */
export const resolveMetadataOrigin = (env: Env, requestUrl: string): string => {
  const configured = env.PUBLIC_API_ORIGIN?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Misconfigured env value — fall back to the request origin rather than
      // burning a malformed URL into the on-chain MetadataPointer.
    }
  }
  return new URL(requestUrl).origin;
};

/**
 * Public, unauthenticated handler serving a Token-2022 / Metaplex
 * fungible-compatible metadata JSON for a token, assembled from its DB row.
 *
 * Registered ahead of the issuance auth middleware so wallets and explorers can
 * fetch it without credentials. CORS is opened explicitly (`*`) here because the
 * global CORS middleware is origin-restricted in production. App-wide KV and
 * rate-limit bypass is wired via KV_FREE_PATHS in app.ts.
 */
export const serveTokenMetadata = async (c: AppContext) => {
  const { tokenId } = c.req.param();

  // Public endpoint: any origin may fetch it (see handler doc above). Set this
  // up-front so it applies to every response — success, both 404s, and the
  // error path. The header is set on the context, which the global onError
  // handler preserves when it builds the JSON error response, so a DB failure
  // surfaces as a readable 500 to browsers rather than an opaque CORS error.
  c.header("Access-Control-Allow-Origin", "*");

  const tokenService = new TokenService(getDb(c.env));
  const result = await tokenService.getPublicTokenMetadata(tokenId);

  if (result.status !== "deployed") {
    // Two different 404s, two cache policies. An unknown id never resolves, so a
    // short negative-cache TTL blunts enumeration probes (this route is
    // rate-limit-exempt, so each one would otherwise hit D1). A pending id, by
    // contrast, can flip to 200 within seconds of deploy — don't let a stale
    // 404 stick to it, so skip caching entirely.
    c.header("Cache-Control", result.status === "pending" ? "no-store" : "public, max-age=60");
    return c.json({ error: { code: "NOT_FOUND", message: "Token not found" } }, 404);
  }

  const metadata = result.metadata;
  c.header("Cache-Control", "public, max-age=300");

  const body: {
    name: string;
    symbol: string;
    description?: string;
    image?: string;
  } = {
    name: metadata.name,
    symbol: metadata.symbol,
  };

  // Omit description/image when absent rather than serving nulls — keeps the
  // JSON aligned with the Metaplex fungible shape consumers expect.
  if (metadata.description) {
    body.description = metadata.description;
  }
  if (metadata.imageUrl) {
    body.image = metadata.imageUrl;
  }

  // Layer the Asset Profile public projection over the base token fields when
  // the feature is enabled. The projection only ever contains registry
  // allow-listed, namespaced fields (asset/chain/...) — never compliance or
  // custom — and core token fields (name/symbol/...) always win on any overlap.
  // Gated by the same flag as the Asset Profiles family, so the canonical URI
  // already burned into deployed tokens serves the projection once it ships.
  if (isAssetProfilesEnabled(c.env)) {
    const publicMetadata = await createAssetProfilesRepository(c.env).getPublicMetadataByTokenId(
      tokenId
    );
    if (publicMetadata) {
      return c.json({ ...publicMetadata, ...body });
    }
  }

  return c.json(body);
};
