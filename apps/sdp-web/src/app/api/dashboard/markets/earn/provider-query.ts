import { EARN_PROVIDERS } from "@sdp/types";

const PROVIDERS = new Set<string>(EARN_PROVIDERS);

/** Longest cursor we will forward — Ground cursors are short opaque tokens. */
const MAX_CURSOR_LENGTH = 512;

/**
 * Allowlisted query passthrough for the program proxy routes: every param is
 * opt-in — a known provider id, a bounded opaque cursor, a page window — and
 * anything else is dropped so the proxy can't be steered with arbitrary query
 * strings. Opt-in because the params differ per route: only the collection
 * list still reads `provider` (per-program routes take it from the stored
 * row), only the deposits feed pages on a cursor.
 *
 * Lives at the `earn/` root rather than beside the routes because since
 * PRO-1670 its importers sit at several depths under `programs/[programId]/`.
 */
export function programProxyQuery(
  request: Request,
  options: { provider?: boolean; cursor?: boolean; page?: boolean }
): string {
  const incoming = new URL(request.url);
  const query = new URLSearchParams();

  if (options.provider) {
    const provider = incoming.searchParams.get("provider");
    if (provider && PROVIDERS.has(provider)) query.set("provider", provider);
  }

  if (options.cursor) {
    const cursor = incoming.searchParams.get("cursor");
    if (cursor && cursor.length <= MAX_CURSOR_LENGTH) query.set("cursor", cursor);
  }

  if (options.page) {
    for (const key of ["page", "pageSize"] as const) {
      const value = incoming.searchParams.get(key);
      // Digits only: the API coerces and range-checks, so this just keeps
      // anything non-numeric from reaching it.
      if (value && /^\d{1,4}$/.test(value)) query.set(key, value);
    }
  }

  return query.size > 0 ? `?${query}` : "";
}
