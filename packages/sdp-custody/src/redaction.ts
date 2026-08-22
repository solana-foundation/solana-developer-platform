const REDACTED = "[REDACTED]";

const SENSITIVE_JSON_FIELD_PATTERN =
  /(["'])(app[-_ ]?secret|api[-_ ]?secret|api[-_ ]?key|client[-_ ]?secret|wallet[-_ ]?secret|signing[-_ ]?secret|private[-_ ]?key|secret[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|authorization|password|pem|token|secret|credential)\1\s*:\s*(["'])(.*?)\3/gi;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(app[-_ ]?secret|api[-_ ]?secret|api[-_ ]?key|client[-_ ]?secret|wallet[-_ ]?secret|signing[-_ ]?secret|private[-_ ]?key|secret[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|authorization|password|pem|token|secret|credential)\b(\s*[:=]\s*)[^,\s}]+/gi;
// Quantified parts all exclude "-" so the pattern cannot backtrack across the
// PEM delimiters (keeps the regex linear; PEM bodies are base64 + whitespace).
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s]*-----END [A-Z ]*PRIVATE KEY-----/g;
const AUTH_HEADER_PATTERN = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]+)/gi;

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

export function redactCredentialString(value: string): string {
  return value
    .replace(PRIVATE_KEY_PATTERN, REDACTED)
    .replace(AUTH_HEADER_PATTERN, (match, scheme: string, token: string) =>
      isLikelyAuthToken(scheme, token) ? `${scheme} ${REDACTED}` : match
    )
    .replace(
      SENSITIVE_JSON_FIELD_PATTERN,
      (_match, quote: string, key: string, valueQuote: string) =>
        `${quote}${key}${quote}:${valueQuote}${REDACTED}${valueQuote}`
    )
    .replace(
      SENSITIVE_ASSIGNMENT_PATTERN,
      (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`
    );
}

function isLikelyAuthToken(scheme: string, token: string): boolean {
  const minLength = scheme.toLowerCase() === "basic" ? 12 : 16;
  return token.length >= minLength || /[0-9._~+/=-]/.test(token);
}

export function redactCredentialSecrets<T>(value: T): T {
  return redactValue(value, new WeakSet<object>()) as T;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactCredentialString(value);
  }

  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactCredentialString(value.message),
      ...(value.stack ? { stack: redactCredentialString(value.stack) } : {}),
      ...("cause" in value ? { cause: redactValue(value.cause, seen) } : {}),
    };
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof URL) {
    return value.toString();
  }

  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return REDACTED;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveCredentialKey(key) ? REDACTED : redactValue(item, seen);
  }
  return result;
}

function isSensitiveCredentialKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    normalized === "secret" ||
    normalized === "credential" ||
    normalized === "credentials" ||
    normalized === "apikey" ||
    normalized === "authorization" ||
    normalized === "password" ||
    normalized === "pem" ||
    normalized === "token" ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password") ||
    normalized.endsWith("token") ||
    normalized.endsWith("pem") ||
    normalized.includes("privatekey") ||
    normalized.includes("secretpayload") ||
    // Covers credentialId / allowedCredentialIds: a provider credential id
    // identifies the signing key it unlocks and must not reach a log sink.
    normalized.includes("credentialid")
  );
}
