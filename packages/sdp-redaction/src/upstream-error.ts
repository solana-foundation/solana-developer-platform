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

// Generic error fields carry no key name to denylist, so the value itself has
// to be vetted: a compromised provider can echo a credential it holds back in
// `code`, and the first thing a leaked `sk_live_…` key meets here is
// `code=<value>` in a signer error that is persisted, serialized, and scrubbed
// as if it were a machine code. Known token prefixes, compact JWTs, and opaque
// key material all collapse to `unavailable` with the prose and the oversized
// values. Compared case-insensitively.
const CREDENTIAL_VALUE_PREFIXES = [
  "akia", // AWS access key id
  "aiza", // Google API key
  "dop_v1_", // DigitalOcean personal access token
  "ghp_", // GitHub classic PAT
  "gho_", // GitHub OAuth token
  "ghr_", // GitHub refresh token
  "ghs_", // GitHub App server token
  "ghu_", // GitHub App user token
  "github_pat_", // GitHub fine-grained PAT
  "glpat-", // GitLab personal access token
  "npm_", // npm granular access token
  "pk-", // publishable key (Stripe-style)
  "pk_",
  "rk-", // restricted key (Stripe-style)
  "rk_",
  "shpat_", // Shopify personal access token
  "shppa_", // Shopify custom app credential
  "shpss_", // Shopify shared secret
  "sk-", // secret key (Stripe / OpenAI / Anthropic style)
  "sk_",
  "whsec_", // webhook signing secret (Stripe-style)
  "xox", // Slack token
  "ya29.", // Google OAuth access token
];

function isSecretShapedUpstreamValue(value: string): boolean {
  const lowered = value.toLowerCase();
  if (CREDENTIAL_VALUE_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
    return true;
  }

  // Compact JWT (header.payload.signature): the dots defeat the blob rule.
  if (lowered.startsWith("eyj") && lowered.includes(".")) {
    return true;
  }

  // An unbroken run of 32+ characters mixing letters and digits is key
  // material (hex, base64url, base58), never a provider error enum — those are
  // word-shaped: separated, or letters only.
  return value.length >= 32 && !/[_.:]/.test(value) && /[a-z]/i.test(value) && /[0-9]/.test(value);
}

// A credential the caller itself holds (a bearer token, a credential id) has no
// shape of its own: a short, separator-friendly value like a DFNS auth token
// carries no known prefix and looks exactly like a provider enum code. Shape
// filters cannot catch it, so callers that know their own secrets vet the
// candidate against them by exact value — a provider echoing back what we
// sent it must collapse to `unavailable`. Compared case-insensitively.
function isKnownUpstreamSecret(trimmed: string, knownSecrets?: readonly string[]): boolean {
  if (!knownSecrets || knownSecrets.length === 0) {
    return false;
  }

  const lowered = trimmed.toLowerCase();
  return knownSecrets.some(
    (secret) =>
      typeof secret === "string" && secret.length > 0 && secret.trim().toLowerCase() === lowered
  );
}

/**
 * Reduce an upstream error body to a single machine-readable code that is safe
 * to surface in error messages. Free-form prose (anything with whitespace),
 * oversized values, secret-shaped values, and unrecognized shapes all collapse
 * to `unavailable`.
 *
 * `httpStatus` is used to drop code fields that merely repeat the HTTP status,
 * so Google-style `{ error: { code: 400, status: "INVALID_ARGUMENT" } }` bodies
 * report the descriptive status instead of the redundant number.
 *
 * `knownSecrets` are credentials the caller holds (bearer tokens, credential
 * ids, key material): a candidate that equals one of them collapses to
 * `unavailable` even when it is identifier-shaped and short, because a
 * compromised provider can echo back exactly what it was sent.
 */
export function summarizeUpstreamErrorBody(
  rawBody: string,
  httpStatus?: number,
  knownSecrets?: readonly string[]
): string {
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
      const code = normalizeUpstreamErrorCode(record[key], httpStatus, knownSecrets);
      if (code) {
        return code;
      }
    }
  }

  return UNKNOWN_UPSTREAM_ERROR_CODE;
}

/**
 * Value-level sibling of `summarizeUpstreamErrorBody` for callers that already
 * hold one parsed upstream field (not a raw body). Returns the value only when
 * it is safe to embed in an error message — identifier-shaped, not
 * credential-shaped, and not a caller-held secret — and `null` for everything
 * else, so callers fail closed by omitting the fragment instead of echoing
 * provider-controlled prose.
 */
export function summarizeUpstreamErrorValue(
  value: unknown,
  httpStatus?: number,
  knownSecrets?: readonly string[]
): string | null {
  return normalizeUpstreamErrorCode(value, httpStatus, knownSecrets);
}

function readErrorEnvelope(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  return (parsed as Record<string, unknown>).error;
}

function normalizeUpstreamErrorCode(
  value: unknown,
  httpStatus?: number,
  knownSecrets?: readonly string[]
): string | null {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value === httpStatus) {
      return null;
    }
    const asString = String(value);
    return isSecretShapedUpstreamValue(asString) || isKnownUpstreamSecret(asString, knownSecrets)
      ? null
      : asString;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!UPSTREAM_ERROR_CODE_PATTERN.test(trimmed) || trimmed === String(httpStatus)) {
    return null;
  }

  return isSecretShapedUpstreamValue(trimmed) || isKnownUpstreamSecret(trimmed, knownSecrets)
    ? null
    : trimmed;
}
