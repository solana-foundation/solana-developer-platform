import { decideRecurringPaymentStep } from "@sdp/payments/recurring-payment-lifecycle";
import { createClusterRpc } from "@sdp/rpc/factory";
import { confirmTransaction, getRecentBlockhash } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
import type { ApiKeyWalletScope } from "@sdp/types/api-keys";
import type { MovementId } from "@sdp/types/movements";
import {
  type ActionableRecurringPaymentStepState,
  assertNever,
  type PreparedPaymentSubscriptionTransaction,
} from "@sdp/types/payments";
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
  isSome,
  type MaybeEncodedAccount,
  parseBase64RpcAccount,
  partiallySignTransactionMessageWithSigners,
  pipe,
  removeNullCharacters,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";
import { decodePlan, decodeSubscriptionDelegation, findPlanPda } from "@solana/subscriptions";
import { decodeToken } from "@solana-program/token-2022";
import type { DatabaseExecutor } from "@/db/client";
import type {
  PaymentRecurringPaymentRow,
  RecurringPaymentStepSignatureSlot,
} from "@/db/repositories/payment-recurring-payments.repository";
import type {
  PaymentSubscriptionPlanRow,
  PaymentSubscriptionRow,
} from "@/db/repositories/payment-subscriptions.repository";
import {
  createPaymentRecurringPaymentsRepository,
  createTokenRepository,
} from "@/db/repositories/repository-factory";
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
import { logEvent } from "@/runtime/money-path-events";
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
  return submitSponsoredTransaction({
    feePayment,
    rpc,
    transaction: txBytes,
    lastValidBlockHeight,
    store: input.submissionStore,
  });
}

/**
 * The submission store every subscription step sends with. The step's signature and expiry are
 * saved on its attempt row before the send, only into an empty slot; after a provably refused
 * send the slot is cleared, only while it still holds that signature, so a retry sends again
 * instead of waiting on a transaction that never left. Recovery reads the saved signature and the
 * chain, so there is no started marker.
 *
 * @param step - The step's tenant, schedule id, attempt id and signature slot.
 * @returns The store.
 */
export function createSubscriptionStepStore(step: {
  env: Env;
  organizationId: string;
  projectId: string;
  slot: RecurringPaymentStepSignatureSlot;
  recurringPaymentId: string;
  attemptId: string;
}): SignedSubmissionStore {
  const recurringRepo = createPaymentRecurringPaymentsRepository(step.env, createTenantScope(step));
  const target = {
    slot: step.slot,
    id: step.attemptId,
    recurringPaymentId: step.recurringPaymentId,
    organizationId: step.organizationId,
    projectId: step.projectId,
  };
  return {
    persistSigned: async ({ signature, lastValidBlockHeight }) => {
      const saved = await recurringRepo.setStepSignature({
        ...target,
        signature,
        lastValidBlockHeight,
        updatedAt: new Date().toISOString(),
      });
      if (!saved) {
        throw conflict("Recurring payment step signature changed concurrently");
      }
    },
    markStarted: async () => {},
    hasStarted: async () => false,
    clearSigned: async (signature) => {
      const cleared = await recurringRepo.clearStepSignature({
        ...target,
        signature,
        updatedAt: new Date().toISOString(),
      });
      getLogger().info(
        {
          project_id: step.projectId,
          attempt_id: step.attemptId,
          slot: `${step.slot.row}.${step.slot.column}`,
          signature,
          cleared,
        },
        "Recurring payment step signature cleared after a refused send"
      );
    },
  };
}

/** What a step's logs name. */
export interface RecurringPaymentStepLogContext {
  recurring_payment_id: string;
  attempt_id: string;
  step:
    | "create_plan"
    | "authorization_setup"
    | "authorize_subscription"
    | "update_plan"
    | "cancel_old_subscription"
    | "cancel"
    | "resume";
}

/**
 * A step's effect: the accounts whose state proves the step landed, and the test over them, in
 * the order of `addresses`. Only the attempt causes its effect, so the effect settles a saved
 * send without reading the signature's status.
 */
export interface RecurringPaymentStepEffect {
  addresses: readonly Address[];
  landed: (accounts: readonly MaybeEncodedAccount[]) => boolean;
}

