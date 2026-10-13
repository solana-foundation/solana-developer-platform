import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import { confirmTransaction, getRecentBlockhash } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { type PreparedPaymentSubscriptionTransaction, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import {
  type Address,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  assertIsSignature,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  type Instruction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";
import { findPlanPda } from "@solana/subscriptions";
import type {
  PaymentRecurringPaymentRow,
  PaymentSubscriptionPlanRow,
  PaymentSubscriptionRow,
} from "@/db/repositories";
import { createTokenRepository } from "@/db/repositories";
import {
  AppError,
  badRequest,
  conflict,
  internalError,
  PUBLIC_INTERNAL_ERROR_MESSAGE,
  transactionFailed,
} from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { resolveMintDecimals, resolveMintTokenProgram } from "@/routes/payments/token-accounts";
import {
  isNativePaymentToken,
  normalizePaymentToken,
  parseU64String,
  SOL_MINT,
} from "@/services/payment-operation.service";
import * as solanaServices from "@/services/solana";
import { createProjectSponsorshipFeePayment } from "@/services/sponsorship.service";
import {
  type SignedSubmissionStore,
  submitSponsoredTransaction,
} from "@/services/sponsorship-submission";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";

const RECURRING_PAYMENT_TOKEN_ERROR =
  "Recurring payments support USD stablecoins and tokens issued in this project; native SOL is not supported";

/**
 * Resolves a recurring-payment token to its mint, allowing only well-known USD
 * stablecoins on the open cluster scope's cluster or active tokens issued in the project.
 *
 * @param token - A well-known token symbol or a mint address.
 * @param organizationId - The organization owning the project.
 * @param projectId - The project whose issued tokens are accepted.
 * @param env - The worker environment the token repository reads through.
 * @returns The accepted mint address.
 * @throws AppError (400) when the token is native SOL, a non-USD or off-cluster well-known
 * token, or a mint not actively issued in the project.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export async function assertRecurringPaymentTokenMint(
  token: string,
  organizationId: string,
  projectId: string,
  env: Env
): Promise<string> {
  if (isNativePaymentToken(token)) {
    throw badRequest(RECURRING_PAYMENT_TOKEN_ERROR);
  }

  const { cluster } = currentClusterScope();
  const mint = assertValidAddress(normalizePaymentToken(token), "token");
  const wellKnown = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
  if (wellKnown) {
    if (wellKnown.isUsdStable && wellKnown.clusters.includes(cluster)) {
      return mint;
    }
    throw badRequest(RECURRING_PAYMENT_TOKEN_ERROR);
  }

  const issuedTokenStatus = await createTokenRepository(
    env,
    createTenantScope({ organizationId, projectId })
  ).getStatusByMint(projectId, mint);
  if (issuedTokenStatus !== "active") {
    throw badRequest(RECURRING_PAYMENT_TOKEN_ERROR);
  }

  return mint;
}

export function assertSubscriptionTokenMint(token: string): Address {
  if (token === "SOL" || token === SOL_MINT) {
    throw badRequest("Subscription plans require an SPL token mint");
  }

  return assertValidAddress(token, "token");
}

export async function derivePlanAddresses(
  plan: PaymentSubscriptionPlanRow
): Promise<{ owner: Address; planId: bigint; planPda: Address }> {
  const owner = assertValidAddress(plan.owner_address, "ownerAddress");
  const planId = parseU64String(plan.program_plan_id, "programPlanId");
  const [planPda] = await findPlanPda({ owner, planId });

  return { owner, planId, planPda };
}

/**
 * Resolves a plan's mint, token program and base-unit amount from the mint account on the
 * request's cluster scope.
 *
 * @param plan - Stored subscription plan whose token and decimal amount are resolved.
 * @returns The plan amount in base units, the mint address and the mint's token program.
 */
export async function resolvePlanRuntime(
  plan: PaymentSubscriptionPlanRow
): Promise<{ amountBaseUnits: bigint; mint: Address; tokenProgram: Address }> {
  const mint = assertSubscriptionTokenMint(plan.token);
  const rpc = createClusterRpc();
  const [tokenProgram, decimals] = await Promise.all([
    resolveMintTokenProgram(rpc, mint),
    resolveMintDecimals(rpc, mint),
  ]);
  const amountBaseUnits = parseDecimalAmount(plan.amount, decimals);

  if (amountBaseUnits <= 0n) {
    throw badRequest("Subscription amount must be greater than zero");
  }

  return { amountBaseUnits, mint, tokenProgram };
}

/**
 * Compiles an unsigned subscription transaction using a recent blockhash from the request's
 * cluster scope.
 *
 * @param feePayer - Address that pays the transaction fee.
 * @param instructions - Instructions appended to the transaction message in order.
 * @param requiredSigners - Addresses that must sign alongside the fee payer.
 * @returns The base64 wire transaction, its blockhash lifetime and the deduplicated signer list.
 */
export async function buildPreparedSubscriptionTransaction(
  feePayer: Address,
  instructions: Instruction[],
  requiredSigners: Address[]
): Promise<PreparedPaymentSubscriptionTransaction> {
  const rpc = createClusterRpc();
  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc, "confirmed");

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );
  const compiled = compileTransaction(message);
  const signers = new Set<string>([...requiredSigners.map(String), String(feePayer)]);

  return {
    serialized: getBase64EncodedWireTransaction(compiled),
    blockhash: blockhash as string,
    lastValidBlockHeight: lastValidBlockHeight.toString(),
    requiredSigners: Array.from(signers),
  };
}

