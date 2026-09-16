import { GENESIS_HASH_BY_CLUSTER, type SolanaCluster } from "@sdp/types";
import type { EarnProviderId } from "@sdp/types/provider-access";
import { getBase58Decoder } from "@solana/codecs-strings";
import { internalError, providerNotConfigured } from "./errors";
import { providerFetchJson } from "./fetch";
import type { EarnRuntimeEnvironment } from "./types";

/**
 * Raw Solana JSON-RPC for CATALOGUE reads, shared by every provider whose shelf
 * lives on chain (Kamino's devnet vaults, Veda's).
 *
 * Catalogue reads use Kit's small codec packages; provider execution SDKs stay
 * in their separate adapters so the hourly cron does not load unused clients.
 *
 * Everything goes through `providerFetchJson`, so timeouts and the error
 * taxonomy are the package's rather than bespoke per provider.
 */

/** Default deadline for a catalogue RPC read, inherited from the Kamino path. */
export const CATALOGUE_RPC_TIMEOUT_MS = 20_000;

/**
 * The RPC endpoint a catalogue read should use for `cluster`.
 *
 * `SOLANA_RPC_URL` is the PROCESS endpoint: it serves whichever cluster the
 * deployment is configured for. The catalogue sync walks BOTH environments in
 * that one process, so a provider whose instrument lives on the OTHER cluster
 * can only be read when that cluster has an endpoint of its own. Without one,
 * a mainnet-only provider (Ondo) is invisible to every non-production
 * deployment: its production fetch fails the genesis proof, the sync treats
 * that as a steady-state skip, and the browse-only mirror converges to empty.
 *
 * `SOLANA_MAINNET_RPC_URL` / `SOLANA_DEVNET_RPC_URL` are the same two override
 * keys the API's execution path reads (`resolveClusterRpcUrl`), so one Doppler
 * value serves catalogue and execution alike. Falling back to the process
 * endpoint keeps today's behaviour for every single-cluster deployment, and
 * `assertRpcServesCluster` still measures whatever URL comes back — an
 * override pointed at the wrong chain is refused exactly like the default.
 */
export function resolveCatalogueRpcUrl(
  env: EarnRuntimeEnvironment,
  cluster: SolanaCluster
): string {
  const override = cluster === "devnet" ? env.SOLANA_DEVNET_RPC_URL : env.SOLANA_MAINNET_RPC_URL;
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  return env.SOLANA_RPC_URL?.trim() ?? "";
}

const base58Decoder = getBase58Decoder();

/** Encode account addresses and memcmp discriminators, preserving leading zeros. */
export function toBase58(bytes: Uint8Array): string {
  return base58Decoder.decode(bytes) || "1";
}

/** Keep atob's rejection of malformed RPC data in every runtime. */
export function fromBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (byte) => byte.charCodeAt(0));
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
