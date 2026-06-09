import type { Context } from "hono";
import { getDb } from "@/db";
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

  const tokenService = new TokenService(getDb(c.env));
  const metadata = await tokenService.getPublicTokenMetadata(tokenId);

  // Public endpoint: any origin may fetch it (see handler doc above).
  c.header("Access-Control-Allow-Origin", "*");

  if (!metadata) {
    return c.json({ error: { code: "NOT_FOUND", message: "Token not found" } }, 404);
  }

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

  return c.json(body);
};
