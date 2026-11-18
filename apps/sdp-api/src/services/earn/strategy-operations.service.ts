import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { ExecuteOperation, Operation, OperationProposalBinding } from "@sdp/types/operations";
import { TERMINAL_OPERATION_STATUSES } from "@sdp/types/operations";
import { signature } from "@solana/kit";
import { getDb } from "@/db/client";
import { createPostgresEarnRepository } from "@/db/repositories/earn.repository.postgres";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
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
import { isEarnStrategyInExecutionShelf } from "@/routes/earn/handlers/strategies";
import {
  ProposalAdmissionRefusedError,
  ProposalNotSentError,
} from "@/services/domain/signing/admitted-proposer";
import type {
  CustodyTransactionProposer,
  TransactionProposalObservation,
} from "@/services/domain/signing/admitted-transaction-proposer";
import { acceptOperationExecution } from "@/services/operation-execution-audit.service";
import { createOperationsService } from "@/services/operations.service";
import { createOrgTransactionProposerForCustodyWallet } from "@/services/solana/signer";
import type { Env } from "@/types/env";
import { createOperationWorkerBudget, type OperationWorkerBudget } from "./operation-worker-budget";
import { resolveEarnOperationBuild } from "./strategy-operation-build.service";
import {
  observePreparedSwapStrategyAction,
  retryPreparedSwapStrategyAction,
} from "./strategy-swap-operations.service";
import {
  type PreparedStrategySigningTarget,
  type StrategyTransactionScope,
  signPreparedStrategyTransaction,
  sponsorPreparedStrategyTransaction,
} from "./strategy-transactions.service";
import { readConfirmedBlockHeight } from "./vault-intent-execution.service";
import { verifySignedWalletTransaction } from "./vault-wallet.service";

export function isTerminalOperation(operation: Operation): boolean {
  return TERMINAL_OPERATION_STATUSES.some((status) => status === operation.status);
}

async function projectQueuedOperation(
  env: Env,
  scope: OperationScope,
  operation: Operation,
  requestId: string
): Promise<Operation> {
  const request = await createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env)).getById({
    organizationId: scope.organizationId,
    environment: scope.environment,
    withdrawalRequestId: requestId,
  });
  if (request === null || request.project_id !== scope.projectId)
    throw notFound("Operation withdrawal request");
  const status =
    request.status === "fulfilled"
      ? "completed"
      : request.status === "cancelled"
        ? "cancelled"
        : request.status === "failed"
          ? "failed"
          : "settling";
  return {
    ...operation,
    status: isTerminalOperation(operation) ? operation.status : status,
    nextAction:
      status === "settling" ? { type: "wait", reason: "Waiting for provider settlement" } : null,
    error:
      status === "failed"
        ? {
            code: "TRANSACTION_FAILED",
            message: request.failure_reason ?? "Withdrawal request failed",
          }
        : operation.error,
    result: {
      positionId: request.position_id,
      source:
        request.custody_wallet_id === null
          ? { ownerAddress: request.owner_address }
          : { walletId: request.custody_wallet_id },
      signature: request.closing_signature ?? request.creation_signature,
      settledAmount:
        request.assets_paid === null
          ? null
          : { mint: request.token_mint, value: request.assets_paid },
      settlementOutcome:
        status === "completed" ? "delivered" : status === "cancelled" ? "cancelled" : null,
    },
  };
}

