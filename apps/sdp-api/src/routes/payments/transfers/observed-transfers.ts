// biome-ignore lint/style/noRestrictedImports: observed transfers read wallet signature history through the Helius-first pool
import { createClusterHistoryRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { getSignaturesForAddress, SolanaRpc } from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import { type AssetRef, NATIVE_ASSET } from "@sdp/solana/asset-ref";
import { type BaseUnits, baseUnits, U64_MAX } from "@sdp/solana/token-amount";
import type { PaymentTransferStatus as TransferStatus } from "@sdp/types/payments";
import {
  type AmountVerificationReason,
  type AmountVerificationState,
  CHAIN_DELTA_MATCHED,
  CHAIN_DELTA_MISMATCH,
  MOVEMENT_NOT_EXECUTED,
  type TokenMovementBasis,
} from "@sdp/types/token-movements";
import { SOL_DECIMALS, SOL_MINT, type TokenProgramKind } from "@sdp/types/well-known-tokens";
import { type Address, address, type Signature } from "@solana/kit";
import { observedTransferKind } from "@/db/repositories/payments.kind";
import type {
  PaymentTransferDirection as TransferDirection,
  PaymentTransferRow as TransferRow,
} from "@/db/repositories/payments.repository";
import type { LegAmounts } from "@/db/repositories/token-movement-legs.repository";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import type { AppContext } from "@/routes/payments/context";
import { getSplTokenAccountAddresses } from "@/routes/payments/token-accounts";
import { getLogger } from "@/runtime/logger";

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
  index: number;
  instructions?: readonly ParsedInstructionRecord[];
}

interface PositionedParsedInstruction {
  instruction: ParsedInstructionRecord;
  position: string;
}

interface ParsedAccountKey {
  pubkey?: string;
}

