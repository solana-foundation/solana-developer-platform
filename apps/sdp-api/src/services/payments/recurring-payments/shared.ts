import { createClusterRpc } from "@sdp/rpc/factory";
import { confirmTransaction, getRecentBlockhash, type SolanaRpc } from "@sdp/rpc/solana";
import { withTransientRpcRetry } from "@sdp/rpc/transient";
import { assertValidAddress } from "@sdp/solana/address";
import type { ApiKeyWalletScope, SdpEnvironment } from "@sdp/types/api-keys";
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
import { type DatabaseExecutor, getDb } from "@/db/client";
import type {
  PaymentRecurringPaymentRow,
  RecurringPaymentStepSignatureSlot,
} from "@/db/repositories/payment-recurring-payments.repository";
import { createPostgresPaymentRecurringPaymentsRepository } from "@/db/repositories/payment-recurring-payments.repository.postgres";
import type {
  PaymentSubscriptionPlanRow,
  PaymentSubscriptionRow,
} from "@/db/repositories/payment-subscriptions.repository";
import { createTokenRepository } from "@/db/repositories/repository-factory";
import { createPostgresSubscriptionAuthorityRevocationsRepository } from "@/db/repositories/subscription-authority-revocations.repository";
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
import { getLogger } from "@/runtime/logger";
import { parseGrantsColumn } from "@/services/api-key.service";
import {
  isNativePaymentToken,
  normalizePaymentToken,
  parseU64String,
} from "@/services/payment-operation.service";
import { loadPaymentMint, parseStaticPaymentAmount } from "@/services/payments/token-amount";
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
 * Resolves a recurring-payment token to its mint, refusing native SOL.
 *
 * @param token - The requested token, a mint address or well-known symbol.
 * @returns The token's mint.
 */
export function resolveRecurringPaymentTokenMint(token: string): Address {
  if (isNativePaymentToken(token)) {
    throw badRequest(RECURRING_PAYMENT_TOKEN_ERROR);
  }
  return assertValidAddress(normalizePaymentToken(token), "token");
}

/**
 * Admits a mint for new recurring work: a well-known USD stablecoin on the open
 * scope's cluster or an active token issued in the project. It is start
 * admission, so recovering work already sent does not ask it.
 *
 * @param params - The mint and the tenant it is admitted for.
 * @param params.mint - The schedule's mint.
 * @param params.organizationId - The schedule's organization.
 * @param params.projectId - The schedule's project, where issued tokens are looked up.
 * @param params.env - The API environment.
 */
export async function assertRecurringPaymentTokenAdmitted(params: {
  mint: Address;
  organizationId: string;
  projectId: string;
  env: Env;
}): Promise<void> {
  const wellKnown = WELL_KNOWN_TOKEN_BY_MINT.get(params.mint);
  if (wellKnown) {
    if (!wellKnown.isUsdStable) {
      throw badRequest(RECURRING_PAYMENT_TOKEN_ERROR);
    }
    return;
  }
  const issuedTokenStatus = await createTokenRepository(
    params.env,
    createTenantScope({ organizationId: params.organizationId, projectId: params.projectId })
  ).getStatusByMint(params.projectId, params.mint);
  if (issuedTokenStatus !== "active") {
    throw badRequest(RECURRING_PAYMENT_TOKEN_ERROR);
  }
}

/**
 * Admits a recurring payment's token and amount for new work: the token must be
 * admitted (`assertRecurringPaymentTokenAdmitted`), and the amount must convert to
 * a fixed raw amount at its mint's decimals.
 *
 * @param params - The terms and the tenant they belong to.
 * @param params.token - The requested token, a mint address or well-known symbol.
 * @param params.amount - The per-period UI amount.
 * @param params.organizationId - The schedule's organization.
 * @param params.projectId - The schedule's project, where issued tokens are looked up.
 * @param params.env - The API environment.
 * @returns The token's mint.
 */
export async function assertRecurringPaymentTerms(params: {
  token: string;
  amount: string;
  organizationId: string;
  projectId: string;
  env: Env;
}): Promise<Address> {
  const mint = resolveRecurringPaymentTokenMint(params.token);
  await assertRecurringPaymentTokenAdmitted({ ...params, mint });
  await parseStaticPaymentAmount(params.amount, mint);
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
  const { tokenProgram, toBaseUnits } = await loadPaymentMint(mint);
  const amountBaseUnits = toBaseUnits(plan.amount);

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
  submissionStore: SignedSubmissionStore;
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
    input.movement,
    { custodyWalletId: input.sourceWallet.id }
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
  return submitSponsoredTransaction({
    feePayment,
    rpc,
    transaction: txBytes,
    lastValidBlockHeight,
    store: input.submissionStore,
  });
}

