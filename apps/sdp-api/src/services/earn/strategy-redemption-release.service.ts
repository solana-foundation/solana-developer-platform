import { notImplemented } from "@sdp/earn/errors";
import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import { MAX_SUPPORTED_TRANSACTION_VERSION } from "@sdp/rpc/transaction-version";
import type { Operation, OperationReference, OperationSource } from "@sdp/types/operations";
import { isTerminalOperationStatus, projectedOperationStatus } from "@sdp/types/operations";
import { signature } from "@solana/kit";
import { getDb } from "@/db/client";
import { isCurrentRedemptionReleaseBuild } from "@/db/repositories/earn-redemption-release.repository";
import {
  createPostgresEarnVaultWithdrawalRequestsRepository,
  type EarnWalletWithdrawalRequestTransactionRow,
} from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import type { OperationClaim, OperationScope } from "@/db/repositories/operations.repository";
import { conflict, internalError, notFound } from "@/lib/errors";
import { createOperationsService } from "@/services/operations.service";
import type { Env } from "@/types/env";
import { resolveVaultParRedemptionClient } from "./execution-registry";
import type {
  OperationObservationRpc,
  UnsentTransactionVerdict,
} from "./operation-observation-rpc";
import { earnRuntime } from "./runtime";
import { createVaultDeadline } from "./vault-deadline";
import { broadcastVaultTransaction } from "./vault-execution.service";
import { verifySignedWalletTransaction } from "./vault-wallet.service";

interface FinalizedReleaseTransaction {
  signature: string | null;
  executionResultKnown: boolean;
  error: unknown | null;
  logs: readonly string[] | null;
  blockTime: string | null;
}

type FinalizedTransactionReader = (value: string) => Promise<FinalizedReleaseTransaction | null>;
type FinalizedHeightReader = () => Promise<bigint>;
type ClusterRpc = ReturnType<typeof createClusterRpc>;

/**
 * After expiry, a second finalized miss at least this long after the first proves a
 * release never ran: the same evidence an absent request create needs.
 */
const RELEASE_ABSENCE_RECHECK_MS = 30_000;
const RELEASE_FAILED = {
  code: "TRANSACTION_FAILED",
  message: "The current redemption release failed on chain",
};
const RELEASE_EXPIRED = {
  code: "TRANSACTION_EXPIRED",
  message: "The current redemption release expired before it landed",
};

/** One cluster client serves every chain read a release pass makes. */
function releaseChainReads(): {
  readTransaction: FinalizedTransactionReader;
  readFinalizedHeight: FinalizedHeightReader;
} {
  let rpc: ClusterRpc | undefined;
  const client = (): ClusterRpc => {
    if (rpc === undefined) rpc = createClusterRpc({ timeoutMs: 2_000 });
    return rpc;
  };
  return {
    readTransaction: (value) => readFinalizedTransaction(client(), value),
    readFinalizedHeight: () => client().getBlockHeight({ commitment: "finalized" }).send(),
  };
}

async function readFinalizedTransaction(
  rpc: ClusterRpc,
  value: string
): Promise<FinalizedReleaseTransaction | null> {
  const transaction = await rpc
    .getTransaction(signature(value), {
      commitment: "finalized",
      encoding: "json",
      maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION,
    })
    .send();
  return transaction === null
    ? null
    : {
        signature: transaction.transaction.signatures[0] ?? null,
        executionResultKnown: transaction.meta?.err !== undefined,
        error: transaction.meta?.err ?? null,
        logs: transaction.meta?.logMessages ?? null,
        blockTime: transaction.blockTime?.toString() ?? null,
      };
}

/** The accepted operation owns the PDA before any signing or broadcast. */
export async function submitCurrentRedemptionRelease(
  env: Env,
  input: {
    scope: OperationScope;
    buildId: string;
    attemptId: string;
    signedTransaction: string;
    broadcast: boolean;
  },
  readFinalizedHeight: FinalizedHeightReader = releaseChainReads().readFinalizedHeight
): Promise<OperationReference> {
  if (input.scope.environment !== currentClusterScope().environment)
    throw internalError("Operation cluster scope changed");
  const repository = createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
  const build = await repository.getWalletTransaction({
    organizationId: input.scope.organizationId,
    transactionId: input.buildId,
  });
  if (
    build === null ||
    build.project_id !== input.scope.projectId ||
    build.environment !== input.scope.environment ||
    !isCurrentRedemptionReleaseBuild(build)
  )
    throw notFound("Current redemption release transaction");
  const verified = await verifySignedWalletTransaction(build, input.signedTransaction);
  await repository.consumeCurrentRedemptionRelease({
    ...input.scope,
    transactionId: build.id,
    attemptId: input.attemptId,
    signature: verified.signature,
    signedTransaction: verified.signedTransactionBase64,
  });
  // Past its last valid block height the release can't land and preflight refuses every
  // resend: hand it to observation, which proves absence before failing it.
  if (input.broadcast && (await readFinalizedHeight()) <= BigInt(build.last_valid_block_height))
    await broadcastVaultTransaction({ bytes: verified.bytes, deadline: createVaultDeadline() });
  return { kind: "earn.redemption_release", id: build.id };
}

