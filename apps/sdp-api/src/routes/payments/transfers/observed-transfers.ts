// biome-ignore lint/style/noRestrictedImports: observed transfers read wallet signature history through the Helius-first pool
import { createClusterHistoryRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import type * as solanaRpc from "@sdp/rpc/solana";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import { SOL_MINT, type PaymentTransferStatus as TransferStatus } from "@sdp/types";
import type { Address, Signature } from "@solana/kit";
import { observedTransferKind } from "@/db/repositories/payments.kind";
import type {
  PaymentTransferDirection as TransferDirection,
  PaymentTransferRow as TransferRow,
} from "@/db/repositories/payments.repository";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { getSplTokenAccountAddresses } from "@/routes/payments/token-accounts";
import { getLogger } from "@/runtime/logger";
import type { AppContext } from "../context";

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
  instructions?: readonly ParsedInstructionRecord[];
}

interface ParsedAccountKey {
  pubkey?: string;
}

interface RpcTokenBalanceAmount {
  amount?: string;
  decimals?: number | bigint;
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
    blockTime?: bigint | null;
    meta?: {
      err?: unknown;
      fee?: bigint;
      innerInstructions?: readonly ParsedInstructionGroup[] | null;
      postTokenBalances?: readonly RpcTokenBalanceRecord[] | null;
      preTokenBalances?: readonly RpcTokenBalanceRecord[] | null;
    } | null;
    slot?: bigint;
    transaction?: {
      message?: {
        accountKeys?: readonly (string | ParsedAccountKey)[];
        instructions?: readonly ParsedInstructionRecord[];
      };
    };
  } | null;
}

