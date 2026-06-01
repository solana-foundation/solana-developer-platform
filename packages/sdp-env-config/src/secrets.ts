import { FIELDS } from "./fields";

/** 32 random bytes as lowercase hex — equivalent to `openssl rand -hex 32`. */
export function randomHex32(): string {
  const bytes = new Uint8Array(32);
  // Bare Web Crypto global: resolves under Node, browser DOM, and Workers types alike.
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Keys whose field kind is "secret". */
export function autoSecretKeys(): Set<string> {
  return new Set(FIELDS.filter((f) => f.kind === "secret").map((f) => f.key));
}
