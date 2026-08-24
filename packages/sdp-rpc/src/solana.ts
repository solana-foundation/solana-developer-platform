/**
 * Solana RPC Service
 *
 * Provides RPC client creation and transaction submission utilities
 * using the modern @solana/kit.
 */

import {
  type Address,
  airdropFactory,
  type Base64EncodedWireTransaction,
  type Blockhash,
  type Commitment,
  commitmentComparator,
  createDefaultRpcTransport,
  type createSolanaRpc,
  createSolanaRpcFromTransport,
  createSolanaRpcSubscriptions,
  getBase64Decoder,
  getTransactionDecoder,
  lamports as kitLamports,
  type RpcTransport,
  type Signature,
  type Slot,
  type TransactionError,
  type TransactionMessageBytesBase64,
} from "@solana/kit";
import { getSolanaConfig } from "./config";
import { solanaRpcError } from "./errors";
import { isTransientRpcError, withTransientRpcRetry } from "./transient";
import type { RpcEnv } from "./types";

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

declare const Buffer: {
  from(data: Uint8Array): { toString(encoding: "base64"): string };
};

export interface RpcClientOptions {
  rpcUrl?: string;
  headers?: Readonly<Record<string, string>>;
  /**
   * Per-request transport deadline. A stalled HTTP request (socket open, no
   * response) rejects after this long instead of hanging the caller forever.
   * Callers that pass their own `abortSignal` to `.send()` keep full control.
   */
  requestTimeoutMs?: number;
}

export const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 30_000;

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
 * Wrap a transport so every request carries a deadline. Without one, a stalled
 * HTTP request (socket open, server never responds) hangs the awaiting caller
 * indefinitely — deadlines like `confirmTransaction`'s `timeoutMs` are only
 * checked between polls, so a single hung fetch defeats them.
 */
