import type { Address, Instruction, Signature, TransactionSigner } from "@solana/kit";
import {
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import {
  fetchMaybePlan,
  fetchMaybeSubscriptionAuthority,
  fetchMaybeSubscriptionDelegation,
  findPlanPda,
  findSubscriptionAuthorityPda,
  findSubscriptionDelegationPda,
  getCancelSubscriptionOverlayInstructionAsync,
  getCreatePlanOverlayInstructionAsync,
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  getResumeSubscriptionOverlayInstructionAsync,
  getSubscribeOverlayInstructionAsync,
  getTransferSubscriptionOverlayInstructionAsync,
  PlanStatus,
} from "@solana/subscriptions";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
} from "@solana-program/token-2022";
import type { PaymentRecurringPaymentRow } from "@/db/repositories/payment-recurring-payments.repository";
import { parseDecimalAmount } from "@/lib/amount";
import { AppError } from "@/lib/errors";
import { assertValidAddress } from "@/lib/solana";
import { createFeePaymentAdapter } from "@/services/adapters/fee-payment";
import { normalizePaymentToken, SOL_MINT } from "@/services/payment-operation.service";
import { resolveMintDecimals, resolveMintTokenProgram } from "@/services/payments/token-accounts";
import * as solanaRpc from "@/services/solana/rpc";
import type { Env } from "@/types/env";

const U64_MAX = 18_446_744_073_709_551_615n;
const BLOCKHASH_EXPIRY_ERROR_PATTERN =
  /blockhash.*(expired|not found|no longer valid)|transactionexpiredblockheightexceeded|block height exceeded|last valid block height/i;

export interface RecurringSubscriptionRuntime {
  amountBaseUnits: bigint;
  mint: Address;
  sourceTokenAccount: Address;
  tokenProgram: Address;
}

export interface ExecutedSubscriptionTransaction {
  signature: string;
  slot: number | null;
  blockTime: string | null;
}

export interface SubmittedSubscriptionTransaction {
  signature: string;
}

export function isImmediateRecurringSubscriptionRetryError(error: unknown): boolean {
  return error instanceof AppError && error.details?.retryImmediately === true;
}

export function generateProgramPlanId(): string {
  const bytes = new Uint8Array(8);
  let value = 0n;

  while (value === 0n) {
    crypto.getRandomValues(bytes);
    value = 0n;
    for (const byte of bytes) {
      value = (value << 8n) | BigInt(byte);
    }
  }

  return value.toString();
}

export function parseU64String(value: string, fieldName: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > U64_MAX) {
      throw new Error("out of range");
    }
    return parsed;
  } catch {
    throw new AppError("BAD_REQUEST", `${fieldName} must fit in an unsigned 64-bit integer`);
  }
}

export function assertSubscriptionTokenMint(token: string): Address {
  const normalized = normalizePaymentToken(token);
  if (normalized === "SOL" || normalized === SOL_MINT) {
    throw new AppError("BAD_REQUEST", "Recurring payments require an SPL token mint");
  }
  return assertValidAddress(normalized, "token");
}

function isBlockhashExpiryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return BLOCKHASH_EXPIRY_ERROR_PATTERN.test(message.toLowerCase());
}

