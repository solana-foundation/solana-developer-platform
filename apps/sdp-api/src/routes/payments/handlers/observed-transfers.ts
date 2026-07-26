import { getSolanaConfig } from "@sdp/rpc";
import { withHeliusApiKey } from "@sdp/rpc/relay";
import * as solanaRpc from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import type { Address } from "@solana/kit";
import { getDb } from "@/db";
import type {
  PaymentTransferDirection as TransferDirection,
  PaymentTransferRow as TransferRow,
  PaymentTransferStatus as TransferStatus,
} from "@/db/repositories/payments.repository";
import type { Env } from "@/types/env";
import type { AppContext } from "../context";
import * as tokenAccounts from "../token-accounts";

export const SIGNATURE_HISTORY_LOOKUP_CONCURRENCY = 5;

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
  tokenSymbolsByMint: Map<string, string>;
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

function resolveObservedTokenSymbol(mint: string, tokenSymbolsByMint: Map<string, string>): string {
  const normalizedMint = mint.trim();
  const known = tokenSymbolsByMint.get(normalizedMint)?.trim();
  if (known) {
    return known;
  }

  const wellKnownSymbol = WELL_KNOWN_TOKEN_BY_MINT.get(normalizedMint)?.symbol;
  if (wellKnownSymbol) {
    return wellKnownSymbol;
  }

  return normalizedMint;
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

function readTokenAmountInfo(
  info: Record<string, unknown> | undefined
): { amount: bigint; decimals: number; uiAmount: string | null } | null {
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

export async function mapSettledWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>
): Promise<Array<PromiseSettledResult<U>>> {
  const results = new Array<PromiseSettledResult<U>>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        try {
          results[currentIndex] = {
            status: "fulfilled",
            value: await mapper(items[currentIndex] as T),
          };
        } catch (reason) {
          results[currentIndex] = {
            status: "rejected",
            reason,
          };
        }
      }
    })
  );

  return results;
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
    console.error("listTransfers: failed to fetch token accounts for wallet history", {
      requestId: c.get("requestId"),
      walletId,
      owner,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function resolveObservedTokenSymbols(env: Env): Promise<Map<string, string>> {
  const symbolsByMint = new Map<string, string>();

  try {
    const result = await getDb(env)
      .prepare(
        `SELECT mint_address, symbol
         FROM issued_tokens
        WHERE mint_address IS NOT NULL
          AND deployed_at IS NOT NULL`
      )
      .all<{
        mint_address?: string | null;
        symbol?: string | null;
      }>();

    for (const row of result.results ?? []) {
      const mint = row.mint_address?.trim();
      if (!mint) {
        continue;
      }

      symbolsByMint.set(mint, row.symbol?.trim() || mint);
    }
  } catch {
    // Ignore symbol resolution failures and fall back to mint addresses.
  }

  return symbolsByMint;
}

async function fetchParsedTransaction(
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Parsed transaction synthesis intentionally handles both SOL and SPL transfers in one pass.
function buildObservedTransferRows(
  parsedTransaction: ParsedTransactionResponse["result"],
  signature: string,
  fallbackBlockTime: bigint | number | null,
  context: ObservedTransferContext
): TransferRow[] {
  if (!parsedTransaction) {
    return [];
  }

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

  const timestamp = resolveObservedTimestamp(parsedTransaction.blockTime ?? fallbackBlockTime);
  const status: TransferStatus = parsedTransaction.meta?.err ? "failed" : "confirmed";

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
        counterparty_id: null,
        source_address: sourceAddress,
        destination_address: destinationAddress,
        token: "SOL",
        amount: formatDecimalAmount(lamports, 9),
        memo: null,
        type: "transfer",
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
        slot: parsedTransaction.slot ?? null,
        block_time: timestamp,
        fee: parsedTransaction.meta?.fee ?? null,
        error: null,
        initiated_by_key_id: null,
        idempotency_key: null,
        idempotency_fingerprint: null,
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

      observedRows.set(dedupeKey, {
        id: `xfr_observed_${destinationWalletId}_${signature}_${mint}_mint`,
        organization_id: context.organizationId,
        project_id: context.projectId,
        wallet_id: destinationWalletId,
        counterparty_id: null,
        source_address: readInstructionInfoString(info, "mintAuthority") ?? mint,
        destination_address: destinationOwner ?? destinationTokenAccount,
        token: resolveObservedTokenSymbol(mint, context.tokenSymbolsByMint),
        amount: resolvedUiAmount,
        memo: null,
        type: "transfer",
        direction: "inbound",
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
        slot: parsedTransaction.slot ?? null,
        block_time: timestamp,
        fee: parsedTransaction.meta?.fee ?? null,
        error: null,
        initiated_by_key_id: null,
        idempotency_key: null,
        idempotency_fingerprint: null,
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
      counterparty_id: null,
      source_address: sourceOwner ?? sourceTokenAccount,
      destination_address: destinationOwner ?? destinationTokenAccount,
      token: resolveObservedTokenSymbol(mint, context.tokenSymbolsByMint),
      amount: resolvedUiAmount,
      memo: null,
      type: "transfer",
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
      slot: parsedTransaction.slot ?? null,
      block_time: timestamp,
      fee: parsedTransaction.meta?.fee ?? null,
      error: null,
      initiated_by_key_id: null,
      idempotency_key: null,
      idempotency_fingerprint: null,
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

  const settled = await Promise.allSettled(
    signatures.map(async (signatureInfo) => {
      const parsedTransaction = await fetchParsedTransaction(env, String(signatureInfo.signature));
      return buildObservedTransferRows(
        parsedTransaction,
        String(signatureInfo.signature),
        signatureInfo.blockTime,
        context
      );
    })
  );

  return settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
}