/** Adapts nullable stored metadata to the subscription program's required string argument. */
export function subscriptionProgramMetadataUri(metadataUri: string | null): string {
  return metadataUri === null ? "" : metadataUri;
}

export function parseNullableStoredSignature(value: string | null): Signature | null {
  if (value === null) return null;
  assertIsSignature(value);
  return value;
}

export function canonicalAttemptSignature(input: {
  attemptSignature: string | null;
  journalSignature: string | null;
  label: string;
}): string | null {
  if (input.journalSignature !== null && input.journalSignature !== input.attemptSignature) {
    throw internalError(`${input.label} signatures do not match`);
  }
  return input.attemptSignature;
}

export function requireUpdatedAttempt<T>(attempt: T | null): T {
  if (attempt === null) throw conflict("Recurring payment attempt changed concurrently");
  return attempt;
}

export function requireUpdatedPlan(
  plan: PaymentSubscriptionPlanRow | null
): PaymentSubscriptionPlanRow {
  if (plan === null) throw conflict("Recurring payment plan changed concurrently");
  return plan;
}

export function requireUpdatedSubscription(
  subscription: PaymentSubscriptionRow | null
): PaymentSubscriptionRow {
  if (subscription === null) throw conflict("Recurring payment subscription changed concurrently");
  return subscription;
}

export function assertRecurringPaymentSourceWallet(
  recurringPayment: Pick<
    PaymentRecurringPaymentRow,
    "source_custody_wallet_id" | "source_wallet_id" | "source_address"
  >,
  sourceWallet: Pick<CustodyWallet, "id" | "walletId" | "publicKey">
): void {
  if (!recurringPayment.source_custody_wallet_id) {
    throw conflict("Recurring payment source wallet is unresolved");
  }
  if (recurringPayment.source_custody_wallet_id !== sourceWallet.id) {
    throw badRequest("Recurring payment exact source wallet does not match request");
  }
  if (recurringPayment.source_wallet_id !== sourceWallet.walletId) {
    throw badRequest("Recurring payment source wallet does not match request");
  }
  if (recurringPayment.source_address !== sourceWallet.publicKey) {
    throw badRequest("Recurring payment source address does not match wallet");
  }
}

/**
 * Signs subscription instructions with the source wallet and submits them through the project's
 * sponsorship fee payer, on the open cluster scope's cluster.
 *
 * @param input - The submission inputs.
 * @param input.env - The worker environment.
 * @param input.organizationId - The organization owning the project.
 * @param input.projectId - The project whose sponsorship pays the fee.
 * @param input.sourceWallet - The custody wallet that signs the instructions.
 * @param input.sourceSigner - A signer already resolved for `sourceWallet`; resolved from custody when absent.
 * @param input.instructions - Instructions appended to the transaction in order.
 * @param input.feePayer - Fee payer overriding the sponsorship fee payer's address.
 * @param input.submissionStore - Durable store for the signed submission; without it the fee payer signs and sends directly.
 * @returns The submitted transaction's signature.
 * @throws AppError (400) when the resolved signer does not match the source wallet.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export async function sendSubscriptionInstructions(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  sourceSigner?: TransactionSigner;
  instructions: Instruction[];
  feePayer?: Address;
  submissionStore?: SignedSubmissionStore;
}): Promise<Signature> {
  const signer =
    input.sourceSigner ??
    (await solanaServices.createOrgSignerForCustodyWallet(
      input.env,
      input.organizationId,
      input.projectId,
      input.sourceWallet.id
    ));

  if (signer.address !== input.sourceWallet.publicKey) {
    throw badRequest("Resolved signing wallet does not match source wallet");
  }

  const rpc = createClusterRpc();
  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc, "confirmed");
  const feePayment = await createProjectSponsorshipFeePayment(input.env, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    actor: { type: "wallet", id: input.sourceWallet.walletId },
  });
  const feePayer = input.feePayer ?? (await feePayment.getFeePayer());
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(input.instructions, m),
    (m) => addSignersToTransactionMessage([signer], m)
  );
  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
  const txBytes = new Uint8Array(getTransactionEncoder().encode(partiallySigned));
  return input.submissionStore
    ? submitSponsoredTransaction({
        feePayment,
        rpc,
        transaction: txBytes,
        lastValidBlockHeight,
        store: input.submissionStore,
      })
    : feePayment.signAndSend(txBytes);
}

/**
 * Waits for a subscription transaction to reach `confirmed` on the open cluster scope's cluster.
 *
 * @param signature - The submitted transaction's signature.
 * @param message - The error message when the transaction landed with an error.
 * @returns Resolves once the transaction is confirmed without error.
 * @throws AppError (transaction failed) when the confirmed transaction carries an error.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export async function confirmSubscriptionSignature(
  signature: Signature,
  message: string
): Promise<void> {
  const rpc = createClusterRpc();
  const confirmation = await confirmTransaction(rpc, signature, {
    commitment: "confirmed",
  });

  if (confirmation.err) {
    throw transactionFailed(message);
  }
}

export function recurringPaymentErrorMessage(error: Error): string {
  return error instanceof AppError ? error.message : PUBLIC_INTERNAL_ERROR_MESSAGE;
}
