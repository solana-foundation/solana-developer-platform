import { getSolanaConfig } from "@sdp/rpc";
import { withHeliusApiKey } from "@sdp/rpc/relay";
import * as solanaRpc from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import { SOL_MINT } from "@sdp/types";
import type { Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  amountToUiAmountForInterestBearingMintWithoutSimulation,
  amountToUiAmountForScaledUiAmountMintWithoutSimulation,
  fetchMaybeMint,
  type Mint,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { observedTransferKind } from "@/db/repositories/payments.kind";
import type {
  PaymentTransferDirection as TransferDirection,
  PaymentTransferRow as TransferRow,
  PaymentTransferStatus as TransferStatus,
} from "@/db/repositories/payments.repository";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import type { AppContext } from "../context";
import * as tokenAccounts from "../token-accounts";

export const SIGNATURE_HISTORY_LOOKUP_CONCURRENCY = 5;

/**
 * Cap on token-account addresses added to the signature search alongside the
 * owner address. A wallet's token-account count is unbounded external data;
 * without the cap it directly scales the getSignaturesForAddress fan-out.
 */
export const MAX_TOKEN_ACCOUNT_SIGNATURE_LOOKUPS = 24;

interface ParsedInstructionPayload {
  info?: Record<string, unknown>;
  type?: string;
}

interface ParsedInstructionRecord {
  parsed?: ParsedInstructionPayload;
  program?: string;
}

interface ParsedInstructionGroup {
  instructions?: ParsedInstructionRecord[];
}

interface ParsedAccountKey {
  pubkey?: string;
}

interface RpcTokenBalanceAmount {
  amount?: string;
  decimals?: number;
  uiAmountString?: string | null;
}

interface RpcTokenBalanceRecord {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: RpcTokenBalanceAmount;
}

interface ParsedTransactionResponse {
  error?: {
    message?: string;
  };
  result?: {
    blockTime?: number | null;
    meta?: {
      err?: unknown;
      fee?: number;
      innerInstructions?: ParsedInstructionGroup[];
      postBalances?: number[];
      postTokenBalances?: RpcTokenBalanceRecord[];
      preBalances?: number[];
      preTokenBalances?: RpcTokenBalanceRecord[];
    } | null;
    slot?: number;
    transaction?: {
      message?: {
        accountKeys?: Array<string | ParsedAccountKey>;
        instructions?: ParsedInstructionRecord[];
      };
    };
  } | null;
}

interface ObservedTransferContext {
  organizationId: string;
  projectId: string | null;
  walletIdsByAddress: Map<string, string>;
}

type SignatureHistoryEntry = Awaited<ReturnType<typeof solanaRpc.getSignaturesForAddress>>[number];

function resolveWalletIdForTokenAccount(
  context: ObservedTransferContext,
  tokenAccountAddress: string,
  ownerAddress: string | null
): string | null {
  if (ownerAddress) {
    const ownerWalletId = context.walletIdsByAddress.get(ownerAddress);
    if (ownerWalletId) return ownerWalletId;
  }

  return context.walletIdsByAddress.get(tokenAccountAddress) ?? null;
}

export function createSignatureHistoryRpc(env: Env) {
  // Prefer Helius when configured for richer signature history (getSignaturesForAddress).
  // Falls back to the default RPC URL if Helius is not configured.
  //
  // TODO: Replace getSignaturesForAddress with a dedicated indexer (Helius webhooks,
  // Triton stream, or similar) for production-scale history and comprehensive inbound
  // transfer tracking. The current approach is limited to the most recent ~200 signatures.
  const url = env.SOLANA_RPC_HELIUS_URL
    ? withHeliusApiKey(env.SOLANA_RPC_HELIUS_URL, env.SOLANA_RPC_HELIUS_API_KEY)
    : getSolanaConfig(env).rpcUrl;
  return solanaRpc.createRpc(env, { rpcUrl: url });
}

function resolveSignatureHistoryRpcUrl(env: Env): string {
  return env.SOLANA_RPC_HELIUS_URL
    ? withHeliusApiKey(env.SOLANA_RPC_HELIUS_URL, env.SOLANA_RPC_HELIUS_API_KEY)
    : getSolanaConfig(env).rpcUrl;
}

function resolveParsedAccountKey(accountKey: string | ParsedAccountKey | undefined): string | null {
  if (typeof accountKey === "string" && accountKey.trim()) {
    return accountKey;
  }

  if (
    accountKey &&
    typeof accountKey === "object" &&
    typeof accountKey.pubkey === "string" &&
    accountKey.pubkey.trim()
  ) {
    return accountKey.pubkey;
  }

  return null;
}

function flattenParsedInstructions(payload: ParsedTransactionResponse): ParsedInstructionRecord[] {
  const topLevel = payload.result?.transaction?.message?.instructions ?? [];
  const inner = (payload.result?.meta?.innerInstructions ?? []).flatMap(
    (group) => group.instructions ?? []
  );
  return [...topLevel, ...inner];
}

function resolveObservedTimestamp(blockTime: bigint | number | null | undefined): string {
  if (typeof blockTime === "bigint") {
    return new Date(Number(blockTime) * 1_000).toISOString();
  }

  if (typeof blockTime === "number" && Number.isFinite(blockTime) && blockTime > 0) {
    return new Date(blockTime * 1_000).toISOString();
  }

  return new Date().toISOString();
}

function resolveObservedSlot(
  freshSlot: bigint | null | undefined,
  cachedSlot: number | null | undefined
): number | null {
  if (typeof freshSlot === "bigint") {
    return Number(freshSlot);
  }

  return typeof cachedSlot === "number" && Number.isFinite(cachedSlot) ? cachedSlot : null;
}

function readInstructionInfoString(
  info: Record<string, unknown> | undefined,
  key: string
): string | null {
  const value = info?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function readInstructionInfoInteger(
  info: Record<string, unknown> | undefined,
  key: string
): bigint | null {
  const value = info?.[key];

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }

  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  ) {
    return BigInt(value);
  }

  return null;
}

