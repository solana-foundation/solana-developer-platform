// Upstream error bodies routinely echo request headers, credential ids, or key
// material back to us, so they must never reach logs or API clients verbatim.
// Only short, identifier-shaped values from these known code fields survive.
const UPSTREAM_ERROR_CODE_KEYS = [
  "errorCode",
  "error_code",
  "errorType",
  "code",
  "status",
  "type",
  "reason",
];
const UPSTREAM_ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const UNKNOWN_UPSTREAM_ERROR_CODE = "unavailable";

/**
 * Reduce an upstream error body to a single machine-readable code that is safe
 * to surface in error messages. Free-form prose (anything with whitespace),
 * oversized values, and unrecognized shapes all collapse to `unavailable`.
 *
 * `httpStatus` is used to drop code fields that merely repeat the HTTP status,
 * so Google-style `{ error: { code: 400, status: "INVALID_ARGUMENT" } }` bodies
 * report the descriptive status instead of the redundant number.
 */
export function summarizeUpstreamErrorBody(rawBody: string, httpStatus?: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return UNKNOWN_UPSTREAM_ERROR_CODE;
  }

  for (const candidate of [parsed, readErrorEnvelope(parsed)]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }

    const record = candidate as Record<string, unknown>;
    for (const key of UPSTREAM_ERROR_CODE_KEYS) {
      const code = normalizeUpstreamErrorCode(record[key], httpStatus);
      if (code) {
        return code;
      }
    }
  }

  return UNKNOWN_UPSTREAM_ERROR_CODE;
}

function readErrorEnvelope(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  return (parsed as Record<string, unknown>).error;
}

function normalizeUpstreamErrorCode(value: unknown, httpStatus?: number): string | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value !== httpStatus ? String(value) : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!UPSTREAM_ERROR_CODE_PATTERN.test(trimmed) || trimmed === String(httpStatus)) {
    return null;
  }

  return trimmed;
}
