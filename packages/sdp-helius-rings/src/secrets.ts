/**
 * Wraps a secret value so it never leaks through logs, JSON serialization, or
 * template literals. `reveal()` is the only path to the raw value; the scope
 * argument is a documentation-level contract for reviewers, not enforced at
 * runtime. A lint rule (A23) will forbid `JSON.stringify` on any value typed
 * `SecretRef<*>`; until then the `toJSON`/`toString` overrides are the safety
 * net.
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
