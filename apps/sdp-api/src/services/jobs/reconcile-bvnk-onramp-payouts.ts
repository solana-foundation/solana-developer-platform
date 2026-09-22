import {
  addDecimalAmounts,
  compareDecimalAmounts,
  decimalStringFromNumber,
  subtractDecimalAmounts,
} from "@sdp/payments/decimal";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import { BvnkPayRequestError } from "@sdp/payments/ramps/providers/bvnk/client";
import {
  BVNK_CRYPTO_CURRENCIES,
  BVNK_PAYOUT_NETWORK,
  bvnkPayoutPartyDetailsFromCustomer,
  normalizeBvnkCurrencyAndNetwork,
  readBvnkOnrampTransferData,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import type {
  BvnkCustomer,
  BvnkDryRunPayoutResponse,
  BvnkOnrampPayoutSummary,
} from "@sdp/payments/ramps/providers/bvnk/schemas";
import { bvnkPayoutObservationFromSource } from "@sdp/payments/ramps/providers/bvnk/settlement";
import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import { toNumberAmount } from "@sdp/solana/amount";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { getDb } from "@/db";
import type {
  BvnkOnrampPayoutIntent,
  BvnkOnrampTransferCandidateRow,
  BvnkOnrampTransfersRepository,
} from "@/db/repositories/bvnk-onramp-transfers.repository";
import { createPostgresBvnkOnrampTransfersRepository } from "@/db/repositories/bvnk-onramp-transfers.repository.postgres";
import type { CounterpartyProviderAccountRow } from "@/db/repositories/counterparty-provider-account.repository";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import { internalError } from "@/lib/errors";
import { buildBvnkOnrampPayout } from "@/routes/payments/handlers/ramps/bvnk";
import {
  applyTerminalBvnkPayoutObservation,
  recordBvnkPayoutCreation,
} from "@/routes/payments/handlers/ramps/bvnk-settlement";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";

export const BVNK_PAYOUT_RECOVERY_GRACE_MS = 5 * 60 * 1000;
export const BVNK_PAYOUT_POLL_AFTER_MS = 10 * 60 * 1000;
export const BVNK_PAYOUT_BATCH = 20;

const BVNK_PAYOUT_REQUESTER_IP = "0.0.0.0" as const;
const BVNK_PAYOUT_UNSUPPORTED_ASSET = "UNSUPPORTED_ASSET" as const;
const BVNK_PAYOUT_NON_FIAT_FEE = "NON_FIAT_FEE" as const;
const BVNK_PAYOUT_FEES_EXCEED_DEPOSIT = "FEES_EXCEED_DEPOSIT" as const;
const BVNK_PAYOUT_ASSET_CURRENCIES = new Set<string>(BVNK_CRYPTO_CURRENCIES);

/**
 * Reconciles every BVNK on-ramp payout due on this tick across the unclaimed,
 * recoverable, and pollable branches. Candidate eligibility is decided in SQL
 * before each LIMIT; every BVNK call runs under the candidate's own project
 * environment credentials (R6), per-candidate failures are logged with ids
 * and never abort the batch, and every operation inside a candidate boundary
 * is awaited (P2-1).
 *
 * @param env - Process environment used for database and provider access.
 * @returns The number of candidate rows touched by at least one database write or a successful provider-side create/record.
 */
export async function reconcileBvnkOnrampPayouts(env: Env): Promise<number> {
  const repo = createPostgresBvnkOnrampTransfersRepository(getDb(env));
  const now = Date.now();
  const unclaimed = await repo.listUnclaimedPayoutCandidates({
    limit: BVNK_PAYOUT_BATCH,
    cutoff: new Date(now).toISOString(),
  });
  const recoverable = await repo.listRecoverablePayoutCandidates({
    limit: BVNK_PAYOUT_BATCH,
    cutoff: new Date(now - BVNK_PAYOUT_RECOVERY_GRACE_MS).toISOString(),
  });
  const pollable = await repo.listPollablePayoutCandidates({
    limit: BVNK_PAYOUT_BATCH,
    cutoff: new Date(now - BVNK_PAYOUT_POLL_AFTER_MS).toISOString(),
  });
  let touched = 0;
  for (const candidate of unclaimed) {
    if (await reconcileUnclaimedPayout(repo, env, candidate)) {
      touched += 1;
    }
  }
  for (const candidate of recoverable) {
    if (await reconcileRecoverablePayout(repo, env, candidate)) {
      touched += 1;
    }
  }
  for (const candidate of pollable) {
    if (await reconcilePollablePayout(repo, env, candidate)) {
      touched += 1;
    }
  }
  return touched;
}

function candidateRampContext(
  env: Env,
  candidate: BvnkOnrampTransferCandidateRow
): RampRuntimeContext {
  return {
    env: env as unknown as Record<string, string | undefined>,
    mode: candidate.environment,
  };
}

/**
 * Runs the unclaimed branch for one candidate: resolves the pay-in and
 * destination, dry-runs the payout, validates the fee legs and positive
 * spend, claims the payout slot with the dry-run-derived spend intent
 * (P1-5), creates the payout, and records the provider payout id with the
 * PROCESSING settlement. A lost claim skips the candidate without any
 * provider spend; a definitive rejection BEFORE any claim fails the transfer
 * in one guarded statement without ever persisting a claim or a fabricated
 * intent. The error boundary wraps the whole operation including the failure
 * write.
 *
 * @param repo - The BVNK on-ramp transfers repository.
 * @param env - Process environment used for provider access.
 * @param candidate - The unclaimed payout candidate row.
 * @returns Whether the candidate row was touched.
 */
async function reconcileUnclaimedPayout(
  repo: BvnkOnrampTransfersRepository,
  env: Env,
  candidate: BvnkOnrampTransferCandidateRow
): Promise<boolean> {
  const logger = getLogger();
  let claimLanded = false;
  let claimedAt = "";
  try {
    const data = readBvnkOnrampTransferData(candidate.provider_data);
    const payin = data.payin;
    if (payin === undefined) {
      throw internalError(`BVNK on-ramp payout candidate ${candidate.id} carried no payin facts`);
    }
    const destinationAddress = candidate.destination_address;
    if (destinationAddress === null) {
      throw internalError(
        `BVNK on-ramp payout candidate ${candidate.id} has no destination address`
      );
    }
    const fundingWalletReference = payin.walletId;
    if (fundingWalletReference !== candidate.fundingWalletReference) {
      throw internalError(
        `BVNK on-ramp payout candidate ${candidate.id} pay-in wallet diverges from its funding wallet`
      );
    }
    const ctx = candidateRampContext(env, candidate);
    const cryptoCurrency = resolveBvnkOnrampAsset(candidate.token);
    if (cryptoCurrency === null) {
      await definitiveUnclaimedFail(
        repo,
        candidate,
        new Date().toISOString(),
        BVNK_PAYOUT_UNSUPPORTED_ASSET
      );
      return true;
    }
    const { customerLink, customer } = await resolveBvnkOnrampCustomer(env, candidate);
    const dryRun = await RAMP_PROVIDER_CLIENTS.bvnk.dryRunOnrampPayout(ctx, {
      walletId: fundingWalletReference,
      amount: toNumberAmount(payin.receivedAmount),
      currency: payin.receivedCurrency,
      reference: candidate.id,
      customerId: customerLink.provider_customer_reference,
      payOutDetails: {
        code: "crypto",
        currency: cryptoCurrency,
        network: BVNK_PAYOUT_NETWORK.dryRun,
        address: destinationAddress,
      },
      complianceDetails: {
        requesterIpAddress: BVNK_PAYOUT_REQUESTER_IP,
        partyDetails: [bvnkPayoutPartyDetailsFromCustomer(customer, "BENEFICIARY")],
      },
    });
    const spend = bvnkDryRunSpendIntent(
      payin.receivedAmount,
      payin.receivedCurrency,
      dryRun,
      cryptoCurrency,
      destinationAddress
    );
    if (spend.kind === "rejected") {
      await definitiveUnclaimedFail(repo, candidate, new Date().toISOString(), spend.error);
      return true;
    }
    const claimTimestamp = new Date().toISOString();
    const claimed = await repo.claimPayout({
      transferId: candidate.id,
      claimedAt: claimTimestamp,
      intent: spend.intent,
    });
    if (claimed === null) {
      logger.info({ transfer_id: candidate.id }, "[bvnk onramp] payout claim lost");
      return false;
    }
    claimLanded = true;
    claimedAt = claimTimestamp;
    const created = await RAMP_PROVIDER_CLIENTS.bvnk.createOnrampPayout(
      ctx,
      buildBvnkOnrampPayout({
        transferId: candidate.id,
        bvnkCustomer: customer,
        customerId: customerLink.provider_customer_reference,
        fundingWalletReference,
        intent: spend.intent,
      })
    );
    await recordBvnkPayoutCreation({
      repo,
      environment: candidate.environment,
      transfer: claimed,
      claimedAt,
      summary: created,
    });
    logger.info(
      { transfer_id: candidate.id, payout_id: created.uuid },
      "[bvnk onramp] payout created and recorded with the processing settlement"
    );
    return true;
  } catch (error) {
    let touched = false;
    try {
      touched = await translateUnclaimedFailure(repo, candidate, claimLanded, claimedAt, error);
    } catch (failureWriteError) {
      logger.error(
        {
          transfer_id: candidate.id,
          error: errorMessage(failureWriteError),
        },
        "[bvnk onramp] unclaimed payout failure persistence failed"
      );
    }
    await repo.touchPayoutCandidate({ transferId: candidate.id });
    return touched;
  }
}

/** The validated dry-run spend verdict: the claim gets the intent, a rejection explains itself. */
type BvnkDryRunSpendVerdict =
  | { kind: "accepted"; intent: BvnkOnrampPayoutIntent }
  | { kind: "rejected"; error: string };

/**
 * Derives the claim-time spend intent from the dry-run quote, validating the
 * fee legs before anything is persisted (R5): both fee currencies must EQUAL
 * the received fiat currency, and the fee total must stay strictly below the
 * received amount — checked before any subtraction, so the unsigned
 * comparator never sees a negative (fees at or above the deposit fail the
 * transfer definitively with the amounts named).
 *
 * @param receivedAmount - The persisted pay-in fiat amount.
 * @param receivedCurrency - The persisted pay-in fiat currency.
 * @param dryRun - The typed dry-run payout response.
 * @param cryptoCurrency - The resolved BVNK payout asset.
 * @param destinationAddress - The transfer's payout destination.
 * @returns The accepted intent, or the definitive rejection code.
 */
function bvnkDryRunSpendIntent(
  receivedAmount: string,
  receivedCurrency: string,
  dryRun: BvnkDryRunPayoutResponse,
  cryptoCurrency: string,
  destinationAddress: string
): BvnkDryRunSpendVerdict {
  if (
    dryRun.feeCurrency.currency !== receivedCurrency ||
    dryRun.networkFeeCurrency.currency !== receivedCurrency
  ) {
    return { kind: "rejected", error: BVNK_PAYOUT_NON_FIAT_FEE };
  }
  const totalFees = addDecimalAmounts(
    decimalStringFromNumber(dryRun.feeCurrency.amount),
    decimalStringFromNumber(dryRun.networkFeeCurrency.amount)
  );
  if (compareDecimalAmounts(totalFees, receivedAmount) >= 0) {
    return {
      kind: "rejected",
      error: `${BVNK_PAYOUT_FEES_EXCEED_DEPOSIT}: fees ${totalFees} >= received ${receivedAmount}`,
    };
  }
  const spend = subtractDecimalAmounts(receivedAmount, totalFees);
  return {
    kind: "accepted",
    intent: {
      amount: spend,
      currency: receivedCurrency,
      cryptoCurrency,
      network: BVNK_PAYOUT_NETWORK.create,
      address: destinationAddress,
    },
  };
}

/**
 * Fails an unclaimed settling transfer definitively — the pre-create
 * rejection (unknown asset, non-fiat fee, or non-positive spend), written in
 * one guarded statement so no claim or fabricated intent is ever persisted
 * (P1-5). A lost guard means a concurrent worker claimed the row; recovery
 * owns its retry.
 *
 * @param repo - The BVNK on-ramp transfers repository.
 * @param candidate - The unclaimed payout candidate row.
 * @param claimedAt - The timestamp recorded with the rejection.
 * @param error - The definitive error code to store.
 * @returns Whether the candidate row was touched.
 */
async function definitiveUnclaimedFail(
  repo: BvnkOnrampTransfersRepository,
  candidate: BvnkOnrampTransferCandidateRow,
  claimedAt: string,
  error: string
): Promise<boolean> {
  const logger = getLogger();
  const failed = await repo.failPayoutUnclaimed({
    transferId: candidate.id,
    error,
    claimedAt,
  });
  if (failed === null) {
    logger.warn(
      { transfer_id: candidate.id, error },
      "[bvnk onramp] unclaimed rejection lost its guard; a claim owns the retry"
    );
    return true;
  }
  logger.warn({ transfer_id: candidate.id, error }, "[bvnk onramp] payout failed definitively");
  return true;
}

/**
 * Translates an unclaimed-branch failure: a definitive provider rejection
 * (insufficient funds, below minimum, invalid request) fails the transfer —
 * unclaimed or first-attempt guarded; a duplicate reference is ambiguous and
 * leaves the claim for recovery to adopt; anything else is logged and the
 * candidate is left for the next tick.
 *
 * @param repo - The BVNK on-ramp transfers repository.
 * @param candidate - The unclaimed payout candidate row.
 * @param claimLanded - Whether this worker's claim landed before the failure.
 * @param claimedAt - The claim this worker holds, when it landed.
 * @param error - The failure to translate.
 * @returns Whether the candidate row was touched.
 */
async function translateUnclaimedFailure(
  repo: BvnkOnrampTransfersRepository,
  candidate: BvnkOnrampTransferCandidateRow,
  claimLanded: boolean,
  claimedAt: string,
  error: unknown
): Promise<boolean> {
  const logger = getLogger();
  if (error instanceof BvnkPayRequestError) {
    switch (error.bvnkCode) {
      case "MER-PAY-2010":
        logger.warn(
          { transfer_id: candidate.id },
          "[bvnk onramp] duplicate payout reference; recovery will adopt it on a later tick"
        );
        return claimLanded;
      case "MER-PAY-2012":
      case "MER-PAY-2001":
      case "MER-PAY-2009":
        if (claimLanded) {
          const failed = await repo.failPayout({
            transferId: candidate.id,
            payoutId: null,
            error: error.bvnkCode,
            claimedAt,
          });
          if (failed === null) {
            logger.warn(
              { transfer_id: candidate.id, error: error.bvnkCode },
              "[bvnk onramp] definitive failure lost its first-attempt guard; recovery owns the retry"
            );
          }
          return true;
        }
        return definitiveUnclaimedFail(repo, candidate, new Date().toISOString(), error.bvnkCode);
    }
  }
  logger.error(
    {
      transfer_id: candidate.id,
      counterparty_id: candidate.counterparty_id,
      funding_wallet_reference: candidate.fundingWalletReference,
      error: errorMessage(error),
    },
    "[bvnk onramp] unclaimed payout reconcile failed"
  );
  return claimLanded;
}

/** The outcome of a recovery list-by-reference lookup. */
type RecoveryLookupOutcome = { kind: "adopted" } | { kind: "reissue" } | { kind: "ambiguous" };

/**
 * Applies the exact-cardinality adoption rule (P1-2): zero rows mean a
 * reissue from the persisted intent is allowed; exactly one row is hydrated
 * through `getPayoutSummary` (which carries the receipt url list rows omit)
 * and adopted only when its identity and economics match the stored pay-in
 * and intent — validated before the UUID and settlement land atomically;
 * anything else leaves the claim untouched, logged, and never automated.
 *
 * @param repo - The BVNK on-ramp transfers repository.
 * @param env - Process environment used for provider access.
 * @param candidate - The recoverable payout candidate row.
 * @param ctx - The candidate's per-project ramp runtime.
 * @param claimTimestamp - The lease this worker holds.
 * @param listed - The provider rows returned for the reference.
 * @returns The adjudicated outcome.
 */
async function adjudicateRecoveryLookup(
  repo: BvnkOnrampTransfersRepository,
  candidate: BvnkOnrampTransferCandidateRow,
  ctx: RampRuntimeContext,
  claimTimestamp: string,
  listed: BvnkOnrampPayoutSummary[]
): Promise<RecoveryLookupOutcome> {
  const logger = getLogger();
  if (listed.length === 0) {
    return { kind: "reissue" };
  }
  if (listed.length > 1) {
    logger.error(
      { transfer_id: candidate.id, payout_count: listed.length },
      "[bvnk onramp] recovery lookup matched multiple provider payouts; leaving claimed"
    );
    return { kind: "ambiguous" };
  }
  const row = listed[0];
  try {
    const hydrated = await RAMP_PROVIDER_CLIENTS.bvnk.getPayoutSummary(ctx, { payoutId: row.uuid });
    await recordBvnkPayoutCreation({
      repo,
      environment: candidate.environment,
      transfer: candidate,
      claimedAt: claimTimestamp,
      summary: hydrated,
    });
  } catch (error) {
    logger.error(
      { transfer_id: candidate.id, payout_id: row.uuid, error: errorMessage(error) },
      "[bvnk onramp] recovery adoption failed; the payout claim stays ambiguous"
    );
    return { kind: "ambiguous" };
  }
  logger.info(
    { transfer_id: candidate.id, payout_id: row.uuid },
    "[bvnk onramp] adopted the existing payout after the recovery lookup"
  );
  return { kind: "adopted" };
}

/**
 * Reissues a recovery payout from the persisted intent — no second dry-run
 * (R4). A duplicate-reference rejection re-lists and re-adjudicates; any
 * other definitive rejection leaves the claim ambiguous for the next tick;
 * anything else propagates to the recovery boundary.
 *
 * @param repo - The BVNK on-ramp transfers repository.
 * @param env - Process environment used for repository access.
 * @param candidate - The recoverable payout candidate row.
 * @param ctx - The candidate's per-project ramp runtime.
 * @param claimTimestamp - The lease this worker holds.
 * @param intent - The persisted spend intent.
 * @param fundingWalletReference - The pay-in wallet the payout must debit.
 * @returns Whether the candidate row was touched.
 */
async function reissueRecoveryPayout(
  repo: BvnkOnrampTransfersRepository,
  env: Env,
  candidate: BvnkOnrampTransferCandidateRow,
  ctx: RampRuntimeContext,
  claimTimestamp: string,
  intent: BvnkOnrampPayoutIntent,
  fundingWalletReference: string
): Promise<boolean> {
  const logger = getLogger();
  const payin = readBvnkOnrampTransferData(candidate.provider_data).payin;
  if (payin === undefined) {
    throw internalError(
      `BVNK on-ramp payout candidate ${candidate.id} carried no payin facts to reissue`
    );
  }
  const { customerLink, customer } = await resolveBvnkOnrampCustomer(env, candidate);
  try {
    const created = await RAMP_PROVIDER_CLIENTS.bvnk.createOnrampPayout(
      ctx,
      buildBvnkOnrampPayout({
        transferId: candidate.id,
        bvnkCustomer: customer,
        customerId: customerLink.provider_customer_reference,
        fundingWalletReference,
        intent,
      })
    );
    await recordBvnkPayoutCreation({
      repo,
      environment: candidate.environment,
      transfer: candidate,
      claimedAt: claimTimestamp,
      summary: created,
    });
    logger.info(
      { transfer_id: candidate.id, payout_id: created.uuid },
      "[bvnk onramp] payout reissued from the persisted intent"
    );
    return true;
  } catch (error) {
    if (!(error instanceof BvnkPayRequestError)) {
      throw error;
    }
    if (error.bvnkCode !== "MER-PAY-2010") {
      logger.warn(
        { transfer_id: candidate.id, error: error.message, error_code: error.bvnkCode },
        "[bvnk onramp] recovery reissue rejected; the payout claim stays ambiguous"
      );
      return true;
    }
    const relisted = await RAMP_PROVIDER_CLIENTS.bvnk.listPayoutsByReference(ctx, {
      walletId: fundingWalletReference,
      reference: candidate.id,
    });
    const outcome = await adjudicateRecoveryLookup(repo, candidate, ctx, claimTimestamp, relisted);
    if (outcome.kind === "ambiguous") {
      logger.warn(
        { transfer_id: candidate.id },
        "[bvnk onramp] duplicate-reference re-list is ambiguous; the payout claim stays claimed"
      );
    }
    return true;
  }
}

/**
 * Runs the recovery branch for one candidate whose claim is older than the
 * grace window: leases the claim, lists by the transfer-id reference, adopts
 * an exactly-one matching payout, reissues from the persisted intent when
 * nothing matches, and leaves the claim untouched for any ambiguous listing.
 * A rejection during recovery never fails the transfer.
 *
 * @param repo - The BVNK on-ramp transfers repository.
 * @param env - Process environment used for provider access.
 * @param candidate - The recoverable payout candidate row.
 * @returns Whether the candidate row was touched.
 */
async function reconcileRecoverablePayout(
  repo: BvnkOnrampTransfersRepository,
  env: Env,
  candidate: BvnkOnrampTransferCandidateRow
): Promise<boolean> {
  const logger = getLogger();
  let leaseLanded = false;
  try {
    const data = readBvnkOnrampTransferData(candidate.provider_data);
    const payout = data.payout;
    if (payout === undefined) {
      throw internalError(
        `BVNK on-ramp payout candidate ${candidate.id} carried no payout claim to recover`
      );
    }
    const intent = payout.intent;
    if (intent === undefined) {
      throw internalError(
        `BVNK on-ramp payout candidate ${candidate.id} carried no spend intent to recover`
      );
    }
    const payin = data.payin;
    if (payin === undefined) {
      throw internalError(
        `BVNK on-ramp payout candidate ${candidate.id} carried no payin facts to recover`
      );
    }
    const fundingWalletReference = payin.walletId;
    if (fundingWalletReference !== candidate.fundingWalletReference) {
      throw internalError(
        `BVNK on-ramp payout candidate ${candidate.id} pay-in wallet diverges from its funding wallet`
      );
    }
    const claimTimestamp = new Date().toISOString();
    const leased = await repo.leasePayoutRecovery({
      transferId: candidate.id,
      observedClaimedAt: payout.claimedAt,
      claimedAt: claimTimestamp,
    });
    if (leased === null) {
      logger.info({ transfer_id: candidate.id }, "[bvnk onramp] payout recovery lease lost");
      return false;
    }
    leaseLanded = true;
    const ctx = candidateRampContext(env, candidate);
    const listed = await RAMP_PROVIDER_CLIENTS.bvnk.listPayoutsByReference(ctx, {
      walletId: fundingWalletReference,
      reference: candidate.id,
    });
    const outcome = await adjudicateRecoveryLookup(repo, candidate, ctx, claimTimestamp, listed);
    if (outcome.kind === "adopted" || outcome.kind === "ambiguous") {
      return true;
    }
    await reissueRecoveryPayout(
      repo,
      env,
      candidate,
      ctx,
      claimTimestamp,
      intent,
      fundingWalletReference
    );
    return true;
  } catch (error) {
    logger.error(
      {
        transfer_id: candidate.id,
        counterparty_id: candidate.counterparty_id,
        funding_wallet_reference: candidate.fundingWalletReference,
        error: errorMessage(error),
      },
      "[bvnk onramp] recoverable payout reconcile failed"
    );
    return leaseLanded;
  }
}

/**
 * Runs the poll branch for one candidate whose payout has not been polled
 * since the poll interval: the summary observation routes COMPLETE/FAILED
 * through the shared terminal settlement operation and leaves anything else
 * settling. Every poll advances `lastPolledAt` so the row rotates — including
 * failed polls, which otherwise starve the batch (P2-1).
 *
 * @param repo - The BVNK on-ramp transfers repository.
 * @param env - Process environment used for provider access.
 * @param candidate - The pollable payout candidate row.
 * @returns Whether the candidate row was touched.
 */
async function reconcilePollablePayout(
  repo: BvnkOnrampTransfersRepository,
  env: Env,
  candidate: BvnkOnrampTransferCandidateRow
): Promise<boolean> {
  const logger = getLogger();
  const markPolled = async (): Promise<void> => {
    const polled = await repo.markPayoutPolled({
      transferId: candidate.id,
      polledAt: new Date().toISOString(),
    });
    if (polled === null) {
      logger.info(
        { transfer_id: candidate.id },
        "[bvnk onramp] payout poll marker lost; the row moved on"
      );
    }
  };
  try {
    const data = readBvnkOnrampTransferData(candidate.provider_data);
    const payout = data.payout;
    if (payout === undefined || payout.payoutId === undefined) {
      throw internalError(
        `BVNK on-ramp payout candidate ${candidate.id} carried no payout id to poll`
      );
    }
    const summary = await RAMP_PROVIDER_CLIENTS.bvnk.getPayoutSummary(
      candidateRampContext(env, candidate),
      { payoutId: payout.payoutId }
    );
    const parsed = bvnkPayoutObservationFromSource(summary);
    if (!parsed.ok) {
      throw internalError(
        `BVNK payout summary poll for ${candidate.id} lacks the transaction hash or destination address.`
      );
    }
    const observation = parsed.observation;
    if (observation.outcome === "processing") {
      logger.info(
        { transfer_id: candidate.id, payout_id: payout.payoutId, status: summary.status },
        "[bvnk onramp] payout polled while still settling"
      );
    } else {
      await applyTerminalBvnkPayoutObservation({
        repo,
        environment: candidate.environment,
        transfer: candidate,
        observation,
        failError: summary.status,
        terminalError: (message) =>
          internalError(`BVNK on-ramp payout ${candidate.id}: ${message}`),
      });
    }
    await markPolled();
    return true;
  } catch (error) {
    logger.error(
      {
        transfer_id: candidate.id,
        counterparty_id: candidate.counterparty_id,
        funding_wallet_reference: candidate.fundingWalletReference,
        error: errorMessage(error),
      },
      "[bvnk onramp] pollable payout reconcile failed"
    );
    try {
      await markPolled();
    } catch (pollMarkerError) {
      logger.error(
        { transfer_id: candidate.id, error: errorMessage(pollMarkerError) },
        "[bvnk onramp] poll marker write failed"
      );
    }
    return false;
  }
}

/**
 * Loads the BVNK customer link row and the provider customer it names for a
 * candidate, both scoped to the candidate's project environment.
 *
 * @param env - Process environment used for repository and provider access.
 * @param candidate - The payout candidate row.
 * @returns The customer-link row and the typed BVNK customer.
 */
async function resolveBvnkOnrampCustomer(
  env: Env,
  candidate: BvnkOnrampTransferCandidateRow
): Promise<{ customerLink: CounterpartyProviderAccountRow; customer: BvnkCustomer }> {
  const projectId = candidate.project_id;
  if (projectId === null) {
    throw internalError(`BVNK on-ramp payout candidate ${candidate.id} has no project`);
  }
  const counterpartyId = candidate.counterparty_id;
  if (counterpartyId === null) {
    throw internalError(`BVNK on-ramp payout candidate ${candidate.id} has no counterparty`);
  }
  const customerLink = await createPostgresCounterpartyProviderAccountsRepository(
    getDb(env)
  ).getProviderAccount({
    organizationId: candidate.organization_id,
    projectId,
    counterpartyId,
    provider: "bvnk",
  });
  if (customerLink === null) {
    throw internalError(`BVNK on-ramp payout candidate ${candidate.id} has no BVNK customer link`);
  }
  const customer = await RAMP_PROVIDER_CLIENTS.bvnk.getCustomer(
    {
      env: env as unknown as Record<string, string | undefined>,
      mode: candidate.environment,
    },
    { reference: customerLink.provider_customer_reference }
  );
  return { customerLink, customer };
}

/**
 * Resolves a transfer's token mint to the BVNK payout currency BVNK accepts.
 *
 * @param token - The transfer's token mint address.
 * @returns The normalized BVNK currency code (for example `USDC`), or null
 * when the mint is unknown or its symbol is not a BVNK-supportable asset.
 */
function resolveBvnkOnrampAsset(token: string): string | null {
  const wellKnown = WELL_KNOWN_TOKEN_BY_MINT.get(token);
  if (wellKnown === undefined) {
    return null;
  }
  if (!BVNK_PAYOUT_ASSET_CURRENCIES.has(wellKnown.symbol)) {
    return null;
  }
  return normalizeBvnkCurrencyAndNetwork(wellKnown.symbol).currency;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
