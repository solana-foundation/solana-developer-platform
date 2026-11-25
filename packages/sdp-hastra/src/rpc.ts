import { createHash } from "node:crypto";
import { contextAwareRpcFetch } from "@sdp/rpc/read-context";
import { markRpcAttemptDeadline } from "@sdp/rpc/telemetry";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import { RPC_READ_TIMEOUT_MS } from "./constants";
import { SdpHastraError, type SdpHastraErrorCode } from "./errors";
import type { HastraRuntime } from "./types";

export interface RpcAccount {
  data: Buffer;
  executable: boolean;
  owner: string;
}

export interface RpcAccountWire {
  data?: [string, string] | string;
  executable?: boolean;
  owner?: string;
}

export async function rpcRequest<T>(
  runtime: HastraRuntime,
  method: string,
  params: unknown[],
  code: SdpHastraErrorCode,
  description: string
): Promise<T> {
  let response: Response;
  try {
    response = await contextAwareRpcFetch(runtime.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: markRpcAttemptDeadline(AbortSignal.timeout(RPC_READ_TIMEOUT_MS)),
    });
  } catch (cause) {
    throw new SdpHastraError(code, `The Solana RPC failed while ${description}.`, { cause });
  }
  if (!response.ok) {
    throw new SdpHastraError(
      code,
      `The Solana RPC answered HTTP ${response.status} while ${description}.`
    );
  }
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (body.error !== undefined || body.result === undefined) {
    throw new SdpHastraError(code, `The Solana RPC returned an error while ${description}.`);
  }
  return body.result;
}

export function decodeRpcAccount(value: RpcAccountWire | null, address: string): RpcAccount | null {
  if (value === null) return null;
  const encoded = Array.isArray(value.data) ? value.data[0] : value.data;
  if (
    typeof encoded !== "string" ||
    typeof value.owner !== "string" ||
    typeof value.executable !== "boolean"
  ) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      `The Solana RPC returned malformed account data for ${address}.`
    );
  }
  return { data: Buffer.from(encoded, "base64"), executable: value.executable, owner: value.owner };
}

export function decodeRpcAccounts(
  values: readonly (RpcAccountWire | null)[],
  addresses: readonly string[]
): (RpcAccount | null)[] {
  return addresses.map((address, index) => decodeRpcAccount(values[index] ?? null, address));
}

/** `getMultipleAccounts` left undecoded, so each account is decoded where it is checked. */
export async function getMultipleAccountWires(
  runtime: HastraRuntime,
  addresses: readonly string[],
  code: SdpHastraErrorCode
): Promise<(RpcAccountWire | null)[]> {
  const result = await rpcRequest<{ value?: (RpcAccountWire | null)[] }>(
    runtime,
    "getMultipleAccounts",
    [addresses, { encoding: "base64", commitment: "confirmed" }],
    code,
    "reading Hastra accounts"
  );
  if (!Array.isArray(result.value) || result.value.length !== addresses.length) {
    throw new SdpHastraError(code, "The Solana RPC returned an incomplete Hastra account set.");
  }
  return result.value;
}

export async function getMultipleAccounts(
  runtime: HastraRuntime,
  addresses: readonly string[],
  code: SdpHastraErrorCode = "PROGRAM_MISMATCH"
): Promise<(RpcAccount | null)[]> {
  return decodeRpcAccounts(await getMultipleAccountWires(runtime, addresses, code), addresses);
}

export async function getAccount(
  runtime: HastraRuntime,
  address: string,
  code: SdpHastraErrorCode = "PROGRAM_MISMATCH",
  commitment: "confirmed" | "finalized" = "confirmed"
): Promise<RpcAccount | null> {
  const result = await rpcRequest<{ value?: RpcAccountWire | null }>(
    runtime,
    "getAccountInfo",
    [address, { encoding: "base64", commitment }],
    code,
    `reading account ${address}`
  );
  if (!("value" in result)) {
    throw new SdpHastraError(code, `The Solana RPC omitted account ${address}.`);
  }
  return decodeRpcAccount(result.value ?? null, address);
}

export interface RpcSignatureHistoryEntry {
  signature?: string;
  slot?: number;
  err?: unknown;
}

export interface RpcBlockIdentity {
  blockHeight?: number | null;
}

export interface RpcTransactionLifecycle {
  meta?: { err?: unknown; logMessages?: string[] | null } | null;
}

export function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The vault token accounts the live configs named at the last validated state
 * read, per cluster. They ride in the identity request and stand in for a
 * vault read only where a live config still names the same address, so they
 * are never trusted and need no TTL.
 */
export const namedVaults = new Map<SolanaCluster, readonly string[]>();

/** Rent-exempt minimums are static per (cluster, endpoint, size). */
const RENT_MINIMUM_TTL_MS = 600_000;
const rentMinimums = new Map<string, { lamports: Promise<number>; expiresAt: number | null }>();

/** Test seam: forget remembered vault addresses and rent minimums. */
export function resetHastraReadCaches(): void {
  namedVaults.clear();
  rentMinimums.clear();
}

/** Shared while in flight, kept for the TTL on success, never kept on failure. */
export async function rentExemptMinimum(
  runtime: HastraRuntime,
  bytes: number,
  label: string
): Promise<number> {
  // A digest, so no key holds the RPC URL or its API key.
  const endpoint = createHash("sha256").update(runtime.rpcUrl).digest("hex").slice(0, 16);
  const key = `${runtime.cluster}\n${endpoint}\n${bytes}`;
  let entry = rentMinimums.get(key);
  if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
    rentMinimums.delete(key);
    entry = undefined;
  }
  if (!entry) {
    entry = { lamports: readRentExemptMinimum(runtime, bytes, label), expiresAt: null };
    rentMinimums.set(key, entry);
  }
  const current = entry;
  try {
    const lamports = await current.lamports;
    if (rentMinimums.get(key) === current && current.expiresAt === null) {
      current.expiresAt = Date.now() + RENT_MINIMUM_TTL_MS;
    }
    return lamports;
  } catch (cause) {
    if (rentMinimums.get(key) === current) rentMinimums.delete(key);
    throw cause;
  }
}

async function readRentExemptMinimum(
  runtime: HastraRuntime,
  bytes: number,
  label: string
): Promise<number> {
  const lamports = await rpcRequest<number>(
    runtime,
    // biome-ignore lint/security/noSecrets: public Solana JSON-RPC method name, not a credential.
    "getMinimumBalanceForRentExemption",
    [bytes, { commitment: "confirmed" }],
    "PROGRAM_MISMATCH",
    `reading ${label} rent`
  );
  if (!nonNegativeSafeInteger(lamports)) {
    throw new SdpHastraError(
      "PROGRAM_MISMATCH",
      `The Solana RPC returned an invalid ${label} rent.`
    );
  }
  return lamports;
}
