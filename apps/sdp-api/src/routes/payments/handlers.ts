import { createD1Drizzle } from "@/db/drizzle";
import type {
  PaymentTransferDirection as TransferDirection,
  PaymentTransferRow as TransferRow,
  PaymentTransferStatus as TransferStatus,
  PaymentTransferType as TransferType,
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
import { withHeliusApiKey } from "@/services/rpc-relay.service";
import { createOrgSigner } from "@/services/solana";
import {
  confirmTransaction,
  createRpc,
  getAccountInfo,
  getRecentBlockhash,
  getSignaturesForAddress,
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
  createTransferSchema,
  executeOfframpSchema,
  executeOnrampSchema,
  listTransfersQuerySchema,
  prepareTransferSchema,
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
const MOONPAY_ONRAMP_URL = "https://buy.moonpay.com";
const MOONPAY_OFFRAMP_URL = "https://sell.moonpay.com";
const MOONPAY_SANDBOX_ONRAMP_URL = "https://buy-sandbox.moonpay.com";
const MOONPAY_SANDBOX_OFFRAMP_URL = "https://sell-sandbox.moonpay.com";

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

  let destinationAllowlist: string[] = [];
  let maxTransferAmount: string | undefined;
  let maxDailyAmount: string | undefined;

  for (const row of rows) {
    if (row.policy_type === DESTINATION_ALLOWLIST_POLICY_TYPE) {
      destinationAllowlist = parseDestinationAllowlistPolicy(row.policy);
      continue;
    }

    if (row.policy_type === TRANSFER_LIMITS_POLICY_TYPE) {
      const parsed = parseTransferLimitsPolicy(row.policy);
      maxTransferAmount = parsed.maxTransferAmount;
      maxDailyAmount = parsed.maxDailyAmount;
    }
  }

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
    ...(maxTransferAmount ? { maxTransferAmount } : {}),
    ...(maxDailyAmount ? { maxDailyAmount } : {}),
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
    const amounts = await repository.listTransferAmounts({
      organizationId: input.organizationId,
      projectId: input.projectId,
      walletId: input.wallet.walletId,
      token: input.token,
      direction: "outbound",
      statuses: ["pending", "processing", "confirmed", "finalized"],
      createdAtFrom: dayWindow.start,
      createdAtTo: dayWindow.end,
    });

    const projectedTotal = addDecimalAmounts(sumDecimalAmounts(amounts), input.amount);
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
    throw new AppError(
      "NOT_FOUND",
      "Wallet not found. Provision wallets through /v1/custody/wallets"
    );
  }
  return wallet;
}

function resolveWalletAddress(
  wallets: CustodyWallet[],
  walletIdOrAddress: string,
  fieldName: string
): string {
  const matchingWallet = wallets.find((entry) => entry.walletId === walletIdOrAddress);
  if (matchingWallet) {
    return matchingWallet.publicKey;
  }
  return assertValidAddress(walletIdOrAddress, fieldName);
}

function normalizeMoonPayCurrencyCode(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(normalized)) {
    throw new AppError("BAD_REQUEST", "cryptoToken must be a valid MoonPay currency code");
  }
  return normalized;
}

type MoonPayConfig = {
  apiKey: string;
  secretKey: string;
  onrampUrl: string;
  offrampUrl: string;
};

function getMoonPayConfig(c: AppContext): MoonPayConfig {
  const apiKey = c.env.MOONPAY_API_KEY?.trim();
  const secretKey = c.env.MOONPAY_SECRET_KEY?.trim();

  if (!apiKey || !secretKey) {
    throw new AppError(
      "INTERNAL_ERROR",
      "MoonPay is not configured. Set MOONPAY_API_KEY and MOONPAY_SECRET_KEY."
    );
  }

  const useProduction = c.env.ENVIRONMENT === "production";
  const defaultOnrampUrl = useProduction ? MOONPAY_ONRAMP_URL : MOONPAY_SANDBOX_ONRAMP_URL;
  const defaultOfframpUrl = useProduction ? MOONPAY_OFFRAMP_URL : MOONPAY_SANDBOX_OFFRAMP_URL;

  const onrampUrlRaw = c.env.MOONPAY_ONRAMP_URL ?? defaultOnrampUrl;
  const offrampUrlRaw = c.env.MOONPAY_OFFRAMP_URL ?? defaultOfframpUrl;

  try {
    new URL(onrampUrlRaw);
    new URL(offrampUrlRaw);
  } catch {
    throw new AppError("INTERNAL_ERROR", "MoonPay URL configuration is invalid.");
  }

  return {
    apiKey,
    secretKey,
    onrampUrl: onrampUrlRaw,
    offrampUrl: offrampUrlRaw,
  };
}

async function createMoonPaySignature(unsignedQuery: string, secretKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(unsignedQuery));
  return Buffer.from(signature).toString("base64");
}