/** A row holding one of a step's saved signatures. */
export interface SubscriptionStepSignatureRow {
  slot: RecurringPaymentStepSignatureSlot;
  /** The recurring payment's id for `recurring_payment`, otherwise the attempt's. */
  id: string;
}

/** Where one subscription step's signature is saved: its tenant and every row that holds it. */
export interface SubscriptionStep {
  env: Env;
  organizationId: string;
  projectId: string;
  rows: readonly SubscriptionStepSignatureRow[];
}

/** A step's send that an earlier run saved before broadcasting it. */
export interface SavedStepSend {
  signature: Signature;
  /**
   * The expiry of the blockhash it was signed with. Null only for a step an earlier attempt saved
   * and landed: a reset activation carries those signatures into its new attempt without it.
   */
  lastValidBlockHeight: bigint | null;
}

/**
 * The saved send a step's stored columns describe.
 *
 * @param signature - The step's stored signature, or null when no run saved one.
 * @param lastValidBlockHeight - The attempt's stored block height.
 * @returns The saved send, or null when there is no signature.
 */
export function savedStepSend(
  signature: string | null,
  lastValidBlockHeight: string | null
): SavedStepSend | null {
  const parsedSignature = parseNullableStoredSignature(signature);
  if (parsedSignature === null) return null;
  return {
    signature: parsedSignature,
    lastValidBlockHeight: lastValidBlockHeight === null ? null : BigInt(lastValidBlockHeight),
  };
}

/**
 * Clears a step's saved signature, and an attempt row's block height, from every row that holds
 * it, in one transaction. Each row is cleared only while it still holds `signature`.
 *
 * @param step - The step whose rows to clear.
 * @param signature - The signature the step saved.
 * @param reason - `refused` after a send the RPC provably refused, which leaves a row that no
 *   longer holds the signature as it is; `cannot_land` when the chain proves the saved send can
 *   never land, which refuses unless every row still holds it, so a concurrent run keeps its step.
 * @returns Resolves once the rows are cleared.
 * @throws ResumedStepUnsettledError for `cannot_land` when a row no longer holds the signature.
 */
async function clearSubscriptionStepSignature(
  step: SubscriptionStep,
  signature: Signature,
  reason: "refused" | "cannot_land"
): Promise<void> {
  const updatedAt = new Date().toISOString();
  await getDb(step.env).transaction(async (tx) => {
    const recurringRepo = createPostgresPaymentRecurringPaymentsRepository(tx);
    for (const row of step.rows) {
      const cleared = await recurringRepo.clearStepSignature({
        ...row,
        organizationId: step.organizationId,
        projectId: step.projectId,
        signature,
        updatedAt,
      });
      getLogger().info(
        {
          project_id: step.projectId,
          row_id: row.id,
          slot: `${row.slot.row}.${row.slot.column}`,
          signature,
          cleared,
          reason,
        },
        "Recurring payment step signature cleared"
      );
      if (!cleared && reason === "cannot_land") {
        throw new ResumedStepUnsettledError("Recurring payment step changed concurrently; retry");
      }
    }
  });
}

/**
 * The submission store every subscription step sends with. `save` writes the step's signature and
 * its blockhash's expiry before the send; after a provably refused send, the step's rows are
 * cleared, so a retry sends again instead of waiting on a transaction that never left. Recovery
 * reads the saved send and the chain, so there is no started marker.
 *
 * @param step - The step's rows and the writer that saves its send to them.
 * @param step.save - Writes the signature and the block height to the step's rows.
 * @returns The store.
 */
