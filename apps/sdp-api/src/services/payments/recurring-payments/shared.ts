import { createClusterRpc } from "@sdp/rpc/factory";
import * as solanaRpc from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
import {
  type MovementId,
  type PreparedPaymentSubscriptionTransaction,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types";
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
  type MaybeAccount,
  partiallySignTransactionMessageWithSigners,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";
import { findPlanPda, type SubscriptionDelegation } from "@solana/subscriptions";
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
import { getLogger } from "@/runtime/logger";
import {
  isNativePaymentToken,
  normalizePaymentToken,
  parseU64String,
  SOL_MINT,
} from "@/services/payment-operation.service";
import * as solanaServices from "@/services/solana";
import {
  createSponsorshipFeePayment,
  resolveProjectSponsorshipScope,
} from "@/services/sponsorship.service";
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
 * stablecoins on the open scope's cluster or active tokens issued in the project.
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

  const mint = assertValidAddress(normalizePaymentToken(token), "token");
  const wellKnown = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
  if (wellKnown) {
    if (wellKnown.isUsdStable) {
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

export async function buildPreparedSubscriptionTransaction(
  feePayer: Address,
  instructions: Instruction[],
  requiredSigners: Address[]
): Promise<PreparedPaymentSubscriptionTransaction> {
  const rpc = createClusterRpc();
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");

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

export async function sendSubscriptionInstructions(input: {
  env: Env;
  /** The movement these instructions serve; the custody signer decides on it. */
  movement: MovementId;
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
      input.sourceWallet.id,
      input.movement
    ));

  if (signer.address !== input.sourceWallet.publicKey) {
    throw badRequest("Resolved signing wallet does not match source wallet");
  }

  const rpc = createClusterRpc();
  const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(rpc, "confirmed");
  const feePayment = createSponsorshipFeePayment(
    input.env,
    await resolveProjectSponsorshipScope(input.env, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      actor: { type: "wallet", id: input.sourceWallet.walletId },
    }),
    input.movement
  );
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
 * Whether a subscription delegation is canceled on chain: `cancelSubscription`
 * sets `expiresAtTs` to the end of the current period and `resumeSubscription`
 * clears it to 0.
 */
export function isSubscriptionDelegationCanceled(
  delegation: MaybeAccount<SubscriptionDelegation>
): boolean {
  return delegation.exists && delegation.data.expiresAtTs !== 0n;
}

/** What the warning names when a step is found on chain without its saved signature. */
export interface ResumedStepLogContext {
  recurring_payment_id: string;
  attempt_id: string;
  step:
    | "create_plan"
    | "authorize_subscription"
    | "update_plan"
    | "cancel_old_subscription"
    | "cancel"
    | "resume";
}

/**
 * What the chain says about a step an earlier run reached (HOO-2044):
 * - `landed`: its effect is on chain at `finalized`; it is done and is not sent again;
 * - `absent`: no effect and no saved send; send it (`account` is the `finalized` read);
 * - `failed`: its saved send failed, or never landed before its blockhash expired.
 */
export type ResumedStep<T> =
  | { kind: "landed"; account: T }
  | { kind: "absent"; account: T }
  | { kind: "failed" };

const FINALITY_WAIT_MS = 30_000;
const FINALITY_POLL_MS = 2_000;

/**
 * Settles a step an earlier run reached before this run sends it again. A step's
 * signature is saved only after its send returns, so the attempt alone cannot
 * say whether that send landed; the step's account can, because only this
 * attempt causes its effect. Saved signatures are looked up with transaction
 * history: recovery runs long after the RPC status cache (about 2 minutes) has
 * dropped them.
 *
 * - The effect at `finalized`: landed.
 * - The effect at `confirmed` only: it is landing. Wait for finality instead of
 *   sending; still not final after the wait, throw so the attempt is retried.
 * - No effect, no saved signature: absent. A stale attempt's earlier send can no
 *   longer land; a fresh retry's still could, and a duplicate then fails on chain.
 * - No effect, saved signature: its status decides. Failed, or unknown on a stale
 *   attempt (its blockhash expired), is `failed`; succeeded but not yet visible
 *   throws for a retry; unknown on a fresh retry waits for it.
 */
export async function settleResumedStep<T extends { exists: boolean }>(input: {
  rpc: ReturnType<typeof solanaRpc.createRpc>;
  read: (commitment: "finalized" | "confirmed") => Promise<T>;
  /** Whether the account shows the step's effect. */
  landed: (account: T) => boolean;
  /** The signature an earlier run saved for this step, if it got that far. */
  savedSignature: Signature | null;
  /** The attempt is past the operation's stale window, so any earlier send's blockhash expired. */
  stale: boolean;
  logContext: ResumedStepLogContext;
}): Promise<ResumedStep<T>> {
  const finalized = await input.read("finalized");
  if (input.landed(finalized)) {
    return landedStep(input, finalized);
  }
  if (input.landed(await input.read("confirmed"))) {
    return landedStep(input, await waitForFinalized(input));
  }
  if (input.savedSignature === null) {
    return { kind: "absent", account: finalized };
  }

  const [status] = await solanaRpc.getSignatureStatuses(input.rpc, [input.savedSignature], {
    searchTransactionHistory: true,
  });
  if (status?.err) {
    return { kind: "failed" };
  }
  if (status) {
    throw conflict("Recurring payment step landed but is not visible on chain yet; retry");
  }
  if (input.stale) {
    return { kind: "failed" };
  }
  const confirmation = await solanaRpc.confirmTransaction(input.rpc, input.savedSignature, {
    commitment: "confirmed",
  });
  if (confirmation.err) {
    return { kind: "failed" };
  }
  return landedStep(input, await waitForFinalized(input));
}

function landedStep<T>(
  input: { savedSignature: Signature | null; logContext: ResumedStepLogContext },
  account: T
): ResumedStep<T> {
  if (input.savedSignature === null) {
    getLogger().warn(
      input.logContext,
      "Recurring payment step found on chain without its saved signature"
    );
  }
  return { kind: "landed", account };
}

/**
 * Re-reads the step's account at `finalized` until its effect shows, within
 * FINALITY_WAIT_MS. The caller has just read `finalized`, so each read waits first.
 */
async function waitForFinalized<T>(input: {
  read: (commitment: "finalized" | "confirmed") => Promise<T>;
  landed: (account: T) => boolean;
}): Promise<T> {
  for (let waited = 0; waited < FINALITY_WAIT_MS; waited += FINALITY_POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, FINALITY_POLL_MS));
    const account = await input.read("finalized");
    if (input.landed(account)) {
      return account;
    }
  }
  throw conflict("Recurring payment step is still finalizing on chain; retry");
}

export async function confirmSubscriptionSignature(
  signature: Signature,
  message: string
): Promise<void> {
  const rpc = createClusterRpc();
  const confirmation = await solanaRpc.confirmTransaction(rpc, signature, {
    commitment: "confirmed",
  });

  if (confirmation.err) {
    throw transactionFailed(message);
  }
}

export function recurringPaymentErrorMessage(error: Error): string {
  return error instanceof AppError ? error.message : PUBLIC_INTERNAL_ERROR_MESSAGE;
}
