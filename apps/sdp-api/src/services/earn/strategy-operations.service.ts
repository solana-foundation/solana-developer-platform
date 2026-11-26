import { currentClusterScope } from "@sdp/rpc/scope";
import type { EarnMovementStatus, EarnVaultWithdrawalRequestStatus } from "@sdp/types/earn";
import type {
  Operation,
  OperationProposalBinding,
  OperationSource,
  OperationStatus,
  SubmitOperation,
} from "@sdp/types/operations";
import { isTerminalOperationStatus, projectedOperationStatus } from "@sdp/types/operations";
import { getDb } from "@/db/client";
import { createPostgresEarnRepository } from "@/db/repositories/earn.repository.postgres";
import {
  createPostgresEarnMovementsRepository,
  type EarnPositionRow,
} from "@/db/repositories/earn-movements.repository";
import { createPostgresEarnVaultWithdrawalRequestsRepository } from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import type {
  OperationAttempt,
  OperationClaim,
  OperationScope,
  OperationSignedAttempt,
  OperationUpdate,
} from "@/db/repositories/operations.repository";
import { AppError, badRequest, conflict, internalError, notFound } from "@/lib/errors";
import { assertMoneyStartAdmitted, MoneyMovementRefusedError } from "@/lib/money-admission";
import { markIdempotencyCommitted } from "@/middleware/idempotency";
import type { AppContext } from "@/routes/earn/context";
import { assertRecordedStrategyDepositAdmitted } from "@/routes/earn/handlers/admission";
import { isEarnStrategyInExecutionShelf } from "@/routes/earn/strategy-catalogue";
import {
  ProposalAdmissionRefusedError,
  ProposalNotSentError,
} from "@/services/custody/signing/admitted-proposer";
import type {
  CustodyTransactionProposer,
  TransactionProposalObservation,
} from "@/services/custody/signing/admitted-transaction-proposer";
import { acceptOperationExecution } from "@/services/operation-execution-audit.service";
import { createOperationsService } from "@/services/operations.service";
import { createOrgTransactionProposerForCustodyWallet } from "@/services/solana/signer";
import type { Env } from "@/types/env";
import {
  createOperationObservationRpc,
  type OperationObservationRpc,
  type UnsentTransactionVerdict,
} from "./operation-observation-rpc";
import { createOperationWorkerBudget, type OperationWorkerBudget } from "./operation-worker-budget";
import { resolveEarnOperationBuild } from "./strategy-operation-build.service";
import {
  advanceCurrentRedemptionRelease,
  projectCurrentRedemptionRelease,
} from "./strategy-redemption-release.service";
import {
  type PreparedStrategySigningTarget,
  type StrategyTransactionScope,
  signPreparedStrategyTransaction,
  sponsorPreparedStrategyTransaction,
} from "./strategy-transactions.service";
import { projectWithdrawalRecovery } from "./strategy-withdrawal-recovery-projection.service";
import { verifySignedWalletTransaction } from "./vault-wallet.service";

export function isTerminalOperation(operation: Operation): boolean {
  return isTerminalOperationStatus(operation.status);
}

const CONFIRMATION = "Waiting for transaction confirmation";
const SETTLEMENT = "Waiting for provider settlement";

/** What submitted work's evidence reports, and what a caller waits for until it is final. */
interface ObservedProgress {
  status: OperationStatus;
  waitingFor: typeof CONFIRMATION | typeof SETTLEMENT | null;
}

/** What a provider withdrawal request's lifecycle says about its operation. */
function queuedRequestProgress(
  request: EarnVaultWithdrawalRequestStatus,
  current: OperationStatus
): ObservedProgress & { outcome: NonNullable<Operation["result"]>["settlementOutcome"] } {
  switch (request) {
    case "fulfilled":
      return { status: "completed", waitingFor: null, outcome: "delivered" };
    case "cancelled":
      return { status: "cancelled", waitingFor: null, outcome: "cancelled" };
    case "failed":
      return { status: "failed", waitingFor: null, outcome: null };
    // A creation signature is stored before broadcast. Keep creating requests
    // submitted, without regressing an operation already stored as settling.
    case "creating":
      return current === "settling"
        ? { status: "settling", waitingFor: SETTLEMENT, outcome: null }
        : { status: "submitted", waitingFor: CONFIRMATION, outcome: null };
    case "pending":
    case "fulfillable":
    case "expired_cancelable":
    case "cancelling":
    case "closed_or_unknown":
      return { status: "settling", waitingFor: SETTLEMENT, outcome: null };
    default: {
      const unknownStatus: never = request;
      throw internalError(`Unknown withdrawal request status: ${unknownStatus}`);
    }
  }
}

