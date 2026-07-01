import { WELL_KNOWN_TOKENS } from "@sdp/types";
import type {
  Address,
  Instruction,
  TransactionMessageBytesBase64,
  TransactionSigner,
} from "@solana/kit";
import {
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  getTransactionSize,
  getTransactionSizeLimit,
  isTransactionWithinSizeLimit,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTokenSize,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import { z } from "zod";
import type { CounterpartyAccountRow } from "@/db/repositories/counterparty-account.repository";
import type {
  PaymentTransferBatchRow,
  PaymentTransferRecipientRow,
} from "@/db/repositories/payment-transfer-batches.repository";
import type {
  PaymentTransferRow,
  PaymentTransferStatus,
} from "@/db/repositories/payments.repository";
import { AmountError, formatDecimalAmount, parseDecimalAmount } from "@/lib/amount";
import { getAuth, requireProjectId } from "@/lib/auth";
import {
  badRequest,
  badRequestParams,
  badRequestQuery,
  estimateNotAvailable,
  forbidden,
  internalError,
  notFound,
  transactionFailed,
} from "@/lib/errors";
import { paginated, success } from "@/lib/response";
import { assertValidAddress } from "@/lib/solana";
import {
  assertApiKeyWalletAccess,
  getAllowedApiKeyWalletIds,
} from "@/services/api-key-scope.service";
import {
  assertPaymentProjectScope,
  assertPositivePaymentAmount,
  normalizePaymentToken,
} from "@/services/payment-operation.service";
import {
  enforceWalletOperationPolicy,
  recordLegacyWalletPolicyDenial,
  walletOperationActorFromAuth,
} from "@/services/policy-enforcement.service";
import * as solanaServices from "@/services/solana";
import * as solanaRpc from "@/services/solana/rpc";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import {
  type AppContext,
  getCounterpartyAccountsRepository,
  getFeePayment,
  getPaymentsRepository,
  getPaymentTransferBatchesRepository,
} from "../context";
import { mapTransferRow } from "../mappers";
import { assertWalletPolicyAllowsTransfer } from "../policy";
import {
  createTransferBatchSchema,
  estimateTransferBatchSchema,
  listTransferBatchesQuerySchema,
  transferBatchIdParamsSchema,
} from "../schemas";
import { resolveMintTokenProgram, resolveSourceTokenAccount } from "../token-accounts";
import { type ResolvedScope, resolveScope, resolveWallet } from "../wallets";

const DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION = 20;

type CreateTransferBatchInput = z.infer<typeof createTransferBatchSchema>;
type TransferBatchRecipientInput = CreateTransferBatchInput["recipients"][number];
type Rpc = solanaRpc.SolanaRpc;
type RecentBlockhash = Awaited<ReturnType<typeof solanaRpc.getRecentBlockhash>>;

type TokenContext =
  | {
      kind: "sol";
      token: "SOL";
      decimals: 9;
    }
  | {
      kind: "spl";
      token: string;
      decimals: number;
      mintAddress: Address;
      tokenProgram: Address;
      sourceTokenAccount: Address;
    };

interface ResolvedRecipient {
  index: number;
  externalId: string | null;
  counterpartyId: string;
  counterpartyAccountId: string;
  destinationAddress: Address;
  amount: string;
  amountBaseUnits: bigint;
}

interface RecipientInstructionGroup extends ResolvedRecipient {
  instructions: Instruction[];
  destinationTokenAccount?: Address;
}

interface TransactionChunk {
  recipientIndexes: number[];
  instructions: Instruction[];
  message: ReturnType<typeof buildBatchTransactionMessage>;
  amountBaseUnits: bigint;
}

interface ResolvedBatchRequest {
  scope: ResolvedScope;
  projectId: string;
  sourceWallet: CustodyWallet;
  sourceAddress: Address;
  tokenContext: TokenContext;
  recipients: ResolvedRecipient[];
  totalAmount: string;
  totalAmountBaseUnits: bigint;
  rpc: Rpc;
}

function parseRecipientAmount(amount: string, decimals: number): bigint {
  try {
    return parseDecimalAmount(assertPositivePaymentAmount(amount), decimals);
  } catch (error) {
    if (error instanceof AmountError) {
      throw badRequest(error.message);
    }
    throw error;
  }
}

function mapBatchRow(row: PaymentTransferBatchRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    externalId: row.external_id,
    sourceWalletId: row.source_wallet_id,
    sourceAddress: row.source_address,
    token: row.token,
    status: row.status,
    totalAmount: row.total_amount,
    recipientCount: row.recipient_count,
    transactionCount: row.transaction_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRecipientRow(row: PaymentTransferRecipientRow) {
  return {
    id: row.id,
    batchId: row.batch_id,
    transferId: row.transfer_id,
    externalId: row.external_id,
    counterpartyId: row.counterparty_id,
    counterpartyAccountId: row.counterparty_account_id,
    destination: row.destination_address,
    amount: row.amount,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function resolveTokenContext(
  rpc: Rpc,
  token: string,
  sourceAddress: Address
): Promise<TokenContext> {
  if (token === "SOL") {
    return { kind: "sol", token: "SOL", decimals: WELL_KNOWN_TOKENS.SOL.decimals };
  }

  const mintAddress = assertValidAddress(token, "token");
  const tokenProgram = await resolveMintTokenProgram(rpc, mintAddress);
  const sourceTokenAccount = await resolveSourceTokenAccount(
    rpc,
    sourceAddress,
    mintAddress,
    tokenProgram
  );

  return {
    kind: "spl",
    token,
    decimals: sourceTokenAccount.decimals,
    mintAddress,
    tokenProgram,
    sourceTokenAccount: sourceTokenAccount.tokenAccount,
  };
}

function readCryptoWalletAddress(account: CounterpartyAccountRow, index: number): Address {
  if (account.account_kind !== "crypto_wallet") {
    throw badRequest(`recipients.${index}.counterpartyAccountId must be a crypto wallet account`);
  }

  const { network, address } = account.details;
  if (network !== "solana") {
    throw badRequest(`recipients.${index}.counterpartyAccountId must be a Solana wallet account`);
  }
  if (typeof address !== "string") {
    throw badRequest(`recipients.${index}.counterpartyAccountId is missing a wallet address`);
  }

  return assertValidAddress(address, `recipients.${index}.counterpartyAccountId`);
}

async function resolveRecipients(params: {
  c: AppContext;
  organizationId: string;
  projectId: string;
  recipients: TransferBatchRecipientInput[];
  decimals: number;
}): Promise<ResolvedRecipient[]> {
  const accountsRepository = getCounterpartyAccountsRepository(params.c);

  const accounts = await accountsRepository.listCounterpartyAccountsByIdsInProject({
    counterpartyAccountIds: [...new Set(params.recipients.map((r) => r.counterpartyAccountId))],
    organizationId: params.organizationId,
    projectId: params.projectId,
  });
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  return params.recipients.map((recipient, index) => {
    const account = accountById.get(recipient.counterpartyAccountId);
    if (!account) {
      throw notFound(`Counterparty account ${recipient.counterpartyAccountId}`);
    }
    if (recipient.counterpartyId && account.counterparty_id !== recipient.counterpartyId) {
      throw notFound(`Counterparty account ${recipient.counterpartyAccountId}`);
    }

    const amountBaseUnits = parseRecipientAmount(recipient.amount, params.decimals);
    return {
      index,
      externalId: recipient.externalId ?? null,
      counterpartyId: account.counterparty_id,
      counterpartyAccountId: recipient.counterpartyAccountId,
      destinationAddress: readCryptoWalletAddress(account, index),
      amount: formatDecimalAmount(amountBaseUnits, params.decimals),
      amountBaseUnits,
    };
  });
}

async function resolveBatchRequest(
  c: AppContext,
  input: CreateTransferBatchInput,
  requiredWalletPermissions: Parameters<typeof assertApiKeyWalletAccess>[2]
): Promise<ResolvedBatchRequest> {
  const projectId = requireProjectId(c);
  const scope = await resolveScope(c);
  assertPaymentProjectScope(input.projectId, scope.auth.projectId);

  const sourceWallet = resolveWallet(scope.wallets, input.source);
  assertApiKeyWalletAccess(scope.auth, sourceWallet.walletId, requiredWalletPermissions ?? []);

  const sourceAddress = assertValidAddress(sourceWallet.publicKey, "source");
  const token = normalizePaymentToken(input.token);
  const rpc = solanaRpc.createRpc(c.env);
  const tokenContext = await resolveTokenContext(rpc, token, sourceAddress);
  const recipients = await resolveRecipients({
    c,
    organizationId: scope.auth.organizationId,
    projectId,
    recipients: input.recipients,
    decimals: tokenContext.decimals,
  });
  const totalAmountBaseUnits = recipients.reduce(
    (total, recipient) => total + recipient.amountBaseUnits,
    0n
  );

  return {
    scope,
    projectId,
    sourceWallet,
    sourceAddress,
    tokenContext,
    recipients,
    totalAmount: formatDecimalAmount(totalAmountBaseUnits, tokenContext.decimals),
    totalAmountBaseUnits,
    rpc,
  };
}

async function buildInstructionGroups(params: {
  rpc: Rpc;
  tokenContext: TokenContext;
  recipients: ResolvedRecipient[];
  sourceSigner: TransactionSigner;
  feePayer: Address;
}): Promise<RecipientInstructionGroup[]> {
  if (params.tokenContext.kind === "sol") {
    return params.recipients.map((recipient) => ({
      ...recipient,
      instructions: [
        getTransferSolInstruction({
          source: params.sourceSigner,
          destination: recipient.destinationAddress,
          amount: recipient.amountBaseUnits,
        }),
      ],
    }));
  }

  const tokenContext = params.tokenContext;
  const feePayerSigner = createNoopSigner(params.feePayer);
  return Promise.all(
    params.recipients.map(async (recipient) => {
      const [destinationTokenAccount] = await findAssociatedTokenPda({
        owner: recipient.destinationAddress,
        tokenProgram: tokenContext.tokenProgram,
        mint: tokenContext.mintAddress,
      });
      const createDestinationAtaInstruction = getCreateAssociatedTokenIdempotentInstruction({
        payer: feePayerSigner,
        ata: destinationTokenAccount,
        owner: recipient.destinationAddress,
        mint: tokenContext.mintAddress,
        tokenProgram: tokenContext.tokenProgram,
      });
      const transferInstruction = getTransferCheckedInstruction(
        {
          source: tokenContext.sourceTokenAccount,
          mint: tokenContext.mintAddress,
          destination: destinationTokenAccount,
          authority: params.sourceSigner,
          amount: recipient.amountBaseUnits,
          decimals: tokenContext.decimals,
        },
        { programAddress: tokenContext.tokenProgram }
      );

      return {
        ...recipient,
        destinationTokenAccount,
        instructions: [createDestinationAtaInstruction, transferInstruction],
      };
    })
  );
}

function buildBatchTransactionMessage(params: {
  instructions: Instruction[];
  sourceSigner: TransactionSigner;
  feePayer: Address;
  lifetime: RecentBlockhash;
}) {
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(params.feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: params.lifetime.blockhash,
          lastValidBlockHeight: params.lifetime.lastValidBlockHeight,
        },
        m
      ),
    (m) => appendTransactionMessageInstructions(params.instructions, m),
    (m) => addSignersToTransactionMessage([params.sourceSigner], m)
  );
}

function buildCandidateChunk(
  groups: RecipientInstructionGroup[],
  params: {
    sourceSigner: TransactionSigner;
    feePayer: Address;
    lifetime: RecentBlockhash;
  }
): TransactionChunk {
  const instructions = groups.flatMap((group) => group.instructions);
  return {
    recipientIndexes: groups.map((group) => group.index),
    instructions,
    message: buildBatchTransactionMessage({
      instructions,
      sourceSigner: params.sourceSigner,
      feePayer: params.feePayer,
      lifetime: params.lifetime,
    }),
    amountBaseUnits: groups.reduce((total, group) => total + group.amountBaseUnits, 0n),
  };
}

function assertTransactionFits(chunk: TransactionChunk): void {
  const transaction = compileTransaction(chunk.message);
  if (isTransactionWithinSizeLimit(transaction)) {
    return;
  }

  throw badRequest("A batch transaction exceeds Solana transaction size limits", {
    transactionSize: getTransactionSize(transaction),
    transactionSizeLimit: getTransactionSizeLimit(transaction),
    recipientCount: chunk.recipientIndexes.length,
  });
}

function chunkInstructionGroups(params: {
  groups: RecipientInstructionGroup[];
  sourceSigner: TransactionSigner;
  feePayer: Address;
  lifetime: RecentBlockhash;
  maxRecipientsPerTransaction: number;
}): TransactionChunk[] {
  const chunks: TransactionChunk[] = [];
  let pending: RecipientInstructionGroup[] = [];

  const flush = () => {
    if (pending.length === 0) {
      return;
    }
    const chunk = buildCandidateChunk(pending, params);
    assertTransactionFits(chunk);
    chunks.push(chunk);
    pending = [];
  };

  for (const group of params.groups) {
    if (pending.length >= params.maxRecipientsPerTransaction) {
      flush();
    }

    const candidateGroups = [...pending, group];
    const candidate = buildCandidateChunk(candidateGroups, params);
    if (isTransactionWithinSizeLimit(compileTransaction(candidate.message))) {
      pending = candidateGroups;
      continue;
    }

    flush();
    pending = [group];
    assertTransactionFits(buildCandidateChunk(pending, params));
  }

  flush();
  return chunks;
}

async function estimateNetworkFeeLamports(rpc: Rpc, chunks: TransactionChunk[]): Promise<bigint> {
  const fees = await Promise.all(
    chunks.map(async (chunk) => {
      const { messageBytes } = compileTransaction(chunk.message);
      const message = Buffer.from(messageBytes).toString("base64") as TransactionMessageBytesBase64;
      const { value } = await rpc.getFeeForMessage(message, { commitment: "confirmed" }).send();
      if (value === null) {
        throw estimateNotAvailable("Unable to estimate Solana transaction fees");
      }
      return value;
    })
  );

  return fees.reduce((total, fee) => total + fee, 0n);
}

async function estimateMissingAtaRentLamports(
  rpc: Rpc,
  groups: RecipientInstructionGroup[],
  tokenContext: TokenContext
): Promise<bigint> {
  if (tokenContext.kind === "sol") {
    return 0n;
  }

  const [rentLamports, existence] = await Promise.all([
    solanaRpc.getMinimumBalanceForRentExemption(rpc, getTokenSize()),
    Promise.all(
      groups.map((group) =>
        group.destinationTokenAccount
          ? solanaRpc.accountExists(rpc, group.destinationTokenAccount)
          : Promise.resolve(true)
      )
    ),
  ]);

  const missing = existence.filter((exists) => !exists).length;
  return rentLamports * BigInt(missing);
}

async function enforceBatchPolicies(
  c: AppContext,
  resolved: ResolvedBatchRequest,
  input: CreateTransferBatchInput
): Promise<void> {
  const enforcement = await enforceWalletOperationPolicy(c.env, {
    organizationId: resolved.scope.auth.organizationId,
    projectId: resolved.scope.auth.projectId,
    custodyWalletId: resolved.sourceWallet.id,
    walletId: resolved.sourceWallet.walletId,
    apiKeyId: resolved.scope.auth.apiKeyId,
    actor: walletOperationActorFromAuth(resolved.scope.auth),
    operationFamily: "payment",
    operationType: "payment_transfer_batch_execute",
    asset: resolved.tokenContext.token,
    amount: resolved.totalAmount,
    destination: null,
    context: {
      sourceAddress: resolved.sourceAddress,
      recipientCount: resolved.recipients.length,
      transactionCount: null,
    },
    rawPayload: {
      externalId: input.externalId ?? null,
      source: input.source,
      token: input.token,
      recipients: input.recipients.map((recipient) => ({
        externalId: recipient.externalId ?? null,
        counterpartyId: recipient.counterpartyId,
        counterpartyAccountId: recipient.counterpartyAccountId,
        amount: recipient.amount,
      })),
      options: input.options ?? null,
    },
  });

  try {
    for (const recipient of resolved.recipients) {
      await assertWalletPolicyAllowsTransfer(c, {
        organizationId: resolved.scope.auth.organizationId,
        projectId: resolved.projectId,
        wallet: resolved.sourceWallet,
        destinationAddress: recipient.destinationAddress,
        enforceDailyLimit: false,
        token: resolved.tokenContext.token,
        amount: recipient.amount,
      });
    }

    await assertWalletPolicyAllowsTransfer(c, {
      organizationId: resolved.scope.auth.organizationId,
      projectId: resolved.projectId,
      wallet: resolved.sourceWallet,
      destinationAddress: null,
      enforceDestinationAllowlist: false,
      token: resolved.tokenContext.token,
      amount: resolved.totalAmount,
    });
  } catch (error) {
    await recordLegacyWalletPolicyDenial(c.env, enforcement, error);
    throw error;
  }
}

async function updateTransferRecord(
  c: AppContext,
  params: {
    transferId: string;
    organizationId: string;
    projectId: string;
    status: PaymentTransferStatus;
    signature?: string | null;
    serializedTx?: string | null;
    slot?: number | null;
    blockTime?: string | null;
    fee?: number | null;
    error?: string | null;
  }
): Promise<PaymentTransferRow> {
  const updated = await getPaymentsRepository(c).updateTransfer({
    transferId: params.transferId,
    organizationId: params.organizationId,
    projectId: params.projectId,
    status: params.status,
    signature: params.signature,
    serializedTx: params.serializedTx,
    slot: params.slot,
    blockTime: params.blockTime,
    fee: params.fee,
    error: params.error,
    updatedAt: new Date().toISOString(),
  });

  if (!updated) {
    throw internalError("Payment transfer record not found for update");
  }

  return updated;
}

async function updateRecipientRows(
  c: AppContext,
  params: {
    recipientsByIndex: Map<number, PaymentTransferRecipientRow>;
    recipientIndexes: number[];
    organizationId: string;
    projectId: string;
    transferId?: string | null;
    status: PaymentTransferRecipientRow["status"];
    error?: string | null;
  }
): Promise<PaymentTransferRecipientRow[]> {
  const targets = params.recipientIndexes.map((index) => {
    const existing = params.recipientsByIndex.get(index);
    if (!existing) {
      throw internalError("Transfer batch recipient row is missing");
    }
    return { index, id: existing.id };
  });

  const updatedRows = await getPaymentTransferBatchesRepository(c).updateTransferRecipientsStatus({
    recipientIds: targets.map((target) => target.id),
    organizationId: params.organizationId,
    projectId: params.projectId,
    transferId: params.transferId ?? null,
    status: params.status,
    error: params.error ?? null,
  });

  const updatedById = new Map(updatedRows.map((row) => [row.id, row]));
  for (const target of targets) {
    const updated = updatedById.get(target.id);
    if (!updated) {
      throw internalError("Transfer batch recipient row not found for update");
    }
    params.recipientsByIndex.set(target.index, updated);
  }

  return updatedRows;
}

async function executeChunk(params: {
  c: AppContext;
  resolved: ResolvedBatchRequest;
  chunk: TransactionChunk;
  recipientsByIndex: Map<number, PaymentTransferRecipientRow>;
  feePayment: ReturnType<typeof getFeePayment>;
  preflight: boolean;
}): Promise<PaymentTransferRow> {
  const { c, resolved, chunk } = params;
  const lifetime = await solanaRpc.getRecentBlockhash(resolved.rpc, "confirmed");
  const message = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight },
    chunk.message
  );
  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
  const serializedTx = getBase64EncodedWireTransaction(partiallySigned);
  const txBytes = new Uint8Array(getTransactionEncoder().encode(partiallySigned));
  const recipientRows = chunk.recipientIndexes.map((index) => params.recipientsByIndex.get(index));
  if (recipientRows.some((row) => !row)) {
    throw internalError("Transfer batch recipient row is missing");
  }

  const firstRecipient = recipientRows[0] as PaymentTransferRecipientRow;
  const transfer = await getPaymentsRepository(c).createTransfer({
    organizationId: resolved.scope.auth.organizationId,
    projectId: resolved.projectId,
    walletId: resolved.sourceWallet.walletId,
    counterpartyId: recipientRows.length === 1 ? firstRecipient.counterparty_id : null,
    sourceAddress: resolved.sourceAddress,
    destinationAddress: recipientRows.length === 1 ? firstRecipient.destination_address : null,
    token: resolved.tokenContext.token,
    amount: formatDecimalAmount(chunk.amountBaseUnits, resolved.tokenContext.decimals),
    memo: null,
    type: "transfer_batch",
    direction: "outbound",
    status: "processing",
    provider: null,
    providerReference: null,
    deliveryMode: null,
    fiatCurrency: null,
    fiatAmount: null,
    providerData: {
      batchRecipientCount: recipientRows.length,
      recipientIds: recipientRows.map((row) => row?.id).filter(Boolean),
    },
    serializedTx,
    signature: null,
    slot: null,
    initiatedByKeyId: resolved.scope.auth.id,
  });

  if (!transfer) {
    throw internalError("Failed to create payment transfer record");
  }

  await updateRecipientRows(c, {
    recipientsByIndex: params.recipientsByIndex,
    recipientIndexes: chunk.recipientIndexes,
    organizationId: resolved.scope.auth.organizationId,
    projectId: resolved.projectId,
    transferId: transfer.id,
    status: "processing",
    error: null,
  });

  const settle = async (params2: {
    status: PaymentTransferStatus;
    recipientStatus: PaymentTransferRecipientRow["status"];
    signature?: string | null;
    slot?: number | null;
    error: string | null;
  }): Promise<PaymentTransferRow> => {
    await updateRecipientRows(c, {
      recipientsByIndex: params.recipientsByIndex,
      recipientIndexes: chunk.recipientIndexes,
      organizationId: resolved.scope.auth.organizationId,
      projectId: resolved.projectId,
      transferId: transfer.id,
      status: params2.recipientStatus,
      error: params2.error,
    });
    return updateTransferRecord(c, {
      transferId: transfer.id,
      organizationId: resolved.scope.auth.organizationId,
      projectId: resolved.projectId,
      status: params2.status,
      signature: params2.signature,
      serializedTx,
      slot: params2.slot,
      blockTime: null,
      error: params2.error,
    });
  };

  // Build/sign/submit: any failure here means nothing reached the chain → failed.
  let signature: Awaited<ReturnType<typeof params.feePayment.signAndSend>>;
  try {
    if (params.preflight) {
      const simulated = await solanaRpc.simulateTransaction(resolved.rpc, txBytes);
      if (!simulated.success) {
        throw transactionFailed(
          `Batch transfer preflight failed: ${simulated.error ?? "unknown simulation error"}`,
          { logs: simulated.logs }
        );
      }
    }
    signature = await params.feePayment.signAndSend(txBytes);
  } catch (error) {
    return settle({
      status: "failed",
      recipientStatus: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Submitted: a confirmation timeout is inconclusive (the tx may still land), so keep the
  // signature and leave it processing for reconciliation — only a definitive on-chain error fails.
  let confirmation: Awaited<ReturnType<typeof solanaRpc.confirmTransaction>>;
  try {
    confirmation = await solanaRpc.confirmTransaction(resolved.rpc, signature, {
      commitment: "confirmed",
    });
  } catch (error) {
    return settle({
      status: "processing",
      recipientStatus: "processing",
      signature,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (confirmation.err) {
    return settle({
      status: "failed",
      recipientStatus: "failed",
      signature,
      error: "Batch transfer failed on-chain",
    });
  }

  return settle({
    status: "confirmed",
    recipientStatus: "confirmed",
    signature,
    slot: Number(confirmation.slot),
    error: null,
  });
}

function finalBatchStatus(transfers: PaymentTransferRow[]): PaymentTransferBatchRow["status"] {
  if (transfers.some((transfer) => transfer.status === "processing")) {
    return "processing";
  }
  const confirmed = transfers.filter((transfer) => transfer.status === "confirmed").length;
  if (confirmed === transfers.length) {
    return "confirmed";
  }
  return confirmed === 0 ? "failed" : "partially_failed";
}

export async function estimateTransferBatch(c: AppContext) {
  const body = await c.req.json();
  const parsed = estimateTransferBatchSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const resolved = await resolveBatchRequest(c, parsed.data, ["payments:read"]);
  const feePayment = getFeePayment(c);
  const sourceSigner = createNoopSigner(resolved.sourceAddress);
  const [feePayer, lifetime] = await Promise.all([
    feePayment.getFeePayer(),
    solanaRpc.getRecentBlockhash(resolved.rpc, "confirmed"),
  ]);
  const groups = await buildInstructionGroups({
    rpc: resolved.rpc,
    tokenContext: resolved.tokenContext,
    recipients: resolved.recipients,
    sourceSigner,
    feePayer,
  });
  const chunks = chunkInstructionGroups({
    groups,
    sourceSigner,
    feePayer,
    lifetime,
    maxRecipientsPerTransaction:
      parsed.data.options?.maxRecipientsPerTransaction ?? DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
  });
  const [networkFeeLamports, tokenAccountRentLamports] = await Promise.all([
    estimateNetworkFeeLamports(resolved.rpc, chunks),
    estimateMissingAtaRentLamports(resolved.rpc, groups, resolved.tokenContext),
  ]);

  return success(c, {
    estimate: {
      recipientCount: resolved.recipients.length,
      transactionCount: chunks.length,
      estimatedFees: {
        networkFeeLamports: networkFeeLamports.toString(),
        priorityFeeLamports: "0",
        tokenAccountRentLamports: tokenAccountRentLamports.toString(),
        sponsored: true,
      },
    },
  });
}

export async function createTransferBatch(c: AppContext) {
  const body = await c.req.json();
  const parsed = createTransferBatchSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const resolved = await resolveBatchRequest(c, parsed.data, ["payments:write"]);
  await enforceBatchPolicies(c, resolved, parsed.data);

  const feePayment = getFeePayment(c);
  const [signer, feePayer, lifetime] = await Promise.all([
    solanaServices.createOrgSigner(
      c.env,
      resolved.scope.auth.organizationId,
      resolved.projectId,
      resolved.sourceWallet.walletId
    ),
    feePayment.getFeePayer(),
    solanaRpc.getRecentBlockhash(resolved.rpc, "confirmed"),
  ]);
  if (signer.address !== resolved.sourceWallet.publicKey) {
    throw badRequest("Resolved signing wallet does not match source wallet");
  }
  const groups = await buildInstructionGroups({
    rpc: resolved.rpc,
    tokenContext: resolved.tokenContext,
    recipients: resolved.recipients,
    sourceSigner: signer,
    feePayer,
  });
  const chunks = chunkInstructionGroups({
    groups,
    sourceSigner: signer,
    feePayer,
    lifetime,
    maxRecipientsPerTransaction:
      parsed.data.options?.maxRecipientsPerTransaction ?? DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
  });

  const batchRepository = getPaymentTransferBatchesRepository(c);
  const batch = await batchRepository.createTransferBatch({
    organizationId: resolved.scope.auth.organizationId,
    projectId: resolved.projectId,
    externalId: parsed.data.externalId ?? null,
    sourceWalletId: resolved.sourceWallet.walletId,
    sourceAddress: resolved.sourceAddress,
    token: resolved.tokenContext.token,
    status: "processing",
    totalAmount: resolved.totalAmount,
    recipientCount: resolved.recipients.length,
    transactionCount: chunks.length,
    options: parsed.data.options ?? {},
    initiatedByKeyId: resolved.scope.auth.id,
  });
  const recipientRows = await batchRepository.createTransferRecipients(
    resolved.recipients.map((recipient) => ({
      batchId: batch.id,
      organizationId: resolved.scope.auth.organizationId,
      projectId: resolved.projectId,
      externalId: recipient.externalId,
      counterpartyId: recipient.counterpartyId,
      counterpartyAccountId: recipient.counterpartyAccountId,
      destinationAddress: recipient.destinationAddress,
      amount: recipient.amount,
      status: "pending",
      error: null,
    }))
  );
  const recipientsByIndex = new Map<number, PaymentTransferRecipientRow>(
    resolved.recipients.map((recipient, position) => [recipient.index, recipientRows[position]])
  );

  const transfers: PaymentTransferRow[] = [];
  for (const chunk of chunks) {
    const transfer = await executeChunk({
      c,
      resolved,
      chunk,
      recipientsByIndex,
      feePayment,
      preflight: parsed.data.options?.preflight !== false,
    });
    transfers.push(transfer);
  }

  const status = finalBatchStatus(transfers);
  const finalBatch =
    (await batchRepository.updateTransferBatch({
      batchId: batch.id,
      organizationId: resolved.scope.auth.organizationId,
      projectId: resolved.projectId,
      status,
      error:
        status === "failed" || status === "partially_failed"
          ? "One or more transfer batch transactions failed during execution"
          : null,
    })) ?? batch;

  return success(c, {
    batch: mapBatchRow(finalBatch),
    recipients: Array.from(recipientsByIndex.entries())
      .sort(([a], [b]) => a - b)
      .map(([, row]) => mapRecipientRow(row)),
    transfers: transfers.map(mapTransferRow),
  });
}

export async function listTransferBatches(c: AppContext) {
  const query = listTransferBatchesQuerySchema.safeParse(c.req.query());
  if (!query.success) {
    throw badRequestQuery({
      errors: z.flattenError(query.error).fieldErrors,
    });
  }

  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  if (query.data.wallet) {
    assertApiKeyWalletAccess(auth, query.data.wallet, ["payments:read"]);
  }
  const allowedWalletIds = getAllowedApiKeyWalletIds(auth);
  const result = await getPaymentTransferBatchesRepository(c).listTransferBatches({
    organizationId: auth.organizationId,
    projectId,
    walletId: query.data.wallet,
    walletIds: query.data.wallet ? undefined : (allowedWalletIds ?? undefined),
    token: query.data.token ? normalizePaymentToken(query.data.token) : undefined,
    status: query.data.status,
    externalId: query.data.externalId,
    limit: query.data.pageSize,
    offset: (query.data.page - 1) * query.data.pageSize,
  });

  return paginated(
    c,
    result.rows.map((row) => mapBatchRow(row)),
    {
      total: result.total,
      page: query.data.page,
      pageSize: query.data.pageSize,
    }
  );
}

export async function getTransferBatch(c: AppContext) {
  const params = transferBatchIdParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequestParams({
      errors: z.flattenError(params.error).fieldErrors,
    });
  }

  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const batchRepository = getPaymentTransferBatchesRepository(c);
  const batch = await batchRepository.getTransferBatchById({
    batchId: params.data.batchId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!batch) {
    throw notFound("Transfer batch");
  }

  const allowedWalletIds = getAllowedApiKeyWalletIds(auth);
  if (allowedWalletIds && !allowedWalletIds.includes(batch.source_wallet_id)) {
    throw forbidden("API key is not authorized for the requested wallet");
  }

  const recipients = await batchRepository.listTransferRecipientsByBatch({
    batchId: batch.id,
    organizationId: auth.organizationId,
    projectId,
    limit: 500,
    offset: 0,
  });
  const transferIds = Array.from(
    new Set(
      recipients.rows
        .map((recipient) => recipient.transfer_id)
        .filter((transferId): transferId is string => Boolean(transferId))
    )
  );
  const transferRows = await Promise.all(
    transferIds.map((transferId) =>
      getPaymentsRepository(c).getTransferById({
        transferId,
        organizationId: auth.organizationId,
        projectId,
      })
    )
  );

  return success(c, {
    batch: mapBatchRow(batch),
    recipients: recipients.rows.map(mapRecipientRow),
    transfers: transferRows
      .filter((row): row is PaymentTransferRow => Boolean(row))
      .map(mapTransferRow),
  });
}
