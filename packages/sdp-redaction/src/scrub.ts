/**
 * Telemetry and audit scrubbing — the full denylist (credentials + PII) applied
 * to a value on its way into a sink we own.
 *
 * Two email modes exist because the two sinks answer to different readers:
 *
 * - `redact` (telemetry): a log line or Sentry event has no legitimate reader
 *   who needs the address, so it becomes `[REDACTED_EMAIL]`.
 * - `mask` (audit metadata): an invitation audit row whose subject is unnamed
 *   is not an audit trail. `j***@example.com` keeps the row reviewable — the
 *   full address stays in the invitations table, behind tenant scoping.
 */

import { parseJsonDocument, redactCredentialString } from "./credentials";
import { isSensitiveKey, REDACTED, REDACTED_EMAIL } from "./policy";

export type EmailMode = "redact" | "mask";

// The leading lookbehind is load-bearing, not cosmetic. Without it the local
// part `[A-Za-z0-9._%+-]+` can start at every offset inside one unbroken run of
// local-part characters, so a long run that never reaches an `@` is rescanned
// once per offset — quadratic. This walker sits on an attacker-reachable path (a
// webhook body is scrubbed before anything else reads it), where that is a DoS:
// 160KB of "%" took ~41s before this, ~1ms after. The lookbehind makes a match
// attempt at any offset other than the start of a run fail immediately.
const EMAIL_PATTERN =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/g;

// The identifying fields as they appear *inside* a string rather than as an
// object key: a query string, a URL, a serialized body echoed by a provider.
// `EMAIL_PATTERN` cannot see a percent-encoded address (`email=a%40b.com` has
// no literal `@`), and nothing at all can recognise a bare phone number or
// surname by shape — but both are self-labelling when written as an assignment.
const PII_FIELD_NAMES =
  // biome-ignore lint/security/noSecrets: an alternation of PII field names, not a credential.
  "e[-_ ]?mail(?:[-_ ]?address)?|phone(?:[-_ ]?number)?|first[-_ ]?name|last[-_ ]?name|full[-_ ]?name|date[-_ ]?of[-_ ]?birth|dob|tax[-_ ]?id|ssn|account[-_ ]?number|routing[-_ ]?number|iban|postal[-_ ]?code|zip[-_ ]?code|owner[-_ ]?address";
// The prefix group mirrors `isPiiKey`'s suffix matching for the serialized form,
// the same way the credential pattern does: `"counterparty-email"` has to be
// caught, not just `"email"`, since the backreference anchors the alternation to
// the entire quoted key.
const PII_JSON_FIELD_PATTERN = new RegExp(
  `(["'])((?:[A-Za-z0-9]+[-_ ])*(?:${PII_FIELD_NAMES}))\\1\\s*:\\s*(["'])(.*?)\\3`,
  "gi"
);
const PII_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${PII_FIELD_NAMES})\\b(\\s*[:=]\\s*)[^,\\s}&"']+`,
  "gi"
);

/**
 * `jane.doe@example.com` → `j***@example.com`.
 *
 * The domain survives on purpose: reviewing an invitation trail is mostly
 * asking "was this an employee or an outsider?", and that is a question about
 * the domain.
 */
export function maskEmail(value: string): string {
  return value.replace(EMAIL_PATTERN, (match) => {
    const separator = match.lastIndexOf("@");
    return `${match.slice(0, 1)}***${match.slice(separator)}`;
  });
}

