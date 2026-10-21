import type { SolanaRpc } from "@sdp/rpc/solana";
import type { MovementId } from "@sdp/types/movements";
import {
  type Account,
  type Address,
  createNoopSigner,
  fetchEncodedAccounts,
  type MaybeAccount,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import * as subscriptionsProgram from "@solana/subscriptions";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token-2022";
import type {
  PaymentRecurringPaymentActivationAttemptRow,
  PaymentRecurringPaymentUpdateAttemptRow,
  RecurringPaymentStepSignatureSlot,
} from "@/db/repositories/payment-recurring-payments.repository";
import { transactionFailed } from "@/lib/errors";
import {
  resolveProjectSponsorshipScope,
  resolveSponsoredFeePayer,
} from "@/services/sponsorship.service";
import type { Env } from "@/types/env";
import {
  authorizationSetupEffect,
  delegationCreatedEffect,
  parseNullableStoredSignature,
  type RecurringPaymentSourceWallet,
  type RecurringPaymentStepLogContext,
  type RecurringPaymentStepPhase,
  readSavedRecurringPaymentStep,
  sendRecurringPaymentStep,
} from "./shared";

/**
 * Where each flow that subscribes a source wallet saves its setup and subscribe steps, the
 * movement both sign under, and what a step that cannot land answers with.
 */
export const SUBSCRIPTION_AUTHORITY_SETUP_FLOWS = {
  activation: {
    movement: "recurring.activate",
    setupSlot: { row: "activation_attempt", column: "authorization_setup_signature" },
    setupFailureMessage: "Recurring payment activation failed on-chain",
    subscribeSlot: { row: "activation_attempt", column: "authorization_signature" },
    subscribeFailureMessage: "Recurring payment activation failed on-chain",
  },
  update: {
    movement: "recurring.update",
    setupSlot: { row: "update_attempt", column: "authorization_setup_signature" },
    setupFailureMessage: "Recurring payment update failed on-chain",
    subscribeSlot: { row: "update_attempt", column: "authorization_signature" },
    subscribeFailureMessage: "Recurring payment replacement authorization failed on-chain",
  },
} as const satisfies Record<
  string,
  {
    movement: MovementId;
    setupSlot: RecurringPaymentStepSignatureSlot;
    setupFailureMessage: string;
    subscribeSlot: RecurringPaymentStepSignatureSlot;
    subscribeFailureMessage: string;
  }
>;

export type RecurringPaymentSubscriptionAuthorityFlow =
  keyof typeof SUBSCRIPTION_AUTHORITY_SETUP_FLOWS;

/** The attempt fields the setup step reads: its saved setup signature and the row's expiry. */
type SubscriptionAuthoritySetupAttempt = Pick<
  PaymentRecurringPaymentActivationAttemptRow | PaymentRecurringPaymentUpdateAttemptRow,
  "id" | "authorization_setup_signature" | "last_valid_block_height"
>;

/** What the setup and subscribe steps share. */
interface SubscriptionAuthorityStepInput {
  flow: RecurringPaymentSubscriptionAuthorityFlow;
  env: Env;
  organizationId: string;
  projectId: string;
  recurringPaymentId: string;
  attempt: SubscriptionAuthoritySetupAttempt;
  phase: RecurringPaymentStepPhase;
  rpc: SolanaRpc;
  sourceWallet: RecurringPaymentSourceWallet;
  sourceSigner: () => Promise<TransactionSigner>;
  sourceTokenAccount: Address;
  subscriptionAuthorityAddress: Address;
  owner: Address;
  mint: Address;
  tokenProgram: Address;
}

/**
 * The fee payer a run's setup and subscribe name, resolved from the project's sponsor on the first
 * call only: a run that sends neither never asks Kora.
 *
 * @param input - The schedule's tenant and source wallet.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.sourceWallet - The wallet the sponsorship is scoped to.
 * @returns A function that resolves the fee payer's address, the same promise on every call.
 */
function lazySponsoredFeePayer(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: RecurringPaymentSourceWallet;
}): () => Promise<Address> {
  let feePayer: Promise<Address> | null = null;
  const resolveFeePayer = async (): Promise<Address> =>
    resolveSponsoredFeePayer(
      input.env,
      await resolveProjectSponsorshipScope(input.env, {
        organizationId: input.organizationId,
        projectId: input.projectId,
        actor: { type: "wallet", id: input.sourceWallet.walletId },
      })
    );
  return () => {
    if (feePayer === null) {
      feePayer = resolveFeePayer();
    }
    return feePayer;
  };
}