export function createSubscriptionStepStore(
  step: SubscriptionStep & {
    save: (send: { signature: Signature; lastValidBlockHeight: string }) => Promise<void>;
  }
): SignedSubmissionStore {
  return {
    persistSigned: ({ signature, lastValidBlockHeight }) =>
      step.save({ signature, lastValidBlockHeight }),
    markStarted: async () => {},
    hasStarted: async () => false,
    clearSigned: (signature) => clearSubscriptionStepSignature(step, signature, "refused"),
  };
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
 * A step this run may send: `landed` when its effect is on chain at `finalized`, so it is not sent
 * again; `not_sent` when nothing of it can still land, so it is sent (`account` is the `finalized`
 * read, for building it).
 */
export type ResumedStep<T> = { kind: "landed" | "not_sent"; account: T };

/**
 * The chain cannot settle a step yet: it is landing but not final, its saved send may still land
 * or succeeded but is not visible, or a read failed. The step may be on chain, so the attempt stays
 * in flight for the next run instead of failing or resetting; the request answers 409.
 */
export class ResumedStepUnsettledError extends AppError {
  constructor(message: string) {
    super("CONFLICT", message);
    this.name = "ResumedStepUnsettledError";
  }
}

/**
 * Reads what the chain says about a step an earlier run may have sent, before this run sends it.
 * A step has three outcomes, whatever failed before it (custody, Kora, RPC or the database):
 *
 * - Landed: its effect is on chain at `finalized`.
 * - Not sent: no run saved a send, or the saved send has no record past its blockhash's expiry,
 *   so it can never land. That signature is cleared first, so a concurrent run keeps its step.
 * - Unknown: the effect is on chain at `confirmed` only, the saved send succeeded but its effect
 *   is not visible yet, it has no record before its expiry, or a read failed. It may be on chain,
 *   so this throws for a later run instead of sending or unwinding.
 *
 * A saved send that failed on chain throws TRANSACTION_FAILED once its signature is cleared, so
 * the flow unwinds instead of signing the same refused step again.
 *
 * @param input - The step and how to read it.
 * @param input.rpc - The cluster's RPC.
 * @param input.read - Reads the step's account at a commitment.
 * @param input.landed - Whether the account shows the step's effect.
 * @param input.savedSend - The send an earlier run saved for this step, if it got that far.
 * @param input.step - The rows holding the step's signature.
 * @param input.failureMessage - The TRANSACTION_FAILED message when the saved send failed on chain.
 * @param input.logContext - What the warnings name.
 * @returns The step, landed or not sent.
 * @throws ResumedStepUnsettledError when the outcome is unknown.
 * @throws AppError `TRANSACTION_FAILED` when the saved send failed on chain.
 */
export async function readRecurringPaymentStep<T extends { exists: boolean }>(input: {
  rpc: SolanaRpc;
  read: (commitment: "finalized" | "confirmed") => Promise<T>;
  landed: (account: T) => boolean;
  savedSend: SavedStepSend | null;
  step: SubscriptionStep;
  failureMessage: string;
  logContext: ResumedStepLogContext;
}): Promise<ResumedStep<T>> {
  try {
    return await readStepOutcome(input);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    getLogger().warn(
      { ...input.logContext, err: error },
      "Recurring payment step could not be read on chain"
    );
    throw new ResumedStepUnsettledError("Recurring payment step could not be read on chain; retry");
  }
}

/** {@link readRecurringPaymentStep} without its mapping of read failures to 409. */
async function readStepOutcome<T extends { exists: boolean }>(
  input: Parameters<typeof readRecurringPaymentStep<T>>[0]
): Promise<ResumedStep<T>> {
  const finalized = await input.read("finalized");
  if (input.landed(finalized)) {
    if (input.savedSend === null) {
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
  if (input.savedSend === null) {
    return { kind: "not_sent", account: finalized };
  }

  const { signature } = input.savedSend;
  const outcome = await readSavedSend(input.rpc, input.savedSend);
  switch (outcome) {
    case "succeeded":
      throw stepStillLanding();
    case "pending":
      throw new ResumedStepUnsettledError("Recurring payment step may still land on chain; retry");
    case "failed":
      await clearSubscriptionStepSignature(input.step, signature, "cannot_land");
      throw transactionFailed(input.failureMessage);
    case "expired":
      await clearSubscriptionStepSignature(input.step, signature, "cannot_land");
      getLogger().warn(
        { ...input.logContext, signature },
        "Recurring payment step's saved send expired without landing; sending it again"
      );
      return { kind: "not_sent", account: finalized };
    default: {
      const exhaustive: never = outcome;
      throw internalError(`Unknown saved send outcome: ${exhaustive}`);
    }
  }
}

/** What the chain says about a saved send. */
export type SavedSendOutcome =
  /** It landed and succeeded. */
  | "succeeded"
  /** It landed and failed, so it can never succeed. */
  | "failed"
  /** No record yet, and its blockhash is still valid: it may land. */
  | "pending"
  /** No record past its blockhash's expiry: it can never land. */
  | "expired";

/**
 * Reads a saved send from the chain. A send with no record is proven never landed only once the
 * chain's block height is past the expiry of the blockhash it was signed with.
 *
 * @param rpc - The cluster's RPC.
 * @param savedSend - The send's signature and its blockhash's expiry.
 * @returns What the chain says about the send.
 * @throws AppError `INTERNAL_ERROR` when the send has no record and no saved expiry to prove it.
 */
export async function readSavedSend(
  rpc: SolanaRpc,
  savedSend: SavedStepSend
): Promise<SavedSendOutcome> {
  // Read before the status: once the chain is past the expiry, nothing lands after the status read.
  const chainTip = await withTransientRpcRetry(() =>
    rpc.getEpochInfo({ commitment: "confirmed" }).send()
  );
  const statuses = await withTransientRpcRetry(() =>
    rpc.getSignatureStatuses([savedSend.signature], { searchTransactionHistory: true }).send()
  );
  const [status] = statuses.value;
  if (status) {
    // Seen only at "processed", the verdict may be on a fork the cluster drops: a failure
    // there does not stop the same send landing, so resending it could collect twice
    // (APE SOLA9-708).
    if (status.confirmationStatus === null || status.confirmationStatus === "processed") {
      return "pending";
    }
    return status.err === null ? "succeeded" : "failed";
  }
  if (savedSend.lastValidBlockHeight === null) {
    throw internalError("A saved send with no record has no block height to prove its expiry");
  }
  if (chainTip.blockHeight <= savedSend.lastValidBlockHeight) {
    return "pending";
  }
  // The pool may answer the two reads from different nodes: only a node that has processed the
  // slot the expiry was seen at has seen every block the send could have landed in.
  return statuses.context.slot >= chainTip.absoluteSlot ? "expired" : "pending";
}

/**
 * {@link readRecurringPaymentStep} for a step only some runs resume: null when this run starts
 * the step, or when nothing of it can still land; the account when it landed.
 *
 * @param resumed - Whether an earlier run reached this step.
 * @param input - The step and how to read it, as {@link readRecurringPaymentStep} takes them.
 * @returns The landed account, or null when the step is to be sent.
 */
export async function readRecurringPaymentStepIfResumed<T extends { exists: boolean }>(
  resumed: boolean,
  input: Parameters<typeof readRecurringPaymentStep<T>>[0]
): Promise<T | null> {
  if (!resumed) {
    return null;
  }
  const step = await readRecurringPaymentStep(input);
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
 * way from their organization and project membership rows, which removal
 * and role changes write; no
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
    // The project membership is share-locked too, so a removal from the
    // project either commits first (and refuses) or waits for the claim.
    const member = await tx.queryOne<{ status: string; role: string; inProject: boolean }>(
      `SELECT om.status, om.role,
              EXISTS (
                SELECT 1 FROM project_members pm
                 WHERE pm.user_id = om.user_id AND pm.project_id = ?
                 FOR SHARE
              ) AS "inProject"
         FROM organization_members om
        WHERE om.user_id = ? AND om.organization_id = ?
        FOR SHARE OF om`,
      [input.projectId, userId, input.organizationId]
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

/**
 * Inside a claim that may use a wallet's Subscriptions authorities (activation, update, resume),
 * waits out and then refuses a revoke of them in flight (HOO-2210). The revoke cron claims under
 * the same per-wallet lock and skips a wallet with one of these in flight, so a subscription never
 * lands on an authority that is being closed. A refused claim commits nothing and answers 409.
 *
 * @param tx - The claim's transaction.
 * @param input - The project and every custody wallet the claimed operation signs with.
 * @returns Resolves once no revoke holds the wallets' authorities.
 * @throws AppError `CONFLICT` while a revoke on one of the wallets is in flight.
 */
export async function refuseWhileSubscriptionAuthorityRevokes(
  tx: DatabaseExecutor,
  input: { projectId: string; custodyWalletIds: readonly string[] }
): Promise<void> {
  const wallets = await tx.queryMany<{ public_key: string; environment: SdpEnvironment }>(
    `SELECT DISTINCT w.public_key, p.environment
       FROM custody_wallets w, projects p
      WHERE w.id = ANY(?::text[]) AND p.id = ?
      ORDER BY w.public_key`,
    [[...input.custodyWalletIds], input.projectId]
  );
  const revocations = createPostgresSubscriptionAuthorityRevocationsRepository(tx);
  for (const wallet of wallets) {
    await revocations.lockWalletAuthorities(wallet.public_key);
    if (
      await revocations.hasRevocationHolding({
        environment: wallet.environment,
        walletAddress: wallet.public_key,
      })
    ) {
      throw conflict(
        "This wallet's recurring payment authorization is being cleaned up; retry in a minute"
      );
    }
  }
}