/**
 * The raw UI amount string the RPC reported for a parsed token amount, or
 * null when the payload carries none (plain `transfer` instructions have no
 * token amount at all, and `uiAmountString` is nullable even where present).
 * Extension-aware conversion decides separately whether a decimals-only
 * fallback is safe.
 */
function readTokenAmountInfo(
  info: Record<string, unknown> | undefined
): { amount: bigint; decimals: number; uiAmountString: string | null } | null {
  const rawTokenAmount = info?.tokenAmount;
  if (!rawTokenAmount || typeof rawTokenAmount !== "object" || Array.isArray(rawTokenAmount)) {
    const rawAmount = readInstructionInfoInteger(info, "amount");
    const decimalsValue = info?.decimals;
    if (
      rawAmount === null ||
      typeof decimalsValue !== "number" ||
      !Number.isFinite(decimalsValue) ||
      !Number.isInteger(decimalsValue)
    ) {
      return null;
    }

    return { amount: rawAmount, decimals: decimalsValue, uiAmountString: null };
  }

  const tokenAmountRecord = rawTokenAmount as RpcTokenBalanceAmount;

  const amountValue =
    typeof tokenAmountRecord.amount === "string" && /^\d+$/.test(tokenAmountRecord.amount)
      ? BigInt(tokenAmountRecord.amount)
      : null;
  const decimalsValue =
    typeof tokenAmountRecord.decimals === "number" &&
    Number.isFinite(tokenAmountRecord.decimals) &&
    Number.isInteger(tokenAmountRecord.decimals)
      ? tokenAmountRecord.decimals
      : null;

  if (amountValue === null || decimalsValue === null) {
    return null;
  }

  return {
    amount: amountValue,
    decimals: decimalsValue,
    uiAmountString:
      typeof tokenAmountRecord.uiAmountString === "string" &&
      tokenAmountRecord.uiAmountString.trim()
        ? tokenAmountRecord.uiAmountString
        : null,
  };
}

/**
 * How a mint mutates the UI amount its holders see, resolved from the mint
 * account's Token-2022 extension state.
 *
 * - `scaled` / `interest-bearing`: the on-chain program converts raw units
 *   through the extension, so a decimals-only amount would misreport the
 *   transfer while the row still claims to be confirmed. Both carry enough
 *   state to reconstruct the conversion at the confirming block's clock; a
 *   scaled mint whose pending schedule postdates the transfer cannot be
 *   reconstructed and is dropped instead.
 * - `static`: no amount-mutating extension (including legacy SPL mints), so
 *   the RPC-reported amount or decimals-only formatting is the amount the
 *   holder sees.
 * - `unresolved`: the mint account could not be read or decoded. Extension
 *   state cannot be distinguished from none, so observations against this
 *   mint are dropped rather than confirmed with a possibly-wrong amount.
 */
type ObservedMintAmountState =
  | { kind: "static" }
  | {
      kind: "scaled";
      multiplier: number;
      newMultiplier: number;
      newMultiplierEffectiveTimestamp: bigint;
    }
  | {
      kind: "interest-bearing";
      initializationTimestamp: bigint;
      preUpdateAverageRate: number;
      lastUpdateTimestamp: bigint;
      currentRate: number;
    }
  | { kind: "unresolved" };

function resolveMintAmountState(mint: Mint): ObservedMintAmountState {
  if (mint.extensions.__option !== "Some") {
    return { kind: "static" };
  }

  for (const extension of mint.extensions.value) {
    // biome-ignore lint/security/noSecrets: Token-2022 extension name, not a secret.
    if (extension.__kind === "ScaledUiAmountConfig") {
      return {
        kind: "scaled",
        multiplier: extension.multiplier,
        newMultiplier: extension.newMultiplier,
        newMultiplierEffectiveTimestamp: extension.newMultiplierEffectiveTimestamp,
      };
    }

    if (extension.__kind === "InterestBearingConfig") {
      return {
        kind: "interest-bearing",
        initializationTimestamp: extension.initializationTimestamp,
        preUpdateAverageRate: extension.preUpdateAverageRate,
        lastUpdateTimestamp: extension.lastUpdateTimestamp,
        currentRate: extension.currentRate,
      };
    }
  }

  return { kind: "static" };
}

