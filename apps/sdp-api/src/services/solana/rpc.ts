/**
 * Solana RPC Service
 *
 * Provides RPC client creation and transaction submission utilities
 * using the modern @solana/kit.
 */

import {
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  type Commitment,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  type Signature,
} from "@solana/kit";
import { isTransientRpcError } from "@/lib/rpc";
import { getSolanaConfig } from "@/lib/solana";
import type { Env } from "@/types/env";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface BlockhashWithExpiry {
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
}

export interface TransactionConfirmation {
  signature: Signature;
  slot: bigint;
  confirmationStatus: Commitment;
  err: unknown | null;
}

export interface SimulationResult {
  success: boolean;
  logs: string[];
  unitsConsumed: bigint | null;
  error: string | null;
}

type SolanaRpcConfig = NonNullable<Parameters<typeof createSolanaRpc>[1]>;
type AllowedSolanaRpcHeaders = NonNullable<SolanaRpcConfig["headers"]>;

export interface RpcClientOptions {
  rpcUrl?: string;
  headers?: Readonly<Record<string, string>>;
}

const DISALLOWED_RPC_HEADERS = new Set([
  "accept",
  "accept-charset",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "permissions-policy",
  "referer",
  "solana-client",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

const TRANSIENT_RPC_RETRY_DELAYS_MS = [250, 750, 1500];

async function withTransientRpcRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= TRANSIENT_RPC_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === TRANSIENT_RPC_RETRY_DELAYS_MS.length || !isTransientRpcError(error)) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RPC_RETRY_DELAYS_MS[attempt]));
    }
  }

  throw lastError;
}

function assertAllowedRpcHeaders(
  headers: Readonly<Record<string, string>>
): asserts headers is AllowedSolanaRpcHeaders {
  for (const headerName of Object.keys(headers)) {
    const normalizedHeaderName = headerName.toLowerCase();
    if (
      normalizedHeaderName.startsWith("proxy-") ||
      normalizedHeaderName.startsWith("sec-") ||
      DISALLOWED_RPC_HEADERS.has(normalizedHeaderName)
    ) {
      throw new Error(`Unsupported RPC header: ${headerName}`);
    }
  }
}

// Type for RPC client
export type SolanaRpc = ReturnType<typeof createSolanaRpc>;

// ═══════════════════════════════════════════════════════════════════════════
// RPC Client Factory
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a configured Solana RPC client from environment
 */
export function createRpc(env: Env, options?: RpcClientOptions): SolanaRpc {
  const config = getSolanaConfig(env);
  const rpcUrl = options?.rpcUrl ?? config.rpcUrl;

  if (options?.headers && Object.keys(options.headers).length > 0) {
    assertAllowedRpcHeaders(options.headers);
    return createSolanaRpc(rpcUrl, { headers: options.headers });
  }

  return createSolanaRpc(rpcUrl);
}

export type SolanaRpcSdkBridge<TSdkRpc> = SolanaRpc & TSdkRpc;

export function createRpcForSdk<TSdkRpc>(
  env: Env,
  options?: RpcClientOptions
): SolanaRpcSdkBridge<TSdkRpc> {
  // Mosaic SDK still publishes Solana Kit v5 RPC types. The runtime client shape is
  // compatible, so keep the cross-version cast at the boundary where SDK code is called.
  return createRpc(env, options) as unknown as SolanaRpcSdkBridge<TSdkRpc>;
}

/**
 * Create RPC subscriptions client for real-time updates
 */
export function createRpcSubscriptions(env: Env) {
  const config = getSolanaConfig(env);
  // Convert HTTP URL to WebSocket URL
  const wsUrl = config.rpcUrl.replace("https://", "wss://").replace("http://", "ws://");

  return createSolanaRpcSubscriptions(wsUrl);
}

// ═══════════════════════════════════════════════════════════════════════════
// Blockhash Operations
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get a recent blockhash for transaction construction
 */
export async function getRecentBlockhash(
  rpc: SolanaRpc,
  commitment: Commitment = "confirmed"
): Promise<BlockhashWithExpiry> {
  const response = await rpc.getLatestBlockhash({ commitment }).send();

  return {
    blockhash: response.value.blockhash,
    lastValidBlockHeight: response.value.lastValidBlockHeight,
  };
}

/**
 * Check if a blockhash is still valid
 */
export async function isBlockhashValid(
  rpc: SolanaRpc,
  blockhash: Blockhash,
  commitment: Commitment = "confirmed"
): Promise<boolean> {
  const response = await rpc.isBlockhashValid(blockhash, { commitment }).send();

  return response.value;
}

// ═══════════════════════════════════════════════════════════════════════════
// Transaction Submission
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Send a signed transaction and return the signature
 */
