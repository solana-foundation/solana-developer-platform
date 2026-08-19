/**
 * Strict allowlist for the deposits-list passthrough, same posture as
 * `vaultPositionsProxyQuery`: this route is consumed only by our own typed
 * client, so an unknown key, a repeated key or an out-of-range limit is a 400
 * rather than a silently reshaped page. A typo must not return a different
 * page of someone's money.
 */
export function vaultDepositsProxyQuery(
  request: Request
): { ok: true; query: string } | { ok: false; message: string } {
  const url = new URL(request.url);
  const allowed = new Set(["limit", "before", "requestId"]);
  const forwarded = new URLSearchParams();

  for (const key of new Set(url.searchParams.keys())) {
    if (!allowed.has(key)) return { ok: false, message: `Unsupported query parameter: ${key}` };
    const values = url.searchParams.getAll(key);
    if (values.length !== 1) return { ok: false, message: `Repeated query parameter: ${key}` };
    const value = values[0] as string;
    if (key === "limit" && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) {
      return { ok: false, message: "limit must be an integer from 1 to 100" };
    }
    if (key === "before" && !/^[A-Za-z0-9_-]{1,512}$/.test(value)) {
      return { ok: false, message: "before must be a base64url cursor" };
    }
    // An idempotency key is caller-chosen printable ASCII (1-255) per the API's
    // IDEMPOTENCY_KEY_PATTERN. Validate the same shape here rather than a
    // narrower one, or a legitimate key with a slash or a space would 400.
    if (key === "requestId" && !/^[\x20-\x7e]{1,255}$/.test(value)) {
      return { ok: false, message: "requestId must be printable ASCII, 1-255 characters" };
    }
    forwarded.set(key, value);
  }

  const query = forwarded.toString();
  return { ok: true, query: query ? `?${query}` : "" };
}