/** What an operation's vault movement says about it; operations never record custodial ones. */
function movementProgress(movement: EarnMovementStatus, chainFinalized: boolean): ObservedProgress {
  switch (movement) {
    case "failed":
      return { status: "failed", waitingFor: null };
    case "finalized":
      return { status: "completed", waitingFor: null };
    case "requested":
    case "submitted":
    case "confirmed":
      return chainFinalized
        ? { status: "settling", waitingFor: SETTLEMENT }
        : { status: "submitted", waitingFor: CONFIRMATION };
    case "processing":
    case "pending_approval":
    case "completed":
    case "partially_completed":
    case "cancelled":
      throw internalError("Operation movement is not a vault transaction");
    default: {
      const unknownStatus: never = movement;
      throw internalError(`Unknown movement status: ${unknownStatus}`);
    }
  }
}

function waitFor(progress: ObservedProgress): Operation["nextAction"] {
  return progress.waitingFor === null ? null : { type: "wait", reason: progress.waitingFor };
}

function positionSource(position: EarnPositionRow): OperationSource {
  if (position.custody_wallet_id !== null) return { walletId: position.custody_wallet_id };
  if (position.owner_address !== null) return { ownerAddress: position.owner_address };
  throw internalError("Operation position has no source");
}

/**
 * The error a projection reports. Evidence replaces a recovery error left by an earlier worker
 * pass: only a failure carries one, and a terminal operation keeps its own.
 */
function projectedError(
  operation: Operation,
  failure: NonNullable<Operation["error"]> | null
): Operation["error"] {
  return isTerminalOperation(operation) ? operation.error : failure;
}

async function projectQueuedOperation(
  env: Env,
  scope: OperationScope,
  operation: Operation,
  requestId: string
): Promise<Operation> {
  const requests = createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
  const request = await requests.getById({
    organizationId: scope.organizationId,
    environment: scope.environment,
    withdrawalRequestId: requestId,
  });
  if (request === null || request.project_id !== scope.projectId)
    throw notFound("Operation withdrawal request");
  const position = await createPostgresEarnMovementsRepository(getDb(env)).getPositionById({
    organizationId: scope.organizationId,
    environment: scope.environment,
    positionId: request.position_id,
  });
  const strategyId = position?.strategy_id;
  const supersedingRelease =
    request.mechanism === "operator_redemption"
      ? await requests.findSupersedingRedemptionRelease({
          ...scope,
          withdrawalRequestId: requestId,
        })
      : null;
  const progress =
    supersedingRelease === null
      ? queuedRequestProgress(request.status, operation.status)
      : { status: "failed" as const, waitingFor: null, outcome: null };
  const { status } = progress;
  const observedAt = supersedingRelease?.finalizedAt ?? request.updated_at;
  return {
    ...operation,
    // Request evidence can advance before the operation worker records progress.
    updatedAt:
      Date.parse(observedAt) > Date.parse(operation.updatedAt) ? observedAt : operation.updatedAt,
    status: projectedOperationStatus(operation.status, status),
    nextAction: waitFor(progress),
    error: projectedError(
      operation,
      status === "failed"
        ? {
            code: supersedingRelease === null ? "TRANSACTION_FAILED" : "REDEMPTION_SUPERSEDED",
            message:
              supersedingRelease === null
                ? (request.failure_reason ?? "Withdrawal request failed")
                : "A finalized redemption release ended tracking without establishing a payout",
          }
        : null
    ),
    result: {
      positionId: request.position_id,
      strategyId: strategyId ?? undefined,
      source:
        request.custody_wallet_id === null
          ? { ownerAddress: request.owner_address }
          : { walletId: request.custody_wallet_id },
      signature:
        request.closing_signature ?? request.cancel_signature ?? request.creation_signature,
      settledAmount:
        supersedingRelease !== null || request.assets_paid === null
          ? null
          : { mint: request.token_mint, value: request.assets_paid },
      settlementOutcome: progress.outcome,
    },
  };
}

