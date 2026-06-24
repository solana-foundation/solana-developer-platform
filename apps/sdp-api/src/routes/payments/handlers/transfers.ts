import type { Permission, PrivateTransferRequest } from "@sdp/types";
import type { Address } from "@solana/kit";
import {
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  assertIsTransactionPartialSigner,
  partiallySignTransactionMessageWithSigners,
  partiallySignTransactionWithSigners,
} from "@solana/signers";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import { z } from "zod";
import { getDb } from "@/db";
import {
  isRampTransferType,
  RAMP_TRANSFER_TYPES,
  type PaymentTransferDirection as TransferDirection,
  type PaymentTransferRow as TransferRow,
  type PaymentTransferStatus as TransferStatus,
  type PaymentTransferType as TransferType,
  WALLET_TRANSFER_TYPES,
} from "@/db/repositories/payments.repository";
import { formatDecimalAmount, MAX_SAFE_BASE_UNITS, parseDecimalAmount } from "@/lib/amount";
import { getAuth } from "@/lib/auth";
import { AppError, badRequest, badRequestQuery } from "@/lib/errors";
import { paginated, success } from "@/lib/response";
import { assertValidAddress, getSolanaConfig } from "@/lib/solana";
import {
  assertApiKeyWalletAccess,
  getAllowedApiKeyWalletIds,
} from "@/services/api-key-scope.service";
import {
  assertPaymentProjectScope,
  type OutboundPaymentOperation,
  resolveOutboundPaymentOperation,
} from "@/services/payment-operation.service";
import {
  enforceWalletOperationPolicy,
  recordLegacyWalletPolicyDenial,
  walletOperationActorFromAuth,
} from "@/services/policy-enforcement.service";
import {
  type MagicBlockPrivateTransferOptions as MagicBlockProviderTransferOptions,
  type MagicBlockUnsignedTransaction,
  prepareMagicBlockPrivateTransfer,
} from "@/services/private-transfers";
import { withHeliusApiKey } from "@/services/rpc-relay.service";
import * as solanaServices from "@/services/solana";
import * as solanaRpc from "@/services/solana/rpc";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import {
  type AppContext,
  getFeePayment,
  getPaymentsRepository,
  getSponsoredFeePayer,
} from "../context";
import { mapTransferRow } from "../mappers";
import { assertWalletPolicyAllowsTransfer } from "../policy";
import {
  createTransferSchema,
  listTransfersQuerySchema,
  prepareTransferSchema,
  transferIdParamsSchema,
  walletIdParamsSchema,
} from "../schemas";
import * as tokenAccounts from "../token-accounts";
import {
  resolveMintDecimals,
  resolveMintTokenProgram,
  resolveSourceTokenAccount,
} from "../token-accounts";
import { type ResolvedScope, resolveScope, resolveWallet } from "../wallets";

// biome-ignore lint/security/noSecrets: Devnet USDC mint address constant, not a secret.
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
// biome-ignore lint/security/noSecrets: Mainnet USDC mint address constant, not a secret.
const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SIGNATURE_HISTORY_LOOKUP_CONCURRENCY = 5;

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

type PreparedTransferPayload = {
  serializedTx: string;
  blockhash: string;
  lastValidBlockHeight: string;
};

type PreparedPrivateTransferMetadata = {
  provider: "magicblock";
  magicBlock: {
    kind: MagicBlockUnsignedTransaction["kind"];
    version: MagicBlockUnsignedTransaction["version"];
    instructionCount: number;
    requiredSigners: string[];
    validator?: string;
  };
};

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

export async function resolveWalletFromParams(
  c: AppContext,
  requiredWalletPermissions: Permission[] = []
) {
  const params = walletIdParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequest("Invalid wallet ID");
  }

  const scope = await resolveScope(c);
  const wallet = resolveWallet(scope.wallets, params.data.walletId);
  assertApiKeyWalletAccess(scope.auth, wallet.walletId, requiredWalletPermissions);

  return {
    ...scope,
    wallet,
  };
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
    counterpartyId: null,
    sourceAddress: input.sourceAddress,
    destinationAddress: input.destinationAddress,
    token: input.token,
    amount: input.amount,
    memo: input.memo ?? null,
    type: input.type ?? "transfer",
    direction: input.direction ?? "outbound",
    status: input.status ?? "pending",
    provider: null,
    providerReference: null,
    deliveryMode: null,
    fiatCurrency: null,
    fiatAmount: null,
    providerData: {},
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