function withRequestTimeout(transport: RpcTransport, timeoutMs: number): RpcTransport {
  return async <TResponse>(config: Parameters<RpcTransport>[0]) => {
    if (config.signal) {
      // The caller manages cancellation; don't override it.
      return await transport<TResponse>(config);
    }
    // AbortController + setTimeout (not AbortSignal.timeout) so the timer is
    // cleared on settle and behaves consistently in Node and test environments.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await transport<TResponse>({ ...config, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        // Deterministic, transient-classified message (see transient.ts).
        throw solanaRpcError(`RPC request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Create a configured Solana RPC client from environment
 */
export function createRpc(env: RpcEnv, options?: RpcClientOptions): SolanaRpc {
  // An explicit URL is already the complete endpoint selection. Do not force
  // callers with a per-request/per-cluster URL to also configure the legacy
  // process default merely to construct a client for that explicit endpoint.
  const rpcUrl = options?.rpcUrl ?? getSolanaConfig(env).rpcUrl;
  const timeoutMs = options?.requestTimeoutMs ?? DEFAULT_RPC_REQUEST_TIMEOUT_MS;

  let transport: RpcTransport;
  if (options?.headers && Object.keys(options.headers).length > 0) {
    assertAllowedRpcHeaders(options.headers);
    transport = createDefaultRpcTransport({ headers: options.headers, url: rpcUrl });
  } else {
    transport = createDefaultRpcTransport({ url: rpcUrl });
  }

  return createSolanaRpcFromTransport(withRequestTimeout(transport, timeoutMs));
}

export type SolanaRpcSdkBridge<TSdkRpc> = SolanaRpc & TSdkRpc;

export function createRpcForSdk<TSdkRpc>(
  env: RpcEnv,
  options?: RpcClientOptions
): SolanaRpcSdkBridge<TSdkRpc> {
  // Mosaic SDK still publishes Solana Kit v5 RPC types. The runtime client shape is
  // compatible, so keep the cross-version cast at the boundary where SDK code is called.
  return createRpc(env, options) as unknown as SolanaRpcSdkBridge<TSdkRpc>;
}

/**
 * Create RPC subscriptions client for real-time updates
 */
export function createRpcSubscriptions(env: RpcEnv) {
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

/** Estimate only the Solana network fee from the exact compiled message. */
export async function getTransactionNetworkFee(
  rpc: SolanaRpc,
  transaction: Uint8Array,
  commitment: Commitment = "confirmed"
): Promise<bigint> {
  const { messageBytes } = getTransactionDecoder().decode(transaction);
  const message = getBase64Decoder().decode(messageBytes) as TransactionMessageBytesBase64;
  const response = await rpc.getFeeForMessage(message, { commitment }).send();
  if (response.value === null) {
    throw solanaRpcError("Solana RPC could not price the transaction message");
  }
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
 * One signature-status poll that tolerates transient RPC failures: a stalled
 * or timed-out request returns `null` ("not yet confirmed") so the caller's
 * confirmation budget — not a single poll — decides the outcome.
 * Non-transient errors propagate immediately.
 */
async function getSignatureStatusOrNull(rpc: SolanaRpc, signature: Signature) {
  try {
    const status = await rpc.getSignatureStatuses([signature]).send();
    return status.value[0];
  } catch (error) {
    if (isTransientRpcError(error)) {
      return null;
    }
    throw error;
  }
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
    pollIntervalMs?: number;
  }
): Promise<TransactionConfirmation> {
  const signature = await sendTransaction(rpc, signedTransaction, {
    skipPreflight: options?.skipPreflight,
    maxRetries: options?.maxRetries,
  });

  return confirmTransaction(rpc, signature, options);
}

export type ConfirmTransactionOptions = {
  commitment?: Commitment;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

/**
 * Confirm an already-sent transaction
 */
export async function confirmTransaction(
  rpc: SolanaRpc,
  signature: Signature,
  options?: ConfirmTransactionOptions
): Promise<TransactionConfirmation> {
  const commitment = options?.commitment ?? "confirmed";
  const timeoutMs = options?.timeoutMs ?? 60000;
  const pollIntervalMs = options?.pollIntervalMs ?? 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const result = await getSignatureStatusOrNull(rpc, signature);

    if (result) {
      const isConfirmed =
        result.confirmationStatus !== null &&
        commitmentComparator(result.confirmationStatus, commitment) >= 0;

      if (isConfirmed || result.err) {
        return {
          signature,
          slot: result.slot,
          confirmationStatus: result.confirmationStatus ?? commitment,
          err: result.err,
        };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw solanaRpcError(`Transaction ${signature} confirmation timed out after ${timeoutMs}ms`);
}

/**
 * Request an airdrop and wait for confirmation.
 */
export async function requestAndConfirmAirdrop(
  env: RpcEnv,
  address: Address,
  lamports: bigint | number,
  options?: {
    commitment?: Commitment;
    timeoutMs?: number;
  }
): Promise<TransactionConfirmation> {
  const rpc = createRpc(env);
  const commitment = options?.commitment ?? "confirmed";
  const airdrop = airdropFactory({
    rpc,
    rpcSubscriptions: createRpcSubscriptions(env),
  } as unknown as Parameters<typeof airdropFactory>[0]);

  const signature = await airdrop({
    commitment,
    lamports: kitLamports(BigInt(lamports)),
    recipientAddress: address,
  });

  const confirmation = await confirmTransaction(rpc, signature, {
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
  slot: Slot;
  confirmations: bigint | null;
  confirmationStatus: Commitment | null;
  err: TransactionError | null;
}

/**
 * Batch-fetch status for multiple transaction signatures
 */
export async function getSignatureStatuses(
  rpc: SolanaRpc,
  signatures: Signature[],
  options: { searchTransactionHistory?: boolean } = {}
): Promise<Array<SignatureStatusInfo | null>> {
  if (signatures.length === 0) {
    return [];
  }

  const response = await (options.searchTransactionHistory
    ? rpc.getSignatureStatuses(signatures, { searchTransactionHistory: true })
    : rpc.getSignatureStatuses(signatures)
  ).send();

  return response.value.map((item) =>
    item
      ? {
          slot: item.slot,
          confirmations: item.confirmations,
          confirmationStatus: item.confirmationStatus,
          err: item.err,
        }
      : null
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Transaction Lookup
// ═══════════════════════════════════════════════════════════════════════════

export interface ParsedInstruction {
  programId: string;
  /** Ordered account addresses for non-parsed program instructions. */
  accounts?: string[];
  /** Base58-encoded instruction data for non-parsed program instructions. */
  data?: string | null;
  /** Present only for instructions the RPC could decode (e.g. spl-token-2022). */
  parsedType: string | null;
  /** Decoded instruction fields, when available. */
  info: Record<string, unknown> | null;
}

export interface ParsedTransaction {
  slot: bigint;
  err: unknown | null;
  fee?: bigint;
  preBalances?: readonly bigint[];
  postBalances?: readonly bigint[];
  /** Top-level + inner instructions flattened, in no particular order. */
  instructions: ParsedInstruction[];
}

interface RawParsedInstruction {
  programId?: string;
  accounts?: string[];
  data?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
}

interface RawGetTransactionResponse {
  slot: bigint;
  meta: {
    err: unknown | null;
    fee: bigint;
    preBalances: readonly bigint[];
    postBalances: readonly bigint[];
    innerInstructions?: Array<{ instructions?: RawParsedInstruction[] }> | null;
  } | null;
  transaction: {
    message: { instructions?: RawParsedInstruction[] };
  };
}

const toParsedInstruction = (ix: RawParsedInstruction): ParsedInstruction => ({
  programId: ix.programId ?? "",
  accounts: ix.accounts ?? [],
  data: ix.data ?? null,
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
    fee: response.meta?.fee ?? 0n,
    preBalances: response.meta?.preBalances ?? [],
    postBalances: response.meta?.postBalances ?? [],
    instructions: [...topLevel, ...inner].map(toParsedInstruction),
  };
}

// Re-export types
export type { Blockhash, Commitment, Signature };
