import { FIELDS } from "./fields";
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
 * holds (e.g. an auto-mode Postgres password).
 */
export function autoSecretKeys(values?: Values): Set<string> {
  return new Set(
    FIELDS.filter(
      (f) => f.kind === "secret" || (values ? (f.secretWhen?.(values) ?? false) : false)
    ).map((f) => f.key)
  );
}
