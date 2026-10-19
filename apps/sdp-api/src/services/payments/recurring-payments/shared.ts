import { createClusterRpc } from "@sdp/rpc/factory";
import {
  confirmTransaction,
  type createRpc,
  getRecentBlockhash,
  getSignatureStatuses,
} from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
import type { ApiKeyWalletScope } from "@sdp/types/api-keys";
import type { MovementId } from "@sdp/types/movements";
import type { PreparedPaymentSubscriptionTransaction } from "@sdp/types/payments";
import { SOL_MINT, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
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
import type { DatabaseExecutor } from "@/db/client";
import type { PaymentRecurringPaymentRow } from "@/db/repositories/payment-recurring-payments.repository";
import type {
  PaymentSubscriptionPlanRow,
  PaymentSubscriptionRow,
} from "@/db/repositories/payment-subscriptions.repository";
import { createTokenRepository } from "@/db/repositories/repository-factory";
import type { ApiKeyLifecycleColumns } from "@/lib/api-key-rotation";
import {
  AppError,
  badRequest,
  conflict,
  internalError,
  PUBLIC_INTERNAL_ERROR_MESSAGE,
  transactionFailed,
} from "@/lib/errors";
import { assertMovementAdmitted, decidePrincipal } from "@/lib/money-admission";
import type { currentMandateActivator } from "@/lib/money-principal";
import { createTenantScope } from "@/lib/tenant-scope";
import { resolveMintDecimals, resolveMintTokenProgram } from "@/routes/payments/token-accounts";
import { getLogger } from "@/runtime/logger";
import { parseGrantsColumn } from "@/services/api-key.service";
import {
  isNativePaymentToken,
  normalizePaymentToken,
  parseU64String,
} from "@/services/payment-operation.service";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
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
    (await createOrgSignerForCustodyWallet(
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
  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc, "confirmed");
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
 * What the chain says about a step an earlier run reached (HOO-2044): `landed`
 * when its effect is on chain at `finalized`, so it is not sent again; `absent`
 * when there is no effect and no saved send, so it is sent (`account` is the
 * `finalized` read, for building it).
 */
export type ResumedStep<T> = { kind: "landed" | "absent"; account: T };

/**
 * Settles a step an earlier run reached before this run sends it. A step's
 * signature is saved only after its send returns, so the attempt alone cannot
 * say whether that send landed; the step's account can, because only this
 * attempt causes its effect.
 *
 * - The effect at `finalized`: landed.
 * - The effect at `confirmed` only: it is landing, or the `finalized` view lags
 *   (stale attempts too), so this throws for a retry instead of sending.
 * - No effect, no saved signature: absent. A stale attempt's earlier send can no
 *   longer land; a fresh retry's still could, and a duplicate then fails on chain.
 * - No effect, saved signature: looked up with transaction history, since
 *   recovery runs long after the status cache dropped it. Failed, or unknown on a
 *   stale attempt (its blockhash expired), fails the step; succeeded but not yet
 *   visible throws for a retry; unknown on a fresh retry waits for it.
 */
/**
 * The chain cannot settle a resumed step yet: it is landing but not final, its
 * saved send succeeded but is not visible, or the read itself failed. The step
 * may be on chain, so the attempt stays in flight for the next run instead of
 * failing or resetting; the request answers 409.
 */
export class ResumedStepUnsettledError extends AppError {
  constructor(message: string) {
    super("CONFLICT", message);
    this.name = "ResumedStepUnsettledError";
  }
}

export async function settleResumedStep<T extends { exists: boolean }>(input: {
  rpc: ReturnType<typeof createRpc>;
  read: (commitment: "finalized" | "confirmed") => Promise<T>;
  /** Whether the account shows the step's effect. */
  landed: (account: T) => boolean;
  /** The signature an earlier run saved for this step, if it got that far. */
  savedSignature: Signature | null;
  /** The attempt is past the operation's stale window, so any earlier send's blockhash expired. */
  stale: boolean;
  /** The TRANSACTION_FAILED message when the step's saved send failed. */
  failureMessage: string;
  logContext: ResumedStepLogContext;
}): Promise<ResumedStep<T>> {
  try {
    return await readResumedStep(input);
  } catch (error) {
    if (
      error instanceof ResumedStepUnsettledError ||
      (error instanceof AppError && error.code === "TRANSACTION_FAILED")
    ) {
      throw error;
    }
    getLogger().warn(
      { ...input.logContext, err: error },
      "Recurring payment step could not be read on chain"
    );
    throw new ResumedStepUnsettledError("Recurring payment step could not be read on chain; retry");
  }
}

async function readResumedStep<T extends { exists: boolean }>(
  input: Parameters<typeof settleResumedStep<T>>[0]
): Promise<ResumedStep<T>> {
  const finalized = await input.read("finalized");
  if (input.landed(finalized)) {
    if (input.savedSignature === null) {
      getLogger().warn(
        input.logContext,
        "Recurring payment step found on chain without its saved signature"
      );
    }
    return { kind: "landed", account: finalized };
  }
  if (input.landed(await input.read("confirmed"))) {
    throw stepStillLanding();
  }
  if (input.savedSignature === null) {
    return { kind: "absent", account: finalized };
  }

  const [status] = await getSignatureStatuses(input.rpc, [input.savedSignature], {
    searchTransactionHistory: true,
  });
  if (status === null || status === undefined) {
    if (input.stale) {
      throw transactionFailed(input.failureMessage);
    }
    const confirmation = await confirmTransaction(input.rpc, input.savedSignature, {
      commitment: "confirmed",
    });
    if (confirmation.err) {
      throw transactionFailed(input.failureMessage);
    }
    throw stepStillLanding();
  }
  if (status.err) {
    throw transactionFailed(input.failureMessage);
  }
  throw stepStillLanding();
}

/**
 * {@link settleResumedStep} for a step only some runs resume: null when this run
 * starts the step, or when the chain says to send it; the account when it landed.
 */
export async function settleStepIfResumed<T extends { exists: boolean }>(
  resumed: boolean,
  input: Parameters<typeof settleResumedStep<T>>[0]
): Promise<T | null> {
  if (!resumed) {
    return null;
  }
  const step = await settleResumedStep(input);
  return step.kind === "landed" ? step.account : null;
}

/** A step that landed, or may have, but is not final or not visible yet: retry it. */
function stepStillLanding(): ResumedStepUnsettledError {
  return new ResumedStepUnsettledError(
    "Recurring payment step has landed but is not final on chain yet; retry"
  );
}

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

/**
 * Inside a claim the job can later finish as the mandate, re-reads the key
 * that is starting it under a share lock and decides it as the signing waist
 * would (HOO-2099): live, holding the movement's action, and with every
 * wallet the claim signs with in its scope. Revocation and every key edit
 * (grants, wallet list) write the key row first, under its row lock, so the
 * two are ordered: a narrowing that lands first makes this refuse and the
 * claim roll back, and a claim that commits first is what revocation lists.
 * The job later signs as the mandate without the key, so this is the last
 * point the key's authority is read. A member activator is decided the same
 * way from their membership row, which removal and role changes write; no
 * activator (the job itself) reads nothing.
 *
 * @throws MoneyMovementRefusedError with the waist's refusal (403).
 */
export async function lockLiveActivatingKey(
  tx: DatabaseExecutor,
  input: {
    activator: ReturnType<typeof currentMandateActivator>;
    organizationId: string;
    projectId: string;
    movement: MovementId;
    recurringPaymentId: string;
    /** The custody wallets the claimed operation signs with. */
    custodyWalletIds: readonly string[];
  }
): Promise<void> {
  const context = {
    surface: "http",
    movement: input.movement,
    organizationId: input.organizationId,
    projectId: input.projectId,
    subjectId: input.recurringPaymentId,
  } as const;
  const userId = input.activator?.userId;
  if (userId) {
    const member = await tx.queryOne<{ status: string; role: string }>(
      `SELECT status, role FROM organization_members
        WHERE user_id = ? AND organization_id = ?
        FOR SHARE`,
      [userId, input.organizationId]
    );
    assertMovementAdmitted(
      decidePrincipal(
        input.movement,
        { readAt: Date.now(), principal: { kind: "member", member } },
        { custodyWalletId: null }
      ),
      context
    );
    return;
  }
  const apiKeyId = input.activator?.apiKeyId;
  if (!apiKeyId) {
    return;
  }
  const key = await tx.queryOne<
    ApiKeyLifecycleColumns & { grants: unknown; wallet_scope: ApiKeyWalletScope }
  >(
    `SELECT status, expires_at, rotation_deadline, grants, wallet_scope
       FROM api_keys
      WHERE id = ? AND organization_id = ? AND project_id = ?
      FOR SHARE`,
    [apiKeyId, input.organizationId, input.projectId]
  );
  const listed = key
    ? await tx.queryMany<{ custody_wallet_id: string }>(
        `SELECT custody_wallet_id FROM api_key_signing_wallets
          WHERE api_key_id = ? AND status = 'active' AND custody_wallet_id = ANY(?::text[])`,
        [apiKeyId, [...input.custodyWalletIds]]
      )
    : [];
  const readAt = Date.now();
  for (const custodyWalletId of input.custodyWalletIds) {
    const decision = decidePrincipal(
      input.movement,
      {
        readAt,
        principal: {
          kind: "api_key",
          key: key && {
            status: key.status,
            expires_at: key.expires_at,
            rotation_deadline: key.rotation_deadline,
            grants: parseGrantsColumn(key.grants),
            walletScope: key.wallet_scope,
            walletListed: listed.some((row) => row.custody_wallet_id === custodyWalletId),
          },
        },
      },
      { custodyWalletId }
    );
    assertMovementAdmitted(decision, context);
  }
}