interface ObservedTransferContext {
  organizationId: string;
  projectId: string;
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
  cachedSlot: bigint | null | undefined
): number | null {
  if (typeof freshSlot === "bigint") {
    return Number(freshSlot);
  }

  return typeof cachedSlot === "bigint" ? Number(cachedSlot) : null;
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

  if (typeof value === "bigint") {
    return value >= 0n ? value : null;
  }

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

function readTokenAmountInfo(
  info: Record<string, unknown> | undefined
): { amount: bigint; decimals: number; uiAmount: string | null } | null {
  const rawTokenAmount = info?.tokenAmount;
  if (!rawTokenAmount || typeof rawTokenAmount !== "object" || Array.isArray(rawTokenAmount)) {
    const rawAmount = readInstructionInfoInteger(info, "amount");
    const rawDecimals = info?.decimals;
    const decimalsValue = typeof rawDecimals === "bigint" ? Number(rawDecimals) : rawDecimals;
    if (
      rawAmount === null ||
      typeof decimalsValue !== "number" ||
      !Number.isFinite(decimalsValue) ||
      !Number.isInteger(decimalsValue)
    ) {
      return null;
    }

    return {
      amount: rawAmount,
      decimals: decimalsValue,
      uiAmount: formatDecimalAmount(rawAmount, decimalsValue),
    };
  }

  const tokenAmountRecord = rawTokenAmount as RpcTokenBalanceAmount;

  const amountValue =
    typeof tokenAmountRecord.amount === "string" && /^\d+$/.test(tokenAmountRecord.amount)
      ? BigInt(tokenAmountRecord.amount)
      : null;
  const rawDecimals =
    typeof tokenAmountRecord.decimals === "bigint"
      ? Number(tokenAmountRecord.decimals)
      : tokenAmountRecord.decimals;
  const decimalsValue =
    typeof rawDecimals === "number" && Number.isFinite(rawDecimals) && Number.isInteger(rawDecimals)
      ? rawDecimals
      : null;

  if (amountValue === null || decimalsValue === null) {
    return null;
  }

  return {
    amount: amountValue,
    decimals: decimalsValue,
    uiAmount:
      typeof tokenAmountRecord.uiAmountString === "string" &&
      tokenAmountRecord.uiAmountString.trim()
        ? tokenAmountRecord.uiAmountString
        : formatDecimalAmount(amountValue, decimalsValue),
  };
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
  rpc: SolanaRpc,
  owner: Address,
  walletId: string
): Promise<Address[]> {
  try {
    return await getSplTokenAccountAddresses(rpc, owner);
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
 * are keyed by cluster and signature and shared across tenants (a parsed body is
 * tenant-independent), so callers that stub the RPC must clear the cache to
 * stay isolated.
 */
export function clearObservedTransferCaches() {
  parsedTransactionCache.clear();
  inFlightParsedTransactions.clear();
}

function readCachedParsedTransaction(cacheKey: string): ParsedTransaction | null {
  const entry = parsedTransactionCache.get(cacheKey);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    parsedTransactionCache.delete(cacheKey);
    return null;
  }

  return entry.value;
}

function writeParsedTransactionCache(cacheKey: string, parsed: ParsedTransaction): void {
  if (!parsedTransactionCache.has(cacheKey)) {
    while (parsedTransactionCache.size >= PARSED_TRANSACTION_CACHE_MAX_ENTRIES) {
      const oldest = parsedTransactionCache.keys().next();
      if (oldest.done) {
        break;
      }
      parsedTransactionCache.delete(oldest.value);
    }
  }

  parsedTransactionCache.set(cacheKey, {
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
  rpc: SolanaRpc,
  signature: Signature
): Promise<ParsedTransactionResponse["result"]> {
  const parsedTransaction = await rpc
    .getTransaction(signature, {
      encoding: "jsonParsed",
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    })
    .send();
  // SAFETY: kit types each parsed instruction's `info` as `object`; it is the RPC's open
  // jsonParsed map, which buildObservedTransferRows reads key by key and checks per value.
  // kit parses its integers (lamports, tokenAmount.decimals) to bigint, so the readers
  // accept bigint as well as string and number.
  return parsedTransaction as ParsedTransactionResponse["result"];
}

async function fetchParsedTransaction(
  signature: Signature,
  isFinalized: boolean
): Promise<ParsedTransactionResponse["result"]> {
  const cacheKey = `${currentClusterScope().cluster} ${signature}`;
  const cached = readCachedParsedTransaction(cacheKey);
  if (cached) {
    return cached;
  }

  const inFlight = inFlightParsedTransactions.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const pending = fetchParsedTransactionFromRpc(createClusterHistoryRpc(), signature)
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
        writeParsedTransactionCache(cacheKey, parsedTransaction);
      }
      return parsedTransaction;
    })
    .finally(() => {
      inFlightParsedTransactions.delete(cacheKey);
    });
  inFlightParsedTransactions.set(cacheKey, pending);

  return pending;
}

/**
 * The network fee a parsed transaction paid, as the transfer row stores it.
 *
 * @param parsedTransaction - The parsed transaction body.
 * @returns The fee in lamports, or null when the body carries no meta.
 */
function observedFee(parsedTransaction: ParsedTransaction): number | null {
  return parsedTransaction.meta?.fee === undefined ? null : Number(parsedTransaction.meta.fee);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Parsed transaction synthesis intentionally handles both SOL and SPL transfers in one pass.
function buildObservedTransferRows(
  parsedTransaction: ParsedTransactionResponse["result"],
  signatureInfo: SignatureHistoryEntry,
  context: ObservedTransferContext
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

  const accountKeys = (parsedTransaction.transaction?.message?.accountKeys ?? [])
    .map((accountKey) => resolveParsedAccountKey(accountKey))
    .filter((accountKey): accountKey is string => Boolean(accountKey));
  const tokenAccountMetadata = new Map<
    string,
    { decimals: number | null; mint: string | null; owner: string | null }
  >();
  const observedRows = new Map<string, TransferRow>();
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
        fee: observedFee(parsedTransaction),
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

      const resolvedUiAmount =
        tokenAmount?.uiAmount ?? formatDecimalAmount(rawAmount, resolvedDecimals);
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
        fee: observedFee(parsedTransaction),
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
    const resolvedUiAmount =
      tokenAmount?.uiAmount ?? formatDecimalAmount(rawAmount, resolvedDecimals);
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
      fee: observedFee(parsedTransaction),
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
  signatures: Array<Awaited<ReturnType<typeof solanaRpc.getSignaturesForAddress>>[number]>,
  context: ObservedTransferContext
): Promise<TransferRow[]> {
  if (signatures.length === 0 || context.walletIdsByAddress.size === 0) {
    return [];
  }

  // Bounded: the signature list is capped at historyLimit (200), and a bare
  // Promise.allSettled would open that many concurrent getTransaction calls
  // against the billed RPC per request.
  const settled = await mapSettledWithConcurrency(
    signatures,
    SIGNATURE_HISTORY_LOOKUP_CONCURRENCY,
    async (signatureInfo) => {
      // The history entry was fetched fresh for this request, so its
      // confirmationStatus is the current finality signal for the body gate.
      const isFinalized = signatureInfo.confirmationStatus === "finalized";
      const parsedTransaction = await fetchParsedTransaction(signatureInfo.signature, isFinalized);
      return buildObservedTransferRows(parsedTransaction, signatureInfo, context);
    }
  );

  return settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
}