/** A pure database projection. Polling never signs, proposes or broadcasts. */
export async function projectEarnOperation(
  env: Env,
  scope: OperationScope,
  operation: Operation
): Promise<Operation> {
  if (operation.resourceRef?.kind === "earn.withdrawal_request") {
    return projectQueuedOperation(env, scope, operation, operation.resourceRef.id);
  }
  if (operation.resourceRef?.kind !== "earn.movement") return operation;
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
  const status: Operation["status"] =
    movement.status === "failed"
      ? "failed"
      : movement.status === "finalized" || movement.status === "completed"
        ? "completed"
        : movement.chain_finalized_at !== null
          ? "settling"
          : "submitted";
  const source =
    position.custody_wallet_id !== null
      ? { walletId: position.custody_wallet_id }
      : position.owner_address !== null
        ? { ownerAddress: position.owner_address }
        : null;
  if (source === null) throw internalError("Operation position has no source");
  return {
    ...operation,
    status: isTerminalOperation(operation) ? operation.status : status,
    nextAction:
      status === "completed" || status === "failed"
        ? null
        : {
            type: "wait",
            reason:
              status === "settling"
                ? "Waiting for provider settlement"
                : "Waiting for transaction confirmation",
          },
    error:
      movement.status === "failed"
        ? {
            code: "TRANSACTION_FAILED",
            message: movement.failure_reason ?? "Strategy transaction failed",
          }
        : operation.error,
    result: {
      positionId: position.id,
      source,
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
  try {
    await assertMoneyStartAdmitted(
      env,
      scope,
      { surface: "job", movement: built.movement, subjectId: claim.operation.id },
      { custodyWalletId }
    );
    await admitDeposit(env, scope, claim.operation);
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

/**
 * Run only an already claimed action. The durable attempt is the outbox for
 * provider approval; the existing Earn movement remains the broadcast outbox.
 */
async function advanceSwapOperation(
  env: Env,
  scope: OperationScope,
  claim: OperationClaim,
  transactionScope: StrategyTransactionScope,
  built: PreparedStrategySigningTarget,
  workerBudget: OperationWorkerBudget
): Promise<Operation> {
  const reference = claim.operation.resourceRef;
  if (reference?.kind !== "earn.swap") throw internalError("Operation has no swap reference");
  const service = createOperationsService(env);
  const update = (change: OperationUpdate) => service.transition(scope, claim, change);
  const observed = await observePreparedSwapStrategyAction(env, transactionScope, reference.id);
  if (observed.status === "failed")
    return update({
      status: "failed",
      nextAction: null,
      resourceRef: reference,
      error: { code: "TRANSACTION_FAILED", message: "The deposit swap failed on chain" },
    });
  if (observed.status === "finalized") {
    if (claim.operation.cancelRequestedAt !== null)
      return update({
        status: "cancelled",
        nextAction: null,
        resourceRef: reference,
        error: null,
      });
    await update({
      status: "settling",
      nextAction: { type: "wait", reason: "Preparing the deposit review" },
      resourceRef: reference,
      error: null,
    });
    await service.repository.release(scope, claim);
    return service.repository.replacePreparedAction(
      scope,
      claim.operation.id,
      claim.operation,
      {
        nextAction: { type: "execute" },
        terms: { expiresAt: null, estimate: null, minimum: null, fees: null, options: [] },
        buildRef: { kind: "earn.deposit_continuation", id: reference.id },
      },
      { kind: "resolved_attempt", resourceRef: reference }
    );
  }
  if (
    !observed.observed &&
    claim.attempt.signedTransaction !== null &&
    !claim.attempt.observationOnly &&
    claim.operation.cancelRequestedAt === null
  ) {
    const admitted =
      transactionScope.custodyWalletId === null
        ? await admitOwnerOperationBroadcast(env, scope, claim, built)
        : await admitRecordedCustodyBroadcast(
            env,
            scope,
            claim,
            built,
            transactionScope.custodyWalletId
          );
    if (admitted) {
      workerBudget.assertCanStart();
      await retryPreparedSwapStrategyAction(env, {
        ...transactionScope,
        advisoryId: reference.id,
        signedTransaction: claim.attempt.signedTransaction,
      });
    }
  }
  return update({
    status: "submitted",
    nextAction: { type: "wait", reason: "Waiting for swap finalization" },
    resourceRef: reference,
    error: null,
  });
}

async function admitOwnerOperationBroadcast(
  env: Env,
  scope: OperationScope,
  claim: OperationClaim,
  built: PreparedStrategySigningTarget
): Promise<boolean> {
  try {
    await assertMoneyStartAdmitted(
      env,
      scope,
      { surface: "job", movement: built.movement, subjectId: claim.operation.id },
      { custodyWalletId: null }
    );
    await admitDeposit(env, scope, claim.operation);
    return true;
  } catch (error) {
    if (
      !(error instanceof MoneyMovementRefusedError) &&
      !(error instanceof AppError && (error.code === "BAD_REQUEST" || error.code === "FORBIDDEN"))
    ) {
      throw error;
    }
    await createOperationsService(env).repository.restrictToObservation(scope, claim);
    return false;
  }
}

export async function advanceEarnOperation(
  env: Env,
  scope: OperationScope,
  claim: OperationClaim,
  input?: ExecuteOperation
): Promise<Operation> {
  if (scope.environment !== currentClusterScope().environment)
    throw internalError("Operation cluster scope changed");
  const workerBudget = createOperationWorkerBudget();
  if (claim.operation.resourceRef?.kind === "custody.proposal_not_sent") return claim.operation;
  const service = createOperationsService(env);
  const {
    target: built,
    transactionScope,
    submit,
  } = await resolveEarnOperationBuild(env, scope, claim);
  const update = (change: OperationUpdate) => service.transition(scope, claim, change);
  if (claim.operation.resourceRef?.kind === "earn.swap") {
    return advanceSwapOperation(env, scope, claim, transactionScope, built, workerBudget);
  }
  if (
    claim.operation.resourceRef?.kind === "earn.movement" ||
    claim.operation.resourceRef?.kind === "earn.withdrawal_request"
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
  const stopping = claim.purpose !== "cancel" && claim.operation.cancelRequestedAt !== null;
  let observeOnly = stopping || attempt.observationOnly;
  if (
    transactionScope.custodyWalletId === null &&
    attempt.dispatchStartedAt === null &&
    !observeOnly
  ) {
    observeOnly = !(await admitOwnerOperationBroadcast(env, scope, claim, built));
  }
  if (signedTransaction === null && transactionScope.custodyWalletId === null) {
    if (input?.signedTransaction === undefined)
      throw conflict("The operation is waiting for its signed transaction");
    const signed = await verifySignedWalletTransaction(built, input.signedTransaction);
    attempt = await service.recordSignedAttempt(scope, claim, {
      signedTransaction: signed.signedTransactionBase64,
      signature: signed.signature,
      lastValidBlockHeight: built.last_valid_block_height,
    });
    signedTransaction = attempt.signedTransaction;
  }
  // These helpers capture the same leased action; extraction does not add a
  // signing authority, retry identity, or independent lifecycle state.
  async function pendingCustodyProposal(
    proposer: NonNullable<Awaited<ReturnType<typeof createOrgTransactionProposerForCustodyWallet>>>,
    binding: NonNullable<OperationAttempt["proposalBinding"]>,
    observation: TransactionProposalObservation,
    expired: boolean
  ): Promise<Operation> {
    if (!observeOnly) {
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
      status: "awaiting_approval",
      resourceRef: null,
      error: null,
      nextAction:
        expired || observeOnly
          ? { type: "wait", reason: "Waiting for the original custody approval to be cancelled" }
          : {
              type: "approve_in_provider",
              provider: proposer.provider,
              providerTransactionId: observation.providerTransactionId,
              handoffUrl: null,
              instructions: "Approve this transaction in your custody provider",
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
      if ((await readConfirmedBlockHeight()) > BigInt(built.last_valid_block_height)) {
        throw conflict("Prepared transaction expired; refresh before executing", {
          reason: "transaction_expired",
        });
      }
      workerBudget.assertCanStart();
      binding = await proposer.prepare(attempt.id);
      attempt = await service.recordProposalBinding(scope, claim, binding);
    }
    workerBudget.assertCanStart();
    const create =
      attempt.dispatchStartedAt === null && !stopping
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
            status: "awaiting_approval",
            resourceRef: { kind: "custody.proposal_not_sent", id: attempt.id },
            error: {
              code: "SIGNING_REJECTED",
              message: "The approval was not submitted; refresh to review a new transaction",
            },
            nextAction: { type: "refresh" },
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
    if (!observeOnly) {
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
        status: observeOnly ? "cancelled" : "awaiting_approval",
        resourceRef: { kind: "custody.proposal", id: observation.providerTransactionId },
        error: observeOnly
          ? null
          : {
              code: "TRANSACTION_EXPIRED",
              message: "Approval expired; refresh to review a new transaction",
            },
        nextAction: observeOnly ? null : { type: "refresh" },
      });
    }
    observeOnly ||= expired;
    // A provider signature is approval evidence, not fresh spend authority.
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
        status: "awaiting_approval",
        resourceRef: null,
        error: null,
        nextAction: { type: "wait", reason: "Reconciling the original custody approval" },
      });
    const expired = (await readConfirmedBlockHeight()) > BigInt(built.last_valid_block_height);
    if (observation.phase === "pending")
      return pendingCustodyProposal(proposer, binding, observation, expired);
    if (observation.phase === "failed" || observation.phase === "cancelled") {
      const cancelled = stopping && observation.phase === "cancelled";
      return update({
        status: cancelled ? "cancelled" : "awaiting_approval",
        resourceRef: { kind: "custody.proposal", id: observation.providerTransactionId },
        error: cancelled
          ? null
          : {
              code: expired ? "TRANSACTION_EXPIRED" : "SIGNING_REJECTED",
              message: expired
                ? "The approval expired; refresh to review a new transaction"
                : "The approval ended; refresh to review a new transaction",
            },
        nextAction: cancelled ? null : { type: "refresh" },
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
      if ((await readConfirmedBlockHeight()) > BigInt(built.last_valid_block_height)) {
        throw conflict("Prepared transaction expired; refresh before executing", {
          reason: "transaction_expired",
        });
      }
      signedTransaction = await signPreparedStrategyTransaction(
        env,
        transactionScope,
        built,
        workerBudget
      );
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
  // A late owner signature after cancellation is retained for observation,
  // never used as permission to initiate a fresh broadcast.
  const broadcast = !observeOnly;
  if (!broadcast) {
    await service.repository.restrictToObservation(scope, claim);
    const signed = await verifySignedWalletTransaction(built, signedTransaction);
    const observed = await createClusterRpc()
      .getSignatureStatuses([signature(signed.signature)], { searchTransactionHistory: true })
      .send();
    if (observed.value[0] === null || observed.value[0] === undefined) {
      return update({
        status:
          transactionScope.custodyWalletId === null ? "awaiting_signature" : "awaiting_approval",
        nextAction: {
          type: "wait",
          reason: "Reconciling the signed transaction without sending it",
        },
        resourceRef: null,
        error: null,
      });
    }
  }
  workerBudget.assertCanStart();
  if (broadcast) await service.markDispatchStarted(scope, claim);
  const resourceRef = await submit(signedTransaction, broadcast);
  return update({
    status: "submitted",
    nextAction: { type: "wait", reason: "Waiting for transaction confirmation" },
    resourceRef,
    error: null,
  });
}

/** Acknowledgement only. Every signer, provider proposal and send runs in the worker. */
export async function executeEarnOperation(
  env: Env,
  scope: OperationScope,
  id: string,
  input: ExecuteOperation,
  c: AppContext
) {
  const service = createOperationsService(env);
  const claim = await service.claimExecution(scope, id, input);
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
      throw badRequest("Sign the advertised transaction before executing");
    }
    if (claim.purpose !== "cancel" && claim.operation.cancelRequestedAt !== null)
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