/**
 * Makes sure the source wallet's subscription authority and token account exist and delegate to
 * each other before subscribe. A setup an earlier send of this attempt saved is read first, as
 * every other step is, so a pending or dropped one reads nothing else and asks Kora nothing;
 * otherwise the authority and the token account are read in one `getMultipleAccounts`, a wallet
 * that already has both (the token account owned by the mint's token program) skips the step, and one missing either sends the setup (the token account
 * create when it is missing, then the authority init, always) through the step runner. The skip
 * takes an existing authority and token account as set up without reading the token account's
 * delegate (the setup effect does); a revoked approval there is not repaired.
 *
 * @param input - The setup's flow, accounts, signer, fee payer and attempt.
 * @param input.flow - The flow subscribing, which names the movement, slots and failure messages.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.recurringPaymentId - The schedule.
 * @param input.attempt - The run's attempt: its id, saved setup signature and stored expiry.
 * @param input.phase - The run's unwinding steps; the current step moves to setup, then subscribe.
 * @param input.rpc - The cluster RPC the authority is read from.
 * @param input.sourceWallet - The wallet that subscribes and the sponsorship is scoped to.
 * @param input.sourceSigner - The run's lazy source signer, resolved only when a step is sent.
 * @param input.sourceTokenAccount - The source wallet's associated token account for the mint;
 *   setup creates it when the unsaved branch finds it missing.
 * @param input.subscriptionAuthorityAddress - The source wallet's subscription authority.
 * @param input.owner - The source wallet's address.
 * @param input.mint - The plan's mint.
 * @param input.tokenProgram - The mint's token program.
 * @param input.feePayer - The run's lazy fee payer, resolved only when the setup is sent.
 * @returns The subscription authority as read after setup.
 * @throws ResumedStepUnsettledError when the setup is pending.
 * @throws RecurringPaymentStepFailedError when the setup is dropped or cannot land.
 * @throws AppError TRANSACTION_FAILED when the authority is not on chain after setup.
 */
async function prepareRecurringPaymentSubscriptionAuthority(
  input: SubscriptionAuthorityStepInput & { feePayer: () => Promise<Address> }
): Promise<Account<subscriptionsProgram.SubscriptionAuthority>> {
  const flow = SUBSCRIPTION_AUTHORITY_SETUP_FLOWS[input.flow];
  const slot = flow.setupSlot;
  input.phase.step = slot;
  const logContext: RecurringPaymentStepLogContext = {
    recurring_payment_id: input.recurringPaymentId,
    attempt_id: input.attempt.id,
    step: "authorization_setup",
  };
  const effect = authorizationSetupEffect({
    subscriptionAuthorityAddress: input.subscriptionAuthorityAddress,
    sourceTokenAccount: input.sourceTokenAccount,
    owner: input.owner,
    mint: input.mint,
    tokenProgram: input.tokenProgram,
  });
  const savedSetupSignature = parseNullableStoredSignature(
    input.attempt.authorization_setup_signature
  );
  if (savedSetupSignature !== null) {
    const accounts = await readSavedRecurringPaymentStep({
      phase: input.phase,
      slot,
      signature: savedSetupSignature,
      lastValidBlockHeight: input.attempt.last_valid_block_height,
      effect,
      failureMessage: flow.setupFailureMessage,
      logContext,
    });
    return requireSubscriptionAuthority(
      subscriptionsProgram.decodeSubscriptionAuthority(accounts[0])
    );
  }
  const [authorityAccount, existingSourceTokenAccount] = await fetchEncodedAccounts(
    input.rpc,
    [input.subscriptionAuthorityAddress, input.sourceTokenAccount],
    { commitment: "confirmed" }
  );
  const existingAuthority = subscriptionsProgram.decodeSubscriptionAuthority(authorityAccount);
  // Only the token program can own an account at the ATA address once the ATA program created it;
  // a system-owned one (lamports sent there) still needs the create, which adopts it.
  const sourceTokenAccountCreated =
    existingSourceTokenAccount.exists &&
    existingSourceTokenAccount.programAddress === input.tokenProgram;
  if (existingAuthority.exists && sourceTokenAccountCreated) {
    return existingAuthority;
  }

  const feePayer = await input.feePayer();
  const sourceSigner = await input.sourceSigner();
  const payer = createNoopSigner(feePayer);
  // The init always goes out: it is idempotent on an existing authority (its `initId` stays) and
  // re-runs the token account's Approve, which the setup effect requires.
  const initAuthorityInstruction =
    await subscriptionsProgram.getInitSubscriptionAuthorityOverlayInstructionAsync({
      owner: sourceSigner,
      payer,
      tokenMint: input.mint,
      tokenProgram: input.tokenProgram,
      userAta: input.sourceTokenAccount,
    });
  const instructions = sourceTokenAccountCreated
    ? [initAuthorityInstruction]
    : [
        getCreateAssociatedTokenIdempotentInstruction({
          payer,
          ata: input.sourceTokenAccount,
          owner: input.owner,
          mint: input.mint,
          tokenProgram: input.tokenProgram,
        }),
        initAuthorityInstruction,
      ];
  const settled = await sendRecurringPaymentStep({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPaymentId,
    attemptId: input.attempt.id,
    movement: flow.movement,
    sourceWallet: input.sourceWallet,
    sourceSigner,
    feePayer,
    instructions,
    slot,
    effect,
    alreadyDone: null,
    onFailure: { outcome: "unwind" },
    failureMessage: flow.setupFailureMessage,
    logContext,
  });
  if (settled.state === "landed") {
    return requireSubscriptionAuthority(
      subscriptionsProgram.decodeSubscriptionAuthority(settled.accounts[0])
    );
  }
  if (existingAuthority.exists) {
    return existingAuthority;
  }

  return requireSubscriptionAuthority(
    await subscriptionsProgram.fetchMaybeSubscriptionAuthority(
      input.rpc,
      input.subscriptionAuthorityAddress,
      { commitment: "confirmed", minContextSlot: settled.confirmedSlot }
    )
  );
}