/** A pure database projection. Polling never signs, proposes or broadcasts. */
export async function projectEarnOperation(
  env: Env,
  scope: OperationScope,
  operation: Operation
): Promise<Operation> {
  switch (operation.resourceRef?.kind) {
    case "earn.redemption_release":
      return projectCurrentRedemptionRelease(env, scope, operation, operation.resourceRef.id);
    case "earn.withdrawal_recovery":
      return projectWithdrawalRecovery(env, scope, operation, operation.resourceRef.id);
    case "earn.withdrawal_request":
      return projectQueuedOperation(env, scope, operation, operation.resourceRef.id);
    case "earn.movement":
      break;
    default:
      return operation;
  }
  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  const movement = await ledger.getMovementById({
    organizationId: scope.organizationId,
    movementId: operation.resourceRef.id,
  });
  if (
    movement === null ||
    movement.environment !== scope.environment ||
    movement.project_id !== scope.projectId
  ) {
    throw notFound("Operation movement");
  }
  const position = await ledger.getPositionById({
    organizationId: scope.organizationId,
    environment: scope.environment,
    positionId: movement.position_id,
  });
  if (position === null) throw internalError("Operation position is missing");
  const strategyId =
    position.strategy_id ??
    (operation.intent.kind === "earn.deposit" ? operation.intent.strategyId : undefined);
  const progress = movementProgress(movement.status, movement.chain_finalized_at !== null);
  const { status } = progress;
  return {
    ...operation,
    status: projectedOperationStatus(operation.status, status),
    nextAction: waitFor(progress),
    error: projectedError(
      operation,
      status === "failed"
        ? {
            code: "TRANSACTION_FAILED",
            message: movement.failure_reason ?? "Strategy transaction failed",
          }
        : null
    ),
    result: {
      positionId: position.id,
      strategyId: strategyId ?? undefined,
      source: positionSource(position),
      signature: movement.signature,
      settledAmount:
        movement.token_amount_settled !== null && position.token_mint !== null
          ? { mint: position.token_mint, value: movement.token_amount_settled }
          : null,
      settlementOutcome: status === "completed" ? "delivered" : null,
    },
  };
}

async function admitDeposit(env: Env, scope: OperationScope, operation: Operation) {
  if (operation.intent.kind !== "earn.deposit") return;
  const strategy = await createPostgresEarnRepository(getDb(env)).getStrategyById(
    operation.intent.strategyId
  );
  if (strategy === null || strategy.environment !== scope.environment)
    throw notFound("Earn strategy");
  if (!isEarnStrategyInExecutionShelf(strategy))
    throw badRequest("This strategy is available for discovery only");
  await assertRecordedStrategyDepositAdmitted(env, scope, strategy);
}

/** Persisted custody signatures still require the recorded actor's live authority. */
async function admitRecordedCustodyBroadcast(
  env: Env,
  scope: OperationScope,
  claim: OperationClaim,
  built: Awaited<ReturnType<typeof resolveEarnOperationBuild>>["target"],
  custodyWalletId: string
): Promise<boolean> {
  if ((await admitOperationEffect(env, scope, claim, built, custodyWalletId)) !== null)
    return false;
  try {
    if (claim.attempt.signedTransaction !== null && claim.attempt.proposalBinding !== null) {
      const proposer = await createOrgTransactionProposerForCustodyWallet(
        env,
        scope.organizationId,
        scope.projectId,
        custodyWalletId,
        built.movement
      );
      if (proposer === null)
        throw new ProposalAdmissionRefusedError(
          "custody_account_changed",
          conflict("Custody transaction account changed")
        );
      await proposer.admit(claim.attempt.proposalBinding);
    }
    return true;
  } catch (error) {
    if (
      !(error instanceof ProposalAdmissionRefusedError) &&
      !(error instanceof MoneyMovementRefusedError) &&
      !(error instanceof AppError && (error.code === "BAD_REQUEST" || error.code === "FORBIDDEN"))
    )
      throw error;
    await createOperationsService(env).repository.restrictToObservation(scope, claim);
    return false;
  }
}

