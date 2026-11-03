/**
 * Credential-only redaction.
 *
 * This is the narrow pass that is safe to apply to client-facing error bodies:
 * a caller is entitled to see the PII it just submitted, but never to a
 * provider secret that leaked into an upstream error message.
 *
 * For anything crossing a telemetry or audit boundary use `scrubTelemetry` /
 * `scrubAuditMetadata` from `./scrub`, which layer the PII rules on top.
 *
 * A string is parsed before it is matched. Provider errors carry their bodies
 * as strings — serialized JSON, sometimes serialized again, sometimes
 * percent-encoded into a URL — and a pattern over the flat text only sees the
 * shapes someone thought to write down. So a string that is a JSON document
 * is parsed and redacted by key with the same `isCredentialKey` policy the
 * object walker uses, and a string that carries percent-escapes is decoded and
 * redacted again. Both steps are bounded (`MAX_NESTING`, `MAX_JSON_LENGTH`),
 * since this runs on every log line. Text that does not parse goes through the
 * scanners below, which also take their key decisions from `isCredentialKey`,
 * and which mask to the end of the text when a value never closes.
 */

import { isCredentialKey, isFreeTextCredentialKey, normalizeKey, REDACTED } from "./policy";

/**
 * How many times one string may be re-read: a JSON string inside a JSON
 * document, or a percent-decoded copy of the text, each take one level. Past
 * it, the scanners alone decide.
 */
const MAX_NESTING = 4;
/** Longer strings are not parsed as JSON; the scanners still run on them. */
const MAX_JSON_LENGTH = 64 * 1024;
/** Object depth inside one parsed document; deeper values are masked whole. */
const MAX_JSON_DEPTH = 16;

