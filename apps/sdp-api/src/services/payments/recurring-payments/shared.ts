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
import {
  decodePlan,
  decodeSubscriptionDelegation,
  findPlanPda,
  isSubscriptionsError,
  type SubscriptionsError,
} from "@solana/subscriptions";
import { decodeToken } from "@solana-program/token-2022";
import type { DatabaseExecutor } from "@/db/client";
import {
  type PaymentRecurringPaymentRow,
  type PaymentRecurringPaymentsRepository,
  RECURRING_PAYMENT_STEP_SLOT_ORDER,
  type RecurringPaymentStepSignatureSlot,
  type RecurringPaymentStepSignatureSlots,
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
import { describeError, logEvent } from "@/runtime/money-path-events";
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
  SponsoredSendRefusedError,
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
 * A step that cannot land, raised inside a flow's unwinding steps: refused at preflight, dropped
 * past its expiry, or failed with nothing in flight. The flow fails back to its last stable status
 * in one transaction fenced on the step's slot: a dropped send's saved signature is cleared only
 * while the slot still holds it, and with nothing dropped the slot must still be empty, so a run
 * that took the attempt over and saved a send of its own is never unwound. The request answers
 * with `failure`.
 */
export class RecurringPaymentStepFailedError extends AppError {
  readonly failure: Error;
  readonly slot: RecurringPaymentStepSignatureSlot;
  readonly droppedSignature: Signature | null;

  /**
   * @param input - The failure and the step it failed.
   * @param input.failure - The error the request answers with.
   * @param input.slot - The failed step's signature slot.
   * @param input.droppedSignature - A dropped send's saved signature, or null when this run
   *   saved nothing in the slot.
   */
  constructor(input: {
    failure: Error;
    slot: RecurringPaymentStepSignatureSlot;
    droppedSignature: Signature | null;
  }) {
    super("TRANSACTION_FAILED", recurringPaymentErrorMessage(input.failure));
    // biome-ignore lint/security/noSecrets: the error class name, not a secret.
    this.name = "RecurringPaymentStepFailedError";
    this.failure = input.failure;
    this.slot = input.slot;
    this.droppedSignature = input.droppedSignature;
  }
}

/**
 * A step's slot and every later slot of its attempt row, in the order the flow saves them.
 *
 * @param slot - The step's slot.
 * @returns The slots from `slot` to the row's last step.
 */
function stepSlotsFrom(
  slot: RecurringPaymentStepSignatureSlot
): RecurringPaymentStepSignatureSlots {
  switch (slot.row) {
    case "activation_attempt": {
      const order = RECURRING_PAYMENT_STEP_SLOT_ORDER.activation_attempt;
      const later = order.slice(order.indexOf(slot.column) + 1);
      return [slot, ...later.map((column) => ({ row: slot.row, column }))];
    }
    case "update_attempt": {
      const order = RECURRING_PAYMENT_STEP_SLOT_ORDER.update_attempt;
      const later = order.slice(order.indexOf(slot.column) + 1);
      return [slot, ...later.map((column) => ({ row: slot.row, column }))];
    }
    case "lifecycle_attempt": {
      const order = RECURRING_PAYMENT_STEP_SLOT_ORDER.lifecycle_attempt;
      const later = order.slice(order.indexOf(slot.column) + 1);
      return [slot, ...later.map((column) => ({ row: slot.row, column }))];
    }
    default:
      return assertNever(slot);
  }
}

/**
 * Fences a step failure's unwind inside its transaction, on the failed step's slot: clears a
 * dropped send's signature only while the slot still holds it, or, with nothing dropped, holds the
 * attempt row while the slot and every later one of the row are still empty and the attempt in
 * flight, so a run that took the attempt over and saved any later step is never unwound.
 *
 * @param input - The transaction's repository, the attempt and the step failure.
 * @param input.recurringRepo - The repository bound to the failure's transaction.
 * @param input.attemptId - The run's attempt.
 * @param input.recurringPaymentId - The schedule.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.stepFailure - The step failure.
 * @param input.updatedAt - The failure's timestamp.
 * @throws AppError CONFLICT when the slot no longer holds the dropped signature, or it or a later
 *   slot holds a signature this run did not save; the transaction rolls back and the attempt stays
 *   in flight.
 */
export async function fenceRecurringPaymentStepFailure(input: {
  recurringRepo: PaymentRecurringPaymentsRepository;
  attemptId: string;
  recurringPaymentId: string;
  organizationId: string;
  projectId: string;
  stepFailure: RecurringPaymentStepFailedError;
  updatedAt: string;
}): Promise<void> {
  const target = {
    id: input.attemptId,
    recurringPaymentId: input.recurringPaymentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  };
  const fenced =
    input.stepFailure.droppedSignature === null
      ? await input.recurringRepo.lockEmptyStepSlot({
          ...target,
          slots: stepSlotsFrom(input.stepFailure.slot),
        })
      : await input.recurringRepo.clearStepSignature({
          ...target,
          slot: input.stepFailure.slot,
          signature: input.stepFailure.droppedSignature,
          updatedAt: input.updatedAt,
        });
  if (!fenced) {
    throw conflict("Recurring payment step signature changed concurrently");
  }
}

/**
 * Records an error on a run's attempt that leaves it in flight, only while it is still
 * `processing`. An attempt another run already settled is logged and left as it is. A failed
 * write is attached to `error` as its cause, keeping any cause it carried, so the request still
 * answers with `error`.
 *
 * @param input - The error, the write and what the log names.
 * @param input.error - The error the request answers with.
 * @param input.write - The attempt's error-only write, fenced to `processing`.
 * @param input.logContext - The schedule and attempt the log names.
 */
export async function journalInFlightRecurringPaymentAttempt<TAttempt>(input: {
  error: Error;
  write: () => Promise<TAttempt | null>;
  logContext: Pick<RecurringPaymentStepLogContext, "recurring_payment_id" | "attempt_id">;
}): Promise<void> {
  let journaled: TAttempt | null;
  try {
    journaled = await input.write();
  } catch (journalError) {
    input.error.cause =
      input.error.cause === undefined
        ? journalError
        : new AggregateError(
            [input.error.cause, journalError],
            "Recurring payment attempt journal failed"
          );
    return;
  }
  if (journaled === null) {
    getLogger().warn(
      input.logContext,
      "Recurring payment attempt was settled by another run before its error was journaled"
    );
  }
}

/**
 * One run's unwinding steps. `unreadSavedStep` is the latest step an earlier run saved a signature
 * for, until this run reads it landed: its send may still land, so until then a failure leaves
 * the attempt in flight instead of failing it. Only the latest saved step can be in flight; every
 * earlier one landed before it saved. `step` is the step the run is working toward, which the flow
 * moves forward as each step settles: a failure no step names fails that step, fenced on its slot.
 */
export interface RecurringPaymentStepPhase {
  unreadSavedStep: RecurringPaymentStepSignatureSlot["column"] | null;
  step: RecurringPaymentStepSignatureSlot;
}

/**
 * Runs a flow's unwinding steps. Inside them any error but a pending step becomes
 * `RecurringPaymentStepFailedError`, once no saved step is unread: the step runner settles every
 * send before it returns or throws, so nothing this run sent can still land. Every step failure,
 * raised or converted, passes `beforeUnwind` first, which may refuse the unwind.
 *
 * @param phase - The run's unwinding steps.
 * @param run - The steps.
 * @param beforeUnwind - The chain check an unwind must pass, or null when it needs none.
 * @returns What the steps return.
 * @throws ResumedStepUnsettledError when a step is pending, or `beforeUnwind` refuses the unwind.
 * @throws RecurringPaymentStepFailedError when a step fails with nothing in flight.
 */
export async function insideRecurringPaymentStepPhase<T>(
  phase: RecurringPaymentStepPhase,
  run: () => Promise<T>,
  beforeUnwind: ((stepFailure: RecurringPaymentStepFailedError) => Promise<void>) | null
): Promise<T> {
  let stepFailure: RecurringPaymentStepFailedError;
  try {
    return await run();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error instanceof ResumedStepUnsettledError ||
      (phase.unreadSavedStep !== null && !(error instanceof RecurringPaymentStepFailedError))
    ) {
      throw error;
    }
    stepFailure =
      error instanceof RecurringPaymentStepFailedError
        ? error
        : new RecurringPaymentStepFailedError({
            failure: error,
            slot: phase.step,
            droppedSignature: null,
          });
  }
  if (beforeUnwind !== null) {
    await beforeUnwind(stepFailure);
  }
  throw stepFailure;
}

