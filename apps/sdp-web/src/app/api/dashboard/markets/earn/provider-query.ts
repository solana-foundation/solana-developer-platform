import { EARN_PROVIDERS } from "@sdp/types";

const PROVIDERS = new Set<string>(EARN_PROVIDERS);

/** Longest cursor we will forward — Ground cursors are short opaque tokens. */
const MAX_CURSOR_LENGTH = 512;

export type ProxyQueryValidation = { ok: true; query: string } | { ok: false; message: string };

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

/**
 * Strict allowlist for the keyset-paginated vault-position read. Unlike the
 * older program proxies, this route is consumed only by our typed client, so a
 * malformed or unknown parameter is a caller bug and returns 400 instead of
 * silently changing the requested page.
 */
export function vaultPositionsProxyQuery(request: Request): ProxyQueryValidation {
  const incoming = new URL(request.url).searchParams;
  const allowed = new Set(["limit", "before"]);

  for (const key of incoming.keys()) {
    if (!allowed.has(key)) {
      return { ok: false, message: `Unsupported vault positions query parameter: ${key}` };
    }
  }

  for (const key of allowed) {
    if (incoming.getAll(key).length > 1) {
      return { ok: false, message: `Vault positions query parameter must be unique: ${key}` };
    }
  }

  const query = new URLSearchParams();
  const limit = incoming.get("limit");
  if (limit !== null) {
    if (!/^(?:[1-9]|[1-9]\d|100)$/.test(limit)) {
      return { ok: false, message: "Vault positions limit must be an integer from 1 to 100" };
    }
    query.set("limit", limit);
  }

  const before = incoming.get("before");
  if (before !== null) {
    if (
      before.length === 0 ||
      before.length > MAX_CURSOR_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(before)
    ) {
      return { ok: false, message: "Vault positions cursor is invalid" };
    }
    query.set("before", before);
  }

  return { ok: true, query: query.size > 0 ? `?${query}` : "" };
}

/**
 * Strict allowlist for the keyset-paginated deposit read, same posture and same
 * shared limits as `vaultPositionsProxyQuery` above — both are consumed only by
 * our typed client, so a malformed or unknown parameter is a caller bug and
 * returns 400 rather than silently changing the requested page.
 *
 * `requestId` is the one parameter here that is not ours: it is a caller-minted
 * idempotency key, and the API accepts `[\x20-\x7e]{1,255}`
 * (`middleware/idempotency-key.ts`). Validated to that SAME shape rather than a
 * tidier one, because a narrower rule would 400 a legitimate key containing a
 * slash or a space.
 */
export function vaultDepositsProxyQuery(request: Request): ProxyQueryValidation {
  const incoming = new URL(request.url).searchParams;
  const allowed = new Set(["limit", "before", "requestId", "settled"]);

  for (const key of incoming.keys()) {
    if (!allowed.has(key)) {
      return { ok: false, message: `Unsupported vault deposits query parameter: ${key}` };
    }
  }

  for (const key of allowed) {
    if (incoming.getAll(key).length > 1) {
      return { ok: false, message: `Vault deposits query parameter must be unique: ${key}` };
    }
  }

  const query = new URLSearchParams();
  const limit = incoming.get("limit");
  if (limit !== null) {
    if (!/^(?:[1-9]|[1-9]\d|100)$/.test(limit)) {
      return { ok: false, message: "Vault deposits limit must be an integer from 1 to 100" };
    }
    query.set("limit", limit);
  }

  const before = incoming.get("before");
  if (before !== null) {
    if (
      before.length === 0 ||
      before.length > MAX_CURSOR_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(before)
    ) {
      return { ok: false, message: "Vault deposits cursor is invalid" };
    }
    query.set("before", before);
  }

  const requestId = incoming.get("requestId");
  if (requestId !== null) {
    if (!/^[\x20-\x7e]{1,255}$/.test(requestId)) {
      return {
        ok: false,
        message: "Vault deposits requestId must be printable ASCII, 1-255 characters",
      };
    }
    query.set("requestId", requestId);
  }

  const settled = incoming.get("settled");
  if (settled !== null) {
    if (settled !== "true" && settled !== "false") {
      return { ok: false, message: "Vault deposits settled filter must be true or false" };
    }
    query.set("settled", settled);
  }

  return { ok: true, query: query.size > 0 ? `?${query}` : "" };
}
