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
  commitmentComparator,
  createDefaultRpcTransport,
  type createSolanaRpc,
  createSolanaRpcFromTransport,
  fetchEncodedAccount,
  getBase64Decoder,
  getTransactionDecoder,
  type RpcTransport,
  type Signature,
  type Slot,
  type TransactionError,
  type TransactionMessageBytesBase64,
} from "@solana/kit";
import {
  explicitClusterRpcUrl,
  getSolanaConfig,
  resolveDefaultCluster,
  resolveSolanaRpcProviderUrls,
} from "./config";
import { RpcTimeoutError, solanaRpcError } from "./errors";
import { withReadSocketRetry } from "./socket-retry";
import { isTransientRpcError, withTransientRpcRetry } from "./transient";
import type { RpcEnv } from "./types";

export { withReadSocketRetry };

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

/** Request headers kit's HTTP transport accepts; it rejects forbidden ones at runtime too. */
export type RpcRequestHeaders = NonNullable<
  Parameters<typeof createDefaultRpcTransport>[0]["headers"]
>;

export interface RpcClientOptions {
  rpcUrl?: string;
  headers?: RpcRequestHeaders;
  /**
   * Per-request transport deadline. A stalled HTTP request (socket open, no
   * response) rejects after this long instead of hanging the caller forever.
   * Callers that pass their own `abortSignal` to `.send()` keep full control.
   */
  requestTimeoutMs?: number;
  /** Optional caller-owned transport middleware, applied to every provider. */
  wrapTransport?: (transport: RpcTransport) => RpcTransport;
}