/**
 * Reads an unwinding step an earlier run saved a signature for, and acts on it: landed goes on
 * (and settles the phase when it was the unread step), pending keeps the attempt in flight, and
 * dropped fails the flow and clears the saved signature with it. A saved step never reads as
 * unsent; the reader's unsent arm is kept in flight with pending.
 *
 * @param input - The saved step.
 * @param input.phase - The run's unwinding steps.
 * @param input.slot - The step's signature slot.
 * @param input.signature - The signature saved in the slot.
 * @param input.lastValidBlockHeight - The attempt row's stored expiry.
 * @param input.effect - The step's effect.
 * @param input.failureMessage - The TRANSACTION_FAILED message a dropped step answers with.
 * @param input.logContext - What the step's logs name.
 * @returns The landed step's effect accounts.
 * @throws ResumedStepUnsettledError when the step is pending.
 * @throws RecurringPaymentStepFailedError when the step is dropped.
 */
export async function readSavedRecurringPaymentStep(input: {
  phase: RecurringPaymentStepPhase;
  slot: RecurringPaymentStepSignatureSlot;
  signature: Signature;
  lastValidBlockHeight: string | null;
  effect: RecurringPaymentStepEffect;
  failureMessage: string;
  logContext: RecurringPaymentStepLogContext;
}): Promise<readonly MaybeEncodedAccount[]> {
  const step = await readRecurringPaymentStep({
    effect: input.effect,
    savedSignature: input.signature,
    lastValidBlockHeight: input.lastValidBlockHeight,
    logContext: input.logContext,
  });
  switch (step.state) {
    case "landed":
      if (input.phase.unreadSavedStep === input.slot.column) {
        input.phase.unreadSavedStep = null;
      }
      return step.accounts;
    case "unsent":
    case "pending":
      throw new ResumedStepUnsettledError();
    case "dropped":
      throw new RecurringPaymentStepFailedError({
        failure: transactionFailed(input.failureMessage),
        slot: input.slot,
        droppedSignature: input.signature,
      });
    default:
      return assertNever(step);
  }
}