/** Why a new effect was refused, as the failed operation reports it. */
interface EffectRefusal {
  code: "SIGNING_REJECTED" | "DEPOSIT_REFUSED";
  message: string;
}

const PERMISSION_WITHDRAWN: EffectRefusal = {
  code: "SIGNING_REJECTED",
  message: "Permission was withdrawn before signing",
};

/**
 * Exits bypass commercial admission, but never the submitted operation's current permission.
 * Returns null when admitted, else the refusal, having restricted the attempt to observation.
 */
async function admitOperationEffect(
  env: Env,
  scope: OperationScope,
  claim: OperationClaim,
  built: PreparedStrategySigningTarget,
  custodyWalletId: string | null
): Promise<EffectRefusal | null> {
  let stage: "permission" | "deposit" = "permission";
  try {
    await assertMoneyStartAdmitted(
      env,
      scope,
      {
        surface: "job",
        movement: built.movement,
        subjectId: claim.operation.id,
        requiredAction: "earn.execute",
      },
      { custodyWalletId }
    );
    stage = "deposit";
    await admitDeposit(env, scope, claim.operation);
    return null;
  } catch (error) {
    if (
      !(error instanceof MoneyMovementRefusedError) &&
      !(error instanceof AppError && (error.code === "BAD_REQUEST" || error.code === "FORBIDDEN"))
    ) {
      throw error;
    }
    await createOperationsService(env).repository.restrictToObservation(scope, claim);
    // A strategy that stopped admitting the deposit refused it; the caller kept permission.
    return stage === "deposit"
      ? {
          code: "DEPOSIT_REFUSED",
          message: error.message || "The strategy no longer accepts this deposit",
        }
      : PERMISSION_WITHDRAWN;
  }
}

/**
 * What signed bytes SDP will not send become once retained history has a verdict: still
 * reconciling, ended, or undefined once they landed, so they are observed like any sent
 * transaction. They end failed even after a cancellation request: a terminal cancellation needs
 * an authoritative resource reference, and bytes SDP never sent have none.
 */
function unsentSignatureUpdate(
  verdict: UnsentTransactionVerdict,
  operationError: Operation["error"]
): OperationUpdate | undefined {
  const depositRefused = operationError?.code === "DEPOSIT_REFUSED";
  switch (verdict) {
    case "landed":
      return undefined;
    case "pending":
      return {
        status: "awaiting_signature",
        nextAction: {
          type: "wait",
          reason: "Reconciling the signed transaction without sending it",
        },
        resourceRef: null,
        error: depositRefused ? operationError : null,
      };
    case "expired":
      return {
        status: "failed",
        nextAction: null,
        resourceRef: null,
        error: depositRefused
          ? operationError
          : {
              code: "TRANSACTION_EXPIRED",
              message: "The signed transaction expired before it was sent",
            },
      };
    default: {
      const unknownVerdict: never = verdict;
      throw internalError(`Unknown unsent transaction verdict: ${unknownVerdict}`);
    }
  }
}

/**
 * Observe signed bytes SDP will not send. A release is adopted for observation either way: it
 * proves its own absence before failing. Other unsent bytes end only once retained history
 * proves they can never land. Undefined once the bytes are seen, so they are adopted like any
 * sent transaction.
 */
