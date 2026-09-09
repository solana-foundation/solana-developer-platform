import { GENESIS_HASH_BY_CLUSTER, type SolanaCluster } from "@sdp/types";
import type { EarnProviderId } from "@sdp/types/provider-access";
import { internalError, providerNotConfigured } from "./errors";
import { providerFetchJson } from "./fetch";

/**
 * Raw Solana JSON-RPC for CATALOGUE reads, shared by every provider whose shelf
 * lives on chain (Kamino's devnet vaults, Veda's).
 *
 * ── Why this package speaks JSON-RPC at all ─────────────────────────────────
 * `@sdp/earn` runs inside the hourly catalogue cron and its only dependency is
 * `@sdp/types`. A chain SDK here would be loaded on every pass in both
 * environments to read a handful of accounts, which is why the execution
 * packages (`@sdp/kamino`, `@sdp/veda`) exist as separate consumers. The cost of
 * that rule is this file: base58, base64 and one RPC helper, hand-rolled.
 *
 * Everything goes through `providerFetchJson`, so timeouts and the error
 * taxonomy are the package's rather than bespoke per provider.
 */

/** Default deadline for a catalogue RPC read, inherited from the Kamino path. */
export const CATALOGUE_RPC_TIMEOUT_MS = 20_000;

// biome-ignore lint/security/noSecrets: the bitcoin/Solana base58 alphabet
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Encode bytes as base58 — addresses read out of account data, and the
 * discriminator bytes a `memcmp` filter compares against.
 *
 * Hand-rolled because importing `@solana/*` for one function would give this
 * package its first non-`@sdp` dependency.
 */
export function toBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) + BigInt(byte);
  }

  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    value /= 58n;
    encoded = BASE58_ALPHABET[remainder] + encoded;
  }

  // Leading zero bytes are significant and carry no value in the integer above:
  // each encodes as '1'. Dropping them yields a shorter string that decodes to
  // a DIFFERENT address, which would silently mis-key a vault.
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }

  return encoded === "" ? "1" : encoded;
}

/** `atob` rather than `Buffer`, so this stays runtime-agnostic. */
export function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Little-endian u64 as raw bytes — the wire form of an Anchor `u64` filter. */
export function u64ToLeBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let remaining = value;
  for (let i = 0; i < 8; i += 1) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

/** Read a little-endian unsigned integer of `length` bytes at `offset`. */
export function readUintLe(data: Uint8Array, offset: number, length: number): bigint {
  let value = 0n;
  for (let i = length - 1; i >= 0; i -= 1) {
    value = (value << 8n) + BigInt(data[offset + i] as number);
  }
  return value;
}

/** Read a little-endian SIGNED integer of `length` bytes at `offset`. */
export function readIntLe(data: Uint8Array, offset: number, length: number): bigint {
  const unsigned = readUintLe(data, offset, length);
  const bound = 1n << BigInt(length * 8);
  return unsigned >= bound >> 1n ? unsigned - bound : unsigned;
}

/** True when every byte in `[offset, offset + length)` matches `expected`. */
export function bytesEqual(data: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (data.length < offset + expected.length) return false;
  return expected.every((byte, index) => data[offset + index] === byte);
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: { message?: string };
}

/** One `{ pubkey, account }` entry as `getProgramAccounts` returns it. */
export interface RpcProgramAccount {
  pubkey: string;
  account?: { data?: [string, string] } | null;
}

/** One entry of `getMultipleAccounts` — `null` when the account does not exist. */
export type RpcAccount = { data?: [string, string] } | null;

/**
 * One JSON-RPC call, with the failure mode that matters here handled.
 *
 * JSON-RPC reports failure INSIDE a 200 body, so the HTTP layer above cannot
 * see it. Left unchecked, an errored read looks like an empty shelf — and the
 * catalogue sync DELETES rows a provider no longer lists, so "empty" is the one
 * shape that quietly delists a provider's whole catalogue. Both branches below
 * throw for that reason.
 */
export async function solanaRpcCall<T>(
  provider: EarnProviderId,
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs = CATALOGUE_RPC_TIMEOUT_MS
): Promise<T> {
  const response = await providerFetchJson<JsonRpcResponse<T>, JsonRpcRequest>(provider, rpcUrl, {
    method: "POST",
    // `providerFetchJson` serializes the body and sets the JSON headers itself,
    // so the request object goes in as a value rather than pre-stringified.
    body: { jsonrpc: "2.0", id: 1, method, params },
    timeoutMs,
  });

  if (response.error) {
    throw internalError(
      `${provider} ${method} failed: ${response.error.message ?? "unknown RPC error"}`
    );
  }
  if (response.result === undefined) {
    throw internalError(`${provider} ${method} returned no result`);
  }
  return response.result;
}

/**
 * MEASURE the cluster before reading anything from it.
 *
 * `EarnRuntimeContext.environment` is a PER-PROJECT attribute while `ctx.env` is
 * the PROCESS environment, and `syncEarnCatalogue` walks both environments
 * inside one process with one env object. A production deployment therefore
 * reaches this code with `SOLANA_RPC_URL` pointing at MAINNET while syncing the
 * sandbox environment. Without this check a devnet program id would be queried
 * against mainnet, return zero accounts, and hand back a confident empty
 * shelf — which is also the shape that makes the sync skip its delist pass, so
 * sandbox would silently freeze on whatever it last held.
 *
 * It is also what makes a snapshot's `hostCluster` a MEASUREMENT rather than a
 * derivation. Migration 0057's whole point is that the environment must never be
 * assumed to imply the cluster; asserting the chain actually read is how a
 * provider honours that instead of quietly re-introducing the assumption. For a
 * provider whose devnet and mainnet deployments may share addresses — Veda's
 * might — it is the ONLY thing standing between the two.
 */
export async function assertRpcServesCluster(
  provider: EarnProviderId,
  rpcUrl: string,
  cluster: SolanaCluster,
  timeoutMs = CATALOGUE_RPC_TIMEOUT_MS
): Promise<void> {
  if (rpcUrl.trim() === "") {
    throw providerNotConfigured(`${provider} catalogue needs a Solana RPC URL for ${cluster}`);
  }

  const observed = await solanaRpcCall<string>(provider, rpcUrl, "getGenesisHash", [], timeoutMs);
  const expected = GENESIS_HASH_BY_CLUSTER[cluster];
  if (observed !== expected) {
    throw providerNotConfigured(
      `${provider} catalogue requires a ${cluster} RPC; the configured endpoint reports genesis ${observed}, not ${expected}`
    );
  }
}