/** A resumed step the flow acts on now: it landed, or it was never sent. */
export interface ActionableRecurringPaymentStep {
  state: ActionableRecurringPaymentStepState;
  accounts: readonly MaybeEncodedAccount[];
}

/**
 * A step as the chain shows it at `confirmed`. Only an actionable step carries the effect
 * accounts, for the caller to decode what its next transaction needs; nothing acts on a pending
 * or dropped step's accounts.
 */
export type RecurringPaymentStepRead =
  | { state: "pending" }
  | { state: "dropped" }
  | ActionableRecurringPaymentStep;

/**
 * The chain cannot settle a resumed step yet: its saved send may still land, or the read itself
 * failed. The step may be on chain, so the attempt stays in flight for the next run instead of
 * failing or resetting; the request answers 409.
 */
export class ResumedStepUnsettledError extends AppError {
  constructor() {
    super("CONFLICT", "Recurring payment step is not settled on chain yet; retry");
    this.name = "ResumedStepUnsettledError";
  }
}

/**
 * Reads a step an earlier run reached, in two RPC calls on the cluster pool: the `confirmed`
 * epoch info (slot S and block height c), then every effect account in one `getMultipleAccounts`
 * at `confirmed` from a bank at slot S or later, so the accounts include every block up to c.
 * The step is landed when the effect shows; otherwise unsent with no saved signature, dropped
 * once c is past the saved send's expiry, and pending before it. A failed read, an answer from a
 * bank below S, or an effect that does not decode is pending. A saved signature with no stored
 * expiry is pending and logged: it may be a live transaction, so it is never sent again.
 *
 * @param input - The step to read.
 * @param input.effect - The accounts that show the step's effect, and the test over them.
 * @param input.savedSignature - The signature saved in the step's slot, or null when none was.
 * @param input.lastValidBlockHeight - The attempt row's stored expiry (a u64 decimal string),
 *   which belongs to its latest saved step; earlier steps landed before the next one saved.
 * @param input.logContext - What the step's logs name.
 * @returns The step's state, with the effect accounts unless it is pending.
 */
export async function readRecurringPaymentStep(input: {
  effect: RecurringPaymentStepEffect;
  savedSignature: Signature | null;
  lastValidBlockHeight: string | null;
  logContext: RecurringPaymentStepLogContext;
}): Promise<RecurringPaymentStepRead> {
  let observed: Awaited<ReturnType<typeof observeRecurringPaymentStep>>;
  try {
    observed = await observeRecurringPaymentStep(input.effect);
  } catch (error) {
    getLogger().warn(
      { ...input.logContext, err: error },
      "Recurring payment step could not be read on chain"
    );
    return { state: "pending" };
  }

  const state = decideRecurringPaymentStep({
    landed: observed.landed,
    saved:
      input.savedSignature === null
        ? null
        : {
            lastValidBlockHeight:
              input.lastValidBlockHeight === null ? null : BigInt(input.lastValidBlockHeight),
          },
    blockHeight: observed.blockHeight,
  });
  if (state === "landed" && input.savedSignature === null) {
    getLogger().warn(
      input.logContext,
      "Recurring payment step found on chain without its saved signature"
    );
  }
  if (state === "pending" && input.savedSignature !== null && input.lastValidBlockHeight === null) {
    logEvent("warn", {
      event: "sdp_api_recurring_payment_step_expiry_missing",
      ...input.logContext,
      signature: input.savedSignature,
    });
  }
  switch (state) {
    case "pending":
    case "dropped":
      return { state };
    case "landed":
    case "unsent":
      return { state, accounts: observed.accounts };
    default:
      return assertNever(state);
  }
}

/**
 * The block height and effect accounts one step read sees.
 *
 * @param effect - The step's effect.
 * @returns The `confirmed` block height, the effect accounts and whether they show the effect.
 * @throws When a read fails, the accounts come from a bank below the epoch read's slot, the
 *   answer lists a different number of accounts, or an account does not decode.
 */