/** The longest string parsed as a serialized JSON document, matching the credential pass. */
const MAX_SERIALIZED_JSON_LENGTH = 64 * 1024;
/** How many serialized documents deep a string is parsed (JSON in a string in JSON). */
const MAX_SERIALIZED_NESTING = 3;
const SERIALIZED_JSON_START = /^\s*[[{]/;

/**
 * A string that is a whole serialized JSON object or array, scrubbed by key
 * like any object (HOO-2570): a provider error that echoes a body as text
 * (`"{\"beneficiaryName\":\"Jane\"}"`) has PII the field patterns below
 * cannot all name, and the key policy can. Undefined when the string is not a
 * document or nothing in it changed, so its formatting survives.
 */
function scrubSerializedJson(
  value: string,
  emails: EmailMode,
  nesting: number
): string | undefined {
  if (
    nesting >= MAX_SERIALIZED_NESTING ||
    value.length > MAX_SERIALIZED_JSON_LENGTH ||
    !SERIALIZED_JSON_START.test(value)
  ) {
    return undefined;
  }
  const document = parseJsonDocument(value);
  if (document === undefined) {
    return undefined;
  }
  const scrubbed = scrubValue(document.parsed, emails, new WeakSet<object>(), 0, nesting + 1);
  if (unchangedBy(document.parsed, scrubbed)) {
    return undefined;
  }
  return document.restoreNumbers(JSON.stringify(scrubbed));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether scrubbing left a parsed document as it was. The walk is bounded by
 * the scrubbed side, which the walker truncates at {@link MAX_DEPTH}, so an
 * arbitrarily nested original never recurses past that.
 */
function unchangedBy(original: unknown, scrubbed: unknown): boolean {
  if (scrubbed === null || typeof scrubbed !== "object") {
    return Object.is(original, scrubbed);
  }
  if (Array.isArray(scrubbed)) {
    return (
      Array.isArray(original) &&
      original.length === scrubbed.length &&
      scrubbed.every((item, index) => unchangedBy(original[index], item))
    );
  }
  if (!isRecord(original) || !isRecord(scrubbed)) {
    return false;
  }
  const keys = Object.keys(scrubbed);
  return (
    keys.length === Object.keys(original).length &&
    keys.every((key) => Object.hasOwn(original, key) && unchangedBy(original[key], scrubbed[key]))
  );
}

function scrubString(value: string, emails: EmailMode, nesting = 0): string {
  const withoutCredentials = redactCredentialString(
    scrubSerializedJson(value, emails, nesting) ?? value
  );
  const withoutAddresses =
    emails === "mask"
      ? maskEmail(withoutCredentials)
      : withoutCredentials.replace(EMAIL_PATTERN, REDACTED_EMAIL);

  // Quoted form first, so the assignment pattern cannot cut a JSON value in
  // half at its opening quote.
  return withoutAddresses
    .replace(
      PII_JSON_FIELD_PATTERN,
      (_match, quote: string, key: string, valueQuote: string) =>
        `${quote}${key}${quote}:${valueQuote}${REDACTED}${valueQuote}`
    )
    .replace(
      PII_ASSIGNMENT_PATTERN,
      (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`
    );
}

function scrubSensitive(value: unknown, emails: EmailMode): unknown {
  if (emails === "mask" && typeof value === "string") {
    const masked = maskEmail(value);
    if (masked !== value) {
      return masked;
    }
  }
  return REDACTED;
}

/**
 * The walker's recursion bound. The cycle guard already handles self-reference,
 * but this path is now mandatory for attacker-controlled input — a provider
 * webhook body reaches it before anything else reads the payload — and a deeply
 * nested body would otherwise overflow the stack inside a log call. Well past
 * anything the platform's own payloads reach.
 */
const MAX_DEPTH = 16;
const TRUNCATED = "[Truncated]";

function scrubValue(
  value: unknown,
  emails: EmailMode,
  seen: WeakSet<object>,
  depth = 0,
  nesting = 0
): unknown {
  if (typeof value === "string") {
    return scrubString(value, emails, nesting);
  }

  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return TRUNCATED;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (value instanceof Error) {
    return scrubErrorValue(value, emails, seen, depth);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof URL) {
    return scrubString(value.toString(), emails);
  }

  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return REDACTED;
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, emails, seen, depth + 1, nesting));
  }

  // `Object.fromEntries` defines own properties, so a `__proto__` field
  // survives instead of hitting the inherited setter.
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveKey(key)
        ? scrubSensitive(item, emails)
        : scrubValue(item, emails, seen, depth + 1, nesting),
    ])
  );
}

/**
 * Unlike `redactCredentialSecrets`, an `Error` in becomes an `Error` out rather
 * than a plain object. Both pino's `error`/`err` serializers and Sentry's
 * exception grouping branch on `instanceof Error`; flattening it here would
 * silently change how every captured failure is shaped.
 */
function scrubErrorValue(error: Error, emails: EmailMode, seen: WeakSet<object>, depth = 0): Error {
  const sanitized = new Error(scrubString(error.message, emails));
  sanitized.name = error.name;
  sanitized.stack = error.stack ? scrubString(error.stack, emails) : undefined;

  // `context` is what @solana/kit attaches to SolanaError (simulation logs and
  // the like) — the detail that makes a chain failure diagnosable from CI.
  const source = error as Error & { context?: unknown; cause?: unknown };
  const target = sanitized as Error & { context?: unknown; cause?: unknown };
  if (source.context !== undefined) {
    target.context = scrubValue(source.context, emails, seen, depth + 1);
  }
  if (source.cause !== undefined) {
    target.cause = scrubValue(source.cause, emails, seen, depth + 1);
  }

  return sanitized;
}

/** Scrub anything bound for a log line, a Sentry payload, or a trace. */
export function scrubTelemetry<T>(value: T): T {
  return scrubValue(value, "redact", new WeakSet<object>()) as T;
}

/** String-only variant, for provider messages folded into an error. */
export function scrubTelemetryString(value: string): string {
  return scrubString(value, "redact");
}

/** Scrub an audit `metadata` blob, masking email addresses instead of dropping them. */
export function scrubAuditMetadata<T>(value: T): T {
  return scrubValue(value, "mask", new WeakSet<object>()) as T;
}

/** Scrub an error for capture, preserving `Error` identity, `context`, and `cause`. */
export function scrubError(error: Error): Error {
  return scrubErrorValue(error, "redact", new WeakSet<object>());
}