/**
 * Resolves one mint's extension state over RPC. A definitive outcome (a
 * readable mint, one that is gone, or one owned by a program the parsed
 * instruction cannot have come from) resolves; a transient RPC failure
 * rejects so the per-batch resolver can retry a later read instead of
 * pinning the omission for the whole call.
 */
async function fetchObservedMintAmountState(
  rpc: solanaRpc.SolanaRpc,
  mint: Address
): Promise<ObservedMintAmountState> {
  const maybeMint = await fetchMaybeMint(rpc, mint);
  if (!maybeMint.exists) {
    // A mint account that is gone (Token-2022 close-mint) leaves its
    // extension history unrecoverable.
    return { kind: "unresolved" };
  }

  if (maybeMint.programAddress === TOKEN_2022_PROGRAM_ADDRESS) {
    return resolveMintAmountState(maybeMint.data);
  }

  // Legacy SPL mints carry no extensions by construction; any other owner
  // is not a mint the parsed instruction could have moved.
  return maybeMint.programAddress === TOKEN_PROGRAM_ADDRESS
    ? { kind: "static" }
    : { kind: "unresolved" };
}

/**
 * Seconds of the block the transaction confirmed in — the historical clock the
 * on-chain conversion used. Null when the block time is unknown, in which case
 * an extension-aware conversion cannot be reconstructed.
 */
function resolveObservedTimestampSeconds(
  blockTime: bigint | number | null | undefined
): number | null {
  if (typeof blockTime === "bigint") {
    const seconds = Number(blockTime);
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
  }

  if (typeof blockTime === "number" && Number.isFinite(blockTime) && blockTime > 0) {
    return blockTime;
  }

  return null;
}

/**
 * Converts a parsed raw token amount into the UI amount the mint's holders
 * see, or null when no trustworthy amount can be produced (the caller drops
 * the observation instead of confirming a wrong one).
 *
 * Extension state decides the conversion: static mints keep the RPC-reported
 * amount (or decimals-only formatting); `ScaledUiAmountConfig` and
 * `InterestBearingConfig` mints are recomputed from the extension state and
 * the historical clock at confirmation, ignoring any decimals-only amount the
 * RPC reported for them. When the extension state is unresolved the
 * observation is dropped (fail closed): the parsed program label cannot prove
 * the mint is legacy, because a Token-2022 instruction can carry a classic
 * label, so the decimals-only fallback could misreport a scaled or
 * interest-bearing mint.
 */
function convertObservedTokenAmount(input: {
  rawAmount: bigint;
  decimals: number;
  rpcUiAmount: string | null;
  mint: string | null;
  mintStates: Map<string, ObservedMintAmountState>;
  timestampSeconds: number | null;
}): string | null {
  const { rawAmount, decimals, rpcUiAmount, mint, mintStates, timestampSeconds } = input;

  const state = mint ? mintStates.get(mint) : undefined;
  if (!state || state.kind === "unresolved") {
    // The mint account cannot be resolved, so an amount-mutating extension
    // cannot be ruled out — and the parsed program label cannot prove
    // otherwise, since a Token-2022 instruction can carry a classic
    // "spl-token" label. Drop the observation instead of confirming a
    // possibly-wrong decimals-only amount.
    return null;
  }

  if (state.kind === "static") {
    return rpcUiAmount ?? formatDecimalAmount(rawAmount, decimals);
  }

  if (timestampSeconds === null) {
    return null;
  }

  if (state.kind === "scaled") {
    // A schedule that had not matured when the transfer confirmed leaves the
    // historical multiplier unrecoverable: whether this pending schedule (or
    // an older one, since replaced) governed the confirming block cannot be
    // distinguished from the current mint account. Drop the row instead of
    // guessing.
    if (
      state.newMultiplierEffectiveTimestamp !== 0n &&
      BigInt(timestampSeconds) < state.newMultiplierEffectiveTimestamp
    ) {
      return null;
    }

    // At or after maturity the schedule predates the transfer, so the
    // scheduled multiplier governed the confirming block. With no schedule
    // pending, the on-chain processor guarantees multiplier and
    // newMultiplier are equal (initialization and immediate updates set
    // both atomically), so the current multiplier is the only conversion
    // the account exposes; a multiplier replaced between the transfer and
    // this read cannot be ruled out from the account alone, which is the
    // documented approximation of this best-effort synthesis.
    const effectiveMultiplier =
      state.newMultiplierEffectiveTimestamp !== 0n ? state.newMultiplier : state.multiplier;
    return amountToUiAmountForScaledUiAmountMintWithoutSimulation(
      rawAmount,
      decimals,
      effectiveMultiplier
    );
  }

  // Interest-bearing: a rate update recorded after the transaction replaced
  // the historical average rate, so the accrual at confirmation time cannot
  // be reconstructed from the current mint state.
  if (BigInt(timestampSeconds) < state.lastUpdateTimestamp) {
    return null;
  }

  return amountToUiAmountForInterestBearingMintWithoutSimulation(
    rawAmount,
    decimals,
    timestampSeconds,
    Number(state.lastUpdateTimestamp),
    Number(state.initializationTimestamp),
    state.preUpdateAverageRate,
    state.currentRate
  );
}