async function observeRecurringPaymentStep(
  effect: RecurringPaymentStepEffect
): Promise<{ blockHeight: bigint; accounts: MaybeEncodedAccount[]; landed: boolean }> {
  const rpc = createClusterRpc();
  const epochInfo = await rpc.getEpochInfo({ commitment: "confirmed" }).send();
  const response = await rpc
    .getMultipleAccounts(effect.addresses, {
      commitment: "confirmed",
      minContextSlot: epochInfo.absoluteSlot,
      encoding: "base64",
    })
    .send();
  // The pool does not check the answering bank's slot, so it is checked here.
  if (response.context.slot < epochInfo.absoluteSlot) {
    throw new Error(
      `getMultipleAccounts answered from slot ${response.context.slot}, below ${epochInfo.absoluteSlot}`
    );
  }
  if (response.value.length !== effect.addresses.length) {
    throw new Error(
      `getMultipleAccounts returned ${response.value.length} accounts for ${effect.addresses.length} addresses`
    );
  }
  const accounts = effect.addresses.map((address, index) =>
    parseBase64RpcAccount(address, response.value[index])
  );
  return { blockHeight: epochInfo.blockHeight, accounts, landed: effect.landed(accounts) };
}

/**
 * What today's flows do with a resumed step: landed and unsent go back to the flow, dropped
 * fails the step as a definite on-chain failure, and pending keeps the attempt in flight.
 *
 * @param step - The step as read.
 * @param failureMessage - The TRANSACTION_FAILED message for a dropped step.
 * @returns The step, when it landed or was never sent.
 * @throws AppError TRANSACTION_FAILED with `failureMessage` when the step is dropped.
 * @throws ResumedStepUnsettledError when the step is pending.
 */
export function requireActionableStep(
  step: RecurringPaymentStepRead,
  failureMessage: string
): ActionableRecurringPaymentStep {
  switch (step.state) {
    case "landed":
    case "unsent":
      return step;
    case "dropped":
      throw transactionFailed(failureMessage);
    case "pending":
      throw new ResumedStepUnsettledError();
    default:
      return assertNever(step);
  }
}

/**
 * Plan creation's effect: the plan account exists and decodes as a plan; one that does not
 * decode throws, which the reader takes as pending. It is unique to the attempt because the
 * program plan id is fresh per attempt.
 *
 * @param planPda - The plan's address.
 * @returns The effect.
 */
export function planCreatedEffect(planPda: Address): RecurringPaymentStepEffect {
  return { addresses: [planPda], landed: ([plan]) => decodePlan(plan).exists };
}

/**
 * Subscribe's effect: the subscription delegation exists and decodes as one; one that does not
 * decode throws, which the reader takes as pending.
 *
 * @param subscriptionPda - The delegation's address.
 * @returns The effect.
 */
export function delegationCreatedEffect(subscriptionPda: Address): RecurringPaymentStepEffect {
  return {
    addresses: [subscriptionPda],
    landed: ([delegation]) => decodeSubscriptionDelegation(delegation).exists,
  };
}

/**
 * Cancel's effect: the delegation carries an expiry (`cancelSubscription` sets `expiresAtTs` to
 * the end of the current period), or it is closed, which only revoking it after an earlier
 * landed cancel does.
 *
 * @param subscriptionPda - The delegation's address.
 * @returns The effect.
 */
export function delegationCanceledEffect(subscriptionPda: Address): RecurringPaymentStepEffect {
  return {
    addresses: [subscriptionPda],
    landed: ([delegation]) =>
      !delegation.exists || decodeSubscriptionDelegation(delegation).data.expiresAtTs !== 0n,
  };
}

/**
 * Resume's effect: the delegation exists with its expiry cleared to 0.
 *
 * @param subscriptionPda - The delegation's address.
 * @returns The effect.
 */
export function delegationResumedEffect(subscriptionPda: Address): RecurringPaymentStepEffect {
  return {
    addresses: [subscriptionPda],
    landed: ([delegation]) =>
      delegation.exists && decodeSubscriptionDelegation(delegation).data.expiresAtTs === 0n,
  };
}

/** The plan's update-guarded fields as the claimed schedule recorded them. */
export interface RecurringPaymentPlanMetadataPreImage {
  /** The plan's `terms.createdAt`, as a decimal string. */
  createdAt: string;
  /** The metadata URI as the program stores it, without its NUL padding. */
  metadataUri: string;
}