/**
 * A missing receipt proves nothing until the release's blockhash has expired at finalized
 * commitment. After that, a second finalized miss RELEASE_ABSENCE_RECHECK_MS after the first
 * hands the release to the shared absence proof: a lagging or pruned history backend can miss
 * a finalized transaction twice, so only every endpoint's retained history, read at a
 * finalized slot past the expiry, proves the release never ran.
 */
async function releaseAbsenceVerdict(input: {
  build: Pick<
    EarnWalletWithdrawalRequestTransactionRow,
    "last_valid_block_height" | "release_absence_observed_at"
  >;
  readFinalizedHeight: FinalizedHeightReader;
  recordAbsence: () => Promise<unknown>;
  proveAbsence: () => Promise<UnsentTransactionVerdict>;
}): Promise<"pending" | "expired"> {
  const observedAt = input.build.release_absence_observed_at;
  if (observedAt == null) {
    if ((await input.readFinalizedHeight()) > BigInt(input.build.last_valid_block_height))
      await input.recordAbsence();
    return "pending";
  }
  const firstMiss = Date.parse(observedAt);
  if (!Number.isFinite(firstMiss)) throw internalError("Release absence observation is unreadable");
  if (Date.now() - firstMiss < RELEASE_ABSENCE_RECHECK_MS) return "pending";
  // The marker already records expiry; the proof reads its own finalized height.
  return (await input.proveAbsence()) === "expired" ? "expired" : "pending";
}

interface ReleaseProjection {
  position_id: string;
  strategy_id: string | null;
  custody_wallet_id: string | null;
  owner_address: string;
  source: OperationSource;
  signature: string;
  release_finalized_at: string | null;
}

/** Polling reads only the canonical build and its exact accepted attempt. */
export async function projectCurrentRedemptionRelease(
  env: Env,
  scope: OperationScope,
  operation: Operation,
  buildId: string
): Promise<Operation> {
  const row = await getDb(env).queryOne<ReleaseProjection>(
    `SELECT build.position_id, build.strategy_id, build.custody_wallet_id,
            build.owner_address, build.release_finalized_at, operation.source, attempt.signature
       FROM earn_wallet_withdrawal_request_transactions build
       JOIN operation_attempts attempt ON attempt.id = build.consumed_attempt_id
        AND attempt.build_ref ->> 'kind' = 'earn.queued_transaction'
        AND attempt.build_ref ->> 'id' = build.id
        AND attempt.organization_id = build.organization_id
        AND attempt.project_id = build.project_id AND attempt.environment = build.environment
       JOIN operations operation ON operation.id = attempt.operation_id
        AND operation.organization_id = attempt.organization_id
        AND operation.project_id = attempt.project_id AND operation.environment = attempt.environment
        AND operation.action_id = attempt.action_id AND operation.action_version = attempt.action_version
      WHERE build.id = ? AND operation.id = ? AND build.organization_id = ?
        AND build.project_id = ? AND build.environment = ?
        AND build.operation_only AND build.action = 'cancel'
        AND build.mechanism = 'operator_redemption' AND build.withdrawal_request_id IS NULL
        AND build.position_id = operation.intent ->> 'positionId'
        AND attempt.execution_requested_at IS NOT NULL AND attempt.signature IS NOT NULL
        AND attempt.signed_transaction IS NOT NULL`,
    [buildId, operation.id, scope.organizationId, scope.projectId, scope.environment]
  );
  if (
    row === null ||
    ("walletId" in row.source
      ? row.source.walletId !== row.custody_wallet_id
      : row.custody_wallet_id !== null || row.source.ownerAddress !== row.owner_address)
  )
    throw notFound("Operation current redemption release");
  const recovered = row.release_finalized_at !== null;
  const status = projectedOperationStatus(operation.status, recovered ? "completed" : "settling");
  return {
    ...operation,
    status,
    updatedAt:
      row.release_finalized_at !== null &&
      Date.parse(row.release_finalized_at) > Date.parse(operation.updatedAt)
        ? row.release_finalized_at
        : operation.updatedAt,
    nextAction:
      status === "settling"
        ? { type: "wait", reason: "Waiting for the current redemption release to finalize" }
        : null,
    // Release evidence replaces an earlier pass's recovery error; a terminal operation keeps its own.
    error: isTerminalOperationStatus(operation.status) ? operation.error : null,
    result: {
      positionId: row.position_id,
      ...(row.strategy_id === null ? {} : { strategyId: row.strategy_id }),
      source: row.source,
      signature: row.signature,
      // Cancellation closes a request and may revoke a delegation. Its event
      // amount is the request obligation, never a measured token return.
      settledAmount: null,
      settlementOutcome: recovered && status === "completed" ? "recovered" : null,
    },
  };
}