const JSON_DOCUMENT_START = /^\s*["[{]/;
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/;
const PERCENT_ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/g;
const ASCII_PERCENT_ESCAPE = /%([0-7][0-9A-Fa-f])/g;

// Finds a quoted key and the colon after it; `isCredentialKey` decides whether
// its value is masked and `fieldValueEnd` finds where that value ends. A quote
// token may carry backslashes (a body serialized more than once), and the
// lookbehind starts a token only where its backslash run starts, so a long run
// is scanned once. The key is bounded, so each quote is scanned at most that
// far.
const QUOTED_FIELD_START = /(?<!\\)(\\*["'])([\w .-]{1,128})\1\s*:\s*/g;
// A cookie header is a credential container, not one credential: every
// `name=value` pair after `Cookie:` is a session, and they are separated by
// spaces — exactly where the generic assignment value stops. Consume the whole
// header value: to the end of the line for a raw header, to the end of the
// containing string for one embedded in serialized data. The tempered value
// ends at an unescaped quote that opens structure — a `,`/`}`/`]` run followed
// either by a quoted key with a colon (`","status":502`) or by nothing but
// structure to the end. Cookie syntax has no quoted keys, so a raw header —
// quoted values like `session="abc", refresh="def"` included — still consumes
// its line, and an escaped quote inside the value (`\"`) never ends it. The
// token stays linear: the lookahead only runs its structure scan past a quote,
// never per character.
const COOKIE_ASSIGNMENT_PATTERN =
  /\b(cookies?)\b(\s*[:=]\s*)(?:(?!(?<!\\)["']\s*[,}\]][\s,}\]]*(?:["'][^"'\n\r]*["']\s*:|$))[^\n\r])*/gi;
// Finds a `name=value` or `name: value` assignment in free text. The name is
// one identifier (`x-api-key`, `walletMnemonic`) or two words (`api key`,
// `seed phrase`); `isCredentialKey` decides. Starts only at the start of an
// identifier run, so each run is tried once and the scan stays linear.
const ASSIGNMENT_START = /(?<![\w-])(?:[A-Za-z0-9]+[^\S\n\r]+[\w-]+|[\w][\w-]*)(\s*[:=]\s*)/g;
// The value of an ordinary credential assignment: one run, up to a comma,
// whitespace or a closing brace.
const ASSIGNMENT_VALUE = /[^,\s}]+/y;
// A recovery secret's canonical form is whitespace-separated — a BIP-39
// mnemonic is `word word word`, a passphrase is free text — so its value
// continues across horizontal whitespace, one word at a time, until a comma,
// brace, newline, a `name=` that opens the next pair, or a complete two-word
// credential name (`api key=`), which its own rule then redacts.
const HORIZONTAL_SPACE = /[^\S\n\r]+/y;
const FREE_TEXT_WORD = /[^,\s}=]+/y;
const NAME_WORD = /[A-Za-z0-9]+/y;
const NAME_SEPARATOR = /[^\S\n\r]*[:=]/y;
// Words that open a two-word credential name (`access token`, `wallet
// passphrase`). They decide only where a free-text value ends, never whether a
// key is a credential: that is `isCredentialKey`'s.
const CREDENTIAL_NAME_QUALIFIERS = new Set([
  "access",
  "api",
  "app",
  "client",
  "id",
  "private",
  "refresh",
  "secret",
  "seed",
  "set",
  "signing",
  "wallet",
]);
// URL userinfo (the `user:password` before `@` in a URL) is a credential whatever the
// scheme. The whole userinfo goes: the user half is an API key as often as a
// name. Starts only where a scheme run starts, so the scan stays linear.
const URL_USERINFO_PATTERN = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#"<>\\]+@/g;
// Quantified parts all exclude "-" so the pattern cannot backtrack across the
// PEM delimiters (keeps the regex linear; PEM bodies are base64 + whitespace).
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s]*-----END [A-Z ]*PRIVATE KEY-----/g;
const AUTH_HEADER_PATTERN = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]+)/gi;
// The path segment itself is the credential on /pay/:token, including /tx
// and unmatched suffixes. Keep route context without copying the bearer token.
const PAY_LINK_TOKEN_PATTERN = /\/pay\/[^/\s?#"'<>\\]+/g;
// A Clerk invitation ticket signs its holder in, so it is a credential wherever
// a URL carries it: plain, or URL-encoded inside another parameter (once or
// more, `%3D`, `%253D`, ...). Its value stops at `&`, so the query string
// after it stays readable. The JSON field form is the generic field scanner's.
const CLERK_TICKET_PATTERN = /(__clerk_ticket(?:=|%(?:25)*3D))[^&\s"'#%<>]+/gi;
// Where the cookie and Clerk ticket rules end the values they redact.
const EARLIER_RULE_VALUE_ENDS = new Map([
  ["cookie", /[\n\r"'\\]/],
  ["cookies", /[\n\r"'\\]/],
  ["clerkticket", /[&\s"'#%<>]/],
]);

export function redactCredentialString(value: string): string {
  return redactString(value, 0);
}

function redactString(value: string, nesting: number): string {
  if (nesting < MAX_NESTING) {
    const document = redactJsonDocument(value, nesting);
    if (document !== undefined) {
      return document;
    }
  }

  const redacted = redactText(value);
  if (nesting >= MAX_NESTING || !PERCENT_ESCAPE.test(redacted)) {
    return redacted;
  }

  // A credential percent-encoded into a parameter (`%22mnemonic%22%3A...`) has
  // no key the scanners can see. Decode what is already redacted and redact
  // again: when that finds nothing new the encoded form is kept as it was;
  // when it finds more, the decoded, redacted form is what is logged.
  const decoded = percentDecode(redacted);
  if (decoded === redacted) {
    return redacted;
  }
  const decodedRedacted = redactString(decoded, nesting + 1);
  return decodedRedacted === decoded ? redacted : decodedRedacted;
}

/**
 * Redacts a string that is a whole JSON document by key, or returns undefined
 * when it is not one. The original text comes back when nothing was redacted,
 * so formatting survives.
 */
function redactJsonDocument(value: string, nesting: number): string | undefined {
  if (value.length > MAX_JSON_LENGTH || !JSON_DOCUMENT_START.test(value)) {
    return undefined;
  }
  let parsed: JsonValue;
  try {
    // SAFETY: JSON.parse only ever produces JSON values.
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  const redacted = redactJsonValue(parsed, nesting, 0);
  return redacted === parsed ? value : JSON.stringify(redacted);
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Returns `value` itself when nothing inside it changed. A property name is
 * text too (`{"token=...":1}`), so it is redacted like any other string.
 */
function redactJsonValue(value: JsonValue, nesting: number, depth: number): JsonValue {
  if (typeof value === "string") {
    return redactString(value, nesting + 1);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_JSON_DEPTH) {
    return REDACTED;
  }

  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = redactJsonValue(item, nesting, depth + 1);
      changed ||= next !== item;
      return next;
    });
    return changed ? items : value;
  }

  let changed = false;
  const entries = Object.entries(value).map(([key, item]): [string, JsonValue] => {
    const nextKey = redactString(key, nesting + 1);
    const next = isCredentialKey(key) ? REDACTED : redactJsonValue(item, nesting, depth + 1);
    changed ||= nextKey !== key || next !== item;
    return [nextKey, next];
  });
  // `Object.fromEntries` defines own properties, so a `__proto__` field
  // survives instead of hitting the inherited setter.
  return changed ? Object.fromEntries(entries) : value;
}

/**
 * Decodes every run of percent-escapes once. A run that is not valid UTF-8
 * still has its ASCII escapes decoded, since every delimiter a credential
 * hides behind (`"`, `:`, `=`, `&`) is ASCII.
 */
function percentDecode(value: string): string {
  return value.replace(PERCENT_ESCAPE_RUN, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(ASCII_PERCENT_ESCAPE, (_escape, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16))
      );
    }
  });
}

function redactText(value: string): string {
  const withoutHeaders = value
    .replace(PRIVATE_KEY_PATTERN, REDACTED)
    .replace(PAY_LINK_TOKEN_PATTERN, `/pay/${REDACTED}`)
    .replace(CLERK_TICKET_PATTERN, `$1${REDACTED}`)
    .replace(URL_USERINFO_PATTERN, `$1${REDACTED}@`)
    .replace(AUTH_HEADER_PATTERN, (match, scheme: string, token: string) =>
      isLikelyAuthToken(scheme, token) ? `${scheme} ${REDACTED}` : match
    );
  const withoutFields = redactQuotedFields(withoutHeaders).replace(
    COOKIE_ASSIGNMENT_PATTERN,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`
  );
  return redactAssignments(withoutFields);
}

/**
 * Replaces the value of every quoted credential field with REDACTED, in one
 * pass that resumes after each value it redacts.
 */
function redactQuotedFields(text: string): string {
  const start = new RegExp(QUOTED_FIELD_START);
  let redacted = "";
  let copiedUpTo = 0;
  for (let match = start.exec(text); match !== null; match = start.exec(text)) {
    const [field, keyQuote, key] = match;
    if (!isCredentialKey(key)) {
      continue;
    }
    const valueStart = match.index + field.length;
    const value = fieldValueEnd(text, valueStart);
    redacted +=
      text.slice(copiedUpTo, match.index) +
      `${keyQuote}${key}${keyQuote}:${value.open}${REDACTED}` +
      text.slice(value.contentEnd, value.end);
    copiedUpTo = value.end;
    start.lastIndex = value.end;
  }
  return redacted + text.slice(copiedUpTo);
}

/**
 * Where the value of a field that starts at `from` ends: a quoted string, an
 * array or object, or a bare scalar (`"secretKey":[12,34]`, `"pin":1234`).
 *
 * @returns The opening token to keep, where the content ends, and where the
 * value's closing token ends.
 */
function fieldValueEnd(
  text: string,
  from: number
): { open: string; contentEnd: number; end: number } {
  let quoteAt = from;
  while (text[quoteAt] === "\\") {
    quoteAt += 1;
  }
  const quote = text[quoteAt];
  if (quote === '"' || quote === "'") {
    const depth = quoteAt - from;
    return {
      open: text.slice(from, quoteAt + 1),
      ...quotedValueEnd(text, quoteAt + 1, depth, quote),
    };
  }

  const first = text[from];
  if (first === "[" || first === "{") {
    // Bracket counting, not a parse: a value that never balances is masked to
    // the end of the text rather than cut where the secret might continue.
    // A quoted string inside it is skipped whole, so a bracket inside a
    // string (`{"value":"pa}ss"}`) does not end the value early.
    let open = 0;
    let run = 0;
    for (let index = from; index < text.length; index += 1) {
      const char = text[index];
      if (char === "\\") {
        run += 1;
        continue;
      }
      if (char === '"' || char === "'") {
        index = quotedValueEnd(text, index + 1, run, char).end - 1;
        run = 0;
        continue;
      }
      run = 0;
      if (char === "[" || char === "{") {
        open += 1;
      } else if ((char === "]" || char === "}") && --open === 0) {
        return { open: "", contentEnd: index + 1, end: index + 1 };
      }
    }
    return { open: "", contentEnd: text.length, end: text.length };
  }

  let end = from;
  while (end < text.length && !/[,\s}\]"'\\]/.test(text[end])) {
    end += 1;
  }
  return { open: "", contentEnd: end, end };
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

/**
 * Replaces the value of every credential assignment in free text with
 * REDACTED, in one pass. A two-word name that is not a credential is retried
 * by its last word, so `the seed=` is still caught.
 */
function redactAssignments(text: string): string {
  const start = new RegExp(ASSIGNMENT_START);
  let redacted = "";
  let copiedUpTo = 0;
  for (let match = start.exec(text); match !== null; match = start.exec(text)) {
    const [assignment, separator] = match;
    const name = assignment.slice(0, assignment.length - separator.length);
    const key = isCredentialKey(name) ? name : lastWord(name);
    if (key === undefined || !isCredentialKey(key)) {
      continue;
    }
    const valueStart = match.index + match[0].length;
    if (isRedactedByEarlierRule(key, text, valueStart)) {
      // The cookie and Clerk ticket rules end their values at their own
      // boundaries (a closing quote, a query delimiter); keep what follows.
      start.lastIndex = valueStart + REDACTED.length;
      continue;
    }
    const valueEnd = isFreeTextCredentialKey(key)
      ? freeTextValueEnd(text, valueStart)
      : stickyEnd(ASSIGNMENT_VALUE, text, valueStart);
    // Only a value that is exactly the marker is already redacted; a value
    // that merely starts with it (`password=[REDACTED]rest`) is still masked.
    if (valueEnd === valueStart || text.slice(valueStart, valueEnd) === REDACTED) {
      start.lastIndex = Math.max(valueEnd, start.lastIndex);
      continue;
    }
    redacted += text.slice(copiedUpTo, valueStart - separator.length) + separator + REDACTED;
    copiedUpTo = valueEnd;
    start.lastIndex = valueEnd;
  }
  return redacted + text.slice(copiedUpTo);
}

/**
 * Whether `valueStart` holds a value that `COOKIE_ASSIGNMENT_PATTERN` or
 * `CLERK_TICKET_PATTERN` already redacted: the marker followed by a character
 * that rule ends its value at, or the end of the text. Those rules consume
 * whatever value they find, so text that only starts with the marker never
 * survives them to reach this check.
 */
function isRedactedByEarlierRule(key: string, text: string, valueStart: number): boolean {
  const valueEnd = EARLIER_RULE_VALUE_ENDS.get(normalizeKey(key));
  const after = valueStart + REDACTED.length;
  return (
    valueEnd !== undefined &&
    text.startsWith(REDACTED, valueStart) &&
    (after === text.length || valueEnd.test(text[after]))
  );
}

/** The last of several space-separated words, or undefined for one word. */
function lastWord(name: string): string | undefined {
  const lastSpace = name.search(/[^\S\n\r][^\s]*$/);
  return lastSpace === -1 ? undefined : name.slice(lastSpace + 1);
}

function stickyEnd(pattern: RegExp, text: string, from: number): number {
  pattern.lastIndex = from;
  return pattern.test(text) ? pattern.lastIndex : from;
}

function freeTextValueEnd(text: string, from: number): number {
  let end = stickyEnd(ASSIGNMENT_VALUE, text, from);
  if (end === from) {
    return from;
  }
  for (;;) {
    const wordStart = stickyEnd(HORIZONTAL_SPACE, text, end);
    const wordEnd = stickyEnd(FREE_TEXT_WORD, text, wordStart);
    if (
      wordStart === end ||
      wordEnd === wordStart ||
      text[wordEnd] === "=" ||
      opensCredentialName(text, wordStart)
    ) {
      return end;
    }
    end = wordEnd;
  }
}

/**
 * Whether a complete two-word credential name (`api key=`, `wallet
 * passphrase=`) starts at `from`. When the second word is a credential on its
 * own (`token=`), the first word is part of the name only if it qualifies one
 * (`access token`); otherwise it is the last word of the value before it, and
 * `seed=... india token=` must not leave `india` readable.
 */
function opensCredentialName(text: string, from: number): boolean {
  const firstEnd = stickyEnd(NAME_WORD, text, from);
  const secondStart = stickyEnd(HORIZONTAL_SPACE, text, firstEnd);
  const secondEnd = stickyEnd(NAME_WORD, text, secondStart);
  if (
    firstEnd === from ||
    secondStart === firstEnd ||
    secondEnd === secondStart ||
    stickyEnd(NAME_SEPARATOR, text, secondEnd) === secondEnd
  ) {
    return false;
  }
  const first = text.slice(from, firstEnd);
  const second = text.slice(secondStart, secondEnd);
  if (!isCredentialKey(text.slice(from, secondEnd))) {
    return false;
  }
  return !isCredentialKey(second) || CREDENTIAL_NAME_QUALIFIERS.has(first.toLowerCase());
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
    return redactCredentialString(value.toString());
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