async function buildSignedMoonPayWidgetUrl(
  baseUrl: string,
  secretKey: string,
  params: Record<string, string | undefined>
): Promise<string> {
  const url = new URL(baseUrl);
  const sortedEntries = Object.entries(params).sort(([left], [right]) => left.localeCompare(right));

  for (const [key, value] of sortedEntries) {
    if (!value) {
      continue;
    }
    url.searchParams.set(key, value);
  }

  const signature = await createMoonPaySignature(url.search, secretKey);
  url.searchParams.set("signature", signature);

  return url.toString();
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
    type?: TransferType;
    direction?: TransferDirection;
    status?: TransferStatus;
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

async function updateTransferRecord(
  c: AppContext,
  transferId: string,
  patch: {
    status?: TransferStatus;
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
): Promise<{ signature: string; slot: number | null; blockTime: string | null }> {
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
    blockTime: null,
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
): Promise<{ signature: string; slot: number | null; blockTime: string | null }> {
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
    blockTime: null,
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

  // TODO: parsed.data.referenceAddress — attach as a memo/reference key to the transaction
  //       for Solana Pay compatibility and client-side correlation. Not yet implemented.
  // TODO: parsed.data.options?.priorityFee — add a compute budget instruction to the
  //       transaction based on the requested priority level. Not yet implemented.

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

  const transfer = await createTransferRecord(c, {
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
    transfer: mapTransferRow(transfer),
    preparedTransaction: {
      serialized: prepared.serializedTx,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    },
    ...(simulation ? { simulation } : {}),
  });
}

function createSignatureHistoryRpc(env: Env) {
  // Prefer Helius when configured for richer signature history (getSignaturesForAddress).
  // Falls back to the default RPC URL if Helius is not configured.
  //
  // TODO: Replace getSignaturesForAddress with a dedicated indexer (Helius webhooks,
  // Triton stream, or similar) for production-scale history and comprehensive inbound
  // transfer tracking. The current approach is limited to the most recent ~200 signatures.
  const url = env.SOLANA_RPC_HELIUS_URL
    ? withHeliusApiKey(env.SOLANA_RPC_HELIUS_URL, env.SOLANA_RPC_HELIUS_API_KEY)
    : env.SOLANA_RPC_URL;
  return createRpc(env, { rpcUrl: url });
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
  const transferToken = isNativeSolToken(parsed.data.token) ? "SOL" : parsed.data.token;

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
    if (transferToken === "SOL") {
      const solResult = await executeSolTransfer(
        c,
        sourceWallet,
        destinationAddress,
        parsed.data.amount
      );
      const updated = await updateTransferRecord(c, transfer.id, {
        status: "confirmed",
        signature: solResult.signature,
        slot: solResult.slot,
        blockTime: solResult.blockTime,
        error: null,
      });
      return success(c, { transfer: mapTransferRow(updated) });
    }

    const mintAddress = assertValidAddress(parsed.data.token, "token");
    const result = await executeSplTransfer(
      c,
      sourceWallet,
      destinationAddress,
      mintAddress,
      parsed.data.amount
    );

    const updated = await updateTransferRecord(c, transfer.id, {
      status: "confirmed",
      signature: result.signature,
      slot: result.slot,
      blockTime: result.blockTime,
      error: null,
    });

    return success(c, { transfer: mapTransferRow(updated) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown transfer error";
    await updateTransferRecord(c, transfer.id, {
      status: "failed",
      error: message,
      blockTime: null,
    });

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError("SOLANA_RPC_ERROR", message);
  }
}

export async function listTransfers(c: AppContext) {
  const auth = getAuth(c);
  const query = listTransfersQuerySchema.safeParse(c.req.query());
  if (!query.success) throw new AppError("BAD_REQUEST", "Invalid query parameters");

  const {
    page,
    pageSize,
    wallet: walletId,
    walletAddress,
    token,
    direction,
    status,
    from,
    to,
  } = query.data;
  const repo = getPaymentsRepository(c);
  const offset = (page - 1) * pageSize;

  let transferRows: TransferRow[];
  let total: number;

  if (walletId || walletAddress) {
    // Helius-backed path: fetch on-chain signatures for the wallet address, then
    // cross-reference with our DB. Append pending/processing/failed from DB (not on-chain yet).
    //
    // TODO: Replace getSignaturesForAddress with a dedicated indexer for production use.

    let sourceAddress: string | undefined;
    let resolvedWalletId: string | undefined;

    if (walletId) {
      const scope = await resolveScope(c);
      const wallet = resolveWallet(scope.wallets, walletId);
      sourceAddress = wallet.publicKey;
      resolvedWalletId = walletId;
    } else {
      sourceAddress = walletAddress;
    }

    // 1. Fetch on-chain signature history via Helius (or fallback RPC)
    const heliusRpc = createSignatureHistoryRpc(c.env);
    const onChainSigs = await getSignaturesForAddress(heliusRpc, sourceAddress as Address, {
      limit: Math.min(pageSize * 5, 200),
      commitment: "confirmed",
    });
    const sigStrings = onChainSigs.map((s) => String(s.signature));

    // 2. Look up on-chain signatures in our DB
    const confirmedRows = await repo.listTransfersBySignatures({
      signatures: sigStrings,
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    // 3. Fetch pending/processing/failed from DB (not yet on-chain).
    //    Skip if the caller's status filter already excludes these — e.g. status=confirmed
    //    or status=finalized would never match any of these records.
    const nonChainStatuses: TransferStatus[] = ["pending", "processing", "failed"];
    const needsNonChainRecords = !status || nonChainStatuses.includes(status);
    const pendingRows: TransferRow[] = [];
    if (needsNonChainRecords) {
      const pendingResult = await repo.listTransfers({
        organizationId: auth.organizationId,
        projectId: auth.projectId,
        walletId: resolvedWalletId,
        sourceAddress: resolvedWalletId ? undefined : walletAddress,
        statuses: nonChainStatuses,
        token,
        direction,
        createdAtFrom: from,
        createdAtTo: to,
        limit: 100,
        offset: 0,
      });
      pendingRows.push(...pendingResult.rows);
    }

    // 4. Merge: confirmed (Helius-backed) + non-confirmed (DB), deduplicated
    const seen = new Set<string>();
    const merged = [...confirmedRows, ...pendingRows].filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });

    // 5. Apply remaining filters and sort
    const filtered = merged
      .filter((row) => {
        if (status && row.status !== status) return false;
        if (token && row.token !== token) return false;
        if (direction && row.direction !== direction) return false;
        return true;
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    total = filtered.length;
    transferRows = filtered.slice(offset, offset + pageSize);
  } else {
    // DB-only path for org-scoped queries without a specific wallet
    const result = await repo.listTransfers({
      organizationId: auth.organizationId,
      projectId: auth.projectId,
      token,
      direction,
      statuses: status ? [status] : undefined,
      createdAtFrom: from,
      createdAtTo: to,
      limit: pageSize,
      offset,
    });
    total = result.total;
    transferRows = result.rows;
  }

  const transfers = transferRows.map(mapTransferRow);
  return paginated(c, transfers, { total, page, pageSize });
}

export async function getTransfer(c: AppContext) {
  const auth = getAuth(c);
  const transferId = c.req.param("transferId");
  const repo = getPaymentsRepository(c);

  const row = await repo.getTransferById({
    transferId,
    organizationId: auth.organizationId,
    projectId: auth.projectId,
  });

  if (!row) throw new AppError("NOT_FOUND", "Transfer not found");

  return success(c, { transfer: mapTransferRow(row) });
}

export async function executeOnramp(c: AppContext) {
  const body = await c.req.json();
  const parsed = executeOnrampSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const scope = await resolveScope(c);
  const destinationWalletAddress = resolveWalletAddress(
    scope.wallets,
    parsed.data.destinationWallet,
    "destinationWallet"
  );
  const moonPay = getMoonPayConfig(c);

  const redirectUrl = await buildSignedMoonPayWidgetUrl(moonPay.onrampUrl, moonPay.secretKey, {
    apiKey: moonPay.apiKey,
    baseCurrencyCode: "usd",
    baseCurrencyAmount: parsed.data.fiatAmount,
    currencyCode: normalizeMoonPayCurrencyCode(parsed.data.cryptoToken),
    walletAddress: destinationWalletAddress,
    redirectURL: parsed.data.redirectUrl,
    externalCustomerId: parsed.data.kycReference,
    externalTransactionId: `sdp_onramp_${crypto.randomUUID()}`,
  });

  return success(c, {
    ramp: {
      id: `ramp_${crypto.randomUUID()}`,
      status: "pending",
      redirectUrl,
    },
  });
}

export async function executeOfframp(c: AppContext) {
  const body = await c.req.json();
  const parsed = executeOfframpSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const scope = await resolveScope(c);
  const sourceWalletAddress = resolveWalletAddress(
    scope.wallets,
    parsed.data.sourceWallet,
    "sourceWallet"
  );
  const moonPay = getMoonPayConfig(c);
  const externalTransactionId = `sdp_offramp_${crypto.randomUUID()}`;

  const redirectUrl = await buildSignedMoonPayWidgetUrl(moonPay.offrampUrl, moonPay.secretKey, {
    apiKey: moonPay.apiKey,
    baseCurrencyCode: normalizeMoonPayCurrencyCode(parsed.data.cryptoToken),
    baseCurrencyAmount: parsed.data.cryptoAmount,
    quoteCurrencyCode: "usd",
    walletAddress: sourceWalletAddress,
    refundWalletAddress: sourceWalletAddress,
    redirectURL: parsed.data.redirectUrl,
    externalCustomerId: parsed.data.kycReference,
    externalTransactionId,
  });

  return success(c, {
    ramp: {
      id: `ramp_${crypto.randomUUID()}`,
      status: "pending",
      redirectUrl,
      reference: externalTransactionId,
    },
  });
}
