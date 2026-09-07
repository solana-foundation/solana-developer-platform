/**
 * Credential-only redaction.
 *
 * This is the narrow pass that is safe to apply to client-facing error bodies:
 * a caller is entitled to see the PII it just submitted, but never to a
 * provider secret that leaked into an upstream error message.
 *
 * For anything crossing a telemetry or audit boundary use `scrubTelemetry` /
 * `scrubAuditMetadata` from `./scrub`, which layer the PII rules on top.
 */

import { isCredentialKey, REDACTED } from "./policy";

// `(?:[A-Za-z0-9]+[-_ ])*` mirrors, for the serialized-string form, the suffix
// matching that `isCredentialKey` already does on object keys: the quoted key
// has to *end* with a denied name, not equal one. Without it `x-api-key` — the
// spelling that actually arrives, and exactly what a stringified
// `request.headers` blob holds — slips past, because the closing `\1`
// backreference anchors the alternation to the whole quoted key. The separator
// is mandatory each repetition, so the group cannot split a run two ways and
// the pattern stays linear.
const SENSITIVE_JSON_FIELD_PATTERN =
  /(["'])((?:[A-Za-z0-9]+[-_ ])*(?:app[-_ ]?secret|api[-_ ]?secret|api[-_ ]?key|client[-_ ]?secret|wallet[-_ ]?secret|signing[-_ ]?secret|private[-_ ]?key|secret[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|authorization|password|pem|token|secret|credential))\1\s*:\s*(["'])(.*?)\3/gi;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(app[-_ ]?secret|api[-_ ]?secret|api[-_ ]?key|client[-_ ]?secret|wallet[-_ ]?secret|signing[-_ ]?secret|private[-_ ]?key|secret[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|authorization|password|pem|token|secret|credential)\b(\s*[:=]\s*)[^,\s}]+/gi;
// Quantified parts all exclude "-" so the pattern cannot backtrack across the
// PEM delimiters (keeps the regex linear; PEM bodies are base64 + whitespace).
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s]*-----END [A-Z ]*PRIVATE KEY-----/g;
const AUTH_HEADER_PATTERN = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]+)/gi;

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
    result[key] = isCredentialKey(key) ? REDACTED : redactValue(item, seen);
  }
  return result;
}
