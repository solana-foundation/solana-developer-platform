import { SdpRpcError } from "@sdp/rpc/errors";
import { createClusterJsonRpcFetch } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { SolanaCluster } from "@sdp/types";
import type { EarnProviderId } from "@sdp/types/provider-access";
import { internalError, providerNotConfigured } from "./errors";
import { providerFetchJsonVia } from "./fetch";

/**
 * Raw Solana JSON-RPC for CATALOGUE reads, shared by every provider whose shelf
 * lives on chain (Kamino's devnet vaults, Veda's).
 *
 * ── Why this package speaks JSON-RPC at all ─────────────────────────────────
 * `@sdp/earn` runs inside the hourly catalogue cron and keeps chain SDKs out:
 * a handful of accounts does not justify loading one on every pass, which is
 * why the execution packages (`@sdp/kamino`, `@sdp/veda`) exist as separate
 * consumers. The cost of that rule is this file: base58, base64 and one RPC
 * helper, hand-rolled. The bytes still travel through the door
 * (`createClusterJsonRpcFetch`), so the catalogue reads the cluster the open
 * scope names, from a genesis-proven managed endpoint.
 *
 * Everything goes through `providerFetchJsonVia`, so timeouts and the error
 * taxonomy are the package's rather than bespoke per provider.
 */

/** Default deadline for a catalogue RPC read, inherited from the Kamino path. */
export const CATALOGUE_RPC_TIMEOUT_MS = 20_000;

// Never dialed: the door's cluster JSON-RPC fetch ignores the URL it is handed.
const DOOR_ENDPOINT_PLACEHOLDER = "https://door.invalid";

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
 * One JSON-RPC call on the open cluster scope's cluster, through the door's managed pool (genesis
 * guard, failover, deadline), with the failure mode that matters here handled.
 *
 * JSON-RPC reports failure INSIDE a 200 body, so the HTTP layer above cannot
 * see it. Left unchecked, an errored read looks like an empty shelf — and the
 * catalogue sync DELETES rows a provider no longer lists, so "empty" is the one
 * shape that quietly delists a provider's whole catalogue. Both branches below
 * throw for that reason. A cluster with no endpoint configured is the steady
 * state "this deployment cannot read that cluster", reported as
 * `PROVIDER_NOT_CONFIGURED` so the sync skips quietly.
 *
 * @param provider - The provider the read is for, for errors.
 * @param method - The JSON-RPC method.
 * @param params - Its positional params.
 * @param timeoutMs - The read's end-to-end deadline.
 * @returns The response's `result`.
 * @throws SdpEarnError `PROVIDER_NOT_CONFIGURED` when the cluster has no endpoint configured;
 *   `PROVIDER_UNAVAILABLE` when the read fails; `INTERNAL_ERROR` on a JSON-RPC error or no result.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope; `RPC_CLUSTER_MISMATCH` when
 *   the pool serves another cluster.
 */
export async function solanaRpcCall<T>(
  provider: EarnProviderId,
  method: string,
  params: unknown[],
  timeoutMs = CATALOGUE_RPC_TIMEOUT_MS
): Promise<T> {
  let clusterFetch: typeof fetch;
  try {
    clusterFetch = createClusterJsonRpcFetch({ timeoutMs });
  } catch (error) {
    if (error instanceof SdpRpcError && error.code === "RPC_NOT_CONFIGURED") {
      throw providerNotConfigured(
        `${provider} catalogue needs a Solana RPC for ${currentClusterScope().cluster}`
      );
    }
    throw error;
  }
  const response = await providerFetchJsonVia<JsonRpcResponse<T>, JsonRpcRequest>(
    clusterFetch,
    provider,
    DOOR_ENDPOINT_PLACEHOLDER,
    {
      method: "POST",
      // `providerFetchJson` serializes the body and sets the JSON headers itself,
      // so the request object goes in as a value rather than pre-stringified.
      body: { jsonrpc: "2.0", id: 1, method, params },
      timeoutMs,
    }
  );

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
 * Refuse to read `cluster` unless it is the open cluster scope's cluster.
 *
 * `EarnRuntimeContext.environment` decides which deployment a provider reads, while the scope
 * decides which cluster the door reaches, and the door proves every endpoint's genesis before
 * serving it. Requiring the two to agree is what keeps a snapshot's `hostCluster` a
 * MEASUREMENT rather than a derivation: a devnet program id is never queried against mainnet,
 * where it would return zero accounts and a confident empty shelf. For a provider whose devnet
 * and mainnet deployments may share addresses (Veda's might), it is the ONLY thing standing
 * between the two.
 *
 * @param provider - The provider about to read, for the error.
 * @param cluster - The cluster the provider means to read.
 * @returns Nothing; it throws on a mismatch.
 * @throws SdpEarnError `INTERNAL_ERROR` when the scope serves another cluster.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export function assertRpcServesCluster(provider: EarnProviderId, cluster: SolanaCluster): void {
  const scopeCluster = currentClusterScope().cluster;
  if (scopeCluster !== cluster) {
    throw internalError(
      `${provider} catalogue read for ${cluster} ran inside a ${scopeCluster} cluster scope`
    );
  }
}