/** A raw token amount; the RPC's display fields (`uiAmount`, `uiAmountString`) are never read. */
interface RpcTokenBalanceAmount {
  amount?: string;
  decimals?: number | bigint;
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
      preBalances?: readonly (bigint | number)[] | null;
      postBalances?: readonly (bigint | number)[] | null;
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

type SignatureHistoryEntry = Awaited<ReturnType<typeof getSignaturesForAddress>>[number];

/**
 * What an observed transfer moved, as the chain shows it (ADR 0012): the
 * shape of a movement leg, built at read time and never persisted. Inbound
 * rows take the credit basis, outbound rows the debit.
 */
export interface ObservedMovement {
  /** Native SOL and the wrapped SOL mint are different assets, though rows store both under the mint. */
  asset: AssetRef;
  basis: TokenMovementBasis;
  decimals: number;
  amounts: LegAmounts;
  verification: Readonly<{
    state: AmountVerificationState;
    reason: AmountVerificationReason | null;
  }>;
}

/** A synthesized observed transfer row and what it moved. */
export interface ObservedTransfer {
  row: TransferRow;
  movement: ObservedMovement;
}

/** One move an instruction makes that touches a wallet SDP knows. */
interface ObservedMove {
  /** The instruction's position, from flattenParsedInstructions. */
  position: string;
  /**
   * The tracked wallet the move belongs to; null for a move between accounts
   * no tracked wallet owns, read only to check balance changes.
   */
  walletId: string | null;
  direction: TransferDirection;
  asset: AssetRef;
  /** The row's `token`: the mint, or the wrapped SOL mint for native SOL. */
  token: string;
  decimals: number;
  /** What the instruction moves out of its source, in base units. */
  debit: BaseUnits;
  /** The transfer fee the instruction states; null for a transfer that states none. */
  statedFee: BaseUnits | null;
  /** The account debited (a token account, or the paying wallet); null for a mint. */
  sourceAccount: string | null;
  /** The account credited (a token account, or the receiving wallet). */
  destinationAccount: string;
  sourceAddress: string;
  destinationAddress: string;
}

interface TokenAccountMetadata {
  decimals: number | null;
  mint: string | null;
  owner: string | null;
}

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

/**
 * Lists every outer and inner instruction of a parsed transaction with its
 * position: `<outer>` for an outer instruction, `<outer>.<inner>` for an inner
 * one, where `<outer>` is the RPC's `innerInstructions[].index`. A position is
 * unique within its transaction, so it tells apart transfers that share every
 * other field.
 *
 * @param parsedTransaction - The parsed transaction body.
 * @returns The outer instructions in message order, then the inner ones.
 */
function flattenParsedInstructions(
  parsedTransaction: ParsedTransaction
): PositionedParsedInstruction[] {
  const topLevel = (parsedTransaction.transaction?.message?.instructions ?? []).map(
    (instruction, outerIndex) => ({ instruction, position: `${outerIndex}` })
  );
  const inner = (parsedTransaction.meta?.innerInstructions ?? []).flatMap((group) =>
    (group.instructions ?? []).map((instruction, innerIndex) => ({
      instruction,
      position: `${group.index}.${innerIndex}`,
    }))
  );
  return [...topLevel, ...inner];
}

/**
 * Builds the id of a synthesized observed transfer row. One transfer
 * instruction yields one row per wallet and direction, so the instruction
 * position keeps movements that share a signature apart.
 *
 * @param params - The row's identifying fields.
 * @param params.walletId - The SDP wallet the row is listed under.
 * @param params.signature - The transaction signature.
 * @param params.position - The instruction position from flattenParsedInstructions.
 * @param params.direction - The row's direction relative to the wallet.
 * @returns The `xfr_observed_` row id.
 */
function observedTransferRowId(params: {
  walletId: string;
  signature: string;
  position: string;
  direction: TransferDirection;
}): string {
  return `xfr_observed_${params.walletId}_${params.signature}_${params.position}_${params.direction}`;
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

/** A non-negative integer the RPC serves as a bigint or a safe number; null otherwise. */
function integerOrNull(value: bigint | number | null | undefined): bigint | null {
  if (typeof value === "bigint") {
    return value >= 0n ? value : null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  return null;
}

/** Base units in the u64 range; null for anything a token amount cannot be. */
function u64OrNull(value: bigint | null): BaseUnits | null {
  return value === null || value > U64_MAX ? null : baseUnits(value);
}

/**
 * A parsed instruction's raw token amount and decimals: `info[key]`
 * (`tokenAmount` or `feeAmount`), or for `tokenAmount` the flat `amount` and
 * `decimals` some instructions carry. Base units only: the display string is
 * never read.
 */
function readTokenAmountInfo(
  info: Record<string, unknown> | undefined,
  key: "tokenAmount" | "feeAmount"
): { amount: bigint; decimals: number } | null {
  const rawTokenAmount = info?.[key];
  if (!rawTokenAmount || typeof rawTokenAmount !== "object" || Array.isArray(rawTokenAmount)) {
    if (key === "feeAmount") {
      return null;
    }
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
    return { amount: rawAmount, decimals: decimalsValue };
  }

  // SAFETY: checked above to be a non-array object; each field is read and checked below.
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
  return { amount: amountValue, decimals: decimalsValue };
}

/** The token program a parsed instruction's `program` names; null for any other program. */
function tokenProgramOf(program: string | undefined): TokenProgramKind | null {
  switch (program) {
    case "spl-token":
      return "spl-token";
    case "spl-token-2022":
      return "token-2022";
    default:
      return null;
  }
}

/** Each token account's owner, mint and decimals, from the transaction's token balances. */
function tokenAccountMetadata(
  parsedTransaction: ParsedTransaction,
  accountKeys: readonly string[]
): Map<string, TokenAccountMetadata> {
  const metadata = new Map<string, TokenAccountMetadata>();
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
    const current = metadata.get(accountAddress) ?? { owner: null, mint: null, decimals: null };
    const decimals = balance.uiTokenAmount?.decimals;
    metadata.set(accountAddress, {
      owner:
        typeof balance.owner === "string" && balance.owner.trim() ? balance.owner : current.owner,
      mint: typeof balance.mint === "string" && balance.mint.trim() ? balance.mint : current.mint,
      decimals:
        typeof decimals === "number" && Number.isFinite(decimals) && Number.isInteger(decimals)
          ? decimals
          : current.decimals,
    });
  }
  return metadata;
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one pass over the instructions reads SOL, mints and the three token transfer forms.
function readObservedMoves(
  parsedTransaction: ParsedTransaction,
  context: ObservedTransferContext,
  tokenAccounts: ReadonlyMap<string, TokenAccountMetadata>
): ObservedMove[] {
  const moves: ObservedMove[] = [];
  for (const { instruction, position } of flattenParsedInstructions(parsedTransaction)) {
    const parsedType = instruction.parsed?.type;
    const info = instruction.parsed?.info;

    if (!parsedType || !info) {
      continue;
    }

    if ((instruction.program ?? "").startsWith("system") && parsedType === "transfer") {
      const sourceAddress = readInstructionInfoString(info, "source");
      const destinationAddress = readInstructionInfoString(info, "destination");
      const lamports = u64OrNull(readInstructionInfoInteger(info, "lamports"));

      if (!sourceAddress || !destinationAddress || lamports === null) {
        continue;
      }

      const sourceWalletId = context.walletIdsByAddress.get(sourceAddress) ?? null;
      const destinationWalletId = context.walletIdsByAddress.get(destinationAddress) ?? null;
      const walletId = sourceWalletId ?? destinationWalletId;
      moves.push({
        position,
        walletId,
        direction: destinationWalletId && !sourceWalletId ? "inbound" : "outbound",
        asset: NATIVE_ASSET,
        // Rows store native SOL under the wrapped SOL mint (`normalizePaymentToken`); the
        // movement's asset is what tells the two apart.
        token: SOL_MINT,
        decimals: SOL_DECIMALS,
        debit: lamports,
        statedFee: baseUnits(0n),
        sourceAccount: sourceAddress,
        destinationAccount: destinationAddress,
        sourceAddress,
        destinationAddress,
      });
      continue;
    }

    const program = tokenProgramOf(instruction.program);
    if (program === null) {
      continue;
    }

    if (parsedType === "mintTo" || parsedType === "mintToChecked") {
      const destinationTokenAccount = readInstructionInfoString(info, "account");
      if (!destinationTokenAccount) {
        continue;
      }
      const destinationTokenMetadata = tokenAccounts.get(destinationTokenAccount);
      const destinationOwner = destinationTokenMetadata?.owner ?? null;
      const destinationWalletId = resolveWalletIdForTokenAccount(
        context,
        destinationTokenAccount,
        destinationOwner
      );
      const tokenAmount = readTokenAmountInfo(info, "tokenAmount");
      const decimals = tokenAmount?.decimals ?? destinationTokenMetadata?.decimals ?? null;
      const rawAmount = u64OrNull(
        tokenAmount?.amount ?? readInstructionInfoInteger(info, "amount")
      );
      const mint = readInstructionInfoString(info, "mint") ?? destinationTokenMetadata?.mint;
      if (decimals === null || rawAmount === null || !mint) {
        continue;
      }
      moves.push({
        position,
        walletId: destinationWalletId,
        direction: "inbound",
        asset: { kind: "token", mint: address(mint), program },
        token: mint,
        decimals,
        debit: rawAmount,
        // A mint charges no transfer fee.
        statedFee: baseUnits(0n),
        sourceAccount: null,
        destinationAccount: destinationTokenAccount,
        sourceAddress: readInstructionInfoString(info, "mintAuthority") ?? mint,
        destinationAddress: destinationOwner ?? destinationTokenAccount,
      });
      continue;
    }

    if (
      parsedType !== "transfer" &&
      parsedType !== "transferChecked" &&
      parsedType !== "transferCheckedWithFee"
    ) {
      continue;
    }

    const sourceTokenAccount = readInstructionInfoString(info, "source");
    const destinationTokenAccount = readInstructionInfoString(info, "destination");
    if (!sourceTokenAccount || !destinationTokenAccount) {
      continue;
    }

    const sourceTokenMetadata = tokenAccounts.get(sourceTokenAccount);
    const destinationTokenMetadata = tokenAccounts.get(destinationTokenAccount);
    const sourceOwner = sourceTokenMetadata?.owner ?? null;
    const destinationOwner = destinationTokenMetadata?.owner ?? null;
    const sourceWalletId = resolveWalletIdForTokenAccount(context, sourceTokenAccount, sourceOwner);
    const destinationWalletId = resolveWalletIdForTokenAccount(
      context,
      destinationTokenAccount,
      destinationOwner
    );
    const walletId = sourceWalletId ?? destinationWalletId;

    const tokenAmount = readTokenAmountInfo(info, "tokenAmount");
    const decimals =
      tokenAmount?.decimals ??
      sourceTokenMetadata?.decimals ??
      destinationTokenMetadata?.decimals ??
      null;
    const rawAmount = u64OrNull(tokenAmount?.amount ?? readInstructionInfoInteger(info, "amount"));
    const mint =
      readInstructionInfoString(info, "mint") ??
      sourceTokenMetadata?.mint ??
      destinationTokenMetadata?.mint;
    // TransferCheckedWithFee states the fee it was built for; the program
    // refuses it unless that is the fee it withholds.
    const feeAmount =
      parsedType === "transferCheckedWithFee" ? readTokenAmountInfo(info, "feeAmount") : null;
    const statedFee =
      parsedType === "transferCheckedWithFee" ? u64OrNull(feeAmount?.amount ?? null) : null;
    if (
      decimals === null ||
      rawAmount === null ||
      !mint ||
      (parsedType === "transferCheckedWithFee" && (statedFee === null || statedFee > rawAmount))
    ) {
      continue;
    }

    moves.push({
      position,
      walletId,
      direction: destinationWalletId && !sourceWalletId ? "inbound" : "outbound",
      asset: { kind: "token", mint: address(mint), program },
      token: mint,
      decimals,
      debit: rawAmount,
      statedFee,
      sourceAccount: sourceTokenAccount,
      destinationAccount: destinationTokenAccount,
      sourceAddress: sourceOwner ?? sourceTokenAccount,
      destinationAddress: destinationOwner ?? destinationTokenAccount,
    });
  }
  return moves;
}

/**
 * Each account's balance change in base units, as the transaction's metadata
 * reports it: lamports from `pre/postBalances` by account index, a token
 * account's raw amount from `pre/postTokenBalances[].uiTokenAmount.amount`
 * (never `uiAmountString`, a display value). An account the metadata does
 * not list is absent.
 */
function balanceDeltas(
  parsedTransaction: ParsedTransaction,
  accountKeys: readonly string[]
): { lamports: Map<string, bigint>; tokens: Map<string, bigint> } {
  const lamports = new Map<string, bigint>();
  const pre = parsedTransaction.meta?.preBalances ?? [];
  const post = parsedTransaction.meta?.postBalances ?? [];
  for (const [index, key] of accountKeys.entries()) {
    const before = integerOrNull(pre[index]);
    const after = integerOrNull(post[index]);
    if (before !== null && after !== null) {
      lamports.set(key, after - before);
    }
  }

  const tokens = new Map<string, bigint>();
  const read = (
    balances: readonly RpcTokenBalanceRecord[] | null | undefined,
    sign: 1n | -1n
  ): boolean => {
    for (const balance of balances ?? []) {
      const key =
        typeof balance.accountIndex === "number" ? accountKeys[balance.accountIndex] : undefined;
      const amount = balance.uiTokenAmount?.amount;
      if (key === undefined || typeof amount !== "string" || !/^\d+$/.test(amount)) {
        return false;
      }
      tokens.set(key, (tokens.get(key) ?? 0n) + sign * BigInt(amount));
    }
    return true;
  };
  // A token account the transaction creates has no pre balance: it starts at 0.
  const readable =
    read(parsedTransaction.meta?.postTokenBalances, 1n) &&
    read(parsedTransaction.meta?.preTokenBalances, -1n);
  return { lamports, tokens: readable ? tokens : new Map() };
}

/**
 * The base units each token account burned in the transaction: a burn lowers
 * a balance without a move, so the balance check counts it.
 */
function burnedByAccount(parsedTransaction: ParsedTransaction): Map<string, bigint> {
  const burned = new Map<string, bigint>();
  for (const { instruction } of flattenParsedInstructions(parsedTransaction)) {
    const parsedType = instruction.parsed?.type;
    const info = instruction.parsed?.info;
    if (
      (parsedType !== "burn" && parsedType !== "burnChecked") ||
      !info ||
      tokenProgramOf(instruction.program) === null
    ) {
      continue;
    }
    const account = readInstructionInfoString(info, "account");
    const amount = u64OrNull(
      readTokenAmountInfo(info, "tokenAmount")?.amount ?? readInstructionInfoInteger(info, "amount")
    );
    if (account && amount !== null) {
      burned.set(account, (burned.get(account) ?? 0n) + amount);
    }
  }
  return burned;
}

/**
 * What each move moved, checked against the chain (ADR 0012, verification
 * where the program does not already guarantee it): the credits instruction
 * data implies into each destination account, less what the transaction
 * moved out of it or burned from it (and, for lamports, the network fee its
 * fee payer paid), must equal that account's balance change.
 *
 * A plain `TransferChecked` (or `Transfer`) on a fee mint does not state its
 * fee: when it is the only such move into an account that received less than
 * expected, the program withheld the difference, so that is the fee. Between
 * several, the chain does not say how the fees split, so they stay unverified.
 * A failed transaction moved nothing.
 */
function observedMovements(
  parsedTransaction: ParsedTransaction,
  accountKeys: readonly string[],
  moves: readonly ObservedMove[]
): ObservedMovement[] {
  const executed = !parsedTransaction.meta?.err;
  const deltas = balanceDeltas(parsedTransaction, accountKeys);
  const burned = burnedByAccount(parsedTransaction);
  const feePayer = accountKeys[0];
  // The fee the fee payer paid; when the transaction does not state it, no
  // move into the fee payer's lamports can be checked.
  const networkFee = integerOrNull(parsedTransaction.meta?.fee);

  return moves.map((move): ObservedMovement => {
    const basis = move.direction === "inbound" ? "credit" : "debit";
    // A plain transfer states no fee: until the chain shows one, its debit is all credit.
    const stated = (fee: BaseUnits | null): BaseUnits => (fee === null ? baseUnits(0n) : fee);
    const split = (fee: BaseUnits): LegAmounts => ({
      debit: move.debit,
      fee,
      credit: baseUnits(move.debit - fee),
    });
    const movement = (
      amounts: LegAmounts,
      verification: ObservedMovement["verification"]
    ): ObservedMovement => ({
      asset: move.asset,
      basis,
      decimals: move.decimals,
      amounts,
      verification,
    });
    if (!executed) {
      return movement(split(stated(move.statedFee)), MOVEMENT_NOT_EXECUTED);
    }

    // A move back into its own account moves nothing and withholds no fee, whatever
    // amount and fee it states: it must not report them as verified.
    if (move.sourceAccount === move.destinationAccount) {
      return movement(
        { debit: baseUnits(0n), fee: baseUnits(0n), credit: baseUnits(0n) },
        CHAIN_DELTA_MATCHED
      );
    }

    const native = move.asset.kind === "native";
    const sameFamily = (other: ObservedMove) => (other.asset.kind === "native") === native;
    // A self-move is no credit into, and no debit out of, the account.
    const counted = (other: ObservedMove) =>
      sameFamily(other) && other.sourceAccount !== other.destinationAccount;
    const into = moves.filter(
      (other) => counted(other) && other.destinationAccount === move.destinationAccount
    );
    const outOf = moves.filter(
      (other) => counted(other) && other.sourceAccount === move.destinationAccount
    );
    const delta = (native ? deltas.lamports : deltas.tokens).get(move.destinationAccount);
    if (delta === undefined) {
      return movement(split(stated(move.statedFee)), { state: "pending", reason: null });
    }
    const intoFeePayer = native && move.destinationAccount === feePayer;
    if (intoFeePayer && networkFee === null) {
      return movement(split(stated(move.statedFee)), { state: "pending", reason: null });
    }
    const paidFee = intoFeePayer && networkFee !== null ? networkFee : 0n;
    const expected =
      into.reduce((total, other) => total + other.debit - stated(other.statedFee), 0n) -
      outOf.reduce((total, other) => total + other.debit, 0n) -
      (native ? 0n : (burned.get(move.destinationAccount) ?? 0n)) -
      paidFee;
    if (delta === expected) {
      return movement(split(stated(move.statedFee)), CHAIN_DELTA_MATCHED);
    }
    // The System program moves exactly the lamports it states. A lamport
    // change that differs comes from moves this reader does not count (a
    // wrapped SOL account's rent, a wrapped SOL transfer or close), so it
    // leaves the move unverified rather than contradicted.
    if (native) {
      return movement(split(stated(move.statedFee)), { state: "pending", reason: null });
    }
    // Only a Token-2022 mint can withhold a fee, and every move into, out of
    // and burned from the account is counted (tracked wallet or not), so a
    // shortfall no stated fee explains is the withheld fees. The whole debit
    // can be withheld: fees round up, so a tiny transfer can credit nothing.
    const shortfall = expected - delta;
    const unstated = into.filter((other) => other.statedFee === null);
    if (
      move.asset.kind !== "token" ||
      move.asset.program !== "token-2022" ||
      paidFee !== 0n ||
      shortfall <= 0n ||
      shortfall > unstated.reduce((total, other) => total + other.debit, 0n)
    ) {
      return movement(split(stated(move.statedFee)), CHAIN_DELTA_MISMATCH);
    }
    if (unstated.length === 1 && unstated[0] === move) {
      return movement(split(baseUnits(shortfall)), CHAIN_DELTA_MATCHED);
    }
    return movement(split(stated(move.statedFee)), { state: "pending", reason: null });
  });
}

function buildObservedTransfers(
  parsedTransaction: ParsedTransactionResponse["result"],
  signatureInfo: SignatureHistoryEntry,
  context: ObservedTransferContext
): ObservedTransfer[] {
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
  const moves = readObservedMoves(
    parsedTransaction,
    context,
    tokenAccountMetadata(parsedTransaction, accountKeys)
  );
  // Every move checks the balances; only a tracked wallet's move is a row.
  const movements = observedMovements(parsedTransaction, accountKeys, moves);

  return moves.flatMap((move, index) => {
    const { walletId } = move;
    if (walletId === null) {
      return [];
    }
    const movement = movements[index];
    // The row's amount is its own wallet's effect: what it received, or what it sent.
    const ownEffect =
      move.direction === "inbound" ? movement.amounts.credit : movement.amounts.debit;
    const row: TransferRow = {
      id: observedTransferRowId({
        walletId,
        signature,
        position: move.position,
        direction: move.direction,
      }),
      organization_id: context.organizationId,
      project_id: context.projectId,
      wallet_id: walletId,
      custody_wallet_id: null,
      counterparty_id: null,
      source_address: move.sourceAddress,
      destination_address: move.destinationAddress,
      token: move.token,
      amount: formatDecimalAmount(ownEffect, move.decimals),
      memo: null,
      type: "transfer",
      kind: observedTransferKind(move.direction),
      direction: move.direction,
      status,
      provider: null,
      provider_reference: null,
      provider_observed_at: null,
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
    };
    return [{ row, movement }];
  });
}

export async function buildObservedTransfersForSignatures(
  signatures: Array<Awaited<ReturnType<typeof getSignaturesForAddress>>[number]>,
  context: ObservedTransferContext
): Promise<ObservedTransfer[]> {
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
      return buildObservedTransfers(parsedTransaction, signatureInfo, context);
    }
  );

  return settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
}
