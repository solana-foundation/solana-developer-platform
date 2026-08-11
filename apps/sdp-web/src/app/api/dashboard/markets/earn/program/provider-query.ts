import { EARN_PROVIDERS } from "@sdp/types";

const PROVIDERS = new Set<string>(EARN_PROVIDERS);

/** Longest cursor we will forward — Ground cursors are short opaque tokens. */
const MAX_CURSOR_LENGTH = 512;

/**
 * Allowlisted query passthrough for the program proxy routes: only a known
 * provider id and (optionally) a bounded opaque cursor survive; anything else
 * is dropped so the proxy can't be steered with arbitrary query strings.
 */
export function programProxyQuery(request: Request, options?: { cursor?: boolean }): string {
  const incoming = new URL(request.url);
  const query = new URLSearchParams();

  const provider = incoming.searchParams.get("provider");
  if (provider && PROVIDERS.has(provider)) query.set("provider", provider);

  if (options?.cursor) {
    const cursor = incoming.searchParams.get("cursor");
    if (cursor && cursor.length <= MAX_CURSOR_LENGTH) query.set("cursor", cursor);
  }

  return query.size > 0 ? `?${query}` : "";
}
