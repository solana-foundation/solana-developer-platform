import { FIELDS, isFieldVisible } from "./fields";
import type { Values } from "./types";

/** 32 random bytes as lowercase hex — equivalent to `openssl rand -hex 32`. */
export function randomHex32(): string {
  const bytes = new Uint8Array(32);
  // Bare Web Crypto global: resolves under Node, browser DOM, and Workers types alike.
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Keys to auto-generate as secrets. Always includes `kind: "secret"` fields;
 * when `values` are supplied, also includes fields whose `secretWhen(values)`
 * holds (e.g. an auto-mode Postgres password) and, conversely, drops any field
 * that is currently invisible — an invisible field is never emitted, so
 * generating a secret for it would only be discarded. The exception is an
 * `alwaysEmit` field, which is emitted even when hidden and so still needs its
 * secret generated.
 */
export function autoSecretKeys(values?: Values): Set<string> {
  return new Set(
    FIELDS.filter((f) => {
      if (values && !isFieldVisible(f, values) && !f.alwaysEmit) return false;
      return f.kind === "secret" || (values ? (f.secretWhen?.(values) ?? false) : false);
    }).map((f) => f.key)
  );
}