/** A step send as settled: sent and confirmed now, or found landed after its send failed. */
export type SettledRecurringPaymentStep =
  | {
      state: "sent";
      signature: Signature;
      /** The slot the send confirmed in; reads after it ask for a bank at least this new. */
      confirmedSlot: bigint;
    }
  | {
      state: "landed";
      /** Null when the send was refused as already done, which cleared its slot. */
      signature: Signature | null;
      accounts: readonly MaybeEncodedAccount[];
    };

/**
 * What a step that cannot land does to its flow: `unwind` fails it back to its last stable
 * status; `stay_in_flight` (a replacement's old-subscription cancel, past the unwinding steps)
 * leaves it in flight to send again, after `onDropped` handles a dropped send's saved signature.
 */
export type RecurringPaymentStepFailureOutcome =
  | { outcome: "unwind" }
  | { outcome: "stay_in_flight"; onDropped: (signature: Signature) => Promise<void> };

export interface RecurringPaymentStepSend {
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  attemptId: string;
  movement: MovementId;
  sourceWallet: CustodyWallet;
  sourceSigner: TransactionSigner;
  feePayer?: Address;
  instructions: Instruction[];
  slot: RecurringPaymentStepSignatureSlot;
  effect: RecurringPaymentStepEffect;
  /**
   * The program error a resend raises when an earlier send of this step may already have landed,
   * and what a re-read that does not show the effect means: `pending` when the error proves the
   * effect exists (the reading endpoint lags the simulating one), `failed` when the error also
   * fires without it.
   */
  alreadyDone: {
    code: SubscriptionsError;
    notLanded: "pending" | "failed";
  } | null;
  onFailure: RecurringPaymentStepFailureOutcome;
  failureMessage: string;
  logContext: RecurringPaymentStepLogContext;
}

/**
 * Sends one step and settles it before returning, so no caller acts on a send in flight. A send
 * confirmed now is sent. A preflight refusal cleared the step's slot and nothing left; it fails
 * the step, unless the program refused it as already done, which re-reads the effect. Any other
 * error reloads the step's slot: an empty one means nothing was saved, so nothing left and the
 * step fails; a saved signature (an ambiguous send, a confirmation timeout, an on-chain error at
 * `processed`) reads the step: landed goes on, pending keeps the attempt in flight, and dropped
 * fails the step. The read costs two RPC calls, only on these error paths.
 *
 * @param input - The step's send.
 * @returns The step as settled.
 * @throws ResumedStepUnsettledError when the step is pending.
 * @throws RecurringPaymentStepFailedError when an unwinding step fails.
 * @throws The send's error when a step that stays in flight fails.
 */
