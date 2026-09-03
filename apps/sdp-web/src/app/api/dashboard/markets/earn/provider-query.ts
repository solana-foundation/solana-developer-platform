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
function positionsProxyQuery(
  request: Request,
  labels: { resource: string; title: string }
): ProxyQueryValidation {
  const incoming = new URL(request.url).searchParams;
  const allowed = new Set(["limit", "before"]);

  for (const key of incoming.keys()) {
    if (!allowed.has(key)) {
      return { ok: false, message: `Unsupported ${labels.resource} query parameter: ${key}` };
    }
  }

  for (const key of allowed) {
    if (incoming.getAll(key).length > 1) {
      return { ok: false, message: `${labels.title} query parameter must be unique: ${key}` };
    }
  }

  const query = new URLSearchParams();
  const limit = incoming.get("limit");
  if (limit !== null) {
    if (!/^(?:[1-9]|[1-9]\d|100)$/.test(limit)) {
      return { ok: false, message: `${labels.title} limit must be an integer from 1 to 100` };
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
      return { ok: false, message: `${labels.title} cursor is invalid` };
    }
    query.set("before", before);
  }

  return { ok: true, query: query.size > 0 ? `?${query}` : "" };
}

export function vaultPositionsProxyQuery(request: Request): ProxyQueryValidation {
  return positionsProxyQuery(request, {
    resource: "vault positions",
    title: "Vault positions",
  });
}

export function externalWalletPositionsProxyQuery(request: Request): ProxyQueryValidation {
  return positionsProxyQuery(request, {
    resource: "external-wallet positions",
    title: "External-wallet positions",
  });
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
function vaultMovementsProxyQuery(
  request: Request,
  resource: "deposits" | "withdrawals"
): ProxyQueryValidation {
  const incoming = new URL(request.url).searchParams;
  const allowed = new Set(["limit", "before", "requestId", "settled"]);
  const label = resource === "deposits" ? "Vault deposits" : "Vault withdrawals";

  for (const key of incoming.keys()) {
    if (!allowed.has(key)) {
      return { ok: false, message: `Unsupported vault ${resource} query parameter: ${key}` };
    }
  }

  for (const key of allowed) {
    if (incoming.getAll(key).length > 1) {
      return { ok: false, message: `${label} query parameter must be unique: ${key}` };
    }
  }

  const query = new URLSearchParams();
  const limit = incoming.get("limit");
  if (limit !== null) {
    if (!/^(?:[1-9]|[1-9]\d|100)$/.test(limit)) {
      return { ok: false, message: `${label} limit must be an integer from 1 to 100` };
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
      return { ok: false, message: `${label} cursor is invalid` };
    }
    query.set("before", before);
  }

  const requestId = incoming.get("requestId");
  if (requestId !== null) {
    if (!/^[\x20-\x7e]{1,255}$/.test(requestId)) {
      return {
        ok: false,
        message: `${label} requestId must be printable ASCII, 1-255 characters`,
      };
    }
    query.set("requestId", requestId);
  }

  const settled = incoming.get("settled");
  if (settled !== null) {
    if (settled !== "true" && settled !== "false") {
      return { ok: false, message: `${label} settled filter must be true or false` };
    }
    query.set("settled", settled);
  }

  return { ok: true, query: query.size > 0 ? `?${query}` : "" };
}

export function vaultDepositsProxyQuery(request: Request): ProxyQueryValidation {
  return vaultMovementsProxyQuery(request, "deposits");
}

/**
 * Strict allowlist for the keyset-paginated withdrawal read. It mirrors the
 * deposit reader's posture and parameter set, including the
 * idempotency-key shape rule (the API's `[\x20-\x7e]{1,255}`).
 */
export function vaultWithdrawalsProxyQuery(request: Request): ProxyQueryValidation {
  return vaultMovementsProxyQuery(request, "withdrawals");
}

/**
 * Strict allowlist for the cross-provider movement feed, same posture as the two
 * readers above: consumed only by our typed client, so an unknown or duplicated
 * parameter is a caller bug and returns 400 rather than silently changing the
 * page.
 *
 * The filter values are deliberately validated for SHAPE and length only, not
 * against a vocabulary. `status` is per execution model and `provider` is an open
 * registry string, so a client-side allowlist here would have to be revised every
 * time either grows — and the API already answers an unknown value with an empty
 * page, which is the honest result. Addresses and ids are bounded because they
 * reach an indexed equality match, never a pattern.
 */
export function earnMovementsProxyQuery(request: Request): ProxyQueryValidation {
  const incoming = new URL(request.url).searchParams;
  const allowed = new Set([
    "limit",
    "before",
    "direction",
    "status",
    "provider",
    "positionId",
    "sourceAddress",
    "destinationAddress",
  ]);

  for (const key of incoming.keys()) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        message: `Unsupported Embedded Yield movements query parameter: ${key}`,
      };
    }
  }

  for (const key of allowed) {
    if (incoming.getAll(key).length > 1) {
      return {
        ok: false,
        message: `Embedded Yield movements query parameter must be unique: ${key}`,
      };
    }
  }

  const query = new URLSearchParams();
  const limit = incoming.get("limit");
  if (limit !== null) {
    if (!/^(?:[1-9]|[1-9]\d|100)$/.test(limit)) {
      return {
        ok: false,
        message: "Embedded Yield movements limit must be an integer from 1 to 100",
      };
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
      return { ok: false, message: "Embedded Yield movements cursor is invalid" };
    }
    query.set("before", before);
  }

  const direction = incoming.get("direction");
  if (direction !== null) {
    if (direction !== "deposit" && direction !== "withdrawal") {
      return {
        ok: false,
        message: "Embedded Yield movements direction must be deposit or withdrawal",
      };
    }
    query.set("direction", direction);
  }

  for (const [key, maxLength] of [
    ["status", 64],
    ["provider", 64],
    ["positionId", 128],
    ["sourceAddress", 128],
    ["destinationAddress", 128],
  ] as const) {
    const value = incoming.get(key);
    if (value === null) continue;
    if (value.length === 0 || value.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(value)) {
      return { ok: false, message: `Embedded Yield movements ${key} is invalid` };
    }
    query.set(key, value);
  }

  return { ok: true, query: query.size > 0 ? `?${query}` : "" };
}