function compareSignatureHistoryDesc(
  left: SignatureHistoryEntry,
  right: SignatureHistoryEntry
): number {
  const leftBlockTime = left.blockTime ?? 0n;
  const rightBlockTime = right.blockTime ?? 0n;

  if (leftBlockTime !== rightBlockTime) {
    return leftBlockTime > rightBlockTime ? -1 : 1;
  }

  if (left.slot !== right.slot) {
    return left.slot > right.slot ? -1 : 1;
  }

  return String(left.signature).localeCompare(String(right.signature));
}

export function dedupeSignatureHistory(
  signatures: SignatureHistoryEntry[],
  limit: number
): SignatureHistoryEntry[] {
  const bySignature = new Map<string, SignatureHistoryEntry>();

  for (const signatureInfo of signatures) {
    bySignature.set(String(signatureInfo.signature), signatureInfo);
  }

  return Array.from(bySignature.values()).sort(compareSignatureHistoryDesc).slice(0, limit);
}

export async function resolveWalletTokenAccountAddresses(
  c: AppContext,
  rpc: ReturnType<typeof solanaRpc.createRpc>,
  owner: Address,
  walletId: string
): Promise<Address[]> {
  try {
    return await tokenAccounts.getSplTokenAccountAddresses(rpc, owner);
  } catch (error) {
    getLogger().error(
      {
        requestId: c.get("requestId"),
        walletId,
        owner,
        error: error instanceof Error ? error.message : String(error),
      },
      "listTransfers: failed to fetch token accounts for wallet history"
    );
    return [];
  }
}

type ParsedTransaction = NonNullable<ParsedTransactionResponse["result"]>;

/**
 * Cap on cached parsed transactions. Only finalized transaction bodies are
 * cached — a finalized transaction's instructions, balances, and placement are
 * immutable, so entries never need revalidation; the bound exists only to keep
 * memory flat as signatures rotate through the FIFO. Fork-sensitive metadata
 * (slot, blockTime) is additionally always taken from the fresh
 * signature-history entry rather than the cached body (see
 * buildObservedTransferRows).
 */
export const PARSED_TRANSACTION_CACHE_MAX_ENTRIES = 1_000;

const PARSED_TRANSACTION_CACHE_TTL_MS = 60 * 60 * 1000;

interface ParsedTransactionCacheEntry {
  expiresAt: number;
  value: ParsedTransaction;
}

const parsedTransactionCache = new Map<string, ParsedTransactionCacheEntry>();
const inFlightParsedTransactions = new Map<string, Promise<ParsedTransactionResponse["result"]>>();

/**
 * Drops every cached parsed transaction and in-flight lookup. Cache entries
 * are keyed by signature alone and shared across tenants (a parsed body is
 * tenant-independent), so callers that stub the RPC must clear the cache to
 * stay isolated.
 */
export function clearObservedTransferCaches() {
  parsedTransactionCache.clear();
  inFlightParsedTransactions.clear();
}

function readCachedParsedTransaction(signature: string): ParsedTransaction | null {
  const entry = parsedTransactionCache.get(signature);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    parsedTransactionCache.delete(signature);
    return null;
  }

  return entry.value;
}

function writeParsedTransactionCache(signature: string, parsed: ParsedTransaction): void {
  if (!parsedTransactionCache.has(signature)) {
    while (parsedTransactionCache.size >= PARSED_TRANSACTION_CACHE_MAX_ENTRIES) {
      const oldest = parsedTransactionCache.keys().next();
      if (oldest.done) {
        break;
      }
      parsedTransactionCache.delete(oldest.value);
    }
  }

  parsedTransactionCache.set(signature, {
    value: parsed,
    expiresAt: Date.now() + PARSED_TRANSACTION_CACHE_TTL_MS,
  });
}

/**
 * A body is fork-proof only once it roots into a finalized block. Finality is
 * reported by the fresh signature-history entry (`getSignaturesForAddress`
 * returns each signature's `confirmationStatus`), not by the transaction body:
 * `getTransaction` responses carry no finality field at all, so the history —
 * which this request just fetched — is the only current source. Anything short
 * of "finalized" keeps the body uncached: a fork can still drop and re-land a
 * merely-confirmed transaction with different metadata.
 */