export async function sendTransaction(
  rpc: SolanaRpc,
  signedTransaction: Uint8Array,
  options?: {
    skipPreflight?: boolean;
    maxRetries?: bigint;
  }
): Promise<Signature> {
  const encodedTx = Buffer.from(signedTransaction).toString(
    "base64"
  ) as Base64EncodedWireTransaction;

  const signature = await rpc
    .sendTransaction(encodedTx, {
      skipPreflight: options?.skipPreflight ?? false,
      encoding: "base64",
      maxRetries: options?.maxRetries,
    })
    .send();

  return signature;
}

/**
 * Send a signed transaction and wait for confirmation
 */
export async function sendAndConfirmTransaction(
  rpc: SolanaRpc,
  signedTransaction: Uint8Array,
  options?: {
    commitment?: Commitment;
    skipPreflight?: boolean;
    maxRetries?: bigint;
    timeoutMs?: number;
  }
): Promise<TransactionConfirmation> {
  const commitment = options?.commitment ?? "confirmed";
  const timeoutMs = options?.timeoutMs ?? 60000;

  // Send the transaction
  const signature = await sendTransaction(rpc, signedTransaction, {
    skipPreflight: options?.skipPreflight,
    maxRetries: options?.maxRetries,
  });

  // Poll for confirmation
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const status = await rpc.getSignatureStatuses([signature]).send();

    const result = status.value[0];

    if (result) {
      // Check if confirmed to required level
      const isConfirmed =
        result.confirmationStatus === commitment ||
        (commitment === "confirmed" && result.confirmationStatus === "finalized") ||
        result.confirmationStatus === "finalized";

      if (isConfirmed) {
        return {
          signature,
          slot: result.slot,
          confirmationStatus: result.confirmationStatus ?? commitment,
          err: result.err,
        };
      }

      // Check for error
      if (result.err) {
        return {
          signature,
          slot: result.slot,
          confirmationStatus: result.confirmationStatus ?? "processed",
          err: result.err,
        };
      }
    }

    // Wait before polling again
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Transaction ${signature} confirmation timed out after ${timeoutMs}ms`);
}

/**
 * Confirm an already-sent transaction
 */
export async function confirmTransaction(
  rpc: SolanaRpc,
  signature: Signature,
  options?: {
    commitment?: Commitment;
    timeoutMs?: number;
  }
): Promise<TransactionConfirmation> {
  const commitment = options?.commitment ?? "confirmed";
  const timeoutMs = options?.timeoutMs ?? 60000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const status = await rpc.getSignatureStatuses([signature]).send();

    const result = status.value[0];

    if (result) {
      const isConfirmed =
        result.confirmationStatus === commitment ||
        (commitment === "confirmed" && result.confirmationStatus === "finalized") ||
        result.confirmationStatus === "finalized";

      if (isConfirmed || result.err) {
        return {
          signature,
          slot: result.slot,
          confirmationStatus: result.confirmationStatus ?? commitment,
          err: result.err,
        };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Transaction ${signature} confirmation timed out`);
}

/**
 * Request an airdrop and wait for confirmation.
 */