async function observeUnsentSignature(input: {
  scope: OperationScope;
  built: PreparedStrategySigningTarget;
  signedTransaction: string;
  currentRelease: boolean;
  operationError: Operation["error"];
  observations: OperationObservationRpc;
  workerBudget: OperationWorkerBudget;
}): Promise<OperationUpdate | undefined> {
  const signed = await verifySignedWalletTransaction(input.built, input.signedTransaction);
  input.workerBudget.assertCanStart();
  if (input.currentRelease) return undefined;
  if (await input.observations.hasSignature(input.scope, signed.signature)) return undefined;
  const verdict = await input.observations.unsentVerdict(
    input.scope,
    signed.signature,
    BigInt(input.built.last_valid_block_height)
  );
  return unsentSignatureUpdate(verdict, input.operationError);
}

/** A ledger admission refusal does not prove that exposed signed bytes never landed. */
function depositExposureRefusal(
  cause: unknown,
  built: PreparedStrategySigningTarget,
  broadcast: boolean
): EffectRefusal | null {
  if (
    !broadcast ||
    built.movement !== "earn.deposit" ||
    !(cause instanceof AppError) ||
    cause.code !== "VAULT_EXPOSURE_CAP"
  )
    return null;
  return { code: "DEPOSIT_REFUSED", message: cause.message };
}

function isUnavailableWithdrawalRecovery(
  cause: unknown,
  built: PreparedStrategySigningTarget
): boolean {
  return (
    built.movement === "earn.queued_withdraw_cancel" &&
    cause instanceof AppError &&
    cause.details?.reason === "withdrawal_recovery_unavailable"
  );
}

/**
 * The synchronous custody signer's signed bytes. A provider wallet policy that refused before
 * signing anything ends the operation, as a rejected proposal does: asking again cannot change
 * its answer. Any other failure propagates to recovery.
 */
async function signWithCustodySigner(
  env: Env,
  transactionScope: StrategyTransactionScope,
  built: PreparedStrategySigningTarget,
  workerBudget: OperationWorkerBudget
): Promise<string | OperationUpdate> {
  try {
    return await signPreparedStrategyTransaction(env, transactionScope, built, workerBudget);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "CUSTODY_POLICY_REFUSED") throw error;
    return {
      status: "failed",
      nextAction: null,
      resourceRef: null,
      error: { code: error.code, message: error.message },
    };
  }
}