export async function sendRecurringPaymentStep(
  input: RecurringPaymentStepSend
): Promise<SettledRecurringPaymentStep> {
  try {
    const signature = await sendSubscriptionInstructions({
      movement: input.movement,
      env: input.env,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sourceWallet: input.sourceWallet,
      sourceSigner: input.sourceSigner,
      instructions: input.instructions,
      feePayer: input.feePayer,
      submissionStore: createSubscriptionStepStore({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        slot: input.slot,
        recurringPaymentId: input.recurringPaymentId,
        attemptId: input.attemptId,
      }),
    });
    const confirmedSlot = await confirmSubscriptionSignature(signature, input.failureMessage);
    return { state: "sent", signature, confirmedSlot };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error instanceof SponsoredSendRefusedError) {
      if (
        input.alreadyDone === null ||
        !isSubscriptionsError(
          error.refusal,
          { instructions: input.instructions },
          input.alreadyDone.code
        )
      ) {
        return failRecurringPaymentStep(input, error, null);
      }
      return settleAlreadyDoneRefusal(input, input.alreadyDone.notLanded, error);
    }
    const saved = await reloadSavedRecurringPaymentStep(input);
    // The store saves before the send, so an empty slot proves this run broadcast nothing.
    if (saved.signature === null) {
      return failRecurringPaymentStep(input, error, null);
    }
    return settleFailedRecurringPaymentStep(input, {
      signature: saved.signature,
      lastValidBlockHeight: saved.lastValidBlockHeight,
    });
  }
}

/**
 * The step's slot as the store left it after a failed send: the local attempt row predates the
 * save. A failed read cannot tell whether the send left, so it is pending.
 *
 * @param input - The step's send.
 * @returns The saved signature, or null when none is saved, and the row's stored expiry.
 * @throws ResumedStepUnsettledError when the slot cannot be read, or the attempt is no longer in
 *   flight.
 */
