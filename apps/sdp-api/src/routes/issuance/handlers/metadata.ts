import type { Context } from "hono";
import { getDb } from "@/db";
import { createSystemAssetProfilesRepository } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { isAssetProfilesEnabled } from "@/lib/feature-flags";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

/**
 * Canonical URL of the SDP-hosted metadata JSON for a token.
 *
 * The id is encoded so a value with path characters can't splice extra
 * segments into the minted URI — ids are server-generated UUIDs today, but
 * this function must stay safe for any caller.
 */
export const canonicalMetadataUrl = (origin: string, tokenId: string): string =>
  `${origin}/v1/issuance/tokens/${encodeURIComponent(tokenId)}/metadata.json`;

/**
 * Origin to embed in the on-chain metadata URL — `env.PUBLIC_API_ORIGIN`, and
 * nothing else.
 *
 * The URL is burned into the on-chain MetadataPointer at deploy time, so it
 * must come from trusted configuration only. This used to fall back to the
 * request's own origin, which let a hostile or spoofed Host header (or a
 * malformed env value silently degrading to that fallback) pin an
 * attacker-controlled metadata URL into a mint forever (HOO-1013). Now a
 * missing, malformed, or non-http(s) value fails the deploy closed with a
 * config error instead. The configured value is normalized through
 * `URL.origin` so a stray trailing slash or path can't leak into the minted
 * URI.
 */
export const resolveMetadataOrigin = (env: Env): string => {
  const configured = env.PUBLIC_API_ORIGIN?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "http:" || url.protocol === "https:") {
        return url.origin;
      }
    } catch {
      // Malformed — fall through to the config error below.
    }
  }

  throw new AppError(
    "INTERNAL_ERROR",
    "PUBLIC_API_ORIGIN must be set to a valid http(s) origin to mint SDP-hosted metadata URLs"
  );
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
    const publicMetadata = await createSystemAssetProfilesRepository(
      c.env
    ).getPublicMetadataByTokenId(tokenId);
    if (publicMetadata) {
      return c.json({ ...publicMetadata, ...body });
    }
  }

  return c.json(body);
};
