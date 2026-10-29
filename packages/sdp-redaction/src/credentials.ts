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
//
// The pattern only finds a sensitive key and the quote that opens its value;
// `quotedValueEnd` finds where the value closes. A quote token may carry
// backslashes (a body serialized more than once), and the lookbehind starts a
// token only where its backslash run starts, so a long run is scanned once.
const SENSITIVE_JSON_FIELD_START =
  /(?<!\\)(\\*["'])((?:[A-Za-z0-9]+[-_ ])*(?:app[-_ ]?secret|api[-_ ]?secret|api[-_ ]?key|client[-_ ]?secret|wallet[-_ ]?secret|signing[-_ ]?secret|private[-_ ]?key|secret[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|authorization|password|pem|token|secret|credential))\1\s*:\s*(\\*)(["'])/gi;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(app[-_ ]?secret|api[-_ ]?secret|api[-_ ]?key|client[-_ ]?secret|wallet[-_ ]?secret|signing[-_ ]?secret|private[-_ ]?key|secret[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|authorization|password|pem|token|secret|credential)\b(\s*[:=]\s*)[^,\s}]+/gi;
// Quantified parts all exclude "-" so the pattern cannot backtrack across the
// PEM delimiters (keeps the regex linear; PEM bodies are base64 + whitespace).
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s]*-----END [A-Z ]*PRIVATE KEY-----/g;
const AUTH_HEADER_PATTERN = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]+)/gi;
// The path segment itself is the credential on /pay/:token, including /tx
// and unmatched suffixes. Keep route context without copying the bearer token.
const PAY_LINK_TOKEN_PATTERN = /\/pay\/[^/\s?#"'<>\\]+/g;
// A Clerk invitation ticket signs its holder in, so it is a credential wherever
// a URL carries it: plain, URL-encoded inside another parameter (once or more,
// `%3D`, `%253D`, ...), or as a serialized JSON field.
const CLERK_TICKET_PATTERN = /(__clerk_ticket(?:=|%(?:25)*3D))[^&\s"'#%<>]+/gi;
// Starts only where a backslash run starts (the lookbehind), so a long run is
// scanned once, as SENSITIVE_JSON_FIELD_START does.
const CLERK_TICKET_FIELD_PATTERN = /(?<!\\)(\\*["']__clerk_ticket\\*["']\s*:\s*\\*["'])[^"'\\]+/gi;

export function redactCredentialString(value: string): string {
  const withoutHeaders = value
    .replace(PRIVATE_KEY_PATTERN, REDACTED)
    .replace(PAY_LINK_TOKEN_PATTERN, `/pay/${REDACTED}`)
    .replace(CLERK_TICKET_PATTERN, `$1${REDACTED}`)
    .replace(CLERK_TICKET_FIELD_PATTERN, `$1${REDACTED}`)
    .replace(AUTH_HEADER_PATTERN, (match, scheme: string, token: string) =>
      isLikelyAuthToken(scheme, token) ? `${scheme} ${REDACTED}` : match
    );
  return redactSensitiveJsonFields(withoutHeaders).replace(
    SENSITIVE_ASSIGNMENT_PATTERN,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`
  );
}

/**
 * Replaces the value of every quoted sensitive field with REDACTED, in one
 * pass that resumes after each value it redacts.
 */
function redactSensitiveJsonFields(text: string): string {
  const start = new RegExp(SENSITIVE_JSON_FIELD_START);
  let redacted = "";
  let copiedUpTo = 0;
  for (let match = start.exec(text); match !== null; match = start.exec(text)) {
    const [field, keyQuote, key, valueBackslashes, valueQuote] = match;
    const valueStart = match.index + field.length;
    const value = quotedValueEnd(text, valueStart, valueBackslashes.length, valueQuote);
    redacted +=
      text.slice(copiedUpTo, match.index) +
      `${keyQuote}${key}${keyQuote}:${valueBackslashes}${valueQuote}${REDACTED}` +
      text.slice(value.contentEnd, value.end);
    copiedUpTo = value.end;
    start.lastIndex = value.end;
  }
  return redacted + text.slice(copiedUpTo);
}

/**
 * Where a quoted value that opened with `depth` backslashes before `quote`
 * ends. Serializing a body once more doubles every backslash and adds one, so
 * at this depth a quote whose backslash run is `depth` modulo `2 * (depth + 1)`
 * closes the value, a shorter run closes an outer string, and any other run is
 * an escaped quote inside the value. A value that never closes runs to the end.
 *
 * @returns Where the value's content ends and where its closing quote ends.
 */
function quotedValueEnd(
  text: string,
  from: number,
  depth: number,
  quote: string
): { contentEnd: number; end: number } {
  const period = 2 * (depth + 1);
  let run = 0;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      run += 1;
      continue;
    }
    if (char === quote && (run < depth || run % period === depth)) {
      return { contentEnd: index - Math.min(run, depth), end: index + 1 };
    }
    run = 0;
  }
  return { contentEnd: text.length, end: text.length };
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
