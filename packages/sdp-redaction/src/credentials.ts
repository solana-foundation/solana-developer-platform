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
// Bare `seed` sits outside the suffix group: public PDA keys such as
// `pda_seed` are not credentials under the object-key policy.
const SENSITIVE_JSON_FIELD_START =
  /(?<!\\)(\\*["'])((?:[A-Za-z0-9]+[-_ ])*(?:app[-_ ]?secret|api[-_ ]?secret|api[-_ ]?key|client[-_ ]?secret|wallet[-_ ]?secret|signing[-_ ]?secret|private[-_ ]?key|secret[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|authorization|cookies?|passphrase|password|pem|credential|secret|token|set[-_ ]?cookie|wallet[-_ ]?passphrase|seed[-_ ]?phrase)|seed)\1\s*:\s*(\\*)(["'])/gi;
// A cookie header is a credential container, not one credential: every
// `name=value` pair after `Cookie:` is a session, and they are separated by
// spaces — exactly where the generic assignment pattern's value stops. Consume
// the whole header value: to the end of the line for a raw header, to the end
// of the containing string for one embedded in serialized data. The tempered
// value ends at an unescaped quote that opens structure — a `,`/`}`/`]` run
// followed either by a quoted key with a colon (`","status":502`) or by
// nothing but structure to the end. Cookie syntax has no quoted keys, so a raw
// header — quoted values like `session="abc", refresh="def"` included — still
// consumes its line, and an escaped quote inside the value (`\"`) never ends
// it. Without the boundary, redacting
// `{"message":"Cookie: session=abc","status":502}` erased `status` and the
// closing quotes along with the header. The token stays linear: the lookahead
// only runs its structure scan past a quote, never per character.
const COOKIE_ASSIGNMENT_PATTERN =
  /\b(cookies?)\b(\s*[:=]\s*)(?:(?!(?<!\\)["']\s*[,}\]][\s,}\]]*(?:["'][^"'\n\r]*["']\s*:|$))[^\n\r])*/gi;
// Do not start the exact-only seed alternative after an identifier separator.
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(app[-_ ]?secret|api[-_ ]?secret|api[-_ ]?key|client[-_ ]?secret|wallet[-_ ]?secret|signing[-_ ]?secret|private[-_ ]?key|secret[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|authorization|pem|credential|secret|token)\b(\s*[:=]\s*)[^,\s}]+/gi;
// The recovery-secret keys take values whose canonical form is
// whitespace-separated — a BIP-39 mnemonic is `word word word` and a passphrase is
// free text — so the generic rule above, whose value stops at the first
// space, left every word after the first readable in an interpolated message:
// `seed=word1 word2 word3` redacted to `seed=[REDACTED] word2 word3`. These
// keys' values continue across runs of horizontal whitespace instead — a
// double space or a tab between words is just formatting, and stopping there
// exposed the rest of the secret (`seed=legal  winner thank` kept `winner
// thank`) — up to a clear boundary: a comma or brace (the containing-structure
// delimiters the generic rule also stops at), a newline (the value never
// crosses lines), or a `name=` assignment following the value — the next
// pair's key must not be swallowed into this redaction, both so the structure
// after the value survives and so that pair's own value is still redacted by
// the generic rule. Punctuation stays INSIDE the value exactly as the generic
// rule keeps it: `password=alpha;bravo` is one value, and a `;`, `)`, `]` or
// quote that follows a word is that word's tail while the `=` that opens the
// next assignment is not. Every quantified part has one forced parse — the
// whitespace and word classes are disjoint, so their split cannot move, and
// the lookahead rejects every shorter prefix of a continuation run — so the
// scan stays linear.
const SENSITIVE_WORD_ASSIGNMENT_PATTERN =
  /\b(passphrase|password|wallet[-_ ]?passphrase|seed[-_ ]?phrase|(?:seed[-_ ]?)?mnemonic|(?<![A-Za-z0-9_-])seed)\b(\s*[:=]\s*)[^,\s}]+(?:[^\S\n\r]+[^,\s}=]+(?![\w=-]))*/gi;
// Quantified parts all exclude "-" so the pattern cannot backtrack across the
// PEM delimiters (keeps the regex linear; PEM bodies are base64 + whitespace).
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s]*-----END [A-Z ]*PRIVATE KEY-----/g;
const AUTH_HEADER_PATTERN = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]+)/gi;
// The path segment itself is the credential on /pay/:token, including /tx
// and unmatched suffixes. Keep route context without copying the bearer token.
const PAY_LINK_TOKEN_PATTERN = /\/pay\/[^/\s?#"'<>\\]+/g;

export function redactCredentialString(value: string): string {
  const withoutHeaders = value
    .replace(PRIVATE_KEY_PATTERN, REDACTED)
    .replace(PAY_LINK_TOKEN_PATTERN, `/pay/${REDACTED}`)
    .replace(AUTH_HEADER_PATTERN, (match, scheme: string, token: string) =>
      isLikelyAuthToken(scheme, token) ? `${scheme} ${REDACTED}` : match
    );
  return redactSensitiveJsonFields(withoutHeaders)
    .replace(
      COOKIE_ASSIGNMENT_PATTERN,
      (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`
    )
    .replace(
      SENSITIVE_WORD_ASSIGNMENT_PATTERN,
      (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`
    )
    .replace(
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
