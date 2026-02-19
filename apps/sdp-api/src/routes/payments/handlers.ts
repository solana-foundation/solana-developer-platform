import { createD1Drizzle } from "@/db/drizzle";
import type {
  PaymentTransferRow as TransferRow,
  PaymentWalletPolicyRow as WalletPolicyRow,
} from "@/db/repositories/payments.repository";
import { createD1PaymentsRepository } from "@/db/repositories/payments.repository.d1";
import { formatDecimalAmount, isDecimalString, parseDecimalAmount } from "@/lib/amount";
import { getAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { paginated, success } from "@/lib/response";
import { assertValidAddress } from "@/lib/solana";
import { createFeePaymentAdapter } from "@/services/adapters/fee-payment";
import { createSigningService } from "@/services/domain/signing.service";
import { createOrgSigner } from "@/services/solana";
import {
  confirmTransaction,
  createRpc,
  getAccountInfo,
  getRecentBlockhash,
  simulateTransaction,
} from "@/services/solana/rpc";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import type { Address } from "@solana/kit";
import {
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import type { Context } from "hono";
import {
  type SignatureStatusRow,
  getTransactionJsonParsed,
  getTransactionsJsonParsedBatch,
  inferTransferFromTransaction,
  listSignaturesForAddressPaged,
  mapSignatureStatusToTransferStatus,
  touchesOwnedWallet,
  unixSecondsToIso,
} from "./rpc-history";
import {
  createTransferSchema,
  listTransfersQuerySchema,
  prepareTransferSchema,
  transferIdParamsSchema,
  updateWalletPolicySchema,
  walletIdParamsSchema,
} from "./schemas";

type AppContext = Context<{ Bindings: Env }>;
// biome-ignore lint/nursery/noSecrets: Solana native SOL mint address constant, not a secret.
const SOL_MINT = "So11111111111111111111111111111111111111112";
// biome-ignore lint/nursery/noSecrets: Solana SPL Token program ID, not a secret.
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
// biome-ignore lint/nursery/noSecrets: Solana Token-2022 program ID, not a secret.
const SPL_TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const SPL_TOKEN_PROGRAM_IDS = [SPL_TOKEN_PROGRAM_ID, SPL_TOKEN_2022_PROGRAM_ID] as const;
const PAYMENT_POLICY_VERSION = 1;
const DESTINATION_ALLOWLIST_POLICY_TYPE = "destination_allowlist";
const TRANSFER_LIMITS_POLICY_TYPE = "transfer_limits";

function getPaymentsRepository(c: AppContext) {
  return createD1PaymentsRepository({ db: createD1Drizzle(c.env.DB) });
}

function getFeePayment(c: AppContext) {
  return createFeePaymentAdapter(c.env);
}

async function getSponsoredFeePayer(c: AppContext): Promise<Address> {
  return getFeePayment(c).getFeePayer();
}

function isNativeSolToken(token: string): boolean {
  const normalized = token.trim();
  return normalized.toUpperCase() === "SOL" || normalized === SOL_MINT;
}

function parsePolicyDocument(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseDestinationAllowlistPolicy(raw: string): string[] {
  const document = parsePolicyDocument(raw);
  if (!document || document.version !== PAYMENT_POLICY_VERSION) {
    return [];
  }

  const value = document.destinationAllowlist;
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function parseTransferLimitsPolicy(raw: string): {
  maxTransferAmount?: string;
  maxDailyAmount?: string;
} {
  const document = parsePolicyDocument(raw);
  if (!document || document.version !== PAYMENT_POLICY_VERSION) {
    return {};
  }

  const payload: { maxTransferAmount?: string; maxDailyAmount?: string } = {};
  if (typeof document.maxTransferAmount === "string") {
    payload.maxTransferAmount = document.maxTransferAmount;
  }
  if (typeof document.maxDailyAmount === "string") {
    payload.maxDailyAmount = document.maxDailyAmount;
  }

  return payload;
}

function buildWalletPolicyPayload(
  walletId: string,
  rows: WalletPolicyRow[],
  fallbackTimestamp: string
): {
  walletId: string;
  destinationAllowlist: string[];
  maxTransferAmount?: string;
  maxDailyAmount?: string;
  createdAt: string;
  updatedAt: string;
} {
  if (rows.length === 0) {
    return {
      walletId,
      destinationAllowlist: [],
      createdAt: fallbackTimestamp,
      updatedAt: fallbackTimestamp,
    };
  }

  const rowsByType = new Map(rows.map((row) => [row.policy_type, row]));
  const destinationAllowlistRow = rowsByType.get(DESTINATION_ALLOWLIST_POLICY_TYPE);
  const transferLimitsRow = rowsByType.get(TRANSFER_LIMITS_POLICY_TYPE);
  const destinationAllowlist = destinationAllowlistRow
    ? parseDestinationAllowlistPolicy(destinationAllowlistRow.policy)
    : [];
  const parsedLimits = transferLimitsRow ? parseTransferLimitsPolicy(transferLimitsRow.policy) : {};

  const createdAt = rows.reduce(
    (earliest, row) => (row.created_at < earliest ? row.created_at : earliest),
    rows[0].created_at
  );
  const updatedAt = rows.reduce(
    (latest, row) => (row.updated_at > latest ? row.updated_at : latest),
    rows[0].updated_at
  );

  return {
    walletId,
    destinationAllowlist,
    ...(parsedLimits.maxTransferAmount
      ? { maxTransferAmount: parsedLimits.maxTransferAmount }
      : {}),
    ...(parsedLimits.maxDailyAmount ? { maxDailyAmount: parsedLimits.maxDailyAmount } : {}),
    createdAt,
    updatedAt,
  };
}

function parseDecimalParts(value: string): { whole: string; fraction: string } {
  const normalized = value.trim();
  if (!isDecimalString(normalized)) {
    throw new AppError("BAD_REQUEST", "Invalid amount format");
  }

  const [wholeRaw = "", fractionRaw = ""] = normalized.split(".");
  const whole = (wholeRaw || "0").replace(/^0+(?=\d)/, "");
  let fraction = fractionRaw ?? "";
  fraction = fraction.replace(/0+$/, "");

  return {
    whole: whole.length > 0 ? whole : "0",
    fraction,
  };
}

function compareDecimalAmounts(left: string, right: string): number {
  const leftParts = parseDecimalParts(left);
  const rightParts = parseDecimalParts(right);

  if (leftParts.whole.length !== rightParts.whole.length) {
    return leftParts.whole.length < rightParts.whole.length ? -1 : 1;
  }

  if (leftParts.whole !== rightParts.whole) {
    return leftParts.whole < rightParts.whole ? -1 : 1;
  }

  const scale = Math.max(leftParts.fraction.length, rightParts.fraction.length);
  const leftFraction = leftParts.fraction.padEnd(scale, "0");
  const rightFraction = rightParts.fraction.padEnd(scale, "0");

  if (leftFraction === rightFraction) {
    return 0;
  }

  return leftFraction < rightFraction ? -1 : 1;
}

function sumDecimalAmounts(amounts: string[]): string {
  if (amounts.length === 0) {
    return "0";
  }

  const parsed = amounts.map(parseDecimalParts);
  const scale = parsed.reduce((max, entry) => Math.max(max, entry.fraction.length), 0);

  const total = parsed.reduce((acc, entry) => {
    const combined = `${entry.whole}${entry.fraction.padEnd(scale, "0")}`;
    return acc + BigInt(combined);
  }, 0n);

  if (scale === 0) {
    return total.toString();
  }

  const digits = total.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale).replace(/^0+(?=\d)/, "") || "0";
  const fraction = digits.slice(-scale).replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole;
}

function addDecimalAmounts(left: string, right: string): string {
  return sumDecimalAmounts([left, right]);
}

function getUtcDayWindow(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

const SIGNATURE_PAGE_LIMIT = 1000;

type ScopedSignatureRow = SignatureStatusRow & { queriedAddress: string };

function toBigIntSlot(slot: number | bigint): bigint {
  return typeof slot === "bigint" ? slot : BigInt(slot);
}

function compareSlotsDescending(left: number | bigint, right: number | bigint): number {
  const leftSlot = toBigIntSlot(left);
  const rightSlot = toBigIntSlot(right);
  if (leftSlot === rightSlot) {
    return 0;
  }
  return leftSlot < rightSlot ? 1 : -1;
}

function slotToNumber(slot: number | bigint | null | undefined): number | null {
  if (slot === null || slot === undefined) {
    return null;
  }
  return typeof slot === "bigint" ? Number(slot) : slot;
}

function normalizeTransferToken(token: string): string {
  return isNativeSolToken(token) ? "SOL" : token;
}

async function listScopedSignaturesForAddresses(
  rpc: ReturnType<typeof createRpc>,
  addresses: string[],
  options: { from?: string; to?: string }
): Promise<ScopedSignatureRow[]> {
  const minDate = options.from ? Date.parse(options.from) : null;
  const maxDate = options.to ? Date.parse(options.to) : null;
  const bySignature = new Map<string, ScopedSignatureRow>();

  for (const address of addresses) {
    let before: string | undefined;

    while (true) {
      const rows = await listSignaturesForAddressPaged(rpc, address, {
        limit: SIGNATURE_PAGE_LIMIT,
        before,
      });

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        const blockTimeIso = unixSecondsToIso(row.blockTime);
        if ((minDate !== null || maxDate !== null) && !blockTimeIso) {
          continue;
        }

        if (blockTimeIso) {
          const blockTimeDate = Date.parse(blockTimeIso);
          if (minDate !== null && blockTimeDate < minDate) {
            continue;
          }
          if (maxDate !== null && blockTimeDate > maxDate) {
            continue;
          }
        }

        const existing = bySignature.get(row.signature);
        if (!existing || toBigIntSlot(row.slot) > toBigIntSlot(existing.slot)) {
          bySignature.set(row.signature, {
            ...row,
            queriedAddress: address,
          });
        }
      }

      const last = rows[rows.length - 1];
      if (!last) {
        break;
      }

      before = last.signature;
      if (!before) {
        break;
      }

      if (minDate !== null) {
        const oldestIso = unixSecondsToIso(last.blockTime);
        if (oldestIso && Date.parse(oldestIso) < minDate) {
          break;
        }
      }
    }
  }

  return Array.from(bySignature.values()).sort((a, b) => compareSlotsDescending(a.slot, b.slot));
}

async function listOnChainOutboundTransferAmounts(input: {
  c: AppContext;
  walletAddress: string;
  token: string;
  from: string;
  to: string;
}): Promise<string[]> {
  const rpc = createRpc(input.c.env);
  const rows = await listScopedSignaturesForAddresses(rpc, [input.walletAddress], {
    from: input.from,
    to: input.to,
  });

  if (rows.length === 0) {
    return [];
  }

  const txBySignature = await getTransactionsJsonParsedBatch({
    env: input.c.env,
    rpc,
    signatures: rows.map((row) => row.signature),
  });

  const ownedAddresses = new Set([input.walletAddress]);
  const amounts: string[] = [];

  for (const row of rows) {
    const tx = txBySignature.get(row.signature);
    if (!tx) {
      continue;
    }

    const details = inferTransferFromTransaction(tx, {
      queriedAddress: input.walletAddress,
      ownedAddresses: new Set(ownedAddresses),
    });
    if (details.direction !== "outbound") {
      continue;
    }

    const detailToken = details.token ? normalizeTransferToken(details.token) : null;
    if (detailToken !== input.token) {
      continue;
    }

    if (details.amount && isDecimalString(details.amount)) {
      amounts.push(details.amount);
    }
  }

  return amounts;
}

async function assertWalletPolicyAllowsTransfer(
  c: AppContext,
  input: {
    organizationId: string;
    projectId: string | null;
    wallet: CustodyWallet;
    destinationAddress: string;
    token: string;
    amount: string;
  }
): Promise<void> {
  const repository = getPaymentsRepository(c);
  const rows = await repository.getWalletPoliciesByCustodyWalletId(input.wallet.id);

  if (rows.length === 0) {
    return;
  }

  const policy = buildWalletPolicyPayload(input.wallet.walletId, rows, input.wallet.createdAt);

  if (
    policy.destinationAllowlist.length > 0 &&
    !policy.destinationAllowlist.includes(input.destinationAddress)
  ) {
    throw new AppError("FORBIDDEN", "Destination address is not allowed by wallet policy");
  }

  if (policy.maxTransferAmount) {
    if (!isDecimalString(policy.maxTransferAmount)) {
      throw new AppError("INTERNAL_ERROR", "Wallet policy has invalid maxTransferAmount");
    }

    if (compareDecimalAmounts(input.amount, policy.maxTransferAmount) > 0) {
      throw new AppError("FORBIDDEN", "Transfer amount exceeds wallet policy maxTransferAmount");
    }
  }

  if (policy.maxDailyAmount) {
    if (!isDecimalString(policy.maxDailyAmount)) {
      throw new AppError("INTERNAL_ERROR", "Wallet policy has invalid maxDailyAmount");
    }

    const dayWindow = getUtcDayWindow(new Date());
    const pendingAmounts = await repository.listTransferAmounts({
      organizationId: input.organizationId,
      projectId: input.projectId,
      walletId: input.wallet.walletId,
      token: input.token,
      direction: "outbound",
      statuses: ["pending", "processing"],
      createdAtFrom: dayWindow.start,
      createdAtTo: dayWindow.end,
    });
    const onChainAmounts = await listOnChainOutboundTransferAmounts({
      c,
      walletAddress: input.wallet.publicKey,
      token: input.token,
      from: dayWindow.start,
      to: dayWindow.end,
    });

    const projectedTotal = addDecimalAmounts(
      sumDecimalAmounts([...pendingAmounts, ...onChainAmounts]),
      input.amount
    );
    if (compareDecimalAmounts(projectedTotal, policy.maxDailyAmount) > 0) {
      throw new AppError("FORBIDDEN", "Transfer amount exceeds wallet policy maxDailyAmount");
    }
  }
}

function mapTransferRow(row: TransferRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    type: row.type,
    direction: row.direction,
    status: row.status,
    signature: row.signature,
    serializedTx: row.serialized_tx,
    slot: row.slot,
    blockTime: row.block_time,
    fee: row.fee,
    error: row.error,
    ...(row.initiated_by_key_id
      ? {
          initiatedBy: {
            type: "api_key",
            id: row.initiated_by_key_id,
          },
        }
      : {}),
    source: row.source_address,
    destination: row.destination_address,
    ...(row.memo ? { memo: row.memo } : {}),
    token: row.token,
    amount: row.amount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type JsonParsedTokenAccountEntry = {
  pubkey?: string;
  account?: {
    data?: {
      parsed?: {
        info?: unknown;
      };
    };
  };
};

type JsonParsedTokenAccountsByOwnerResponse = {
  value?: JsonParsedTokenAccountEntry[];
};

type TokenAccountsByOwnerRpc = {
  getTokenAccountsByOwner: (
    address: Address,
    filter: { programId: Address },
    config: { encoding: "jsonParsed"; commitment: "confirmed" }
  ) => {
    send: () => Promise<JsonParsedTokenAccountsByOwnerResponse>;
  };
};

async function getTokenAccountsByOwnerJsonParsed(
  rpc: ReturnType<typeof createRpc>,
  owner: Address,
  programId: Address
): Promise<JsonParsedTokenAccountsByOwnerResponse> {
  return (rpc as unknown as TokenAccountsByOwnerRpc)
    .getTokenAccountsByOwner(
      owner,
      { programId },
      { encoding: "jsonParsed", commitment: "confirmed" }
    )
    .send();
}

function parseTokenAmountInfo(
  value: unknown
): { mint: string; amount: bigint; decimals: number; uiAmount?: string } | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const info = value as Record<string, unknown>;
  const mint = typeof info.mint === "string" ? info.mint : null;
  if (!mint) {
    return null;
  }

  const tokenAmount =
    typeof info.tokenAmount === "object" && info.tokenAmount !== null
      ? (info.tokenAmount as Record<string, unknown>)
      : null;
  if (!tokenAmount) {
    return null;
  }

  const rawAmount = tokenAmount.amount;
  const rawDecimals = tokenAmount.decimals;

  if (
    (typeof rawAmount !== "string" && typeof rawAmount !== "number") ||
    typeof rawDecimals !== "number"
  ) {
    return null;
  }

  let amount: bigint;
  try {
    amount = BigInt(String(rawAmount));
  } catch {
    return null;
  }

  const decimals = Number(rawDecimals);
  if (!Number.isInteger(decimals) || decimals < 0) {
    return null;
  }

  const uiAmount =
    typeof tokenAmount.uiAmountString === "string" ? tokenAmount.uiAmountString : undefined;

  return { mint, amount, decimals, uiAmount };
}

async function getSplTokenBalances(
  rpc: ReturnType<typeof createRpc>,
  owner: Address
): Promise<
  Array<{ token: string; mint: string; amount: string; uiAmount: string; decimals: number }>
> {
  const balancesByMint = new Map<string, { amount: bigint; decimals: number; uiAmount?: string }>();

  for (const programId of SPL_TOKEN_PROGRAM_IDS) {
    const response = await getTokenAccountsByOwnerJsonParsed(rpc, owner, programId);

    for (const account of response.value ?? []) {
      const parsed = parseTokenAmountInfo(account.account?.data?.parsed?.info);
      if (!parsed || parsed.amount <= 0n) {
        continue;
      }

      const existing = balancesByMint.get(parsed.mint);
      if (existing) {
        existing.amount += parsed.amount;
        continue;
      }

      balancesByMint.set(parsed.mint, {
        amount: parsed.amount,
        decimals: parsed.decimals,
        uiAmount: parsed.uiAmount,
      });
    }
  }

  return Array.from(balancesByMint.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mint, balance]) => ({
      token: mint,
      mint,
      amount: balance.amount.toString(),
      uiAmount: balance.uiAmount ?? formatDecimalAmount(balance.amount, balance.decimals),
      decimals: balance.decimals,
    }));
}

function assertSupportedTokenProgram(program: string): Address {
  if (program === SPL_TOKEN_PROGRAM_ID || program === SPL_TOKEN_2022_PROGRAM_ID) {
    return program as Address;
  }
  throw new AppError("BAD_REQUEST", "Unsupported token program for mint");
}

async function resolveMintTokenProgram(
  rpc: ReturnType<typeof createRpc>,
  mint: Address
): Promise<Address> {
  const mintAccountInfo = await getAccountInfo(rpc, mint);
  if (!mintAccountInfo) {
    throw new AppError("BAD_REQUEST", "Token mint account does not exist");
  }
  return assertSupportedTokenProgram(mintAccountInfo.owner);
}

async function resolveSourceTokenAccount(
  rpc: ReturnType<typeof createRpc>,
  owner: Address,
  mint: Address,
  tokenProgram: Address
): Promise<{ tokenAccount: Address; decimals: number }> {
  const response = await getTokenAccountsByOwnerJsonParsed(rpc, owner, tokenProgram);
  let selected: { tokenAccount: Address; decimals: number; amount: bigint } | null = null;

  for (const account of response.value ?? []) {
    if (typeof account.pubkey !== "string") {
      continue;
    }

    const parsed = parseTokenAmountInfo(account.account?.data?.parsed?.info);
    if (!parsed || parsed.mint !== mint) {
      continue;
    }

    const tokenAccount = assertValidAddress(account.pubkey, "sourceToken");
    if (!selected || parsed.amount > selected.amount) {
      selected = {
        tokenAccount,
        decimals: parsed.decimals,
        amount: parsed.amount,
      };
    }
  }

  if (!selected) {
    throw new AppError("BAD_REQUEST", "Source wallet has no token account for this mint");
  }

  return {
    tokenAccount: selected.tokenAccount,
    decimals: selected.decimals,
  };
}

async function resolveScope(c: AppContext) {
  const auth = getAuth(c);
  const signingService = createSigningService(c.env);
  const config = await signingService.getConfiguration(
    auth.organizationId,
    auth.projectId ?? undefined
  );

  if (!config) {
    throw new AppError("NOT_FOUND", "Custody configuration is not initialized for this scope");
  }

  const wallets = await signingService.getWallets(auth.organizationId, auth.projectId ?? undefined);

  return {
    auth,
    wallets,
  };
}

function resolveWallet(wallets: CustodyWallet[], walletId: string): CustodyWallet {
  const wallet = wallets.find((entry) => entry.walletId === walletId);
  if (!wallet) {
    throw new AppError("NOT_FOUND", "Wallet not found. Provision wallets through /v1/wallets");
  }
  return wallet;
}

async function resolveWalletFromParams(c: AppContext) {
  const params = walletIdParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw new AppError("BAD_REQUEST", "Invalid wallet ID");
  }

  const scope = await resolveScope(c);
  const wallet = resolveWallet(scope.wallets, params.data.walletId);

  return {
    ...scope,
    wallet,
  };
}