export async function requestAndConfirmAirdrop(
  env: Env,
  address: Address,
  lamports: bigint | number,
  options?: {
    commitment?: Commitment;
    timeoutMs?: number;
  }
): Promise<TransactionConfirmation> {
  const rpcUrl = getSolanaConfig(env).rpcUrl;
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "requestAirdrop",
      params: [address, Number(lamports)],
    }),
  });

  if (!response.ok) {
    throw new Error(`Airdrop request failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    result?: string;
    error?: {
      code?: number;
      message?: string;
      data?: unknown;
    };
  };

  if (payload.error) {
    throw new Error(payload.error.message ?? "Airdrop request failed");
  }

  if (!payload.result) {
    throw new Error("Airdrop request returned no signature");
  }

  const rpc = createRpc(env);
  const confirmation = await confirmTransaction(rpc, payload.result as Signature, {
    commitment: options?.commitment,
    timeoutMs: options?.timeoutMs,
  });

  if (confirmation.err) {
    const serializedError = JSON.stringify(confirmation.err, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
    throw new Error(`Airdrop transaction ${confirmation.signature} failed: ${serializedError}`);
  }

  return confirmation;
}

// ═══════════════════════════════════════════════════════════════════════════
// Transaction Simulation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Simulate a transaction without submitting
 */
export async function simulateTransaction(
  rpc: SolanaRpc,
  transaction: Uint8Array,
  options?: {
    commitment?: Commitment;
  }
): Promise<SimulationResult> {
  const encodedTx = Buffer.from(transaction).toString("base64") as Base64EncodedWireTransaction;

  const response = await rpc
    .simulateTransaction(encodedTx, {
      encoding: "base64" as const,
      commitment: options?.commitment ?? "confirmed",
      sigVerify: false as const,
    })
    .send();

  const result = response.value;

  const serializeError = (value: unknown) =>
    JSON.stringify(value, (_key, val) => (typeof val === "bigint" ? val.toString() : val));

  return {
    success: result.err === null,
    logs: result.logs ?? [],
    unitsConsumed: result.unitsConsumed ?? null,
    error: result.err ? serializeError(result.err) : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Account Operations
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get account info for an address
 */
export async function getAccountInfo(
  rpc: SolanaRpc,
  address: Address,
  commitment: Commitment = "confirmed"
) {
  const response = await rpc
    .getAccountInfo(address, {
      encoding: "base64",
      commitment,
    })
    .send();

  return response.value;
}

/**
 * Check if an account exists
 */
export async function accountExists(
  rpc: SolanaRpc,
  address: Address,
  commitment: Commitment = "confirmed"
): Promise<boolean> {
  const info = await getAccountInfo(rpc, address, commitment);
  return info !== null;
}

/**
 * Get minimum rent-exempt balance for an account of given size
 */
export async function getMinimumBalanceForRentExemption(
  rpc: SolanaRpc,
  dataSize: number
): Promise<bigint> {
  const response = await rpc.getMinimumBalanceForRentExemption(BigInt(dataSize)).send();

  return response;
}

// ═══════════════════════════════════════════════════════════════════════════
// Signature History
// ═══════════════════════════════════════════════════════════════════════════

export interface SignatureInfo {
  signature: Signature;
  slot: bigint;
  blockTime: bigint | null;
  err: unknown | null;
}

/**
 * Get transaction signatures for an address (newest first)
 */
export async function getSignaturesForAddress(
  rpc: SolanaRpc,
  address: Address,
  options?: {
    limit?: number;
    before?: Signature;
    until?: Signature;
    commitment?: "confirmed" | "finalized";
  }
): Promise<SignatureInfo[]> {
  const response = await withTransientRpcRetry(() =>
    rpc
      .getSignaturesForAddress(address, {
        limit: options?.limit ?? 100,
        ...(options?.before ? { before: options.before } : {}),
        ...(options?.until ? { until: options.until } : {}),
        commitment: options?.commitment ?? "confirmed",
      })
      .send()
  );

  return response.map((item) => ({
    signature: item.signature,
    slot: item.slot,
    blockTime: item.blockTime ?? null,
    err: item.err ?? null,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Signature Status
// ═══════════════════════════════════════════════════════════════════════════

export interface SignatureStatusInfo {
  slot: bigint;
  confirmations: bigint | null;
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
  err: unknown | null;
}

/**
 * Batch-fetch status for multiple transaction signatures
 */
export async function getSignatureStatuses(
  rpc: SolanaRpc,
  signatures: Signature[]
): Promise<Array<SignatureStatusInfo | null>> {
  if (signatures.length === 0) {
    return [];
  }

  const response = await rpc.getSignatureStatuses(signatures).send();

  return response.value.map((item) =>
    item
      ? {
          slot: item.slot,
          confirmations: item.confirmations ?? null,
          confirmationStatus:
            (item.confirmationStatus as SignatureStatusInfo["confirmationStatus"]) ?? null,
          err: item.err ?? null,
        }
      : null
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Transaction Lookup
// ═══════════════════════════════════════════════════════════════════════════

export interface ParsedInstruction {
  programId: string;
  /** Present only for instructions the RPC could decode (e.g. spl-token-2022). */
  parsedType: string | null;
  /** Decoded instruction fields, when available. */
  info: Record<string, unknown> | null;
}

export interface ParsedTransaction {
  slot: bigint;
  err: unknown | null;
  /** Top-level + inner instructions flattened, in no particular order. */
  instructions: ParsedInstruction[];
}

interface RawParsedInstruction {
  programId?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
}

interface RawGetTransactionResponse {
  slot: bigint;
  meta: {
    err: unknown | null;
    innerInstructions?: Array<{ instructions?: RawParsedInstruction[] }> | null;
  } | null;
  transaction: {
    message: { instructions?: RawParsedInstruction[] };
  };
}

const toParsedInstruction = (ix: RawParsedInstruction): ParsedInstruction => ({
  programId: ix.programId ?? "",
  parsedType: ix.parsed?.type ?? null,
  info: ix.parsed?.info ?? null,
});

/**
 * Fetch a confirmed transaction with its instructions decoded (`jsonParsed`).
 *
 * Returns `null` when the signature is unknown to the RPC. Top-level and inner
 * instructions are flattened into a single list so callers can inspect what the
 * transaction actually did (e.g. verifying it initialized a specific mint).
 */
export async function getTransaction(
  rpc: SolanaRpc,
  signature: Signature,
  commitment: "confirmed" | "finalized" = "confirmed"
): Promise<ParsedTransaction | null> {
  const response = (await withTransientRpcRetry(() =>
    rpc
      .getTransaction(signature, {
        commitment,
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
      })
      .send()
  )) as RawGetTransactionResponse | null;

  if (!response) {
    return null;
  }

  const topLevel = response.transaction.message.instructions ?? [];
  const inner = (response.meta?.innerInstructions ?? []).flatMap(
    (group) => group.instructions ?? []
  );

  return {
    slot: response.slot,
    err: response.meta?.err ?? null,
    instructions: [...topLevel, ...inner].map(toParsedInstruction),
  };
}

// Re-export types
export type { Blockhash, Commitment, Signature };