async function resolveConfirmedBlockTime(
  rpc: solanaRpc.SolanaRpc,
  slot: bigint
): Promise<string | null> {
  try {
    const blockTime = await rpc.getBlockTime(slot).send();
    return blockTime === null ? null : new Date(Number(blockTime) * 1_000).toISOString();
  } catch (error) {
    console.warn("Failed to resolve recurring payment transaction block time", {
      slot: slot.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function resolveRecurringSubscriptionRuntime(
  env: Env,
  recurringPayment: PaymentRecurringPaymentRow
): Promise<RecurringSubscriptionRuntime> {
  const mint = assertSubscriptionTokenMint(recurringPayment.token);
  const rpc = solanaRpc.createRpc(env);
  const tokenProgram = await resolveMintTokenProgram(rpc, mint);
  const sourceAddress = assertValidAddress(recurringPayment.source_address, "sourceAddress");
  const [sourceTokenAccount] = await findAssociatedTokenPda({
    owner: sourceAddress,
    tokenProgram,
    mint,
  });
  const [sourceTokenAccountInfo, decimals] = await Promise.all([
    solanaRpc.getAccountInfo(rpc, sourceTokenAccount),
    resolveMintDecimals(rpc, mint),
  ]);

  if (!sourceTokenAccountInfo) {
    throw new AppError(
      "BAD_REQUEST",
      "Source wallet has no associated token account for this mint"
    );
  }
  if (String(sourceTokenAccountInfo.owner) !== String(tokenProgram)) {
    throw new AppError("BAD_REQUEST", "Source associated token account uses an unsupported owner");
  }
  const amountBaseUnits = parseDecimalAmount(recurringPayment.amount, decimals);

  if (amountBaseUnits <= 0n) {
    throw new AppError("BAD_REQUEST", "Recurring payment amount must be greater than zero");
  }

  return {
    amountBaseUnits,
    mint,
    sourceTokenAccount,
    tokenProgram,
  };
}

async function executeSignedInstructions(input: {
  env: Env;
  instructions: Instruction[];
  signers: TransactionSigner[];
  onSubmitted?: (submitted: SubmittedSubscriptionTransaction) => Promise<void>;
}): Promise<ExecutedSubscriptionTransaction> {
  const rpc = solanaRpc.createRpc(input.env);
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
  const feePayment = createFeePaymentAdapter(input.env);
  const feePayer = await feePayment.getFeePayer();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(input.instructions, m),
    (m) => addSignersToTransactionMessage(input.signers, m)
  );

  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
  const txBytes = new Uint8Array(getTransactionEncoder().encode(partiallySigned));
  let signature: Signature;
  try {
    signature = await feePayment.signAndSend(txBytes);
  } catch (error) {
    if (isBlockhashExpiryError(error)) {
      throw new AppError(
        "SOLANA_RPC_ERROR",
        "Recurring payment transaction blockhash expired before submission",
        {
          retryImmediately: true,
          retryReason: "blockhash_expired",
        }
      );
    }

    throw error;
  }
  await input.onSubmitted?.({ signature });
  const confirmation = await solanaRpc.confirmTransaction(rpc, signature, {
    commitment: "confirmed",
  });

  if (confirmation.err) {
    throw new AppError("TRANSACTION_FAILED", "Recurring payment transaction failed on-chain");
  }

  return {
    signature,
    slot: Number(confirmation.slot),
    blockTime: await resolveConfirmedBlockTime(rpc, confirmation.slot),
  };
}

export async function ensureSubscriptionPlanOnChain(input: {
  env: Env;
  sourceSigner: TransactionSigner;
  sourceAddress: Address;
  destinationTokenAccount: Address;
  programPlanId: string;
  metadataUri: string;
  runtime: RecurringSubscriptionRuntime;
  periodHours: number;
  existingSignature?: string | null;
}): Promise<{
  planId: bigint;
  planPda: Address;
  planCreatedAt: bigint;
  signature?: string;
}> {
  const planId = parseU64String(input.programPlanId, "programPlanId");
  const [planPda] = await findPlanPda({ owner: input.sourceAddress, planId });
  const rpc = solanaRpc.createRpc(input.env);
  const existingPlanAccount = await fetchMaybePlan(rpc, planPda, { commitment: "confirmed" });
  let signature = input.existingSignature ?? undefined;
  let planCreatedAt = existingPlanAccount.exists
    ? existingPlanAccount.data.data.terms.createdAt
    : null;

  if (!existingPlanAccount.exists) {
    const createPlanInstruction = await getCreatePlanOverlayInstructionAsync({
      amount: input.runtime.amountBaseUnits,
      destinations: [input.destinationTokenAccount],
      endTs: 0n,
      metadataUri: input.metadataUri,
      mint: input.runtime.mint,
      owner: input.sourceSigner,
      periodHours: BigInt(input.periodHours),
      planId,
      pullers: [input.sourceAddress],
      tokenProgram: input.runtime.tokenProgram,
    });
    const executed = await executeSignedInstructions({
      env: input.env,
      instructions: [createPlanInstruction],
      signers: [input.sourceSigner],
    });
    signature = executed.signature;

    const planAccount = await fetchMaybePlan(rpc, planPda, { commitment: "confirmed" });
    if (!planAccount.exists) {
      throw new AppError("TRANSACTION_FAILED", "Created subscription plan was not found on-chain");
    }
    planCreatedAt = planAccount.data.data.terms.createdAt;
  }

  if (planCreatedAt === null) {
    throw new AppError("TRANSACTION_FAILED", "Subscription plan createdAt could not be resolved");
  }

  return { planId, planPda, planCreatedAt, signature };
}

export async function deriveAssociatedTokenAccount(input: {
  owner: Address;
  runtime: RecurringSubscriptionRuntime;
}): Promise<Address> {
  const [tokenAccount] = await findAssociatedTokenPda({
    owner: input.owner,
    tokenProgram: input.runtime.tokenProgram,
    mint: input.runtime.mint,
  });
  return tokenAccount;
}

export async function ensureSubscriptionAuthorizationOnChain(input: {
  env: Env;
  sourceSigner: TransactionSigner;
  sourceAddress: Address;
  sourceTokenAccount: Address;
  planId: bigint;
  planPda: Address;
  planCreatedAt: bigint;
  runtime: RecurringSubscriptionRuntime;
  periodHours: number;
  existingSignature?: string | null;
}): Promise<{
  subscriptionPda: Address;
  subscriptionAuthorityAddress: Address;
  signature?: string;
}> {
  const [subscriptionAuthorityAddress] = await findSubscriptionAuthorityPda({
    tokenMint: input.runtime.mint,
    user: input.sourceAddress,
  });
  const [subscriptionPda] = await findSubscriptionDelegationPda({
    planPda: input.planPda,
    subscriber: input.sourceAddress,
  });
  const rpc = solanaRpc.createRpc(input.env);
  const existingDelegation = await fetchMaybeSubscriptionDelegation(rpc, subscriptionPda, {
    commitment: "confirmed",
  });
  let signature = input.existingSignature ?? undefined;

  if (!existingDelegation.exists) {
    const feePayment = createFeePaymentAdapter(input.env);
    const feePayer = await feePayment.getFeePayer();
    const payer = createNoopSigner(feePayer);
    const authority = await fetchMaybeSubscriptionAuthority(rpc, subscriptionAuthorityAddress, {
      commitment: "confirmed",
    });
    const initAuthorityInstruction = authority.exists
      ? null
      : await getInitSubscriptionAuthorityOverlayInstructionAsync({
          owner: input.sourceSigner,
          payer,
          tokenMint: input.runtime.mint,
          tokenProgram: input.runtime.tokenProgram,
          userAta: input.sourceTokenAccount,
        });
    const expectedSubscriptionAuthorityInitId = authority.exists ? authority.data.initId : 0n;
    const subscribeInstruction = await getSubscribeOverlayInstructionAsync({
      expectedAmount: input.runtime.amountBaseUnits,
      expectedCreatedAt: input.planCreatedAt,
      expectedPeriodHours: BigInt(input.periodHours),
      expectedSubscriptionAuthorityInitId,
      merchant: input.sourceAddress,
      payer,
      planId: input.planId,
      subscriber: input.sourceSigner,
      tokenMint: input.runtime.mint,
    });
    const instructions = initAuthorityInstruction
      ? [initAuthorityInstruction, subscribeInstruction]
      : [subscribeInstruction];
    const executed = await executeSignedInstructions({
      env: input.env,
      instructions,
      signers: [input.sourceSigner],
    });
    signature = executed.signature;

    const delegation = await fetchMaybeSubscriptionDelegation(rpc, subscriptionPda, {
      commitment: "confirmed",
    });
    if (!delegation.exists) {
      throw new AppError("TRANSACTION_FAILED", "Subscription authorization was not found on-chain");
    }
  }

  return { subscriptionPda, subscriptionAuthorityAddress, signature };
}

export async function assertOnChainPlanAndSubscription(input: {
  env: Env;
  planPda: Address;
  subscriptionPda: Address;
}) {
  const rpc = solanaRpc.createRpc(input.env);
  const [planAccount, subscriptionAccount] = await Promise.all([
    fetchMaybePlan(rpc, input.planPda, { commitment: "confirmed" }),
    fetchMaybeSubscriptionDelegation(rpc, input.subscriptionPda, { commitment: "confirmed" }),
  ]);

  if (!planAccount.exists) {
    throw new AppError("BAD_REQUEST", "Recurring payment plan is missing on-chain");
  }
  if (!subscriptionAccount.exists) {
    throw new AppError("BAD_REQUEST", "Recurring payment subscription is missing on-chain");
  }
  if (planAccount.data.status !== PlanStatus.Active) {
    throw new AppError("BAD_REQUEST", "Recurring payment plan is not active on-chain");
  }
}

export async function collectSubscriptionOnChain(input: {
  env: Env;
  sourceSigner: TransactionSigner;
  sourceAddress: Address;
  destinationAddress: Address;
  planPda: Address;
  subscriptionPda: Address;
  runtime: RecurringSubscriptionRuntime;
  onSubmitted?: (
    submitted: SubmittedSubscriptionTransaction & { destinationTokenAccount: Address }
  ) => Promise<void>;
}): Promise<ExecutedSubscriptionTransaction & { destinationTokenAccount: Address }> {
  await assertOnChainPlanAndSubscription({
    env: input.env,
    planPda: input.planPda,
    subscriptionPda: input.subscriptionPda,
  });

  const [destinationTokenAccount] = await findAssociatedTokenPda({
    owner: input.destinationAddress,
    tokenProgram: input.runtime.tokenProgram,
    mint: input.runtime.mint,
  });
  const feePayment = createFeePaymentAdapter(input.env);
  const feePayer = await feePayment.getFeePayer();
  const createDestinationAtaInstruction = getCreateAssociatedTokenIdempotentInstruction({
    payer: createNoopSigner(feePayer),
    ata: destinationTokenAccount,
    owner: input.destinationAddress,
    mint: input.runtime.mint,
    tokenProgram: input.runtime.tokenProgram,
  });
  const transferInstruction = await getTransferSubscriptionOverlayInstructionAsync({
    amount: input.runtime.amountBaseUnits,
    caller: input.sourceSigner,
    delegator: input.sourceAddress,
    planPda: input.planPda,
    receiverAta: destinationTokenAccount,
    subscriptionPda: input.subscriptionPda,
    tokenMint: input.runtime.mint,
    tokenProgram: input.runtime.tokenProgram,
  });
  const executed = await executeSignedInstructions({
    env: input.env,
    instructions: [createDestinationAtaInstruction, transferInstruction],
    signers: [input.sourceSigner],
    onSubmitted: async (submitted) => {
      await input.onSubmitted?.({ ...submitted, destinationTokenAccount });
    },
  });

  return { ...executed, destinationTokenAccount };
}

export async function executeSubscriptionLifecycleOnChain(input: {
  env: Env;
  operation: "cancel" | "resume";
  sourceSigner: TransactionSigner;
  planPda: Address;
  subscriptionPda: Address;
  onSubmitted?: (submitted: SubmittedSubscriptionTransaction) => Promise<void>;
}): Promise<ExecutedSubscriptionTransaction | null> {
  const { isCanceled: isCanceledOnChain } = await readSubscriptionLifecycleStateOnChain({
    env: input.env,
    sourceAddress: input.sourceSigner.address,
    planPda: input.planPda,
    subscriptionPda: input.subscriptionPda,
  });
  if (
    (input.operation === "cancel" && isCanceledOnChain) ||
    (input.operation === "resume" && !isCanceledOnChain)
  ) {
    return null;
  }

  const instruction =
    input.operation === "cancel"
      ? await getCancelSubscriptionOverlayInstructionAsync({
          planPda: input.planPda,
          subscriber: input.sourceSigner,
          subscriptionPda: input.subscriptionPda,
        })
      : await getResumeSubscriptionOverlayInstructionAsync({
          planPda: input.planPda,
          subscriber: input.sourceSigner,
          subscriptionPda: input.subscriptionPda,
        });

  return executeSignedInstructions({
    env: input.env,
    instructions: [instruction],
    signers: [input.sourceSigner],
    onSubmitted: input.onSubmitted,
  });
}

export async function readSubscriptionLifecycleStateOnChain(input: {
  env: Env;
  sourceAddress: Address;
  planPda: Address;
  subscriptionPda: Address;
}): Promise<{ isCanceled: boolean; expiresAtTs: bigint }> {
  const rpc = solanaRpc.createRpc(input.env);
  const subscriptionAccount = await fetchMaybeSubscriptionDelegation(rpc, input.subscriptionPda, {
    commitment: "confirmed",
  });

  if (!subscriptionAccount.exists) {
    throw new AppError("BAD_REQUEST", "Recurring payment subscription is missing on-chain");
  }
  if (subscriptionAccount.data.header.delegator !== input.sourceAddress) {
    throw new AppError("BAD_REQUEST", "Recurring payment subscription owner mismatch");
  }
  if (subscriptionAccount.data.header.delegatee !== input.planPda) {
    throw new AppError("BAD_REQUEST", "Recurring payment subscription plan mismatch");
  }

  const expiresAtTs = subscriptionAccount.data.expiresAtTs;
  return { isCanceled: expiresAtTs !== 0n, expiresAtTs };
}

export async function isSubscriptionLifecycleTargetReachedOnChain(input: {
  env: Env;
  operation: "cancel" | "resume";
  sourceAddress: Address;
  planPda: Address;
  subscriptionPda: Address;
}): Promise<boolean> {
  const { isCanceled: isCanceledOnChain } = await readSubscriptionLifecycleStateOnChain(input);

  return input.operation === "cancel" ? isCanceledOnChain : !isCanceledOnChain;
}
