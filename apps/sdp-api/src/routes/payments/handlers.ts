import { createD1Drizzle } from "@/db/drizzle";
import type {
  PaymentTransferDirection as TransferDirection,
  PaymentTransferRow as TransferRow,
  PaymentTransferStatus as TransferStatus,
  PaymentTransferType as TransferType,
  PaymentWalletPolicyRow as WalletPolicyRow,
} from "@/db/repositories/payments.repository";
import { createD1PaymentsRepository } from "@/db/repositories/payments.repository.d1";
import { formatDecimalAmount, parseDecimalAmount } from "@/lib/amount";
import { getAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { paginated, success } from "@/lib/response";
import { assertValidAddress } from "@/lib/solana";
import { createFeePaymentAdapter } from "@/services/adapters/fee-payment";
import { createSigningService } from "@/services/domain/signing.service";
import { createMosaicService } from "@/services/mosaic";
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
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import type { Context } from "hono";
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

type SignatureStatusRow = {
  signature: string;
  slot: number;
  err: unknown;
  confirmationStatus?: string | null;
  blockTime?: number | null;
};

type SignaturesForAddressRpc = {
  getSignaturesForAddress: (
    address: string,
    options: { limit: number; commitment: "confirmed" }
  ) => {
    send: () => Promise<SignatureStatusRow[]>;
  };
};

async function getSignaturesForAddressConfirmed(
  rpc: ReturnType<typeof createRpc>,
  address: string,
  limit: number
): Promise<SignatureStatusRow[]> {
  return (rpc as unknown as SignaturesForAddressRpc)
    .getSignaturesForAddress(address, { limit, commitment: "confirmed" })
    .send();
}

type TransactionBySignatureRpc = {
  getTransaction: (
    signature: string,
    options: {
      commitment: "confirmed";
      maxSupportedTransactionVersion: number;
      encoding: "jsonParsed";
    }
  ) => { send: () => Promise<unknown> };
};

async function getTransactionJsonParsed(
  rpc: ReturnType<typeof createRpc>,
  signature: string
): Promise<unknown> {
  return (rpc as unknown as TransactionBySignatureRpc)
    .getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
      encoding: "jsonParsed",
    })
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

async function getTransferRowById(
  c: AppContext,
  transferId: string,
  organizationId: string,
  projectId: string | null
): Promise<TransferRow | null> {
  const repository = getPaymentsRepository(c);
  return repository.getTransferById({ transferId, organizationId, projectId });
}

async function getTransferRowBySignature(
  c: AppContext,
  signature: string,
  organizationId: string,
  projectId: string | null
): Promise<TransferRow | null> {
  const repository = getPaymentsRepository(c);
  return repository.getTransferBySignature({ signature, organizationId, projectId });
}

async function getTransferRowsBySignatures(
  c: AppContext,
  signatures: string[],
  organizationId: string,
  projectId: string | null
): Promise<Map<string, TransferRow>> {
  const repository = getPaymentsRepository(c);
  const rows = await repository.listTransfersBySignatures({
    signatures,
    organizationId,
    projectId,
  });

  const bySignature = new Map<string, TransferRow>();
  for (const row of rows) {
    if (row.signature) {
      bySignature.set(row.signature, row);
    }
  }

  return bySignature;
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
  const feePayer = c.env.KORA_RPC_URL
    ? await createFeePaymentAdapter(c.env).getFeePayer()
    : sourceAddress;

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
  const feePayment = c.env.KORA_RPC_URL ? createFeePaymentAdapter(c.env) : undefined;
  const feePayer = feePayment ? await feePayment.getFeePayer() : undefined;

  const instruction = getTransferSolInstruction({
    source: signer,
    destination: destinationAddress,
    amount: lamports,
  });

  const message = feePayment
    ? pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(feePayer as Address, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
        (m) => appendTransactionMessageInstructions([instruction], m),
        (m) => addSignersToTransactionMessage([signer], m)
      )
    : pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(signer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
        (m) => appendTransactionMessageInstructions([instruction], m),
        (m) => addSignersToTransactionMessage([signer], m)
      );

  const signature = feePayment
    ? await (async () => {
        const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
        const txEncoder = getTransactionEncoder();
        const txBytes = new Uint8Array(txEncoder.encode(partiallySigned));
        return feePayment.signAndSend(txBytes);
      })()
    : await (async () => {
        const signed = await signTransactionMessageWithSigners(message);
        const encoded = getBase64EncodedWireTransaction(signed);
        return rpc
          .sendTransaction(encoded, {
            encoding: "base64",
          })
          .send();
      })();

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
  };
}