/** Observe only this signed cancellation, never a historical request cycle. */
export async function advanceCurrentRedemptionRelease(
  env: Env,
  scope: OperationScope,
  claim: OperationClaim,
  observations: Pick<OperationObservationRpc, "unsentVerdict">,
  readTransaction?: FinalizedTransactionReader,
  readFinalizedHeight?: FinalizedHeightReader
): Promise<Operation> {
  if (scope.environment !== currentClusterScope().environment)
    throw internalError("Operation cluster scope changed");
  const buildId = claim.operation.resourceRef?.id;
  if (
    claim.operation.resourceRef?.kind !== "earn.redemption_release" ||
    buildId === undefined ||
    claim.attempt.signature === null ||
    claim.attempt.signedTransaction === null
  )
    throw conflict("Current redemption release has no recorded signed attempt");
  if (isTerminalOperationStatus(claim.operation.status))
    return projectCurrentRedemptionRelease(env, scope, claim.operation, buildId);
  const repository = createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
  const input = { ...scope, transactionId: buildId, attemptId: claim.attempt.id };
  const build = await repository.consumeCurrentRedemptionRelease({
    ...input,
    signature: claim.attempt.signature,
    signedTransaction: claim.attempt.signedTransaction,
  });
  const service = createOperationsService(env);
  const update = async (
    status: "settling" | "completed" | "failed",
    error: { code: string; message: string } = RELEASE_FAILED
  ) => {
    const operation = await service.transition(scope, claim, {
      status,
      resourceRef: { kind: "earn.redemption_release", id: buildId },
      nextAction:
        status === "settling"
          ? { type: "wait", reason: "Waiting for the current redemption release to finalize" }
          : null,
      error: status === "failed" ? error : null,
    });
    return projectCurrentRedemptionRelease(env, scope, operation, buildId);
  };
  if (build.release_finalized_at != null) return update("completed");
  const chain = releaseChainReads();
  const transaction = await (readTransaction ?? chain.readTransaction)(claim.attempt.signature);
  if (transaction === null) {
    const released = claim.attempt.signature;
    const verdict = await releaseAbsenceVerdict({
      build,
      readFinalizedHeight: readFinalizedHeight ?? chain.readFinalizedHeight,
      recordAbsence: () => repository.recordCurrentRedemptionReleaseAbsent(input),
      proveAbsence: () =>
        observations.unsentVerdict(scope, released, BigInt(build.last_valid_block_height)),
    });
    // An expired release with no effect is a definitive failure, which lifts the PDA fence.
    return verdict === "expired" ? update("failed", RELEASE_EXPIRED) : update("settling");
  }
  if (transaction.signature !== claim.attempt.signature || !transaction.executionResultKnown)
    return update("settling");
  // A finalized error proves no instruction effects survived. The terminal
  // operation transition releases the PDA fence in the same DB transaction.
  if (transaction.error !== null) return update("failed");
  if (
    transaction.logs === null ||
    transaction.blockTime === null ||
    build.share_decimals === null ||
    build.asset_decimals === null ||
    build.intermediate_mint === null
  )
    return update("settling");
  const client = resolveVaultParRedemptionClient(env, build.provider, createVaultDeadline());
  if (client === null) throw notImplemented(build.provider, "par redemptions");
  const events = await client.decodeParRedemptionLifecycleEvents(earnRuntime(env), {
    providerReference: build.vault_address,
    requestAddress: build.request_address,
    logs: transaction.logs,
    blockTime: transaction.blockTime,
    shareDecimals: build.share_decimals,
    assetDecimals: build.asset_decimals,
  });
  const cancellations = events.filter(
    (event) =>
      event.kind === "redemptionCancelled" &&
      event.requestAddress === build.request_address &&
      event.owner === build.owner_address &&
      event.intermediateMint === build.intermediate_mint
  );
  if (cancellations.length !== 1) return update("settling");
  // This reviewed action releases whichever request occupies the PDA when it
  // executes. A replacement request may have the same or a different amount.
  await repository.recordCurrentRedemptionReleaseFinalized(input);
  return update("completed");
}