export async function advanceEarnOperation(
  env: Env,
  scope: OperationScope,
  claim: OperationClaim,
  observations: OperationObservationRpc = createOperationObservationRpc()
): Promise<Operation> {
  if (scope.environment !== currentClusterScope().environment)
    throw internalError("Operation cluster scope changed");
  const workerBudget = createOperationWorkerBudget();
  if (isTerminalOperation(claim.operation)) return claim.operation;
  if (claim.operation.resourceRef?.kind === "earn.redemption_release")
    return advanceCurrentRedemptionRelease(env, scope, claim, observations);
  const service = createOperationsService(env);
  const {
    target: built,
    transactionScope,
    submit,
    currentRelease,
  } = await resolveEarnOperationBuild(env, scope, claim);
  const update = (change: OperationUpdate) => service.transition(scope, claim, change);
  if (
    claim.operation.resourceRef?.kind === "earn.movement" ||
    claim.operation.resourceRef?.kind === "earn.withdrawal_request" ||
    claim.operation.resourceRef?.kind === "earn.withdrawal_recovery"
  ) {
    const projected = await projectEarnOperation(env, scope, claim.operation);
    return update({
      status: projected.status,
      nextAction: projected.nextAction,
      resourceRef: projected.resourceRef,
      error: projected.error,
    });
  }
  let attempt = claim.attempt;
  let signedTransaction = attempt.signedTransaction;
  const stopping = claim.operation.cancelRequestedAt !== null;
  let observeOnly = stopping || attempt.observationOnly;
  let refusal: EffectRefusal | null = null;
  async function admitNewEffect(): Promise<boolean> {
    if (observeOnly) return false;
    refusal = await admitOperationEffect(
      env,
      scope,
      claim,
      built,
      transactionScope.custodyWalletId
    );
    observeOnly = refusal !== null;
    return refusal === null;
  }
  const refuseUnsentSignature = () =>
    update({
      status: "failed",
      nextAction: null,
      resourceRef: null,
      error: refusal ?? PERMISSION_WITHDRAWN,
    });
  if (!observeOnly && signedTransaction === null && transactionScope.custodyWalletId !== null)
    await admitNewEffect();
  if (observeOnly && !stopping && signedTransaction === null && attempt.dispatchStartedAt === null)
    return refuseUnsentSignature();
  if (signedTransaction === null && transactionScope.custodyWalletId === null)
    throw internalError("Accepted wallet submission has no stored signed transaction");
  // These helpers capture the same leased action; extraction does not add a
  // signing authority, retry identity, or independent lifecycle state.
  async function pendingCustodyProposal(
    proposer: NonNullable<Awaited<ReturnType<typeof createOrgTransactionProposerForCustodyWallet>>>,
    binding: NonNullable<OperationAttempt["proposalBinding"]>,
    observation: TransactionProposalObservation,
    expired: boolean
  ): Promise<Operation> {
    if (await admitNewEffect()) {
      try {
        await proposer.admit(binding);
      } catch (error) {
        if (!(error instanceof ProposalAdmissionRefusedError)) throw error;
        await service.repository.restrictToObservation(scope, claim);
        observeOnly = true;
      }
    }
    if (expired || observeOnly) {
      workerBudget.assertCanStart();
      await proposer.cancel(binding);
    }
    return update({
      status: "awaiting_signature",
      resourceRef: null,
      error: null,
      nextAction:
        expired || observeOnly
          ? { type: "wait", reason: "Waiting for the original signing request to be cancelled" }
          : {
              type: "sign_in_provider",
              provider: proposer.provider,
              providerTransactionId: observation.providerTransactionId,
              handoffUrl: null,
              instructions: "Sign this transaction with your wallet provider",
            },
    });
  }
  async function readCustodyProposal(
    proposer: CustodyTransactionProposer
  ): Promise<
    | { binding: OperationProposalBinding; observation: TransactionProposalObservation | null }
    | { operation: Operation }
  > {
    let binding = attempt.proposalBinding;
    let observation: TransactionProposalObservation | null;
    if (binding === null) {
      if (stopping) throw conflict("Operation cancellation was requested");
      await admitDeposit(env, scope, claim.operation);
      if ((await observations.confirmedHeight(scope)) > BigInt(built.last_valid_block_height)) {
        return {
          operation: await update({
            status: "failed",
            nextAction: null,
            resourceRef: null,
            error: {
              code: "TRANSACTION_EXPIRED",
              message: "The transaction expired before signing",
            },
          }),
        };
      }
      workerBudget.assertCanStart();
      binding = await proposer.prepare(attempt.id);
      attempt = await service.recordProposalBinding(scope, claim, binding);
    }
    workerBudget.assertCanStart();
    if (attempt.dispatchStartedAt === null && !(await admitNewEffect()))
      return { operation: await refuseUnsentSignature() };
    const create =
      attempt.dispatchStartedAt === null && !stopping && !observeOnly
        ? await service.markDispatchStarted(scope, claim)
        : false;
    if (create) {
      try {
        observation = await proposer.propose({
          binding,
          unsignedTransaction: built.unsigned_transaction,
        });
      } catch (error) {
        // Only this typed pre-POST refusal proves the provider received nothing.
        if (!(error instanceof ProposalNotSentError)) throw error;
        return {
          operation: await update({
            status: "failed",
            resourceRef: { kind: "custody.proposal_not_sent", id: attempt.id },
            error: {
              code: "SIGNING_REJECTED",
              message: "The signing request was not sent",
            },
            nextAction: null,
          }),
        };
      }
    } else {
      // A missing lookup after an uncertain create does not authorize another
      // POST. Keep the original external identity recoverable indefinitely.
      observation = await proposer.read({
        binding,
        unsignedTransaction: built.unsigned_transaction,
      });
    }
    return { binding, observation };
  }
  async function acceptSignedCustodyProposal(
    proposer: CustodyTransactionProposer,
    binding: OperationProposalBinding,
    observation: TransactionProposalObservation,
    expired: boolean
  ): Promise<Operation | undefined> {
    if (observation.signedTransaction === null)
      throw internalError("Signed custody observation has no transaction");
    if (await admitNewEffect()) {
      try {
        await proposer.admit(binding);
      } catch (error) {
        if (!(error instanceof ProposalAdmissionRefusedError)) throw error;
        await service.repository.restrictToObservation(scope, claim);
        observeOnly = true;
      }
    }
    if ((expired || observeOnly) && built.fee_mode === "sponsored") {
      // No sponsor signature was requested for these bytes. Retaining the
      // owner proposal cannot create an executable sponsored transaction.
      return update({
        status: observeOnly ? "cancelled" : "failed",
        resourceRef: { kind: "custody.proposal", id: observation.providerTransactionId },
        error: observeOnly
          ? null
          : {
              code: "TRANSACTION_EXPIRED",
              message: "The signing request expired",
            },
        nextAction: null,
      });
    }
    observeOnly ||= expired;
    // A provider signature does not restore withdrawn spend authority.
    if (observeOnly) signedTransaction = observation.signedTransaction;
    else {
      await admitDeposit(env, scope, claim.operation);
      signedTransaction = await sponsorPreparedStrategyTransaction(
        env,
        transactionScope,
        built,
        observation.signedTransaction,
        workerBudget
      );
    }
  }
  async function prepareCustodyProposal(
    proposer: CustodyTransactionProposer
  ): Promise<Operation | undefined> {
    const result = await readCustodyProposal(proposer);
    if ("operation" in result) return result.operation;
    const { binding, observation } = result;
    if (observation === null)
      return update({
        status: "awaiting_signature",
        resourceRef: null,
        error: null,
        nextAction: { type: "wait", reason: "Reconciling the original signing request" },
      });
    const expired =
      (await observations.confirmedHeight(scope)) > BigInt(built.last_valid_block_height);
    if (observation.phase === "pending")
      return pendingCustodyProposal(proposer, binding, observation, expired);
    if (observation.phase === "failed" || observation.phase === "cancelled") {
      const cancelled = stopping && observation.phase === "cancelled";
      return update({
        status: cancelled ? "cancelled" : "failed",
        resourceRef: { kind: "custody.proposal", id: observation.providerTransactionId },
        error: cancelled
          ? null
          : {
              code: expired ? "TRANSACTION_EXPIRED" : "SIGNING_REJECTED",
              message: expired ? "The signing request expired" : "The signing request ended",
            },
        nextAction: null,
      });
    }
    return acceptSignedCustodyProposal(proposer, binding, observation, expired);
  }
  async function prepareCustodySignature(): Promise<Operation | undefined> {
    const movement = built.movement;
    const custodyWalletId = transactionScope.custodyWalletId;
    if (custodyWalletId === null) throw internalError("Custody signing has no wallet");
    const proposer = await createOrgTransactionProposerForCustodyWallet(
      env,
      scope.organizationId,
      scope.projectId,
      custodyWalletId,
      movement
    );
    if (proposer === null) {
      if (stopping) throw conflict("Operation cancellation was requested");
      await admitDeposit(env, scope, claim.operation);
      if ((await observations.confirmedHeight(scope)) > BigInt(built.last_valid_block_height)) {
        return update({
          status: "failed",
          nextAction: null,
          resourceRef: null,
          error: { code: "TRANSACTION_EXPIRED", message: "The transaction expired before signing" },
        });
      }
      if (!(await admitNewEffect())) return refuseUnsentSignature();
      const signing = await signWithCustodySigner(env, transactionScope, built, workerBudget);
      if (typeof signing !== "string") return update(signing);
      signedTransaction = signing;
    } else {
      const outcome = await prepareCustodyProposal(proposer);
      if (outcome !== undefined) return outcome;
    }
    if (signedTransaction === null) throw internalError("Custody signing returned no transaction");
    const signed = await verifySignedWalletTransaction(built, signedTransaction);
    attempt = await service.recordSignedAttempt(scope, claim, {
      signedTransaction: signed.signedTransactionBase64,
      signature: signed.signature,
      lastValidBlockHeight: built.last_valid_block_height,
    });
    signedTransaction = attempt.signedTransaction;
  }
  if (signedTransaction === null && transactionScope.custodyWalletId !== null) {
    const outcome = await prepareCustodySignature();
    if (outcome !== undefined) return outcome;
  }
  if (signedTransaction === null) throw internalError("Operation has no signed transaction");
  if (!observeOnly && transactionScope.custodyWalletId !== null)
    observeOnly = !(await admitRecordedCustodyBroadcast(
      env,
      scope,
      claim,
      built,
      transactionScope.custodyWalletId
    ));
  if (!observeOnly && transactionScope.custodyWalletId === null) await admitNewEffect();
  // A late owner signature after cancellation is retained for observation,
  // never used as permission to initiate a fresh broadcast.
  const broadcast = !observeOnly;
  if (!broadcast) {
    await service.repository.restrictToObservation(scope, claim);
    const unsent = await observeUnsentSignature({
      scope,
      built,
      signedTransaction,
      currentRelease,
      operationError: claim.operation.error,
      observations,
      workerBudget,
    });
    if (unsent !== undefined) return update(unsent);
  }
  workerBudget.assertCanStart();
  if (broadcast) await service.markDispatchStarted(scope, claim);
  let resourceRef: Operation["resourceRef"];
  try {
    resourceRef = await submit(signedTransaction, broadcast);
  } catch (error) {
    const exposureRefusal = depositExposureRefusal(error, built, broadcast);
    if (exposureRefusal !== null) {
      // The ledger refused before broadcast, but exposed bytes can still land independently.
      await service.repository.restrictToObservation(scope, claim);
      return update({
        status: "awaiting_signature",
        nextAction: {
          type: "wait",
          reason: "Reconciling the refused deposit without sending it",
        },
        resourceRef: null,
        error: exposureRefusal,
      });
    }
    if (!isUnavailableWithdrawalRecovery(error, built)) throw error;
    return update({
      status: "failed",
      nextAction: null,
      resourceRef: null,
      error: {
        code: "TRANSACTION_FAILED",
        message: "The withdrawal settled or was recovered before this recovery was recorded",
      },
    });
  }
  return update({
    status: "submitted",
    nextAction: { type: "wait", reason: "Waiting for transaction confirmation" },
    resourceRef,
    error: null,
  });
}