function mapOnChainStatus(input: { confirmationStatus?: string | null; err?: unknown }) {
  if (input.err) return "failed" as const;
  if (input.confirmationStatus === "finalized") return "finalized" as const;
  if (input.confirmationStatus === "processed") return "processing" as const;
  return "confirmed" as const;
}

function unixSecondsToIso(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number") return null;
  return new Date(seconds * 1000).toISOString();
}

function coerceInstructionInfoValue(value: unknown): string | number | null {
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function inferOnChainTransferDetails(
  tx: unknown,
  queriedAddress: string
): {
  type: "transfer" | "transfer_confidential";
  direction: "inbound" | "outbound";
  source?: string;
  destination?: string;
  token?: string;
  amount?: string;
  fee?: number | null;
} {
  const candidate = tx as {
    meta?: { fee?: number };
    transaction?: {
      message?: {
        instructions?: Array<{
          parsed?: { type?: string; info?: Record<string, unknown> };
        }>;
      };
    };
  };

  const instructions = candidate.transaction?.message?.instructions ?? [];
  for (const instruction of instructions) {
    const parsed = instruction.parsed;
    if (!parsed?.info) continue;

    const sourceRaw = coerceInstructionInfoValue(parsed.info.source);
    const destinationRaw = coerceInstructionInfoValue(parsed.info.destination);
    const authorityRaw = coerceInstructionInfoValue(parsed.info.authority);
    const mintRaw = coerceInstructionInfoValue(parsed.info.mint);
    const lamportsRaw = coerceInstructionInfoValue(parsed.info.lamports);
    const amountRaw = coerceInstructionInfoValue(parsed.info.amount);
    const tokenAmountUiRaw =
      typeof parsed.info.tokenAmount === "object" && parsed.info.tokenAmount !== null
        ? coerceInstructionInfoValue(
            (parsed.info.tokenAmount as Record<string, unknown>).uiAmountString
          )
        : null;

    const source = typeof sourceRaw === "string" ? sourceRaw : undefined;
    const destination = typeof destinationRaw === "string" ? destinationRaw : undefined;
    const authority = typeof authorityRaw === "string" ? authorityRaw : undefined;

    const direction =
      source === queriedAddress || authority === queriedAddress ? "outbound" : "inbound";

    if (typeof lamportsRaw === "number" || typeof lamportsRaw === "string") {
      const lamports = BigInt(lamportsRaw);
      return {
        type: "transfer",
        direction,
        source,
        destination,
        token: "SOL",
        amount: formatDecimalAmount(lamports, 9),
        fee: candidate.meta?.fee ?? null,
      };
    }

    if (source || destination || authority) {
      return {
        type: parsed.type?.toLowerCase().includes("confidential")
          ? "transfer_confidential"
          : "transfer",
        direction,
        source: source ?? authority,
        destination,
        token: typeof mintRaw === "string" ? mintRaw : undefined,
        amount:
          typeof tokenAmountUiRaw === "string"
            ? tokenAmountUiRaw
            : typeof amountRaw === "string" || typeof amountRaw === "number"
              ? String(amountRaw)
              : undefined,
        fee: candidate.meta?.fee ?? null,
      };
    }
  }

  return {
    type: "transfer",
    direction: "outbound",
    fee: candidate.meta?.fee ?? null,
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

  let prepared: { serializedTx: string; blockhash: string; lastValidBlockHeight: string };

  if (isNativeSolToken(parsed.data.token)) {
    prepared = await prepareSolTransfer(c, sourceAddress, destinationAddress, parsed.data.amount);
  } else {
    const mintAddress = assertValidAddress(parsed.data.token, "token");
    const signer = await createOrgSigner(
      c.env,
      scope.auth.organizationId,
      scope.auth.projectId ?? undefined,
      sourceWallet.walletId
    );

    const mosaic = createMosaicService(c.env, signer);
    const preparedTokenTransfer = await mosaic.prepareTransfer({
      mint: mintAddress,
      from: sourceAddress,
      to: destinationAddress,
      amount: parsed.data.amount,
      memo: parsed.data.memo,
      authority: signer.address,
      feePayer: signer.address,
    });

    prepared = {
      serializedTx: preparedTokenTransfer.serializedTx,
      blockhash: preparedTokenTransfer.blockhash,
      lastValidBlockHeight: preparedTokenTransfer.lastValidBlockHeight.toString(),
    };
  }

  const transfer = await createTransferRecord(c, {
    organizationId: scope.auth.organizationId,
    projectId: scope.auth.projectId,
    walletId: sourceWallet.walletId,
    sourceAddress: sourceWallet.publicKey,
    destinationAddress: parsed.data.destination,
    token: isNativeSolToken(parsed.data.token) ? "SOL" : parsed.data.token,
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
  const sourceAddress = assertValidAddress(sourceWallet.publicKey, "source");
  const destinationAddress = assertValidAddress(parsed.data.destination, "destination");

  const transfer = await createTransferRecord(c, {
    organizationId: scope.auth.organizationId,
    projectId: scope.auth.projectId,
    walletId: sourceWallet.walletId,
    sourceAddress: sourceWallet.publicKey,
    destinationAddress: parsed.data.destination,
    token: isNativeSolToken(parsed.data.token) ? "SOL" : parsed.data.token,
    amount: parsed.data.amount,
    memo: parsed.data.memo,
    status: "processing",
    initiatedByKeyId: scope.auth.id,
  });

  try {
    if (isNativeSolToken(parsed.data.token)) {
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
    const signer = await createOrgSigner(
      c.env,
      scope.auth.organizationId,
      scope.auth.projectId ?? undefined,
      sourceWallet.walletId
    );

    const mosaic = createMosaicService(c.env, signer);
    const result = await mosaic.transfer({
      mint: mintAddress,
      from: sourceAddress,
      to: destinationAddress,
      amount: parsed.data.amount,
      memo: parsed.data.memo,
      authority: signer,
      feePayer: signer,
    });

    const updated = await updateTransferRecord(c, transfer.id, {
      status: "confirmed",
      signature: result.signature,
      slot: Number(result.slot),
      blockTime: new Date().toISOString(),
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

  const selectedWalletAddresses = new Set<string>();
  if (wallet) {
    selectedWalletAddresses.add(resolveWallet(scope.wallets, wallet).publicKey);
  }
  if (walletAddress) {
    selectedWalletAddresses.add(assertValidAddress(walletAddress, "walletAddress"));
  }
  if (!wallet && !walletAddress) {
    for (const w of scope.wallets) selectedWalletAddresses.add(w.publicKey);
  }

  const addressList = Array.from(selectedWalletAddresses);
  if (addressList.length === 0) {
    return paginated(c, [], { total: 0, page, pageSize });
  }

  const rpc = createRpc(c.env);
  const fetchLimit = Math.min(1000, page * pageSize + 200);

  const signatureRows = await Promise.all(
    addressList.map(async (address) => {
      const rows = await getSignaturesForAddressConfirmed(rpc, address, fetchLimit);

      return rows.map((row) => ({ ...row, queriedAddress: address }));
    })
  );

  const bySignature = new Map<
    string,
    {
      signature: string;
      slot: number;
      err: unknown;
      confirmationStatus?: string | null;
      blockTime?: number | null;
      queriedAddress: string;
    }
  >();

  for (const rows of signatureRows) {
    for (const row of rows) {
      if (!bySignature.has(row.signature)) {
        bySignature.set(row.signature, row);
      }
    }
  }

  let merged = Array.from(bySignature.values());
  merged.sort((a, b) => b.slot - a.slot);

  if (status) {
    merged = merged.filter((row) => mapOnChainStatus(row) === status);
  }
  if (from) {
    const minDate = Date.parse(from);
    merged = merged.filter((row) => {
      const iso = unixSecondsToIso(row.blockTime);
      return iso ? Date.parse(iso) >= minDate : false;
    });
  }
  if (to) {
    const maxDate = Date.parse(to);
    merged = merged.filter((row) => {
      const iso = unixSecondsToIso(row.blockTime);
      return iso ? Date.parse(iso) <= maxDate : false;
    });
  }

  const offset = (page - 1) * pageSize;
  const slicedPlusOne = merged.slice(offset, offset + pageSize + 1);
  const hasMore = slicedPlusOne.length > pageSize;
  const pageItems = hasMore ? slicedPlusOne.slice(0, pageSize) : slicedPlusOne;
  const transferRowsBySignature = await getTransferRowsBySignatures(
    c,
    pageItems.map((row) => row.signature),
    scope.auth.organizationId,
    scope.auth.projectId
  );

  const transfers = await Promise.all(
    pageItems.map(async (row) => {
      const tx = await getTransactionJsonParsed(rpc, row.signature);

      const details = inferOnChainTransferDetails(tx, row.queriedAddress);
      const blockTimeIso = unixSecondsToIso(row.blockTime) ?? new Date().toISOString();
      const persisted = transferRowsBySignature.get(row.signature);
      const persistedTransfer = persisted ? mapTransferRow(persisted) : null;

      return {
        id: persistedTransfer?.id ?? row.signature,
        organizationId: scope.auth.organizationId,
        ...(scope.auth.projectId ? { projectId: scope.auth.projectId } : {}),
        type: persistedTransfer?.type ?? details.type,
        direction: persistedTransfer?.direction ?? details.direction,
        status: mapOnChainStatus(row),
        signature: row.signature,
        serializedTx: persistedTransfer?.serializedTx ?? null,
        slot: row.slot,
        blockTime: unixSecondsToIso(row.blockTime),
        fee: details.fee ?? persistedTransfer?.fee ?? null,
        error: row.err ? JSON.stringify(row.err) : null,
        ...(persistedTransfer?.initiatedBy ? { initiatedBy: persistedTransfer.initiatedBy } : {}),
        ...(details.source
          ? { source: details.source }
          : persistedTransfer?.source
            ? { source: persistedTransfer.source }
            : {}),
        ...(details.destination
          ? { destination: details.destination }
          : persistedTransfer?.destination
            ? { destination: persistedTransfer.destination }
            : {}),
        ...(details.token
          ? { token: details.token }
          : persistedTransfer?.token
            ? { token: persistedTransfer.token }
            : {}),
        ...(details.amount
          ? { amount: details.amount }
          : persistedTransfer?.amount
            ? { amount: persistedTransfer.amount }
            : {}),
        ...(persistedTransfer?.memo ? { memo: persistedTransfer.memo } : {}),
        createdAt: persistedTransfer?.createdAt ?? blockTimeIso,
        updatedAt: persistedTransfer?.updatedAt ?? blockTimeIso,
      };
    })
  );

  let filteredTransfers = transfers;
  if (token) {
    filteredTransfers = filteredTransfers.filter((t) => t.token === token);
  }
  if (direction) {
    filteredTransfers = filteredTransfers.filter((t) => t.direction === direction);
  }

  const total = hasMore ? offset + filteredTransfers.length + 1 : offset + filteredTransfers.length;

  return paginated(c, filteredTransfers, { total, page, pageSize });
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

  const bySignature = await getTransferRowBySignature(
    c,
    transferId,
    auth.organizationId,
    auth.projectId
  );
  if (bySignature) {
    return success(c, { transfer: mapTransferRow(bySignature) });
  }

  const scope = await resolveScope(c);
  const rpc = createRpc(c.env);

  const tx = await getTransactionJsonParsed(rpc, transferId);

  if (!tx) {
    throw new AppError("NOT_FOUND", "Transfer not found");
  }

  const walletAddress = scope.wallets[0]?.publicKey ?? "";
  const details = inferOnChainTransferDetails(tx, walletAddress);
  const parsedTx = tx as {
    slot?: number;
    blockTime?: number | null;
    meta?: { err?: unknown };
  };
  const blockTimeIso = unixSecondsToIso(parsedTx.blockTime) ?? new Date().toISOString();

  return success(c, {
    transfer: {
      id: transferId,
      organizationId: scope.auth.organizationId,
      ...(scope.auth.projectId ? { projectId: scope.auth.projectId } : {}),
      type: details.type,
      direction: details.direction,
      status: mapOnChainStatus({
        err: parsedTx.meta?.err,
        confirmationStatus: "confirmed",
      }),
      signature: transferId,
      serializedTx: null,
      slot: parsedTx.slot ?? null,
      blockTime: unixSecondsToIso(parsedTx.blockTime),
      fee: details.fee ?? null,
      error: parsedTx.meta?.err ? JSON.stringify(parsedTx.meta.err) : null,
      ...(details.source ? { source: details.source } : {}),
      ...(details.destination ? { destination: details.destination } : {}),
      ...(details.token ? { token: details.token } : {}),
      ...(details.amount ? { amount: details.amount } : {}),
      createdAt: blockTimeIso,
      updatedAt: blockTimeIso,
    },
  });
}