async function reloadSavedRecurringPaymentStep(
  input: RecurringPaymentStepSend
): Promise<{ signature: Signature | null; lastValidBlockHeight: string | null }> {
  let saved: Awaited<ReturnType<PaymentRecurringPaymentsRepository["getStepSignature"]>>;
  try {
    saved = await createPaymentRecurringPaymentsRepository(
      input.env,
      createTenantScope(input)
    ).getStepSignature({
      slot: input.slot,
      id: input.attemptId,
      recurringPaymentId: input.recurringPaymentId,
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
  } catch (readError) {
    logEvent("warn", {
      event: "sdp_api_recurring_payment_step_reload_failed",
      ...input.logContext,
      ...describeError(readError),
    });
    throw new ResumedStepUnsettledError();
  }
  if (saved === null) {
    throw new ResumedStepUnsettledError();
  }
  return {
    signature: parseNullableStoredSignature(saved.signature),
    lastValidBlockHeight: saved.lastValidBlockHeight,
  };
}

/**
 * Reads a step whose resend the program refused as already done; the refusal cleared its slot,
 * so the read carries no saved signature. Landed goes on with no signature. Not landed is
 * pending or failed as the refusal's `notLanded` says: pending keeps the attempt in flight, and
 * the next run finds the slot empty and sends again.
 *
 * @param input - The step's send.
 * @param notLanded - What a read that does not show the effect means.
 * @param refusal - The refusal.
 * @returns The landed step.
 * @throws ResumedStepUnsettledError when the read is pending, or not landed and `notLanded` is
 *   `pending`.
 * @throws RecurringPaymentStepFailedError when an unwinding step is not landed and `notLanded`
 *   is `failed`.
 * @throws `refusal` when a step that stays in flight is not landed and `notLanded` is `failed`.
 */
async function settleAlreadyDoneRefusal(
  input: RecurringPaymentStepSend,
  notLanded: "pending" | "failed",
  refusal: SponsoredSendRefusedError
): Promise<SettledRecurringPaymentStep> {
  const step = await readRecurringPaymentStep({
    effect: input.effect,
    savedSignature: null,
    lastValidBlockHeight: null,
    logContext: input.logContext,
  });
  switch (step.state) {
    case "landed":
      return { state: "landed", signature: null, accounts: step.accounts };
    case "pending":
      throw new ResumedStepUnsettledError();
    case "unsent":
    case "dropped":
      switch (notLanded) {
        case "pending":
          throw new ResumedStepUnsettledError();
        case "failed":
          return failRecurringPaymentStep(input, refusal, null);
        default:
          return assertNever(notLanded);
      }
    default:
      return assertNever(step);
  }
}

/**
 * Reads a step whose send failed after the store saved its signature, and acts on it. A saved
 * step never reads as unsent; the reader's unsent arm is kept in flight with pending.
 *
 * @param input - The step's send.
 * @param saved - The step's saved signature and the row's stored expiry.
 * @param saved.signature - The saved signature.
 * @param saved.lastValidBlockHeight - The stored expiry.
 * @returns The landed step.
 * @throws ResumedStepUnsettledError when the step is pending.
 * @throws RecurringPaymentStepFailedError when an unwinding step is dropped.
 * @throws A TRANSACTION_FAILED error when a step that stays in flight is dropped, after
 *   `onDropped` ran.
 */
async function settleFailedRecurringPaymentStep(
  input: RecurringPaymentStepSend,
  saved: { signature: Signature; lastValidBlockHeight: string | null }
): Promise<SettledRecurringPaymentStep> {
  const step = await readRecurringPaymentStep({
    effect: input.effect,
    savedSignature: saved.signature,
    lastValidBlockHeight: saved.lastValidBlockHeight,
    logContext: input.logContext,
  });
  switch (step.state) {
    case "landed":
      return { state: "landed", signature: saved.signature, accounts: step.accounts };
    case "unsent":
    case "pending":
      throw new ResumedStepUnsettledError();
    case "dropped": {
      if (input.onFailure.outcome === "stay_in_flight") {
        await input.onFailure.onDropped(saved.signature);
      }
      return failRecurringPaymentStep(
        input,
        transactionFailed(input.failureMessage),
        saved.signature
      );
    }
    default:
      return assertNever(step);
  }
}

/**
 * Fails a step that cannot land, as its outcome says.
 *
 * @param input - The step's send.
 * @param failure - The error the request answers with.
 * @param droppedSignature - A dropped send's saved signature, or null when none is saved.
 * @throws RecurringPaymentStepFailedError for an unwinding step.
 * @throws `failure` for a step that stays in flight.
 */
function failRecurringPaymentStep(
  input: RecurringPaymentStepSend,
  failure: Error,
  droppedSignature: Signature | null
): never {
  switch (input.onFailure.outcome) {
    case "unwind":
      throw new RecurringPaymentStepFailedError({ failure, slot: input.slot, droppedSignature });
    case "stay_in_flight":
      throw failure;
    default:
      return assertNever(input.onFailure);
  }
}

/**
 * The source wallet's signer for a run's new sends, resolved on the first call, just before the
 * first send the run needs: a run that only reads saved steps never resolves it, so a wallet that
 * can no longer sign still finishes what landed and waits on what is pending. A recovered run is
 * admitted first. A refusal, or a signer that cannot be resolved or signs for another address, is
 * logged as an error and thrown; every later call returns the same outcome.
 *
 * @param input - The wallet, its movement and the run's admission.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.sourceWallet - The wallet that signs.
 * @param input.movement - The movement the signer decides on.
 * @param input.admitRecovered - Money admission for a recovered run, or null when the run needs
 *   none here (a fresh start admitted before its claim, or an exit).
 * @param input.logContext - The schedule and attempt the error log names.
 * @returns A function that resolves the signer.
 */
export function lazyRecurringPaymentStepSigner(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  movement: MovementId;
  admitRecovered: (() => Promise<void>) | null;
  logContext: Pick<RecurringPaymentStepLogContext, "recurring_payment_id" | "attempt_id">;
}): () => Promise<TransactionSigner> {
  let signer: Promise<TransactionSigner> | null = null;
  const resolveSigner = async (): Promise<TransactionSigner> => {
    try {
      if (input.admitRecovered !== null) {
        await input.admitRecovered();
      }
      const resolved = await createOrgSignerForCustodyWallet(
        input.env,
        input.organizationId,
        input.projectId,
        input.sourceWallet.id,
        input.movement
      );
      if (resolved.address !== input.sourceWallet.publicKey) {
        throw badRequest("Resolved signing wallet does not match source wallet");
      }
      return resolved;
    } catch (error) {
      logEvent("error", {
        event: "sdp_api_recurring_payment_step_unsendable",
        ...input.logContext,
        movement: input.movement,
        ...describeError(error),
      });
      throw error;
    }
  };
  return () => {
    if (signer === null) {
      signer = resolveSigner();
    }
    return signer;
  };
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
 * caller fails it as not found. Every send of the step, fresh or resumed, signs the pre-image as
 * the program's `expected_created_at` and `expected_metadata_uri`, so the program refuses it
 * (stale plan approval) unless the plan still holds the pre-image; that refusal re-reads this
 * effect, and anything but the target fails the step. `endTs` and pullers have no stored
 * pre-image, and only SDP's key can change them.
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