/**
 * The subscription authority, present.
 *
 * @param authority - The authority as read.
 * @returns The authority account.
 * @throws AppError TRANSACTION_FAILED when it is not on chain.
 */
function requireSubscriptionAuthority(
  authority: MaybeAccount<subscriptionsProgram.SubscriptionAuthority>
): Account<subscriptionsProgram.SubscriptionAuthority> {
  if (!authority.exists) {
    throw transactionFailed("Subscription authority was not found on-chain");
  }
  return authority;
}

/**
 * Subscribes the source wallet to a plan: the wallet's setup when it needs one
 * (`prepareRecurringPaymentSubscriptionAuthority`), then subscribe through the step runner, both
 * under the flow's movement and slots. The fee payer resolves once, only when a step is sent. A
 * confirmed subscribe is landed (D1): nothing reads the delegation after it. The caller reads a
 * subscribe it already saved before calling this.
 *
 * @param input - The flow, the setup's accounts, signer and attempt, and the subscribe's terms.
 * @param input.flow - The flow subscribing, which names the movement, slots and failure messages.
 * @param input.env - The environment.
 * @param input.organizationId - The schedule's organization.
 * @param input.projectId - The schedule's project.
 * @param input.recurringPaymentId - The schedule.
 * @param input.attempt - The run's attempt: its id, saved setup signature and stored expiry.
 * @param input.phase - The run's unwinding steps; the current step moves to setup, then subscribe.
 * @param input.rpc - The cluster RPC the authority is read from.
 * @param input.sourceWallet - The wallet that subscribes and the sponsorship is scoped to.
 * @param input.sourceSigner - The run's lazy source signer, resolved only when a step is sent.
 * @param input.sourceTokenAccount - The source wallet's associated token account for the mint;
 *   setup creates it when the unsaved branch finds it missing.
 * @param input.subscriptionAuthorityAddress - The source wallet's subscription authority.
 * @param input.owner - The source wallet's address.
 * @param input.mint - The plan's mint.
 * @param input.tokenProgram - The mint's token program.
 * @param input.subscriptionPda - The delegation subscribe creates.
 * @param input.amountBaseUnits - The plan's amount, in base units.
 * @param input.planCreatedAt - The plan's on-chain creation time, which subscribe expects.
 * @param input.periodHours - The plan's period, which subscribe expects.
 * @param input.programPlanId - The plan's program id.
 * @returns The subscribe's signature, or null when a resend was refused as already subscribed.
 * @throws ResumedStepUnsettledError when the setup or subscribe is pending.
 * @throws RecurringPaymentStepFailedError when either is dropped or cannot land.
 */
export async function authorizeRecurringPaymentSubscription(
  input: SubscriptionAuthorityStepInput & {
    subscriptionPda: Address;
    amountBaseUnits: bigint;
    planCreatedAt: string;
    periodHours: number;
    programPlanId: bigint;
  }
): Promise<Signature | null> {
  const flow = SUBSCRIPTION_AUTHORITY_SETUP_FLOWS[input.flow];
  const feePayer = lazySponsoredFeePayer(input);
  const subscriptionAuthority = await prepareRecurringPaymentSubscriptionAuthority({
    ...input,
    feePayer,
  });
  input.phase.step = flow.subscribeSlot;

  const payer = await feePayer();
  const sourceSigner = await input.sourceSigner();
  const subscribeInstruction = await subscriptionsProgram.getSubscribeOverlayInstructionAsync({
    expectedAmount: input.amountBaseUnits,
    expectedCreatedAt: BigInt(input.planCreatedAt),
    expectedPeriodHours: BigInt(input.periodHours),
    expectedSubscriptionAuthorityInitId: subscriptionAuthority.data.initId,
    merchant: input.owner,
    payer: createNoopSigner(payer),
    planId: input.programPlanId,
    subscriber: sourceSigner,
    tokenMint: input.mint,
  });
  const settled = await sendRecurringPaymentStep({
    env: input.env,
    organizationId: input.organizationId,
    projectId: input.projectId,
    recurringPaymentId: input.recurringPaymentId,
    attemptId: input.attempt.id,
    movement: flow.movement,
    sourceWallet: input.sourceWallet,
    sourceSigner,
    feePayer: payer,
    instructions: [subscribeInstruction],
    slot: flow.subscribeSlot,
    effect: delegationCreatedEffect(input.subscriptionPda),
    alreadyDone: {
      code: subscriptionsProgram.SUBSCRIPTIONS_ERROR__ALREADY_SUBSCRIBED,
      notLanded: "pending",
    },
    onFailure: { outcome: "unwind" },
    failureMessage: flow.subscribeFailureMessage,
    logContext: {
      recurring_payment_id: input.recurringPaymentId,
      attempt_id: input.attempt.id,
      step: "authorize_subscription",
    },
  });
  return settled.signature;
}
