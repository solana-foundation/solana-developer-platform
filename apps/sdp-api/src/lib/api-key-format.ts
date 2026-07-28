import type { Context } from "hono";
import type { Env } from "@/types/env";

/**
 * Extracts the API key credential from the Authorization header, supporting
 * both "Bearer sk_xxx" and a raw "sk_xxx" value.
 */
export function extractApiKey(c: Context<{ Bindings: Env }>): string | null {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return null;
  }

  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  if (authHeader.startsWith("sk_")) {
    return authHeader;
  }

  return null;
}

/**
 * Checks whether a credential is shaped like an SDP API key. Shared by auth
 * (key lookup) and pre-auth rate limiting (anonymous limit vs keyed backstop),
 * which must agree on what counts as a key.
 */
export function looksLikeApiKey(token: string): boolean {
  return token.startsWith("sk_");
}