function assertProjectContext(
  bodyProjectId: string | undefined,
  authProjectId: string | null
): void {
  if (!bodyProjectId) {
    return;
  }

  if (!authProjectId) {
    throw new AppError(
      "BAD_REQUEST",
      "projectId overrides are not supported for org-scoped keys in payments endpoints"
    );
  }

  if (bodyProjectId !== authProjectId) {
    throw new AppError("BAD_REQUEST", "projectId does not match the authenticated API key scope");
  }
}

async function createTransferRecord(
  c: AppContext,
  input: {
    organizationId: string;
    projectId: string | null;
    walletId: string;
    sourceAddress: string;
    destinationAddress: string;
    token: string;
    amount: string;
    memo?: string;
    type?: TransferRow["type"];
    direction?: TransferRow["direction"];
    status?: TransferRow["status"];
    serializedTx?: string;
    initiatedByKeyId?: string;
  }
): Promise<TransferRow> {
  const repository = getPaymentsRepository(c);
  const id = `xfr_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const createdRow = await repository.createTransfer({
    id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    walletId: input.walletId,
    sourceAddress: input.sourceAddress,
    destinationAddress: input.destinationAddress,
    token: input.token,
    amount: input.amount,
    memo: input.memo ?? null,
    type: input.type ?? "transfer",
    direction: input.direction ?? "outbound",
    status: input.status ?? "pending",
    serializedTx: input.serializedTx ?? null,
    initiatedByKeyId: input.initiatedByKeyId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  if (!createdRow) {
    throw new AppError("INTERNAL_ERROR", "Failed to create payment transfer record");
  }

  return createdRow;
}

async function getTransferRowById(
  c: AppContext,
  transferId: string,
  organizationId: string,
  projectId: string | null
): Promise<TransferRow | null> {
  const repository = getPaymentsRepository(c);
  return repository.getTransferById({ transferId, organizationId, projectId });
}

async function updateTransferRecord(
  c: AppContext,
  transferId: string,
  patch: {
    status?: TransferRow["status"];
    signature?: string | null;
    serializedTx?: string | null;
    slot?: number | null;
    blockTime?: string | null;
    fee?: number | null;
    error?: string | null;
  }
): Promise<TransferRow> {
  const repository = getPaymentsRepository(c);
  const now = new Date().toISOString();

  const updated = await repository.updateTransfer({
    transferId,
    status: patch.status,
    signature: patch.signature,
    serializedTx: patch.serializedTx,
    slot: patch.slot,
    blockTime: patch.blockTime,
    fee: patch.fee,
    error: patch.error,
    updatedAt: now,
  });

  if (!updated) {
    throw new AppError("INTERNAL_ERROR", "Payment transfer record not found for update");
  }

  return updated;
}

async function prepareSolTransfer(
  c: AppContext,
  sourceAddress: Address,
  destinationAddress: Address,
  amount: string
): Promise<{ serializedTx: string; blockhash: string; lastValidBlockHeight: string }> {
  const lamports = parseDecimalAmount(amount, 9);
  if (lamports <= 0n) {
    throw new AppError("BAD_REQUEST", "Transfer amount must be greater than zero");
  }

  const rpc = createRpc(c.env);
  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc, "confirmed");
  const feePayer = await getSponsoredFeePayer(c);

  const instruction = getTransferSolInstruction({
    source: createNoopSigner(sourceAddress),
    destination: destinationAddress,
    amount: lamports,
  });

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions([instruction], m)
  );

  const compiled = compileTransaction(message);

  return {
    serializedTx: getBase64EncodedWireTransaction(compiled),
    blockhash: blockhash as string,
    lastValidBlockHeight: lastValidBlockHeight.toString(),
  };
}

async function executeSolTransfer(
  c: AppContext,
  sourceWallet: CustodyWallet,
  destinationAddress: Address,
  amount: string
): Promise<{
  signature: string;
  slot: number | null;
  blockTime: string | null;
  status: TransferRow["status"];
}> {
  const lamports = parseDecimalAmount(amount, 9);
  if (lamports <= 0n) {
    throw new AppError("BAD_REQUEST", "Transfer amount must be greater than zero");
  }

  const auth = getAuth(c);
  const signer = await createOrgSigner(
    c.env,
    auth.organizationId,
    auth.projectId ?? undefined,
    sourceWallet.walletId
  );

  if (signer.address !== sourceWallet.publicKey) {
    throw new AppError("BAD_REQUEST", "Resolved signing wallet does not match source wallet");
  }

  const rpc = createRpc(c.env);
  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc, "confirmed");
  const feePayment = getFeePayment(c);
  const feePayer = await feePayment.getFeePayer();

  const instruction = getTransferSolInstruction({
    source: signer,
    destination: destinationAddress,
    amount: lamports,
  });

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions([instruction], m),
    (m) => addSignersToTransactionMessage([signer], m)
  );

  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
  const txEncoder = getTransactionEncoder();
  const txBytes = new Uint8Array(txEncoder.encode(partiallySigned));
  const signature = await feePayment.signAndSend(txBytes);

  const confirmation = await confirmTransaction(rpc, signature, {
    commitment: "confirmed",
  });

  if (confirmation.err) {
    throw new AppError("TRANSACTION_FAILED", "SOL transfer failed on-chain");
  }

  return {
    signature,
    slot: Number(confirmation.slot),
    blockTime: new Date().toISOString(),
    status: confirmation.confirmationStatus === "finalized" ? "finalized" : "confirmed",
  };
}

async function prepareSplTransfer(
  c: AppContext,
  sourceAddress: Address,
  destinationAddress: Address,
  mintAddress: Address,
  amount: string
): Promise<{ serializedTx: string; blockhash: string; lastValidBlockHeight: string }> {
  const rpc = createRpc(c.env);
  const tokenProgram = await resolveMintTokenProgram(rpc, mintAddress);
  const sourceTokenAccount = await resolveSourceTokenAccount(
    rpc,
    sourceAddress,
    mintAddress,
    tokenProgram
  );
  const transferAmount = parseDecimalAmount(amount, sourceTokenAccount.decimals);

  if (transferAmount <= 0n) {
    throw new AppError("BAD_REQUEST", "Transfer amount must be greater than zero");
  }

  const [destinationTokenAccount] = await findAssociatedTokenPda({
    owner: destinationAddress,
    tokenProgram,
    mint: mintAddress,
  });
  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc, "confirmed");
  const feePayer = await getSponsoredFeePayer(c);
  const feePayerSigner = createNoopSigner(feePayer);

  const createDestinationAtaInstruction = getCreateAssociatedTokenIdempotentInstruction({
    payer: feePayerSigner,
    ata: destinationTokenAccount,
    owner: destinationAddress,
    mint: mintAddress,
    tokenProgram,
  });
  const transferInstruction = getTransferCheckedInstruction(
    {
      source: sourceTokenAccount.tokenAccount,
      mint: mintAddress,
      destination: destinationTokenAccount,
      authority: createNoopSigner(sourceAddress),
      amount: transferAmount,
      decimals: sourceTokenAccount.decimals,
    },
    { programAddress: tokenProgram }
  );

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) =>
      appendTransactionMessageInstructions(
        [createDestinationAtaInstruction, transferInstruction],
        m
      )
  );

  const compiled = compileTransaction(message);

  return {
    serializedTx: getBase64EncodedWireTransaction(compiled),
    blockhash: blockhash as string,
    lastValidBlockHeight: lastValidBlockHeight.toString(),
  };
}

async function executeSplTransfer(
  c: AppContext,
  sourceWallet: CustodyWallet,
  destinationAddress: Address,
  mintAddress: Address,
  amount: string
): Promise<{
  signature: string;
  slot: number | null;
  blockTime: string | null;
  status: TransferRow["status"];
}> {
  const auth = getAuth(c);
  const signer = await createOrgSigner(
    c.env,
    auth.organizationId,
    auth.projectId ?? undefined,
    sourceWallet.walletId
  );

  if (signer.address !== sourceWallet.publicKey) {
    throw new AppError("BAD_REQUEST", "Resolved signing wallet does not match source wallet");
  }

  const rpc = createRpc(c.env);
  const tokenProgram = await resolveMintTokenProgram(rpc, mintAddress);
  const sourceTokenAccount = await resolveSourceTokenAccount(
    rpc,
    signer.address,
    mintAddress,
    tokenProgram
  );
  const transferAmount = parseDecimalAmount(amount, sourceTokenAccount.decimals);

  if (transferAmount <= 0n) {
    throw new AppError("BAD_REQUEST", "Transfer amount must be greater than zero");
  }

  const [destinationTokenAccount] = await findAssociatedTokenPda({
    owner: destinationAddress,
    tokenProgram,
    mint: mintAddress,
  });
  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc, "confirmed");
  const feePayment = getFeePayment(c);
  const feePayer = await feePayment.getFeePayer();
  const feePayerSigner = createNoopSigner(feePayer);

  const createDestinationAtaInstruction = getCreateAssociatedTokenIdempotentInstruction({
    payer: feePayerSigner,
    ata: destinationTokenAccount,
    owner: destinationAddress,
    mint: mintAddress,
    tokenProgram,
  });
  const transferInstruction = getTransferCheckedInstruction(
    {
      source: sourceTokenAccount.tokenAccount,
      mint: mintAddress,
      destination: destinationTokenAccount,
      authority: signer,
      amount: transferAmount,
      decimals: sourceTokenAccount.decimals,
    },
    { programAddress: tokenProgram }
  );

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) =>
      appendTransactionMessageInstructions(
        [createDestinationAtaInstruction, transferInstruction],
        m
      ),
    (m) => addSignersToTransactionMessage([signer], m)
  );

  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
  const txEncoder = getTransactionEncoder();
  const txBytes = new Uint8Array(txEncoder.encode(partiallySigned));
  const signature = await feePayment.signAndSend(txBytes);

  const confirmation = await confirmTransaction(rpc, signature, {
    commitment: "confirmed",
  });

  if (confirmation.err) {
    throw new AppError("TRANSACTION_FAILED", "SPL token transfer failed on-chain");
  }

  return {
    signature,
    slot: Number(confirmation.slot),
    blockTime: new Date().toISOString(),
    status: confirmation.confirmationStatus === "finalized" ? "finalized" : "confirmed",
  };
}

function mapOnChainTransfer(input: {
  row: ScopedSignatureRow;
  tx: unknown | null;
  organizationId: string;
  projectId: string | null;
  ownedAddresses: Set<string>;
}) {
  const details = inferTransferFromTransaction(input.tx, {
    queriedAddress: input.row.queriedAddress,
    ownedAddresses: new Set(input.ownedAddresses),
  });
  const parsedTx = (input.tx ?? {}) as {
    slot?: number | bigint;
    blockTime?: number | null;
    meta?: { err?: unknown };
  };
  const blockTimeIso =
    unixSecondsToIso(parsedTx.blockTime) ??
    unixSecondsToIso(input.row.blockTime) ??
    new Date().toISOString();
  const token = details.token ? normalizeTransferToken(details.token) : undefined;

  return {
    id: input.row.signature,
    organizationId: input.organizationId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    type: details.type,
    direction: details.direction,
    status: mapSignatureStatusToTransferStatus(input.row),
    signature: input.row.signature,
    serializedTx: null,
    slot: slotToNumber(parsedTx.slot) ?? slotToNumber(input.row.slot),
    blockTime: unixSecondsToIso(parsedTx.blockTime) ?? unixSecondsToIso(input.row.blockTime),
    fee: details.fee ?? null,
    error: input.row.err ? JSON.stringify(input.row.err) : null,
    ...(details.source ? { source: details.source } : {}),
    ...(details.destination ? { destination: details.destination } : {}),
    ...(token ? { token } : {}),
    ...(details.amount ? { amount: details.amount } : {}),
    createdAt: blockTimeIso,
    updatedAt: blockTimeIso,
  };
}
export async function getWalletBalances(c: AppContext) {
  const { wallet } = await resolveWalletFromParams(c);

  const rpc = createRpc(c.env);
  const accountInfo = await getAccountInfo(rpc, wallet.publicKey as Address);
  const splBalances = await getSplTokenBalances(rpc, wallet.publicKey as Address);

  const lamports = accountInfo?.lamports ?? 0n;

  const payload = {
    walletId: wallet.walletId,
    address: wallet.publicKey,
    balances: [
      {
        token: "SOL",
        mint: SOL_MINT,
        amount: lamports.toString(),
        uiAmount: formatDecimalAmount(lamports, 9),
        decimals: 9,
      },
      ...splBalances,
    ],
  };

  return success(c, { walletBalances: payload });
}

export async function getWalletPolicy(c: AppContext) {
  const { wallet } = await resolveWalletFromParams(c);
  const repository = getPaymentsRepository(c);

  const rows = await repository.getWalletPoliciesByCustodyWalletId(wallet.id);
  const payload = buildWalletPolicyPayload(wallet.walletId, rows, wallet.createdAt);

  return success(c, { policy: payload });
}

export async function updateWalletPolicy(c: AppContext) {
  const { wallet } = await resolveWalletFromParams(c);
  const repository = getPaymentsRepository(c);

  const body = await c.req.json();
  const parsed = updateWalletPolicySchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const now = new Date().toISOString();
  const rows = await repository.upsertWalletPolicies([
    {
      id: `pwp_${crypto.randomUUID()}`,
      custodyWalletId: wallet.id,
      policyType: DESTINATION_ALLOWLIST_POLICY_TYPE,
      policy: JSON.stringify({
        version: PAYMENT_POLICY_VERSION,
        destinationAllowlist: parsed.data.destinationAllowlist,
      }),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: `pwp_${crypto.randomUUID()}`,
      custodyWalletId: wallet.id,
      policyType: TRANSFER_LIMITS_POLICY_TYPE,
      policy: JSON.stringify({
        version: PAYMENT_POLICY_VERSION,
        maxTransferAmount: parsed.data.maxTransferAmount ?? null,
        maxDailyAmount: parsed.data.maxDailyAmount ?? null,
      }),
      createdAt: now,
      updatedAt: now,
    },
  ]);

  if (rows.length === 0) {
    throw new AppError("INTERNAL_ERROR", "Failed to persist wallet policy");
  }

  const payload = buildWalletPolicyPayload(wallet.walletId, rows, now);

  return success(c, { policy: payload });
}

export async function prepareTransfer(c: AppContext) {
  const body = await c.req.json();
  const parsed = prepareTransferSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const scope = await resolveScope(c);
  assertProjectContext(parsed.data.projectId, scope.auth.projectId);

  const sourceWallet = resolveWallet(scope.wallets, parsed.data.source);
  const sourceAddress = assertValidAddress(sourceWallet.publicKey, "source");
  const destinationAddress = assertValidAddress(parsed.data.destination, "destination");
  const transferToken = isNativeSolToken(parsed.data.token) ? "SOL" : parsed.data.token;

  await assertWalletPolicyAllowsTransfer(c, {
    organizationId: scope.auth.organizationId,
    projectId: scope.auth.projectId,
    wallet: sourceWallet,
    destinationAddress,
    token: transferToken,
    amount: parsed.data.amount,
  });

  let prepared: { serializedTx: string; blockhash: string; lastValidBlockHeight: string };

  if (transferToken === "SOL") {
    prepared = await prepareSolTransfer(c, sourceAddress, destinationAddress, parsed.data.amount);
  } else {
    const mintAddress = assertValidAddress(parsed.data.token, "token");
    prepared = await prepareSplTransfer(
      c,
      sourceAddress,
      destinationAddress,
      mintAddress,
      parsed.data.amount
    );
  }

  await createTransferRecord(c, {
    organizationId: scope.auth.organizationId,
    projectId: scope.auth.projectId,
    walletId: sourceWallet.walletId,
    sourceAddress: sourceWallet.publicKey,
    destinationAddress: parsed.data.destination,
    token: transferToken,
    amount: parsed.data.amount,
    memo: parsed.data.memo,
    status: "pending",
    serializedTx: prepared.serializedTx,
    initiatedByKeyId: scope.auth.id,
  });

  let simulation:
    | { success: boolean; logs: string[]; unitsConsumed: string | null; error: string | null }
    | undefined;
  if (parsed.data.options?.simulate) {
    const rpc = createRpc(c.env);
    const txBytes = Buffer.from(prepared.serializedTx, "base64");
    const simulated = await simulateTransaction(rpc, txBytes);
    simulation = {
      success: simulated.success,
      logs: simulated.logs,
      unitsConsumed: simulated.unitsConsumed ? simulated.unitsConsumed.toString() : null,
      error: simulated.error,
    };
  }

  return success(c, {
    preparedTransaction: {
      serialized: prepared.serializedTx,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    },
    ...(simulation ? { simulation } : {}),
  });
}

export async function createTransfer(c: AppContext) {
  const body = await c.req.json();
  const parsed = createTransferSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const scope = await resolveScope(c);
  assertProjectContext(parsed.data.projectId, scope.auth.projectId);

  const sourceWallet = resolveWallet(scope.wallets, parsed.data.source);
  const destinationAddress = assertValidAddress(parsed.data.destination, "destination");
  const transferToken = normalizeTransferToken(parsed.data.token);

  await assertWalletPolicyAllowsTransfer(c, {
    organizationId: scope.auth.organizationId,
    projectId: scope.auth.projectId,
    wallet: sourceWallet,
    destinationAddress,
    token: transferToken,
    amount: parsed.data.amount,
  });

  const transfer = await createTransferRecord(c, {
    organizationId: scope.auth.organizationId,
    projectId: scope.auth.projectId,
    walletId: sourceWallet.walletId,
    sourceAddress: sourceWallet.publicKey,
    destinationAddress: parsed.data.destination,
    token: transferToken,
    amount: parsed.data.amount,
    memo: parsed.data.memo,
    status: "processing",
    initiatedByKeyId: scope.auth.id,
  });

  try {
    let executionResult: {
      signature: string;
      slot: number | null;
      blockTime: string | null;
      status: TransferRow["status"];
    };
    if (isNativeSolToken(parsed.data.token)) {
      executionResult = await executeSolTransfer(
        c,
        sourceWallet,
        destinationAddress,
        parsed.data.amount
      );
    } else {
      const mintAddress = assertValidAddress(parsed.data.token, "token");
      executionResult = await executeSplTransfer(
        c,
        sourceWallet,
        destinationAddress,
        mintAddress,
        parsed.data.amount
      );
    }

    const updated = await updateTransferRecord(c, transfer.id, {
      status: executionResult.status,
      signature: executionResult.signature,
      slot: executionResult.slot,
      blockTime: executionResult.blockTime,
      error: null,
    });

    return success(c, { transfer: mapTransferRow(updated) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown transfer error";
    await updateTransferRecord(c, transfer.id, {
      status: "failed",
      error: message,
      blockTime: new Date().toISOString(),
    });

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError("SOLANA_RPC_ERROR", message);
  }
}

export async function listTransfers(c: AppContext) {
  const parsed = listTransfersQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid query parameters", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const scope = await resolveScope(c);
  const { wallet, walletAddress, token, direction, status, from, to, page, pageSize } = parsed.data;
  const ownedWalletAddresses = new Set(scope.wallets.map((entry) => entry.publicKey));

  const selectedWalletAddresses = new Set<string>();
  if (wallet) {
    selectedWalletAddresses.add(resolveWallet(scope.wallets, wallet).publicKey);
  }
  if (walletAddress) {
    const validated = assertValidAddress(walletAddress, "walletAddress");
    if (!ownedWalletAddresses.has(validated)) {
      throw new AppError("BAD_REQUEST", "walletAddress does not belong to this organization");
    }
    selectedWalletAddresses.add(validated);
  }
  if (!wallet && !walletAddress) {
    for (const w of scope.wallets) selectedWalletAddresses.add(w.publicKey);
  }

  const addressList = Array.from(selectedWalletAddresses);
  if (addressList.length === 0) {
    return paginated(c, [], { total: 0, page, pageSize });
  }

  const rpc = createRpc(c.env);
  let merged = await listScopedSignaturesForAddresses(rpc, addressList, { from, to });

  if (status) {
    merged = merged.filter((row) => mapSignatureStatusToTransferStatus(row) === status);
  }

  const buildTransfers = async (rows: ScopedSignatureRow[]) => {
    if (rows.length === 0) {
      return [];
    }

    const txBySignature = await getTransactionsJsonParsedBatch({
      env: c.env,
      rpc,
      signatures: rows.map((row) => row.signature),
    });

    const transfers = rows.map((row) =>
      mapOnChainTransfer({
        row,
        tx: txBySignature.get(row.signature) ?? null,
        organizationId: scope.auth.organizationId,
        projectId: scope.auth.projectId,
        ownedAddresses: ownedWalletAddresses,
      })
    );

    return transfers;
  };

  const normalizedToken = token ? normalizeTransferToken(token) : undefined;
  const requiresHydratedFiltering = normalizedToken !== undefined || direction !== undefined;

  if (requiresHydratedFiltering) {
    const transfers = await buildTransfers(merged);
    const fullyFiltered = transfers.filter((transfer) => {
      if (normalizedToken && transfer.token !== normalizedToken) {
        return false;
      }
      if (direction && transfer.direction !== direction) {
        return false;
      }
      return true;
    });

    const total = fullyFiltered.length;
    const offset = (page - 1) * pageSize;
    const paged = fullyFiltered.slice(offset, offset + pageSize);
    return paginated(c, paged, { total, page, pageSize });
  }

  const total = merged.length;
  const offset = (page - 1) * pageSize;
  const rows = merged.slice(offset, offset + pageSize);
  const transfers = await buildTransfers(rows);
  return paginated(c, transfers, { total, page, pageSize });
}

export async function getTransfer(c: AppContext) {
  const params = transferIdParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw new AppError("BAD_REQUEST", "Invalid transfer ID");
  }

  const transferId = params.data.transferId;
  const auth = getAuth(c);

  if (transferId.startsWith("xfr_")) {
    const row = await getTransferRowById(c, transferId, auth.organizationId, auth.projectId);

    if (!row) {
      throw new AppError("NOT_FOUND", "Transfer not found");
    }

    return success(c, { transfer: mapTransferRow(row) });
  }

  const scope = await resolveScope(c);
  const rpc = createRpc(c.env);

  const tx = await getTransactionJsonParsed(rpc, transferId);

  if (!tx) {
    throw new AppError("NOT_FOUND", "Transfer not found");
  }

  const ownedAddresses = new Set(scope.wallets.map((wallet) => wallet.publicKey));
  if (!touchesOwnedWallet(tx, ownedAddresses)) {
    throw new AppError("NOT_FOUND", "Transfer not found");
  }

  const details = inferTransferFromTransaction(tx, {
    ownedAddresses: new Set(ownedAddresses),
  });
  const parsedTx = tx as {
    slot?: number | bigint;
    blockTime?: number | null;
    meta?: { err?: unknown };
  };
  const normalizedToken = details.token ? normalizeTransferToken(details.token) : undefined;
  const blockTimeIso = unixSecondsToIso(parsedTx.blockTime) ?? new Date().toISOString();
  const transferStatus = mapSignatureStatusToTransferStatus({
    err: parsedTx.meta?.err,
    confirmationStatus: "confirmed",
  });

  return success(c, {
    transfer: {
      id: transferId,
      organizationId: scope.auth.organizationId,
      ...(scope.auth.projectId ? { projectId: scope.auth.projectId } : {}),
      type: details.type,
      direction: details.direction,
      status: transferStatus,
      signature: transferId,
      serializedTx: null,
      slot: slotToNumber(parsedTx.slot),
      blockTime: unixSecondsToIso(parsedTx.blockTime),
      fee: details.fee ?? null,
      error: parsedTx.meta?.err ? JSON.stringify(parsedTx.meta.err) : null,
      ...(details.source ? { source: details.source } : {}),
      ...(details.destination ? { destination: details.destination } : {}),
      ...(normalizedToken ? { token: normalizedToken } : {}),
      ...(details.amount ? { amount: details.amount } : {}),
      createdAt: blockTimeIso,
      updatedAt: blockTimeIso,
    },
  });
}
