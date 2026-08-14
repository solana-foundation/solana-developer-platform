/**
 * The log redaction registry: field paths pino censors before anything reaches
 * a log sink.
 *
 * This is the belt, not the braces. The primary defence against secret material
 * in logs is the type layer — `SecretRef<T>` in `@sdp/helius-rings` overrides
 * `toJSON()`/`toString()` to `"[REDACTED]"`, so a wrapped secret is already safe
 * wherever it is serialized. This registry catches the case the type layer
 * cannot: a *plaintext* value that reached a log object without ever being
 * wrapped, because someone called `reveal()` upstream, read a column straight
 * out of the database, or destructured a gateway response.
 *
 * A known limit, verified against pino 10: the `*.` prefix matches exactly one
 * intermediate key, not arbitrary depth. `{ wallet: { viewingKey } }` is
 * censored; `{ a: { b: { viewingKey } } }` is not. fast-redact has no
 * recursive-descent wildcard, so the alternative would be a hand-rolled deep
 * walk on every log call — a cost paid on every log line in production to cover
 * a shape that only appears if secret material is being passed around
 * unwrapped, which is the thing `SecretRef` and
 * `scripts/check-secretref-serialization.mjs` exist to prevent. Keep log objects
 * shallow, and keep secrets wrapped.
 *
 * To register a field: add the key to `REDACTED_LEAF_FIELDS` if it can appear
 * anywhere under its own name, or the full path to `REDACTED_NESTED_PATHS` if it
 * is only meaningful inside a parent object. Both forms are expanded to cover
 * the top level and one nesting level.
 */

/** What a censored value is replaced with. */
export const REDACTION_CENSOR = "[REDACTED]";

/**
 * Keys that are sensitive wherever they appear, regardless of parent.
 *
 * `viewingKey` and `nullifierKey` are the Helius Rings key domain: a viewing key
 * deanonymizes every transfer a shielded wallet has ever received, and a
 * nullifier key can spend from it. `ringsMetadata` is the catch-all envelope the
 * gateway attaches to operations, whose contents are not ours to audit.
 */
export const REDACTED_LEAF_FIELDS: readonly string[] = [
  "viewingKey",
  "nullifierKey",
  "ringsMetadata",
];

/**
 * Paths that are only sensitive in context.
 *
 * `proof.ref` is the gateway's opaque handle to a proof and `proof.internal` its
 * witness data — neither is a secret about SDP, but both are a secret about the
 * customer's transfer graph. `keyRefs[*].material` is the encrypted key blob as
 * it travels in memory between the key authority and the signer.
 */
export const REDACTED_NESTED_PATHS: readonly string[] = [
  "proof.ref",
  "proof.internal",
  "keyRefs[*].material",
];

/**
 * Expands a registered field into the shapes pino can actually match: the path
 * at the root of the log object, and the same path one key deeper (the common
 * case, where the caller logs `{ operation: {...} }` or `{ wallet: {...} }`).
 */
function withOneLevelOfNesting(path: string): string[] {
  return [path, `*.${path}`];
}

/** Paths handed to pino's `redact` option. */
export const LOG_REDACTION_PATHS: readonly string[] = [
  ...REDACTED_LEAF_FIELDS.flatMap(withOneLevelOfNesting),
  ...REDACTED_NESTED_PATHS.flatMap(withOneLevelOfNesting),
];