/**
 * Update plan's effect, a three-way compare of the plan's `createdAt` and metadata URI. The
 * target is landed. The pre-image is not landed. Any other existing plan is not landed and is
 * logged as changed outside this attempt; an absent plan is not landed and not logged, since the
 * caller fails it as not found. A resend after a not-landed read signs the pre-image as the
 * program's `expected_created_at` and `expected_metadata_uri`, so the program refuses it unless
 * the plan still holds the pre-image, and the refusal fails the step definitely. `endTs` and
 * pullers have no stored pre-image, and only SDP's key can change them.
 *
 * @param input - The plan and the values to compare.
 * @param input.planPda - The plan's address.
 * @param input.preImage - The plan as the claimed schedule recorded it.
 * @param input.preImage.createdAt - The schedule's `plan_created_at`.
 * @param input.preImage.metadataUri - The schedule's metadata URI as the program stores it.
 * @param input.targetMetadataUri - The metadata URI this attempt writes, as the program stores it.
 * @param input.logContext - What the mismatch log names.
 * @returns The effect.
 */
export function planMetadataUpdatedEffect(input: {
  planPda: Address;
  preImage: RecurringPaymentPlanMetadataPreImage;
  targetMetadataUri: string;
  logContext: RecurringPaymentStepLogContext;
}): RecurringPaymentStepEffect {
  return {
    addresses: [input.planPda],
    landed: ([account]) => {
      if (!account.exists) return false;
      const plan = decodePlan(account).data.data;
      const createdAt = plan.terms.createdAt.toString();
      if (createdAt === input.preImage.createdAt) {
        // The on-chain field is fixed at 128 bytes, padded with NULs.
        const metadataUri = removeNullCharacters(plan.metadataUri);
        if (metadataUri === input.targetMetadataUri) return true;
        if (metadataUri === input.preImage.metadataUri) return false;
      }
      logEvent("error", {
        event: "sdp_api_recurring_payment_plan_changed_outside_attempt",
        ...input.logContext,
        plan_pda: input.planPda,
        observed_created_at: createdAt,
        expected_created_at: input.preImage.createdAt,
      });
      return false;
    },
  };
}

/**
 * Authorization setup's effect: the subscription authority exists and the source token account,
 * owned by the mint's token program for this mint and owner, delegates to it.
 *
 * @param input - The setup's accounts.
 * @param input.subscriptionAuthorityAddress - The subscription authority PDA for the owner and mint.
 * @param input.sourceTokenAccount - The owner's token account for the mint.
 * @param input.owner - The source wallet.
 * @param input.mint - The plan's mint.
 * @param input.tokenProgram - The mint's token program.
 * @returns The effect.
 */
export function authorizationSetupEffect(input: {
  subscriptionAuthorityAddress: Address;
  sourceTokenAccount: Address;
  owner: Address;
  mint: Address;
  tokenProgram: Address;
}): RecurringPaymentStepEffect {
  return {
    addresses: [input.subscriptionAuthorityAddress, input.sourceTokenAccount],
    landed: ([authority, tokenAccount]) => {
      if (
        !authority.exists ||
        !tokenAccount.exists ||
        tokenAccount.programAddress !== input.tokenProgram
      ) {
        return false;
      }
      const token = decodeToken(tokenAccount).data;
      return (
        token.mint === input.mint &&
        token.owner === input.owner &&
        isSome(token.delegate) &&
        token.delegate.value === input.subscriptionAuthorityAddress
      );
    },
  };
}

/**
 * Waits for a sent subscription transaction to reach `confirmed`.
 *
 * @param signature - The sent transaction's signature.
 * @param message - The TRANSACTION_FAILED message when the transaction failed on chain.
 * @returns The slot the transaction was confirmed in, for reads that must not see an older bank.
 * @throws AppError TRANSACTION_FAILED with `message` when the confirmed status carries an error.
 */
export async function confirmSubscriptionSignature(
  signature: Signature,
  message: string
): Promise<bigint> {
  const rpc = createClusterRpc();
  const confirmation = await confirmTransaction(rpc, signature, {
    commitment: "confirmed",
  });

  if (confirmation.err) {
    throw transactionFailed(message);
  }
  return confirmation.slot;
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
