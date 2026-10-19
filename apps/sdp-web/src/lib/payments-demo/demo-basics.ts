import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import type { PaymentsDashboardWallet } from "@sdp/types/payments";

/*
 * The demo's leaf values, shared by the Payments and Issuance fixtures: time units, the demo
 * organization and project, stable seeded addresses and signatures, the demo wallet type and
 * the clock every fixture reads. It imports no other demo module, so neither fixture set
 * imports the other through it.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const ORGANIZATION_ID = "demo_org";
export const PROJECT_ID = "demo_prj";
export const CREATED_BY = "demo_user_ops";

// ─── Stable base58 addresses and signatures ──────────────────────────────────

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Replay seeds the cache with every id a visitor's session creates, so it is capped. */
const MAX_CACHED_SEEDS = 2_000;
const encodedSeeds = new Map<string, string>();

/** Deterministic bytes for a seed: an FNV-1a hash of the seed drives a mulberry32 stream. */
function seededBytes(seed: string, length: number): Uint8Array {
  let state = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    state = Math.imul(state ^ seed.charCodeAt(index), 0x01000193) >>> 0;
  }
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    bytes[index] = (mixed ^ (mixed >>> 14)) & 0xff;
  }
  // A leading zero byte would shorten the encoding; real keys rarely start with one.
  if (bytes[0] === 0) bytes[0] = 1;
  return bytes;
}

function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }
  let encoded = "";
  while (value > 0n) {
    encoded = `${BASE58_ALPHABET[Number(value % 58n)]}${encoded}`;
    value /= 58n;
  }
  return encoded;
}

function seededBase58(kind: "address" | "signature", seed: string): string {
  const key = `${kind}:${seed}`;
  const cached = encodedSeeds.get(key);
  if (cached !== undefined) return cached;
  const encoded = base58(seededBytes(key, kind === "address" ? 32 : 64));
  if (encodedSeeds.size >= MAX_CACHED_SEEDS) encodedSeeds.clear();
  encodedSeeds.set(key, encoded);
  return encoded;
}

export const demoAddress = (seed: string) => seededBase58("address", seed);
export const demoSignature = (seed: string) => seededBase58("signature", seed);

export type DemoWallet = PaymentsDashboardWallet & { balances: CustodyWalletTokenBalance[] };

/** Reads times relative to the world's `now`. */
export interface Clock {
  /** ISO time `ms` before now. */
  ago: (ms: number) => string;
  /** ISO time at a signed offset from now. */
  at: (offset: number) => string;
}
