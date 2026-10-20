/**
 * Where the dashboard serves the playground's API calls: `/api/playground/v1/...`
 * runs `/v1/...` on sdp-api as the signed-in member
 * (`app/api/playground/v1/[...path]/route.ts`).
 */
export const PLAYGROUND_PROXY_PREFIX = "/api/playground";

/**
 * Response headers the playground proxy passes back and the shell shows under
 * Headers. An allowlist, not a denylist: anything the API adds later (cookies,
 * internal routing) stays out until someone decides it belongs. Content-Length
 * is left out: fetch decodes a compressed upstream body, so its length no
 * longer matches.
 */
export const PLAYGROUND_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "cache-control",
  "content-type",
  "date",
  "etag",
  "idempotency-key",
  "idempotent-replayed",
  "location",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-request-id",
  "x-sdp-trace-id",
]);

/**
 * The allowlisted headers of a playground response ({@link PLAYGROUND_RESPONSE_HEADERS}).
 *
 * @param headers - The response's headers.
 */
export function playgroundResponseHeaders(headers: Headers): Record<string, string> {
  const shown: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (PLAYGROUND_RESPONSE_HEADERS.has(name)) {
      shown[name] = value;
    }
  }
  return shown;
}