/** Acknowledgement only. Every signer, provider proposal and send runs in the worker. */
export async function submitEarnOperation(
  env: Env,
  scope: OperationScope,
  id: string,
  input: SubmitOperation,
  c: AppContext
) {
  const service = createOperationsService(env);
  const claim = await service.claimSubmission(scope, id, input);
  try {
    const { target, transactionScope } = await resolveEarnOperationBuild(env, scope, claim);
    let verifiedSigned: OperationSignedAttempt | undefined;
    if (transactionScope.custodyWalletId !== null && input.signedTransaction !== undefined) {
      throw badRequest("Custody transactions are signed through their configured provider");
    }
    if (transactionScope.custodyWalletId === null && input.signedTransaction !== undefined) {
      const signed = await verifySignedWalletTransaction(target, input.signedTransaction);
      verifiedSigned = {
        signedTransaction: signed.signedTransactionBase64,
        signature: signed.signature,
        lastValidBlockHeight: target.last_valid_block_height,
      };
    } else if (
      transactionScope.custodyWalletId === null &&
      claim.attempt.signedTransaction === null
    ) {
      throw badRequest("Sign the advertised transaction before submitting");
    }
    if (claim.operation.cancelRequestedAt !== null)
      await service.repository.restrictToObservation(scope, claim);
    await acceptOperationExecution(c, scope, claim, verifiedSigned);
    markIdempotencyCommitted(c);
    if (claim.recoveryRequired) return await projectEarnOperation(env, scope, claim.operation);
    return await service.transition(scope, claim, {
      status: "queued",
      nextAction: { type: "wait", reason: "Execution queued" },
      resourceRef: null,
      error: null,
    });
  } finally {
    await service.repository.release(scope, claim);
  }
}