async function fetchParsedTransactionFromRpc(
  env: Env,
  signature: string
): Promise<ParsedTransactionResponse["result"]> {
  const rpcResponse = await fetch(resolveSignatureHistoryRpcUrl(env), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "getTransaction",
      params: [
        signature,
        { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ],
    }),
  });

  if (!rpcResponse.ok) {
    throw new Error(`RPC request failed with status ${rpcResponse.status}`);
  }

  const payload = (await rpcResponse.json()) as ParsedTransactionResponse;
  if (payload.error) {
    throw new Error(payload.error.message ?? "RPC returned an error");
  }

  return payload.result ?? null;
}

async function fetchParsedTransaction(
  env: Env,
  signature: string,
  isFinalized: boolean
): Promise<ParsedTransactionResponse["result"]> {
  const cached = readCachedParsedTransaction(signature);
  if (cached) {
    return cached;
  }

  const inFlight = inFlightParsedTransactions.get(signature);
  if (inFlight) {
    return inFlight;
  }

  const pending = fetchParsedTransactionFromRpc(env, signature)
    .then((parsedTransaction) => {
      // Cache a body only once the fresh signature history reports the
      // signature finalized. A null means the transaction is not yet indexed
      // at the confirmed commitment; caching it would hide a just-submitted
      // transfer until the TTL lapsed, delaying on-chain status. A
      // confirmed-but-not-finalized body stays uncached too: a fork can still
      // drop and re-land it with different metadata, so it is served fresh on
      // every read until it roots (the fetch happens per read, so freshness
      // is never traded for the cache). Failures stay uncached so the next
      // read retries.
      if (parsedTransaction && isFinalized) {
        writeParsedTransactionCache(signature, parsedTransaction);
      }
      return parsedTransaction;
    })
    .finally(() => {
      inFlightParsedTransactions.delete(signature);
    });
  inFlightParsedTransactions.set(signature, pending);

  return pending;
}

/**
 * Token-account address → the mint, owner, and decimals the transaction's own
 * pre/post token balances report for it. Parsed token instructions often name
 * only the token accounts, so this map is what ties an instruction to its mint
 * for extension resolution and row synthesis.
 */
function buildTokenAccountMetadataMap(
  parsedTransaction: ParsedTransaction
): Map<string, { decimals: number | null; mint: string | null; owner: string | null }> {
  const accountKeys = (parsedTransaction.transaction?.message?.accountKeys ?? [])
    .map((accountKey) => resolveParsedAccountKey(accountKey))
    .filter((accountKey): accountKey is string => Boolean(accountKey));

  const tokenAccountMetadata = new Map<
    string,
    { decimals: number | null; mint: string | null; owner: string | null }
  >();

  const preTokenBalances = parsedTransaction.meta?.preTokenBalances ?? [];
  const postTokenBalances = parsedTransaction.meta?.postTokenBalances ?? [];

  for (const balance of [...preTokenBalances, ...postTokenBalances]) {
    if (typeof balance.accountIndex !== "number") {
      continue;
    }

    const accountAddress = accountKeys[balance.accountIndex];
    if (!accountAddress) {
      continue;
    }

    const current = tokenAccountMetadata.get(accountAddress) ?? {
      owner: null,
      mint: null,
      decimals: null,
    };

    tokenAccountMetadata.set(accountAddress, {
      owner:
        typeof balance.owner === "string" && balance.owner.trim() ? balance.owner : current.owner,
      mint: typeof balance.mint === "string" && balance.mint.trim() ? balance.mint : current.mint,
      decimals:
        typeof balance.uiTokenAmount?.decimals === "number" &&
        Number.isFinite(balance.uiTokenAmount.decimals) &&
        Number.isInteger(balance.uiTokenAmount.decimals)
          ? balance.uiTokenAmount.decimals
          : current.decimals,
    });
  }

  return tokenAccountMetadata;
}

/**
 * The distinct mints whose extension state the parsed transaction's token
 * instructions need: the explicit mint of checked instructions, or the mint
 * the instruction's token accounts carry in the token balances.
 */
function collectObservedMintAddresses(parsedTransaction: ParsedTransaction): Address[] {
  const tokenAccountMetadata = buildTokenAccountMetadataMap(parsedTransaction);
  const mints = new Set<string>();

  for (const instruction of flattenParsedInstructions({ result: parsedTransaction })) {
    const parsedType = instruction.parsed?.type;
    const info = instruction.parsed?.info;

    if (!parsedType || !info) {
      continue;
    }

    const normalizedProgram = (instruction.program ?? "").toLowerCase();
    if (!normalizedProgram.includes("token")) {
      continue;
    }

    // Only the instruction families the row builder synthesizes rows for.
    const tokenAccountKeys =
      parsedType === "transfer" || parsedType === "transferChecked"
        ? ["source", "destination"]
        : parsedType === "mintTo" || parsedType === "mintToChecked"
          ? ["account"]
          : null;
    if (!tokenAccountKeys) {
      continue;
    }

    const explicitMint = readInstructionInfoString(info, "mint");
    if (explicitMint) {
      mints.add(explicitMint);
      continue;
    }

    for (const key of tokenAccountKeys) {
      const accountAddress = readInstructionInfoString(info, key);
      const mint = accountAddress ? tokenAccountMetadata.get(accountAddress)?.mint : null;
      if (mint) {
        mints.add(mint);
      }
    }
  }

  return [...mints] as Address[];
}