export const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 30_000;

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
export function withRequestTimeout(transport: RpcTransport, timeoutMs: number): RpcTransport {
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
        throw new RpcTimeoutError(timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

const lastGoodTransportIndex = new Map<string, number>();

/**
 * Wrap an ordered set of provider transports in per-request failover: a
 * transient failure (429/5xx/transport error) advances to the next provider,
 * and the last index that answered is remembered per `stickyKey` so later
 * requests start on the healthy provider instead of rediscovering the outage.
 *
 * `sendTransaction` never fails over: a transient-looking failure can arrive
 * after the transaction reached the leader, and resubmitting through another
 * provider risks a double-send. It runs once, against the sticky provider.
 */
export function createFailoverTransport(
  transports: readonly RpcTransport[],
  options: { stickyKey?: string } = {}
): RpcTransport {
  if (transports.length === 1) {
    return transports[0];
  }
  const key = options.stickyKey;
  return async <TResponse>(request: Parameters<RpcTransport>[0]): Promise<TResponse> => {
    const payload = request.payload as { method?: unknown } | null | undefined;
    const method = payload && typeof payload.method === "string" ? payload.method : undefined;
    const start = (key ? lastGoodTransportIndex.get(key) : undefined) ?? 0;
    const attempts = method === "sendTransaction" ? 1 : transports.length;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const index = (start + attempt) % transports.length;
      try {
        const result = await transports[index]<TResponse>(request);
        if (key !== undefined && index !== start) {
          lastGoodTransportIndex.set(key, index);
        }
        return result;
      } catch (error) {
        lastError = error;
        if (attempt === attempts - 1 || !isTransientRpcError(error)) {
          throw error;
        }
      }
    }
    throw lastError;
  };
}

/**
 * Create a configured Solana RPC client from environment
 */
export function createRpc(env: RpcEnv, options?: RpcClientOptions): SolanaRpc {
  const timeoutMs = options?.requestTimeoutMs ?? DEFAULT_RPC_REQUEST_TIMEOUT_MS;

  // The socket retry sits below caller middleware, so a read-context scope
  // only ever observes the attempt that answered.
  const buildTransport = (url: string): RpcTransport => {
    if (options?.headers && Object.keys(options.headers).length > 0) {
      const transport = withReadSocketRetry(
        createDefaultRpcTransport({ headers: options.headers, url })
      );
      return options.wrapTransport?.(transport) ?? transport;
    }
    const transport = withReadSocketRetry(createDefaultRpcTransport({ url }));
    return options?.wrapTransport?.(transport) ?? transport;
  };

  // An explicit URL is already the complete endpoint selection. Do not force
  // callers with a per-request/per-cluster URL to also configure the legacy
  // process default merely to construct a client for that explicit endpoint.
  if (options?.rpcUrl) {
    return createRpcFromTransport(buildTransport(options.rpcUrl), {
      requestTimeoutMs: timeoutMs,
    });
  }

  const urls = resolveSolanaRpcProviderUrls(env);
  if (urls.length === 0) {
    // Preserves the single-URL error message callers have always seen.
    getSolanaConfig(env);
  }
  // The deadline sits on each provider attempt, not around the whole failover:
  // an outer deadline lets one stalled provider consume the entire budget and
  // hands every later attempt an already-aborted signal. A stall costs at most
  // timeoutMs per provider before the hop.
  const transports = urls.map((url) => withRequestTimeout(buildTransport(url), timeoutMs));
  return createSolanaRpcFromTransport(
    createFailoverTransport(transports, { stickyKey: urls.join("|") })
  );
}

/**
 * An RPC client for `cluster` on a process that may serve both clusters. An
 * explicit `SOLANA_<CLUSTER>_RPC_URL` wins for any cluster, the default
 * cluster included, so a pinned private endpoint is used for every read of
 * that cluster (Earn execution and sponsorship reconciliation must observe the
 * same chain). Without one, the process default cluster keeps the full
 * failover client `createRpc` builds, and the other cluster throws, so a
 * caller never silently reads or prices against the wrong chain.
 *
 * @deprecated Use `createClusterRpc()` from `@sdp/rpc/factory`, which reads the cluster from the
 * open cluster scope; this one is deleted once its callers move (HOO-1879).
 */
export function createClusterRpc(
  env: RpcEnv,
  cluster: "devnet" | "mainnet-beta",
  options?: Omit<RpcClientOptions, "rpcUrl">
): SolanaRpc {
  const rpcUrl = explicitClusterRpcUrl(env, cluster);
  if (rpcUrl) return createRpc(env, { ...options, rpcUrl });
  if (cluster === resolveDefaultCluster(env)) return createRpc(env, options);
  throw new Error(
    `No RPC endpoint is configured for ${cluster}: set SOLANA_${cluster === "devnet" ? "DEVNET" : "MAINNET"}_RPC_URL`
  );
}

/** Build the standard SDP Solana client around a caller-owned egress transport. */
export function createRpcFromTransport(
  transport: RpcTransport,
  options: Pick<RpcClientOptions, "requestTimeoutMs" | "wrapTransport"> = {}
): SolanaRpc {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_RPC_REQUEST_TIMEOUT_MS;
  return createSolanaRpcFromTransport(
    withRequestTimeout(options.wrapTransport?.(transport) ?? transport, timeoutMs)
  );
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
 * The wire transaction's bytes as base64, verbatim.
 *
 * @param transactionBytes - The wire transaction.
 * @returns The base64 wire transaction.
 */
function wireTransactionBase64(transactionBytes: Uint8Array): Base64EncodedWireTransaction {
  // NOTE: kit 7.1.1's base64 decoder encodes the whole backing ArrayBuffer of an offset-zero view
  // (fixed upstream in kit#1957), so a transaction built inside a larger buffer would be sent with
  // its slack. `new Uint8Array(view)` copies it to an exact-size buffer (`.slice()` would not: on
  // a Node `Buffer` it returns a view). Drop the copy once the installed kit includes kit#1957.
  return getBase64Decoder().decode(
    new Uint8Array(transactionBytes)
  ) as Base64EncodedWireTransaction;
}

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
  const encodedTx = wireTransactionBase64(signedTransaction);

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
    const [status] = (await rpc.getSignatureStatuses([signature]).send()).value;
    return status
      ? { ...status, err: status.err === null ? null : numericTransactionError(status.err) }
      : status;
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
  const encodedTx = wireTransactionBase64(transaction);

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

/** The most addresses one `getMultipleAccounts` call accepts. */
export const GET_MULTIPLE_ACCOUNTS_LIMIT = 100;

/**
 * Lamports held by each address, in the order asked, from one `getMultipleAccounts`
 * call. An address with no account holds 0. Account data is sliced to nothing, since
 * only the balance is read.
 *
 * @throws When asked for more than {@link GET_MULTIPLE_ACCOUNTS_LIMIT} addresses (the
 *   caller chunks, so it decides what one failed chunk costs), or when the RPC answers
 *   for a different number of addresses than it was asked about.
 */
export async function getMultipleAccountsLamports(
  rpc: SolanaRpc,
  addresses: readonly Address[],
  commitment: Commitment = "confirmed"
): Promise<bigint[]> {
  if (addresses.length > GET_MULTIPLE_ACCOUNTS_LIMIT) {
    throw new RangeError(
      `getMultipleAccounts accepts at most ${GET_MULTIPLE_ACCOUNTS_LIMIT} addresses, got ${addresses.length}`
    );
  }
  if (addresses.length === 0) {
    return [];
  }

  const response = await rpc
    .getMultipleAccounts(addresses, {
      encoding: "base64",
      commitment,
      dataSlice: { offset: 0, length: 0 },
    })
    .send();
  // A short answer would shift every balance onto the wrong address.
  if (response.value.length !== addresses.length) {
    throw new Error(
      `getMultipleAccounts returned ${response.value.length} accounts for ${addresses.length} addresses`
    );
  }
  return response.value.map((account) => (account === null ? 0n : account.lamports));
}

/**
 * Check if an account exists
 */
export async function accountExists(
  rpc: SolanaRpc,
  address: Address,
  commitment: Commitment = "confirmed"
): Promise<boolean> {
  const account = await fetchEncodedAccount(rpc, address, { commitment });
  return account.exists;
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
  /**
   * Commitment level the RPC currently reports for this signature
   * ("processed" | "confirmed" | "finalized"), or null when unknown. Callers
   * that must distinguish finality (e.g. to decide whether a transaction body
   * is immutable) should treat everything short of "finalized" — including an
   * absent field from older mocks/callers — as not finalized.
   */
  confirmationStatus?: Commitment | null;
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
    confirmationStatus: item.confirmationStatus ?? null,
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
 * A signature status's `err` with its instruction and account indices as numbers. Kit decodes
 * `getSignatureStatuses` without a numeric allowlist for `err`, so those indices arrive as bigints
 * although kit types them `number`, and `JSON.stringify` throws on them. The indices are small,
 * so the conversion is exact.
 *
 * @param err - The status's transaction error as kit decoded it.
 * @returns The same error with every bigint replaced by its number.
 */
function numericTransactionError(err: TransactionError): TransactionError {
  const decoded: unknown = JSON.parse(
    JSON.stringify(err, (_key, value: unknown) =>
      typeof value === "bigint" ? Number(value) : value
    )
  );
  // SAFETY: the round-trip only turns bigint indices into numbers, so the shape is still kit's TransactionError.
  return decoded as TransactionError;
}

/**
 * Batch-fetch status for multiple transaction signatures
 */
export async function getSignatureStatuses(
  rpc: SolanaRpc,
  signatures: Signature[],
  options: { searchTransactionHistory?: boolean; retryDelaysMs?: readonly number[] } = {}
): Promise<Array<SignatureStatusInfo | null>> {
  if (signatures.length === 0) {
    return [];
  }

  const response = await withTransientRpcRetry(
    () =>
      (options.searchTransactionHistory
        ? rpc.getSignatureStatuses(signatures, { searchTransactionHistory: true })
        : rpc.getSignatureStatuses(signatures)
      ).send(),
    options.retryDelaysMs
  );

  return response.value.map((item) =>
    item
      ? {
          slot: item.slot,
          confirmations: item.confirmations,
          confirmationStatus: item.confirmationStatus,
          err: item.err === null ? null : numericTransactionError(item.err),
        }
      : null
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Transaction Lookup
// ═══════════════════════════════════════════════════════════════════════════

export interface ParsedInstruction {
  programId: string;
  /** Ordered account addresses for non-parsed program instructions; empty when the RPC gave none. */
  accounts: string[];
  /** Base58-encoded instruction data for non-parsed program instructions. */
  data?: string | null;
  /** Present only for instructions the RPC could decode (e.g. spl-token-2022). */
  parsedType: string | null;
  /** Decoded instruction fields, when available. */
  info: Record<string, unknown> | null;
}

/** One token-account balance as the RPC reports it before or after a transaction. */
export interface ParsedTokenBalance {
  /** Index into the transaction's account keys. */
  accountIndex: number;
  mint: string;
  /** The token account's owner; absent from some RPC responses. */
  owner: string | null;
  /** Base units as a decimal integer string, exactly as reported. */
  amount: string;
  decimals: number;
}

export interface ParsedTransaction {
  slot: bigint;
  /** Whether metadata establishes success or failure; absent metadata is unknown. */
  executionResultKnown: boolean;
  err: unknown | null;
  fee?: bigint;
  preBalances?: readonly bigint[];
  postBalances?: readonly bigint[];
  /** SPL token balances touched by the transaction; empty when meta has none. */
  preTokenBalances?: ParsedTokenBalance[];
  postTokenBalances?: ParsedTokenBalance[];
  /** Top-level + inner instructions flattened, in no particular order. */
  instructions: ParsedInstruction[];
}

/**
 * One `jsonParsed` transaction read, typed by kit's `getTransaction` overload.
 *
 * @param rpc - The RPC client.
 * @param signature - The transaction signature.
 * @param commitment - The read commitment.
 * @returns The transaction, or `null` when the RPC doesn't know the signature.
 */
function fetchJsonParsedTransaction(
  rpc: SolanaRpc,
  signature: Signature,
  commitment: "confirmed" | "finalized"
) {
  return rpc
    .getTransaction(signature, {
      commitment,
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
    })
    .send();
}

type JsonParsedTransaction = NonNullable<Awaited<ReturnType<typeof fetchJsonParsedTransaction>>>;
type JsonParsedInstruction =
  JsonParsedTransaction["transaction"]["message"]["instructions"][number];
type JsonParsedTokenBalance = NonNullable<
  NonNullable<JsonParsedTransaction["meta"]>["preTokenBalances"]
>[number];

const toParsedInstruction = (ix: JsonParsedInstruction): ParsedInstruction =>
  "parsed" in ix
    ? {
        programId: ix.programId,
        accounts: [],
        data: null,
        parsedType: ix.parsed.type,
        info: ix.parsed.info ? Object.fromEntries(Object.entries(ix.parsed.info)) : null,
      }
    : {
        programId: ix.programId,
        accounts: [...ix.accounts],
        data: ix.data,
        parsedType: null,
        info: null,
      };

const toParsedTokenBalance = (balance: JsonParsedTokenBalance): ParsedTokenBalance => ({
  accountIndex: Number(balance.accountIndex),
  mint: balance.mint,
  owner: balance.owner ?? null,
  amount: String(balance.uiTokenAmount.amount),
  decimals: Number(balance.uiTokenAmount.decimals),
});

export interface TokenBalanceDelta {
  /** Σpost − Σpre in base units; negative when the owner paid out. */
  baseUnits: bigint;
  decimals: number;
}

/**
 * Net change of one owner's holdings of one mint across a landed transaction,
 * summed over every token account the RPC attributes to that owner and mint.
 * A token account the transaction creates has no pre entry and counts from
 * zero; one it closes has no post entry and counts to zero.
 *
 * Returns null when neither side names the pair at all: that is "not
 * observed", which callers must keep distinct from a zero delta.
 */
export function tokenBalanceDelta(
  transaction: Pick<ParsedTransaction, "preTokenBalances" | "postTokenBalances">,
  match: { mint: string; owner: string }
): TokenBalanceDelta | null {
  const matches = (balance: ParsedTokenBalance) =>
    balance.mint === match.mint && balance.owner === match.owner;
  const pre = (transaction.preTokenBalances ?? []).filter(matches);
  const post = (transaction.postTokenBalances ?? []).filter(matches);
  if (pre.length === 0 && post.length === 0) return null;

  const decimals = (post[0] ?? pre[0])?.decimals ?? 0;
  const sum = (balances: ParsedTokenBalance[]) =>
    balances.reduce((total, balance) => total + BigInt(balance.amount), 0n);
  return { baseUnits: sum(post) - sum(pre), decimals };
}

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
  const response = await withTransientRpcRetry(() =>
    fetchJsonParsedTransaction(rpc, signature, commitment)
  );

  if (!response) {
    return null;
  }

  const topLevel = response.transaction.message.instructions ?? [];
  const inner = (response.meta?.innerInstructions ?? []).flatMap(
    (group) => group.instructions ?? []
  );

  return {
    slot: response.slot,
    executionResultKnown: response.meta?.err !== undefined,
    err: response.meta?.err ?? null,
    fee: response.meta?.fee ?? 0n,
    preBalances: response.meta?.preBalances ?? [],
    postBalances: response.meta?.postBalances ?? [],
    preTokenBalances: (response.meta?.preTokenBalances ?? []).map(toParsedTokenBalance),
    postTokenBalances: (response.meta?.postTokenBalances ?? []).map(toParsedTokenBalance),
    instructions: [...topLevel, ...inner].map(toParsedInstruction),
  };
}

// Re-export types
export type { Blockhash, Commitment, Signature };
