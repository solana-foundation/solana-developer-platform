/**
 * Wraps a secret value so it never leaks through logs, JSON serialization, or
 * template literals. The `toJSON`/`toString` overrides mean a wrapped secret is
 * safe wherever it is serialized or interpolated, at any depth.
 *
 * `reveal()` is the only path to the raw value, and the only real leak vector:
 * the result is an ordinary string or Uint8Array with no redaction behaviour.
 * The scope argument is a documentation-level contract for reviewers, not
 * enforced at runtime. `scripts/check-secretref-serialization.mjs` fails the
 * build if a `reveal()` result reaches `JSON.stringify`, a logger, `String()`,
 * or a template literal — test files excepted, which is what the "test" scope is
 * for. Plaintext key material that never got wrapped is caught separately by the
 * log redaction registry in `apps/sdp-api/src/runtime/log-redaction.ts`.
 */
export type RevealScope = "adapter" | "signer" | "test";

export class SecretRef<T> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  reveal(_scope: RevealScope): T {
    return this.#value;
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }
}