/**
 * Cap on mint extension-state read attempts per mint within one batch. A
 * failed read is evicted so a later signature can retry it, but a persistent
 * outage must not re-bill the same mint for every signature in the
 * 200-signature history cap: once the budget is spent the mint stays
 * unresolved for the rest of the call. Definitive resolutions never consume
 * the budget.
 */
export const MAX_MINT_AMOUNT_STATE_READ_ATTEMPTS = 2;

/**
 * A per-call resolver of mint extension states that shares one lookup per
 * mint across every signature in the batch: repeated signatures over the same
 * mint await the single in-flight read instead of re-billing it. A
 * transiently failed read resolves to `unresolved` for the signatures already
 * awaiting it but is evicted, so a later signature retries the read instead
 * of inheriting the omission — up to the per-mint attempt budget, after which
 * the mint stays unresolved for the rest of the call; a definitive resolution
 * stays cached for the rest of the call.
 */
function createMintAmountStateResolver(rpc: solanaRpc.SolanaRpc) {
  const pending = new Map<string, Promise<ObservedMintAmountState>>();
  const failedAttempts = new Map<string, number>();
  return (mint: Address): Promise<ObservedMintAmountState> => {
    let state = pending.get(mint);
    if (!state) {
      if ((failedAttempts.get(mint) ?? 0) >= MAX_MINT_AMOUNT_STATE_READ_ATTEMPTS) {
        return Promise.resolve({ kind: "unresolved" });
      }
      state = fetchObservedMintAmountState(rpc, mint).catch((error) => {
        // Evict so a later signature can retry a read that failed
        // temporarily, within the per-mint attempt budget; definitive
        // resolutions never land here.
        pending.delete(mint);
        failedAttempts.set(mint, (failedAttempts.get(mint) ?? 0) + 1);
        getLogger().warn(
          { mint, error: error instanceof Error ? error.message : String(error) },
          "observed-transfers: failed to resolve mint extension state; dropping its observations"
        );
        return { kind: "unresolved" };
      });
      pending.set(mint, state);
    }
    return state;
  };
}

/**
 * Resolves every requested mint's extension state, coalescing repeated
 * requests for the same mint within one call.
 */
