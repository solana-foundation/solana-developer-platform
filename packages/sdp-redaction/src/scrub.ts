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

import { redactCredentialString } from "./credentials";
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

// The one shape-based PII rule. Bank instrument numbers are the single value
// class that reaches a sink both self-labelling ("account 000123456789") and
// bare — a provider folds them into error prose where no key, assignment, or
// serialization can vouch for them, so recognition has to be by shape. A run
// of 8+ digits is long enough to exclude the numbers prose legitimately
// carries (statuses, ports, postal codes, compact dates).
//
// The scan walks maximal identifier-shaped tokens — runs of letters, digits,
// `_`, and the base64 separators `+` and `/` — and redacts the digit runs of
// any token that carries no letter or `_`. A digit run inside a letter-bearing
// token is part of an identifier, not a bare value: base58 mints and wallets,
// base64 signatures, and UUID- or prefix-styled resource ids
// (`pcred_…-ff3129488570`, `aint_11549796-…`, `tx_…-98765432-…`) all carry
// long digit runs, and that digit evidence is exactly what audit metadata and
// replay recovery have to keep readable. A token of digits and separators
// alone is prose again, no matter which characters join the number — so
// `account 000123456789/01` is covered, not just whitespace-delimited values.
// Padding `=` is deliberately outside the token class: it never abuts a digit
// run inside valid base64, but it does label prose (`account=000123456789`),
// and no other rule catches that form.
//
// One letterless shape is an identifier all the same: a run of 32-44 base58
// digits (`[1-9]` — base58 has no zero) is the all-digit form of a Solana
// address. The system program id is 32 ones and prefixes every transaction
// log, so redacting it would mangle the most common line in telemetry, and no
// account number reaches 32 digits — a zero or a separator disqualifies the
// token, which is what keeps every account-number form above covered.
const BASE58_ADDRESS_PATTERN = /^[1-9]{32,44}$/;
//
// The scan is linear: the token pattern is a single character-class repeat
// that consumes each token in one match, and the digit-run pass inside it is
// likewise one match per run — nothing is rescanned per offset (the
// EMAIL_PATTERN DoS note above).
const IDENTIFIER_TOKEN_PATTERN = /[A-Za-z0-9_+/-]+/g;
const TOKEN_HAS_LETTER_PATTERN = /[A-Za-z_]/;
const PII_DIGIT_RUN_PATTERN = /\d{8,}/g;

/**
 * Applies the shape rule to prose. A value that is a single digit run end to
 * end is a numeric field serialized as a string — a slot, an amount, an epoch
 * — and the audit sink passes it through untouched: issuance outcomes persist
 * the Solana slot as a string and replay recovery re-parses it, and labelled
 * storage (`accountNumber: "…"`) is caught by key before this runs. The
 * telemetry sink redacts the same shape instead, because a provider error
 * message that is nothing but the instrument number arrives with no key and
 * no label, and no reader of a log line or trace needs the digits — the same
 * redact/mask asymmetry as the email rules above.
 */
function scrubDigitRuns(value: string, emails: EmailMode): string {
  if (emails === "mask" && /^\d+$/.test(value.trim())) {
    return value;
  }
  return value.replace(IDENTIFIER_TOKEN_PATTERN, (token) =>
    TOKEN_HAS_LETTER_PATTERN.test(token) || BASE58_ADDRESS_PATTERN.test(token)
      ? token
      : token.replace(PII_DIGIT_RUN_PATTERN, REDACTED)
  );
}

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

function scrubString(value: string, emails: EmailMode): string {
  const withoutCredentials = redactCredentialString(value);
  const withoutAddresses =
    emails === "mask"
      ? maskEmail(withoutCredentials)
      : withoutCredentials.replace(EMAIL_PATTERN, REDACTED_EMAIL);

  // Quoted form first, so the assignment pattern cannot cut a JSON value in
  // half at its opening quote.
  return scrubDigitRuns(
    withoutAddresses
      .replace(
        PII_JSON_FIELD_PATTERN,
        (_match, quote: string, key: string, valueQuote: string) =>
          `${quote}${key}${quote}:${valueQuote}${REDACTED}${valueQuote}`
      )
      .replace(
        PII_ASSIGNMENT_PATTERN,
        (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`
      ),
    emails
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

function scrubValue(value: unknown, emails: EmailMode, seen: WeakSet<object>, depth = 0): unknown {
  if (typeof value === "string") {
    return scrubString(value, emails);
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
    return value.map((item) => scrubValue(item, emails, seen, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveKey(key)
      ? scrubSensitive(item, emails)
      : scrubValue(item, emails, seen, depth + 1);
  }
  return result;
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
