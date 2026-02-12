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
import { success } from "@/lib/response";
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
  prepareTransferSchema,
  updateWalletPolicySchema,
  walletIdParamsSchema,
} from "./schemas";

type AppContext = Context<{ Bindings: Env }>;
// biome-ignore lint/nursery/noSecrets: Solana native SOL mint address constant, not a secret.
const SOL_MINT = "So11111111111111111111111111111111111111112";
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

export async function getWalletBalances(c: AppContext) {
  const { wallet } = await resolveWalletFromParams(c);

  const rpc = createRpc(c.env);
  const accountInfo = await getAccountInfo(rpc, wallet.publicKey as Address);

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