async function resolveObservedMintAmountStates(
  mints: Address[],
  resolveMintAmountState: (mint: Address) => Promise<ObservedMintAmountState>
): Promise<Map<string, ObservedMintAmountState>> {
  const states = await Promise.all(
    mints.map(async (mint) => [mint, await resolveMintAmountState(mint)] as const)
  );
  return new Map(states);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Parsed transaction synthesis intentionally handles both SOL and SPL transfers in one pass.
function buildObservedTransferRows(
  parsedTransaction: ParsedTransactionResponse["result"],
  signatureInfo: SignatureHistoryEntry,
  context: ObservedTransferContext,
  mintStates: Map<string, ObservedMintAmountState>,
  timestampSeconds: number | null
): TransferRow[] {
  if (!parsedTransaction) {
    return [];
  }

  const signature = String(signatureInfo.signature);
  // A transaction confirmed on a minority fork can be dropped and re-land in a
  // different slot, so slot and blockTime always come from the fresh
  // signature-history entry; the cached body's copy is only a fallback for
  // history entries that lack the metadata.
  const timestamp = resolveObservedTimestamp(
    signatureInfo.blockTime ?? parsedTransaction.blockTime
  );
  const slot = resolveObservedSlot(signatureInfo.slot, parsedTransaction.slot);
  const status: TransferStatus = parsedTransaction.meta?.err ? "failed" : "confirmed";

  const tokenAccountMetadata = buildTokenAccountMetadataMap(parsedTransaction);
  const observedRows = new Map<string, TransferRow>();
  for (const instruction of flattenParsedInstructions({ result: parsedTransaction })) {
    const parsedType = instruction.parsed?.type;
    const info = instruction.parsed?.info;

    if (!parsedType || !info) {
      continue;
    }

    if ((instruction.program ?? "").startsWith("system") && parsedType === "transfer") {
      const sourceAddress = readInstructionInfoString(info, "source");
      const destinationAddress = readInstructionInfoString(info, "destination");
      const lamports = readInstructionInfoInteger(info, "lamports");

      if (!sourceAddress || !destinationAddress || lamports === null) {
        continue;
      }

      const sourceWalletId = context.walletIdsByAddress.get(sourceAddress) ?? null;
      const destinationWalletId = context.walletIdsByAddress.get(destinationAddress) ?? null;
      const walletId = sourceWalletId ?? destinationWalletId;

      if (!walletId) {
        continue;
      }

      const direction: TransferDirection =
        destinationWalletId && !sourceWalletId ? "inbound" : "outbound";
      const dedupeKey = `${walletId}:${signature}:SOL:${direction}`;

      if (observedRows.has(dedupeKey)) {
        continue;
      }

      observedRows.set(dedupeKey, {
        id: `xfr_observed_${walletId}_${signature}`,
        organization_id: context.organizationId,
        project_id: context.projectId,
        wallet_id: walletId,
        custody_wallet_id: null,
        counterparty_id: null,
        source_address: sourceAddress,
        destination_address: destinationAddress,
        token: SOL_MINT,
        amount: formatDecimalAmount(lamports, 9),
        memo: null,
        type: "transfer",
        kind: observedTransferKind(direction),
        direction,
        status,
        provider: null,
        provider_reference: null,
        delivery_mode: null,
        fiat_currency: null,
        fiat_amount: null,
        ramps_memo: {},
        provider_data: {},
        signature,
        serialized_tx: null,
        signed_transaction: null,
        last_valid_block_height: null,
        submission_started_at: null,
        slot,
        block_time: timestamp,
        fee: parsedTransaction.meta?.fee ?? null,
        error: null,
        initiated_by_key_id: null,
        idempotency_key: null,
        idempotency_fingerprint: null,
        confirmed_at: null,
        finalization_last_polled_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      });
      continue;
    }

    const normalizedProgram = (instruction.program ?? "").toLowerCase();
    if (!normalizedProgram.includes("token")) {
      continue;
    }

    if (parsedType === "mintTo" || parsedType === "mintToChecked") {
      const destinationTokenAccount = readInstructionInfoString(info, "account");
      if (!destinationTokenAccount) {
        continue;
      }

      const destinationTokenMetadata = tokenAccountMetadata.get(destinationTokenAccount);
      const destinationOwner = destinationTokenMetadata?.owner ?? null;
      const destinationWalletId = resolveWalletIdForTokenAccount(
        context,
        destinationTokenAccount,
        destinationOwner
      );

      if (!destinationWalletId) {
        continue;
      }

      const tokenAmount = readTokenAmountInfo(info);
      const decimals = tokenAmount?.decimals ?? destinationTokenMetadata?.decimals;
      const rawAmount = tokenAmount?.amount ?? readInstructionInfoInteger(info, "amount");
      const mint = readInstructionInfoString(info, "mint") ?? destinationTokenMetadata?.mint;
      const resolvedDecimals =
        typeof decimals === "number" && Number.isFinite(decimals) && Number.isInteger(decimals)
          ? decimals
          : null;

      if (resolvedDecimals === null || rawAmount === null || !mint) {
        continue;
      }

      const resolvedUiAmount = convertObservedTokenAmount({
        rawAmount,
        decimals: resolvedDecimals,
        rpcUiAmount: tokenAmount?.uiAmountString ?? null,
        mint,
        mintStates,
        timestampSeconds,
      });
      if (resolvedUiAmount === null) {
        continue;
      }

      const dedupeKey = `${destinationWalletId}:${signature}:${mint}:mint:${rawAmount.toString()}`;

      if (observedRows.has(dedupeKey)) {
        continue;
      }

      const direction = "inbound";
      observedRows.set(dedupeKey, {
        id: `xfr_observed_${destinationWalletId}_${signature}_${mint}_mint`,
        organization_id: context.organizationId,
        project_id: context.projectId,
        wallet_id: destinationWalletId,
        custody_wallet_id: null,
        counterparty_id: null,
        source_address: readInstructionInfoString(info, "mintAuthority") ?? mint,
        destination_address: destinationOwner ?? destinationTokenAccount,
        token: mint,
        amount: resolvedUiAmount,
        memo: null,
        type: "transfer",
        kind: observedTransferKind(direction),
        direction,
        status,
        provider: null,
        provider_reference: null,
        delivery_mode: null,
        fiat_currency: null,
        fiat_amount: null,
        ramps_memo: {},
        provider_data: {},
        signature,
        serialized_tx: null,
        signed_transaction: null,
        last_valid_block_height: null,
        submission_started_at: null,
        slot,
        block_time: timestamp,
        fee: parsedTransaction.meta?.fee ?? null,
        error: null,
        initiated_by_key_id: null,
        idempotency_key: null,
        idempotency_fingerprint: null,
        confirmed_at: null,
        finalization_last_polled_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      });
      continue;
    }

    if (parsedType !== "transfer" && parsedType !== "transferChecked") {
      continue;
    }

    const sourceTokenAccount = readInstructionInfoString(info, "source");
    const destinationTokenAccount = readInstructionInfoString(info, "destination");
    if (!sourceTokenAccount || !destinationTokenAccount) {
      continue;
    }

    const sourceTokenMetadata = tokenAccountMetadata.get(sourceTokenAccount);
    const destinationTokenMetadata = tokenAccountMetadata.get(destinationTokenAccount);
    const sourceOwner = sourceTokenMetadata?.owner ?? null;
    const destinationOwner = destinationTokenMetadata?.owner ?? null;
    const sourceWalletId = resolveWalletIdForTokenAccount(context, sourceTokenAccount, sourceOwner);
    const destinationWalletId = resolveWalletIdForTokenAccount(
      context,
      destinationTokenAccount,
      destinationOwner
    );
    const walletId = sourceWalletId ?? destinationWalletId;

    if (!walletId) {
      continue;
    }

    const tokenAmount = readTokenAmountInfo(info);
    const decimals =
      tokenAmount?.decimals ?? sourceTokenMetadata?.decimals ?? destinationTokenMetadata?.decimals;
    const rawAmount = tokenAmount?.amount ?? readInstructionInfoInteger(info, "amount");
    const mint =
      readInstructionInfoString(info, "mint") ??
      sourceTokenMetadata?.mint ??
      destinationTokenMetadata?.mint;
    const resolvedDecimals =
      typeof decimals === "number" && Number.isFinite(decimals) && Number.isInteger(decimals)
        ? decimals
        : null;

    if (resolvedDecimals === null || rawAmount === null || !mint) {
      continue;
    }

    const direction: TransferDirection =
      destinationWalletId && !sourceWalletId ? "inbound" : "outbound";
    const resolvedUiAmount = convertObservedTokenAmount({
      rawAmount,
      decimals: resolvedDecimals,
      rpcUiAmount: tokenAmount?.uiAmountString ?? null,
      mint,
      mintStates,
      timestampSeconds,
    });
    if (resolvedUiAmount === null) {
      continue;
    }
    const dedupeKey = `${walletId}:${signature}:${mint}:${direction}:${rawAmount.toString()}`;

    if (observedRows.has(dedupeKey)) {
      continue;
    }

    observedRows.set(dedupeKey, {
      id: `xfr_observed_${walletId}_${signature}_${mint}`,
      organization_id: context.organizationId,
      project_id: context.projectId,
      wallet_id: walletId,
      custody_wallet_id: null,
      counterparty_id: null,
      source_address: sourceOwner ?? sourceTokenAccount,
      destination_address: destinationOwner ?? destinationTokenAccount,
      token: mint,
      amount: resolvedUiAmount,
      memo: null,
      type: "transfer",
      kind: observedTransferKind(direction),
      direction,
      status,
      provider: null,
      provider_reference: null,
      delivery_mode: null,
      fiat_currency: null,
      fiat_amount: null,
      ramps_memo: {},
      provider_data: {},
      signature,
      serialized_tx: null,
      signed_transaction: null,
      last_valid_block_height: null,
      submission_started_at: null,
      slot,
      block_time: timestamp,
      fee: parsedTransaction.meta?.fee ?? null,
      error: null,
      initiated_by_key_id: null,
      idempotency_key: null,
      idempotency_fingerprint: null,
      confirmed_at: null,
      finalization_last_polled_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    });
  }

  return [...observedRows.values()];
}

export async function buildObservedTransfersForSignatures(
  env: Env,
  signatures: Array<Awaited<ReturnType<typeof solanaRpc.getSignaturesForAddress>>[number]>,
  context: ObservedTransferContext
): Promise<TransferRow[]> {
  if (signatures.length === 0 || context.walletIdsByAddress.size === 0) {
    return [];
  }

  // Bounded: the signature list is capped at historyLimit (200), and a bare
  // Promise.allSettled would open that many concurrent getTransaction calls
  // against the billed RPC per request. Mint extension-state reads go through
  // the shared deadline-wrapped RPC client and are shared per mint for the
  // whole call (see createMintAmountStateResolver), so repeated signatures
  // over the same mint cost one getAccountInfo.
  const mintStateRpc = solanaRpc.createRpc(env, {
    rpcUrl: resolveSignatureHistoryRpcUrl(env),
  });
  const resolveMintAmountState = createMintAmountStateResolver(mintStateRpc);
  const settled = await mapSettledWithConcurrency(
    signatures,
    SIGNATURE_HISTORY_LOOKUP_CONCURRENCY,
    async (signatureInfo) => {
      // The history entry was fetched fresh for this request, so its
      // confirmationStatus is the current finality signal for the body gate.
      const isFinalized = signatureInfo.confirmationStatus === "finalized";
      const parsedTransaction = await fetchParsedTransaction(
        env,
        String(signatureInfo.signature),
        isFinalized
      );
      // The historical clock and the mints' extension state decide whether an
      // extension-aware UI amount can be produced at all; both come from the
      // body and the fresh history entry before any row is synthesized.
      const timestampSeconds = resolveObservedTimestampSeconds(
        signatureInfo.blockTime ?? parsedTransaction?.blockTime
      );
      const mintStates = await resolveObservedMintAmountStates(
        parsedTransaction ? collectObservedMintAddresses(parsedTransaction) : [],
        resolveMintAmountState
      );
      return buildObservedTransferRows(
        parsedTransaction,
        signatureInfo,
        context,
        mintStates,
        timestampSeconds
      );
    }
  );

  return settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
}