async function enforcePaymentTransferOperationPolicy(
  c: AppContext,
  scope: ResolvedScope,
  operation: OutboundPaymentOperation,
  input: {
    operationType: "payment_transfer_prepare" | "payment_transfer_execute";
    memo?: string;
    privateTransfer?: boolean;
    rawPayload?: Record<string, unknown>;
  }
) {
  return enforceWalletOperationPolicy(c.env, {
    organizationId: scope.auth.organizationId,
    projectId: scope.auth.projectId,
    custodyWalletId: operation.sourceWallet.id,
    walletId: operation.sourceWallet.walletId,
    apiKeyId: scope.auth.apiKeyId,
    actor: walletOperationActorFromAuth(scope.auth),
    operationFamily: "payment",
    operationType: input.operationType,
    asset: operation.token,
    amount: operation.amount,
    destination: operation.destinationAddress,
    context: {
      sourceAddress: operation.sourceAddress,
      memo: input.memo ?? null,
      privateTransfer: input.privateTransfer ?? false,
    },
    rawPayload: input.rawPayload,
  });
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
): Promise<PreparedTransferPayload> {
  const lamports = parseDecimalAmount(amount, 9);
  if (lamports <= 0n) {
    throw badRequest("Transfer amount must be greater than zero");
  }

  const rpc = solanaRpc.createRpc(c.env);
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
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
    throw badRequest("Transfer amount must be greater than zero");
  }

  const auth = getAuth(c);
  const signer = await solanaServices.createOrgSigner(
    c.env,
    auth.organizationId,
    auth.projectId ?? undefined,
    sourceWallet.walletId
  );

  if (signer.address !== sourceWallet.publicKey) {
    throw badRequest("Resolved signing wallet does not match source wallet");
  }

  const rpc = solanaRpc.createRpc(c.env);
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
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

  const confirmation = await solanaRpc.confirmTransaction(rpc, signature, {
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
): Promise<PreparedTransferPayload> {
  const rpc = solanaRpc.createRpc(c.env);
  const tokenProgram = await resolveMintTokenProgram(rpc, mintAddress);
  const sourceTokenAccount = await resolveSourceTokenAccount(
    rpc,
    sourceAddress,
    mintAddress,
    tokenProgram
  );
  const transferAmount = parseDecimalAmount(amount, sourceTokenAccount.decimals);

  if (transferAmount <= 0n) {
    throw badRequest("Transfer amount must be greater than zero");
  }

  const [destinationTokenAccount] = await findAssociatedTokenPda({
    owner: destinationAddress,
    tokenProgram,
    mint: mintAddress,
  });
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
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

type MagicBlockProductOptions = Extract<
  PrivateTransferRequest,
  { provider: "magicblock" }
>["magicBlock"];

function buildMagicBlockProviderTransferOptions(
  options: MagicBlockProductOptions,
  context?: { koraSponsoredExecution?: boolean }
): MagicBlockProviderTransferOptions {
  const gasless = context?.koraSponsoredExecution ? true : options.gasless;

  return {
    ...(options.validator ? { validator: options.validator } : {}),
    ...(options.initIfMissing !== undefined ? { initIfMissing: options.initIfMissing } : {}),
    ...(options.initAtasIfMissing !== undefined
      ? { initAtasIfMissing: options.initAtasIfMissing }
      : {}),
    ...(options.initVaultIfMissing !== undefined
      ? { initVaultIfMissing: options.initVaultIfMissing }
      : {}),
    ...(options.minDelayMs !== undefined ? { minDelayMs: options.minDelayMs } : {}),
    ...(options.maxDelayMs !== undefined ? { maxDelayMs: options.maxDelayMs } : {}),
    ...(options.clientRefId !== undefined ? { clientRefId: options.clientRefId } : {}),
    ...(options.split !== undefined ? { split: options.split } : {}),
    ...(gasless !== undefined ? { gasless } : {}),
    ...(options.legacy !== undefined ? { legacy: options.legacy } : {}),
  };
}

function mapMagicBlockPreparedTransfer(unsignedTransaction: MagicBlockUnsignedTransaction): {
  prepared: PreparedTransferPayload;
  metadata: PreparedPrivateTransferMetadata;
} {
  return {
    prepared: {
      serializedTx: unsignedTransaction.transactionBase64,
      blockhash: unsignedTransaction.recentBlockhash,
      lastValidBlockHeight: unsignedTransaction.lastValidBlockHeight.toString(),
    },
    metadata: {
      provider: "magicblock",
      magicBlock: {
        kind: unsignedTransaction.kind,
        version: unsignedTransaction.version,
        instructionCount: unsignedTransaction.instructionCount,
        requiredSigners: unsignedTransaction.requiredSigners,
        ...(unsignedTransaction.validator ? { validator: unsignedTransaction.validator } : {}),
      },
    },
  };
}

async function prepareMagicBlockPrivateTransferForOperation(params: {
  c: AppContext;
  operation: OutboundPaymentOperation;
  privateTransfer: PrivateTransferRequest;
  memo?: string;
  koraSponsoredExecution?: boolean;
}): Promise<{
  prepared: PreparedTransferPayload;
  metadata: PreparedPrivateTransferMetadata;
}> {
  const { c, operation, privateTransfer, memo } = params;

  if (operation.token === "SOL") {
    throw new AppError(
      "BAD_REQUEST",
      "MagicBlock private transfers support SPL tokens only. Provide a token mint address."
    );
  }

  const mintAddress = assertValidAddress(operation.token, "token");
  const rpc = solanaRpc.createRpc(c.env);
  await resolveMintTokenProgram(rpc, mintAddress);
  const decimals = await resolveMintDecimals(rpc, mintAddress);
  const amountBaseUnits = parseDecimalAmount(operation.amount, decimals);

  if (amountBaseUnits <= 0n) {
    throw badRequest("Transfer amount must be greater than zero");
  }

  if (amountBaseUnits > MAX_SAFE_BASE_UNITS) {
    throw new AppError(
      "BAD_REQUEST",
      "MagicBlock transfer amount is too large to send as a JSON integer."
    );
  }

  const magicBlockPrepared = await prepareMagicBlockPrivateTransfer(c.env, {
    from: operation.sourceAddress,
    to: operation.destinationAddress,
    mint: mintAddress,
    amount: Number(amountBaseUnits),
    memo,
    options: buildMagicBlockProviderTransferOptions(privateTransfer.magicBlock, {
      koraSponsoredExecution: params.koraSponsoredExecution,
    }),
  });

  return mapMagicBlockPreparedTransfer(magicBlockPrepared);
}

function assertMagicBlockKoraSponsoredExecutionOptions(options: MagicBlockProductOptions): void {
  if (options.gasless === false) {
    throw new AppError(
      "BAD_REQUEST",
      "MagicBlock private transfer execution is sponsored by Kora and requires gasless transactions. Remove gasless or set it to true."
    );
  }
}

function decodeMagicBlockPreparedTransaction(serializedTx: string) {
  const txBytes = Buffer.from(serializedTx, "base64");
  const transaction = getTransactionDecoder().decode(txBytes);
  const compiledMessage = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);

  if (!("instructions" in compiledMessage) || !("staticAccounts" in compiledMessage)) {
    throw new AppError(
      "PROVIDER_UNAVAILABLE",
      "MagicBlock transaction version is not supported for Kora fee sponsorship."
    );
  }

  const existingFeePayer = compiledMessage.staticAccounts[0];

  if (!existingFeePayer) {
    throw new AppError("PROVIDER_UNAVAILABLE", "MagicBlock transaction has no fee payer.");
  }

  return { transaction, compiledMessage, existingFeePayer };
}

type DecodedMagicBlockPreparedTransaction = ReturnType<typeof decodeMagicBlockPreparedTransaction>;

function addSponsoredFeePayerToPreparedTransaction(
  decoded: DecodedMagicBlockPreparedTransaction,
  feePayer: Address,
  requiredSigners: string[],
  options?: { replaceExistingFeePayer?: boolean }
) {
  const { transaction, compiledMessage, existingFeePayer } = decoded;

  if (existingFeePayer === feePayer) {
    return transaction;
  }

  if (compiledMessage.staticAccounts.includes(feePayer)) {
    throw new AppError(
      "PROVIDER_UNAVAILABLE",
      "MagicBlock transaction already includes the Kora fee payer in a non-fee-payer position."
    );
  }

  if (options?.replaceExistingFeePayer) {
    const { [existingFeePayer]: _existingFeePayerSignature, ...remainingSignatures } =
      transaction.signatures;
    const sponsoredMessage = {
      ...compiledMessage,
      staticAccounts: [feePayer, ...compiledMessage.staticAccounts.slice(1)],
    };

    const messageBytes = getCompiledTransactionMessageEncoder().encode(
      sponsoredMessage
    ) as typeof transaction.messageBytes;
    const signatures = {
      [feePayer]: null,
      ...remainingSignatures,
    } as typeof transaction.signatures;

    return {
      messageBytes,
      signatures: {
        ...signatures,
      },
    };
  }

  const signerCount = compiledMessage.header.numSignerAccounts;
  const existingFeePayerMustSign = requiredSigners.includes(existingFeePayer);

  if (existingFeePayerMustSign) {
    const remapAccountIndex = (accountIndex: number) => accountIndex + 1;
    const sponsoredMessage = {
      ...compiledMessage,
      header: {
        ...compiledMessage.header,
        numSignerAccounts: signerCount + 1,
      },
      staticAccounts: [feePayer, ...compiledMessage.staticAccounts],
      instructions: compiledMessage.instructions.map((instruction) => ({
        ...instruction,
        programAddressIndex: remapAccountIndex(instruction.programAddressIndex),
        accountIndices: instruction.accountIndices?.map(remapAccountIndex) ?? [],
      })),
    };

    const messageBytes = getCompiledTransactionMessageEncoder().encode(
      sponsoredMessage
    ) as typeof transaction.messageBytes;
    const signatures = {
      [feePayer]: null,
      ...transaction.signatures,
    } as typeof transaction.signatures;

    return {
      messageBytes,
      signatures: {
        ...signatures,
      },
    };
  }

  const remapAccountIndex = (accountIndex: number) => {
    if (accountIndex === 0) {
      return signerCount;
    }

    if (accountIndex < signerCount) {
      return accountIndex;
    }

    return accountIndex + 1;
  };
  const { [existingFeePayer]: _existingFeePayerSignature, ...remainingSignatures } =
    transaction.signatures;
  const sponsoredMessage = {
    ...compiledMessage,
    staticAccounts: [
      feePayer,
      ...compiledMessage.staticAccounts.slice(1, signerCount),
      existingFeePayer,
      ...compiledMessage.staticAccounts.slice(signerCount),
    ],
    instructions: compiledMessage.instructions.map((instruction) => ({
      ...instruction,
      programAddressIndex: remapAccountIndex(instruction.programAddressIndex),
      accountIndices: instruction.accountIndices?.map(remapAccountIndex) ?? [],
    })),
  };

  const messageBytes = getCompiledTransactionMessageEncoder().encode(
    sponsoredMessage
  ) as typeof transaction.messageBytes;
  const signatures = {
    [feePayer]: null,
    ...remainingSignatures,
  } as typeof transaction.signatures;

  return {
    messageBytes,
    signatures: {
      ...signatures,
    },
  };
}

async function executePreparedPrivateTransfer(
  c: AppContext,
  wallets: CustodyWallet[],
  serializedTx: string,
  metadata: PreparedPrivateTransferMetadata
): Promise<{ signature: string; slot: number | null; blockTime: string | null }> {
  const auth = getAuth(c);
  const walletsByAddress = new Map(wallets.map((wallet) => [wallet.publicKey, wallet]));
  const signerWallets = new Map<string, CustodyWallet>();
  const requiredSigners = [...new Set(metadata.magicBlock.requiredSigners)];
  const decodedTransaction = decodeMagicBlockPreparedTransaction(serializedTx);
  const existingFeePayer = decodedTransaction.existingFeePayer;
  const shouldReplaceProviderFeePayer =
    requiredSigners.includes(existingFeePayer) && !walletsByAddress.has(existingFeePayer);
  const custodyRequiredSigners = shouldReplaceProviderFeePayer
    ? requiredSigners.filter((signer) => signer !== existingFeePayer)
    : requiredSigners;

  for (const requiredSigner of custodyRequiredSigners) {
    const wallet = walletsByAddress.get(requiredSigner);
    if (wallet) {
      signerWallets.set(wallet.publicKey, wallet);
    }
  }

  const missingSignerCount = custodyRequiredSigners.length - signerWallets.size;
  if (missingSignerCount > 0) {
    throw new AppError(
      "BAD_REQUEST",
      "MagicBlock private transfer requires signer(s) that are not controlled by SDP. Use the prepare endpoint for client-side or external signing."
    );
  }

  const signers = await Promise.all(
    [...signerWallets.values()].map(async (wallet) => {
      const signer = await solanaServices.createOrgSigner(
        c.env,
        auth.organizationId,
        auth.projectId ?? undefined,
        wallet.walletId
      );

      if (signer.address !== wallet.publicKey) {
        throw badRequest("Resolved signing wallet does not match required signer");
      }
      assertIsTransactionPartialSigner(signer);
      return signer;
    })
  );

  const feePayment = getFeePayment(c);
  const feePayer = await feePayment.getFeePayer();
  const transaction = addSponsoredFeePayerToPreparedTransaction(
    decodedTransaction,
    feePayer,
    custodyRequiredSigners,
    { replaceExistingFeePayer: shouldReplaceProviderFeePayer }
  );
  const signedTransaction =
    signers.length > 0
      ? await partiallySignTransactionWithSigners(signers, transaction)
      : transaction;
  const encodedSignedTransaction = new Uint8Array(
    getTransactionEncoder().encode(signedTransaction)
  );

  const signature = await feePayment.signAndSend(encodedSignedTransaction);
  const rpc = solanaRpc.createRpc(c.env);
  const confirmation = await solanaRpc.confirmTransaction(rpc, signature, {
    commitment: "confirmed",
  });

  if (confirmation.err) {
    throw new AppError("TRANSACTION_FAILED", "MagicBlock private transfer failed on-chain");
  }

  return {
    signature,
    slot: Number(confirmation.slot),
    blockTime: null,
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
  const signer = await solanaServices.createOrgSigner(
    c.env,
    auth.organizationId,
    auth.projectId ?? undefined,
    sourceWallet.walletId
  );

  if (signer.address !== sourceWallet.publicKey) {
    throw badRequest("Resolved signing wallet does not match source wallet");
  }

  const rpc = solanaRpc.createRpc(c.env);
  const tokenProgram = await resolveMintTokenProgram(rpc, mintAddress);
  const sourceTokenAccount = await resolveSourceTokenAccount(
    rpc,
    signer.address,
    mintAddress,
    tokenProgram
  );
  const transferAmount = parseDecimalAmount(amount, sourceTokenAccount.decimals);

  if (transferAmount <= 0n) {
    throw badRequest("Transfer amount must be greater than zero");
  }

  const [destinationTokenAccount] = await findAssociatedTokenPda({
    owner: destinationAddress,
    tokenProgram,
    mint: mintAddress,
  });
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
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

  const confirmation = await solanaRpc.confirmTransaction(rpc, signature, {
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

export async function prepareTransfer(c: AppContext) {
  const body = await c.req.json();
  const parsed = prepareTransferSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  if (parsed.data.privateTransfer && parsed.data.options?.simulate) {
    throw new AppError(
      "BAD_REQUEST",
      "Simulation is not supported for provider-built private transfers yet."
    );
  }

  const scope = await resolveScope(c);
  assertPaymentProjectScope(parsed.data.projectId, scope.auth.projectId);
  const operation = resolveOutboundPaymentOperation({
    auth: scope.auth,
    wallets: scope.wallets,
    source: parsed.data.source,
    destination: parsed.data.destination,
    token: parsed.data.token,
    amount: parsed.data.amount,
    requiredWalletPermissions: ["payments:write"],
  });

  // TODO: parsed.data.referenceAddress — attach as a memo/reference key to the transaction
  //       for Solana Pay compatibility and client-side correlation. Not yet implemented.
  // TODO: parsed.data.options?.priorityFee — add a compute budget instruction to the
  //       transaction based on the requested priority level. Not yet implemented.

  const privateTransfer = parsed.data.privateTransfer as PrivateTransferRequest | undefined;
  const enforcement = await enforcePaymentTransferOperationPolicy(c, scope, operation, {
    operationType: "payment_transfer_prepare",
    memo: parsed.data.memo,
    privateTransfer: Boolean(privateTransfer),
    rawPayload: {
      source: parsed.data.source,
      destination: parsed.data.destination,
      token: parsed.data.token,
      amount: parsed.data.amount,
      referenceAddress: parsed.data.referenceAddress ?? null,
    },
  });
  try {
    await assertWalletPolicyAllowsTransfer(c, {
      organizationId: scope.auth.organizationId,
      projectId: scope.auth.projectId,
      wallet: operation.sourceWallet,
      destinationAddress: operation.destinationAddress,
      token: operation.token,
      amount: operation.amount,
    });
  } catch (error) {
    await recordLegacyWalletPolicyDenial(c.env, enforcement, error);
    throw error;
  }

  let prepared: PreparedTransferPayload;
  let privateTransferMetadata: PreparedPrivateTransferMetadata | undefined;
  let transferType: TransferType = "transfer";

  if (privateTransfer) {
    const mapped = await prepareMagicBlockPrivateTransferForOperation({
      c,
      operation,
      privateTransfer,
      memo: parsed.data.memo,
    });
    prepared = mapped.prepared;
    privateTransferMetadata = mapped.metadata;
    transferType = "transfer_confidential";
  } else if (operation.token === "SOL") {
    prepared = await prepareSolTransfer(
      c,
      operation.sourceAddress,
      operation.destinationAddress,
      operation.amount
    );
  } else {
    const mintAddress = assertValidAddress(parsed.data.token, "token");
    prepared = await prepareSplTransfer(
      c,
      operation.sourceAddress,
      operation.destinationAddress,
      mintAddress,
      operation.amount
    );
  }

  const transfer = await createTransferRecord(c, {
    organizationId: scope.auth.organizationId,
    projectId: scope.auth.projectId,
    walletId: operation.sourceWallet.walletId,
    sourceAddress: operation.sourceWallet.publicKey,
    destinationAddress: parsed.data.destination,
    token: operation.token,
    amount: operation.amount,
    memo: parsed.data.memo,
    type: transferType,
    status: "pending",
    serializedTx: prepared.serializedTx,
    initiatedByKeyId: scope.auth.id,
  });

  let simulation:
    | { success: boolean; logs: string[]; unitsConsumed: string | null; error: string | null }
    | undefined;
  if (parsed.data.options?.simulate) {
    const rpc = solanaRpc.createRpc(c.env);
    const txBytes = Buffer.from(prepared.serializedTx, "base64");
    const simulated = await solanaRpc.simulateTransaction(rpc, txBytes);
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
    ...(privateTransferMetadata ? { privateTransfer: privateTransferMetadata } : {}),
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

  if (normalizedMint === DEVNET_USDC_MINT || normalizedMint === MAINNET_USDC_MINT) {
    return "USDC";
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

function dedupeSignatureHistory(
  signatures: SignatureHistoryEntry[],
  limit: number
): SignatureHistoryEntry[] {
  const bySignature = new Map<string, SignatureHistoryEntry>();

  for (const signatureInfo of signatures) {
    bySignature.set(String(signatureInfo.signature), signatureInfo);
  }

  return Array.from(bySignature.values()).sort(compareSignatureHistoryDesc).slice(0, limit);
}

async function mapSettledWithConcurrency<T, U>(
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

async function resolveWalletTokenAccountAddresses(
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

async function resolveObservedTokenSymbols(env: Env): Promise<Map<string, string>> {
  const symbolsByMint = new Map<string, string>([
    [DEVNET_USDC_MINT, "USDC"],
    [MAINNET_USDC_MINT, "USDC"],
  ]);

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
        provider_data: {},
        signature,
        serialized_tx: null,
        slot: parsedTransaction.slot ?? null,
        block_time: timestamp,
        fee: parsedTransaction.meta?.fee ?? null,
        error: null,
        initiated_by_key_id: null,
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
        provider_data: {},
        signature,
        serialized_tx: null,
        slot: parsedTransaction.slot ?? null,
        block_time: timestamp,
        fee: parsedTransaction.meta?.fee ?? null,
        error: null,
        initiated_by_key_id: null,
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
      provider_data: {},
      signature,
      serialized_tx: null,
      slot: parsedTransaction.slot ?? null,
      block_time: timestamp,
      fee: parsedTransaction.meta?.fee ?? null,
      error: null,
      initiated_by_key_id: null,
      created_at: timestamp,
      updated_at: timestamp,
    });
  }

  return [...observedRows.values()];
}

async function buildObservedTransfersForSignatures(
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

export async function createTransfer(c: AppContext) {
  const body = await c.req.json();
  const parsed = createTransferSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const scope = await resolveScope(c);
  assertPaymentProjectScope(parsed.data.projectId, scope.auth.projectId);
  const operation = resolveOutboundPaymentOperation({
    auth: scope.auth,
    wallets: scope.wallets,
    source: parsed.data.source,
    destination: parsed.data.destination,
    token: parsed.data.token,
    amount: parsed.data.amount,
    requiredWalletPermissions: ["payments:write"],
  });

  const privateTransfer = parsed.data.privateTransfer as PrivateTransferRequest | undefined;
  const enforcement = await enforcePaymentTransferOperationPolicy(c, scope, operation, {
    operationType: "payment_transfer_execute",
    memo: parsed.data.memo,
    privateTransfer: Boolean(privateTransfer),
    rawPayload: {
      source: parsed.data.source,
      destination: parsed.data.destination,
      token: parsed.data.token,
      amount: parsed.data.amount,
    },
  });
  try {
    await assertWalletPolicyAllowsTransfer(c, {
      organizationId: scope.auth.organizationId,
      projectId: scope.auth.projectId,
      wallet: operation.sourceWallet,
      destinationAddress: operation.destinationAddress,
      token: operation.token,
      amount: operation.amount,
    });
  } catch (error) {
    await recordLegacyWalletPolicyDenial(c.env, enforcement, error);
    throw error;
  }

  if (privateTransfer) {
    assertMagicBlockKoraSponsoredExecutionOptions(privateTransfer.magicBlock);
    const mapped = await prepareMagicBlockPrivateTransferForOperation({
      c,
      operation,
      privateTransfer,
      memo: parsed.data.memo,
      // MagicBlock's gasless response separates the source signer from the provider sponsor.
      // SDP swaps that sponsor slot for Kora before signing and submission.
      koraSponsoredExecution: true,
    });
    const transferType: TransferType = "transfer_confidential";
    const transfer = await createTransferRecord(c, {
      organizationId: scope.auth.organizationId,
      projectId: scope.auth.projectId,
      walletId: operation.sourceWallet.walletId,
      sourceAddress: operation.sourceWallet.publicKey,
      destinationAddress: parsed.data.destination,
      token: operation.token,
      amount: operation.amount,
      memo: parsed.data.memo,
      type: transferType,
      status: "processing",
      serializedTx: mapped.prepared.serializedTx,
      initiatedByKeyId: scope.auth.id,
    });

    try {
      const result = await executePreparedPrivateTransfer(
        c,
        scope.wallets,
        mapped.prepared.serializedTx,
        mapped.metadata
      );
      const updated = await updateTransferRecord(c, transfer.id, {
        status: "confirmed",
        signature: result.signature,
        slot: result.slot,
        blockTime: result.blockTime,
        error: null,
      });

      return success(c, {
        transfer: mapTransferRow(updated),
        privateTransfer: mapped.metadata,
      });
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

  const transfer = await createTransferRecord(c, {
    organizationId: scope.auth.organizationId,
    projectId: scope.auth.projectId,
    walletId: operation.sourceWallet.walletId,
    sourceAddress: operation.sourceWallet.publicKey,
    destinationAddress: parsed.data.destination,
    token: operation.token,
    amount: operation.amount,
    memo: parsed.data.memo,
    status: "processing",
    initiatedByKeyId: scope.auth.id,
  });

  try {
    if (operation.token === "SOL") {
      const solResult = await executeSolTransfer(
        c,
        operation.sourceWallet,
        operation.destinationAddress,
        operation.amount
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
      operation.sourceWallet,
      operation.destinationAddress,
      mintAddress,
      operation.amount
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Wallet-scoped transfer listing merges DB rows with observed on-chain history.
export async function listTransfers(c: AppContext) {
  const auth = getAuth(c);
  const query = listTransfersQuerySchema.safeParse(c.req.query());
  if (!query.success) throw badRequestQuery();
  const allowedWalletIds = getAllowedApiKeyWalletIds(auth);

  const {
    page,
    pageSize,
    wallet: walletId,
    walletAddress,
    token,
    direction,
    status: statuses,
    category,
    counterpartyId,
    provider,
    providerReference,
    from,
    to,
  } = query.data;
  const repo = getPaymentsRepository(c);
  const offset = (page - 1) * pageSize;
  const transferTypes =
    category === "wallet"
      ? WALLET_TRANSFER_TYPES
      : category === "ramp"
        ? RAMP_TRANSFER_TYPES
        : undefined;
  const transferTypeSet = transferTypes ? new Set<TransferType>(transferTypes) : undefined;
  const hasProvider = provider !== undefined;
  const hasProviderReference = providerReference !== undefined;

  if (hasProvider !== hasProviderReference) {
    throw new AppError(
      "BAD_REQUEST",
      "provider and providerReference are both required for provider reference lookup"
    );
  }

  if (hasProvider && hasProviderReference) {
    const row = await repo.getTransferByProviderReference({
      provider,
      providerReference,
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    if (!row) {
      return paginated(c, [], { total: 0, page, pageSize });
    }
    if (allowedWalletIds && !allowedWalletIds.includes(row.wallet_id)) {
      throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
    }
    if (category === "wallet" && isRampTransferType(row.type)) {
      return paginated(c, [], { total: 0, page, pageSize });
    }
    if (category === "ramp" && !isRampTransferType(row.type)) {
      return paginated(c, [], { total: 0, page, pageSize });
    }

    return paginated(c, [mapTransferRow(row)], { total: 1, page, pageSize });
  }

  let transferRows: TransferRow[];
  let total: number;

  if (walletId || walletAddress) {
    // Helius-backed path: fetch on-chain signatures for the wallet address, then
    // cross-reference with our DB. Append pending/processing/failed from DB (not on-chain yet).
    //
    // TODO: Replace getSignaturesForAddress with a dedicated indexer for production use.

    let sourceAddress: string | undefined;
    let resolvedWalletId: string | undefined;
    let walletIdsByAddress = new Map<string, string>();
    const scope = await resolveScope(c);

    if (walletId) {
      if (allowedWalletIds && !allowedWalletIds.includes(walletId)) {
        throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
      }

      const wallet = resolveWallet(scope.wallets, walletId);
      assertApiKeyWalletAccess(scope.auth, wallet.walletId, ["payments:read"]);
      sourceAddress = wallet.publicKey;
      resolvedWalletId = walletId;
      walletIdsByAddress = new Map([[wallet.publicKey, wallet.walletId]]);
    } else {
      sourceAddress = walletAddress;
      const matchedWallet = scope.wallets.find((wallet) => wallet.publicKey === walletAddress);
      if (matchedWallet) {
        resolvedWalletId = matchedWallet.walletId;
        walletIdsByAddress = new Map([[matchedWallet.publicKey, matchedWallet.walletId]]);
      }

      if (allowedWalletIds) {
        const authorizedWallet = scope.wallets.find(
          (wallet) =>
            wallet.publicKey === walletAddress && allowedWalletIds.includes(wallet.walletId)
        );
        if (!authorizedWallet) {
          throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
        }

        sourceAddress = authorizedWallet.publicKey;
        resolvedWalletId = authorizedWallet.walletId;
        walletIdsByAddress = new Map([[authorizedWallet.publicKey, authorizedWallet.walletId]]);
      }
    }

    // 1. Fetch on-chain signature history via Helius (or fallback RPC)
    const heliusRpc = createSignatureHistoryRpc(c.env);
    const ownerAddress = sourceAddress as Address;
    const historyLimit = Math.min(pageSize * 5, 200);
    const signatureSearchAddresses: Address[] = [ownerAddress];

    if (resolvedWalletId) {
      const tokenAccountAddresses = await resolveWalletTokenAccountAddresses(
        c,
        heliusRpc,
        ownerAddress,
        resolvedWalletId
      );

      for (const tokenAccountAddress of tokenAccountAddresses) {
        walletIdsByAddress.set(tokenAccountAddress, resolvedWalletId);

        if (
          !signatureSearchAddresses.some(
            (searchAddress) => String(searchAddress) === String(tokenAccountAddress)
          )
        ) {
          signatureSearchAddresses.push(tokenAccountAddress);
        }
      }
    }

    const ownerSignatures = await solanaRpc.getSignaturesForAddress(heliusRpc, ownerAddress, {
      limit: historyLimit,
      commitment: "confirmed",
    });
    const tokenAccountSignatureResults = await mapSettledWithConcurrency(
      signatureSearchAddresses.slice(1),
      SIGNATURE_HISTORY_LOOKUP_CONCURRENCY,
      (searchAddress) =>
        solanaRpc.getSignaturesForAddress(heliusRpc, searchAddress, {
          limit: historyLimit,
          commitment: "confirmed",
        })
    );
    const tokenAccountSignatures = tokenAccountSignatureResults.flatMap((result) =>
      result.status === "fulfilled" ? result.value : []
    );
    const onChainSigs = dedupeSignatureHistory(
      [...ownerSignatures, ...tokenAccountSignatures],
      historyLimit
    );
    const sigStrings = onChainSigs.map((s) => String(s.signature));

    // 2. Look up on-chain signatures in our DB
    const confirmedRows = await repo.listTransfersBySignatures({
      signatures: sigStrings,
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });
    const scopedConfirmedRows = allowedWalletIds
      ? confirmedRows.filter((row) => allowedWalletIds.includes(row.wallet_id))
      : confirmedRows;

    // 3. Fetch pending/processing/failed from DB (not yet on-chain).
    //    Skip if the caller's status filter already excludes these — e.g. status=confirmed
    //    or status=finalized would never match any of these records.
    const nonChainStatuses: TransferStatus[] = [
      "pending",
      "processing",
      "failed",
      "awaiting_payment",
      "settling",
      "completed",
      "canceled",
      "expired",
    ];
    const needsNonChainRecords =
      !statuses || statuses.some((value) => nonChainStatuses.includes(value));
    const pendingRows: TransferRow[] = [];
    if (needsNonChainRecords) {
      const pendingResult = await repo.listTransfers({
        organizationId: auth.organizationId,
        projectId: auth.projectId,
        walletId: resolvedWalletId,
        walletIds: resolvedWalletId ? undefined : (allowedWalletIds ?? undefined),
        sourceAddress: resolvedWalletId ? undefined : walletAddress,
        counterpartyId,
        statuses: nonChainStatuses,
        types: transferTypes,
        token,
        direction,
        createdAtFrom: from,
        createdAtTo: to,
        limit: 100,
        offset: 0,
      });
      pendingRows.push(...pendingResult.rows);
    }

    const confirmedSignatures = new Set(
      scopedConfirmedRows
        .map((row) => row.signature)
        .filter((rowSignature): rowSignature is string => Boolean(rowSignature))
    );
    const missingObservedSignatures = onChainSigs.filter(
      (signatureInfo) => !confirmedSignatures.has(String(signatureInfo.signature))
    );
    const tokenSymbolsByMint = await resolveObservedTokenSymbols(c.env);
    const observedRows = await buildObservedTransfersForSignatures(
      c.env,
      missingObservedSignatures,
      {
        organizationId: auth.organizationId,
        projectId: auth.projectId,
        tokenSymbolsByMint,
        walletIdsByAddress,
      }
    );

    // 4. Merge: confirmed (Helius-backed) + non-confirmed (DB), deduplicated
    const seen = new Set<string>();
    const merged = [...scopedConfirmedRows, ...observedRows, ...pendingRows].filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });

    // 5. Apply remaining filters and sort
    const filtered = merged
      .filter((row) => {
        if (counterpartyId && row.counterparty_id !== counterpartyId) return false;
        if (statuses && !statuses.includes(row.status)) return false;
        if (token && row.token !== token) return false;
        if (direction && row.direction !== direction) return false;
        if (transferTypeSet && !transferTypeSet.has(row.type)) return false;
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
      walletIds: allowedWalletIds ?? undefined,
      counterpartyId,
      token,
      direction,
      statuses,
      types: transferTypes,
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
  const allowedWalletIds = getAllowedApiKeyWalletIds(auth);
  const params = transferIdParamsSchema.safeParse(c.req.param());
  const repo = getPaymentsRepository(c);

  if (!params.success) throw badRequest("Transfer ID is required");

  const row = await repo.getTransferById({
    transferId: params.data.transferId,
    organizationId: auth.organizationId,
    projectId: auth.projectId,
  });

  if (!row) throw new AppError("NOT_FOUND", "Transfer not found");
  if (allowedWalletIds && !allowedWalletIds.includes(row.wallet_id)) {
    throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
  }

  return success(c, { transfer: mapTransferRow(row) });
}
