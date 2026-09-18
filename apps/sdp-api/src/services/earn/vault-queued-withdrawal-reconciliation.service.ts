import type {
  EarnVaultQueuedWithdrawalLifecycleEvent,
  EarnVaultQueuedWithdrawalRequestLookup,
  EarnVaultQueuedWithdrawProvider,
} from "@sdp/earn";
import { createRpc, getSignatureStatuses, type SignatureStatusInfo } from "@sdp/rpc/solana";
import { address, type Signature } from "@solana/kit";
import { getDb } from "@/db";
import {
  createPostgresEarnVaultWithdrawalRequestsRepository,
  type EarnVaultWithdrawalRequestActionRow,
  type EarnVaultWithdrawalRequestRow,
  type EarnVaultWithdrawalRequestsRepository,
} from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import {
  earnClusterFor,
  resolveClusterRpcUrl,
  resolveVaultQueuedWithdrawClient,
} from "@/services/earn/execution-registry";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import { broadcastVaultTransaction } from "@/services/earn/vault-execution.service";
import type { Env } from "@/types/env";

const ACTION_BATCH_SIZE = 128;
const REQUEST_BATCH_SIZE = 128;
const CLOSING_HISTORY_PAGE_SIZE = 1_000;
const CLOSING_HISTORY_MAX_PAGES = 10;

type QueueLedger = EarnVaultWithdrawalRequestsRepository;
type RequestedLifecycleEvent = Extract<
  EarnVaultQueuedWithdrawalLifecycleEvent,
  { kind: "withdrawalRequested" }
>;
type ClosingLifecycleEvent = Extract<
  EarnVaultQueuedWithdrawalLifecycleEvent,
  { kind: "withdrawalCancelled" | "withdrawalFulfilled" }
>;

interface ClosingEventObservation {
  signature: string;
  event: ClosingLifecycleEvent;
}

interface QueueReconciliationStats {
  actionsClaimed: number;
  actionsAdvanced: number;
  actionsFailed: number;
  actionsRebroadcast: number;
  requestsClaimed: number;
  requestsAdvanced: number;
  requestsClosedUnknown: number;
  errors: number;
}

interface RawTransactionResponse {
  meta: { err: unknown | null; logMessages?: readonly string[] | null } | null;
}

interface RawSignatureInfo {
  signature: string;
  err: unknown | null;
}

interface RawHistoryRpc {
  getTransaction(
    signature: Signature,
    config: {
      commitment: "finalized";
      encoding: "json";
      maxSupportedTransactionVersion: 0;
    }
  ): { send(): Promise<RawTransactionResponse | null> };
  getSignaturesForAddress(
    requestAddress: ReturnType<typeof address>,
    config: { commitment: "finalized"; limit: number; before?: Signature; until?: Signature }
  ): { send(): Promise<readonly RawSignatureInfo[]> };
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function epochSecondsIso(value: string): string {
  const milliseconds = Number(BigInt(value) * 1_000n);
  const date = new Date(milliseconds);
  if (!Number.isSafeInteger(milliseconds) || Number.isNaN(date.getTime())) {
    throw new Error(`Provider lifecycle timestamp ${value} is outside the ISO date range`);
  }
  return date.toISOString();
}

function emptyStats(actions: number, requests: number): QueueReconciliationStats {
  return {
    actionsClaimed: actions,
    actionsAdvanced: 0,
    actionsFailed: 0,
    actionsRebroadcast: 0,
    requestsClaimed: requests,
    requestsAdvanced: 0,
    requestsClosedUnknown: 0,
    errors: 0,
  };
}

/**
 * Reconcile both layers of a queued withdrawal:
 *
 * - owner-signed request/cancel transaction finality; and
 * - the long-lived queue PDA, including provider-solver fulfillment.
 *
 * A closed PDA is never guessed terminal. Its finalized address history must
 * contain a matching provider-authenticated lifecycle event before SDP records
 * fulfilled or cancelled; otherwise the durable state remains
 * `closed_or_unknown` and is retried on the next sweep.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the bounded sweep keeps per-environment RPC failure isolation and batch draining explicit.
export async function reconcileEarnVaultQueuedWithdrawals(env: Env): Promise<void> {
  const ledger = createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
  await ledger.cleanupExpiredReservations();
  for (const environment of ["sandbox", "production"] as const) {
    try {
      const rpc = createRpc(env, {
        rpcUrl: resolveClusterRpcUrl(env, earnClusterFor(environment)),
      });
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- each environment has an independent confirmed block-height lease.
      const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- cleanup is environment-scoped and bounded to two clusters.
      await ledger.cleanupExpiredExternalBuilds({
        environment,
        currentBlockHeight: height.toString(),
      });
    } catch (error) {
      getLogger().warn(
        { environment, error },
        "earn queued withdrawal reconciliation: abandoned-build cleanup deferred"
      );
    }
  }
  const actions = await ledger.claimUnsettledActions(ACTION_BATCH_SIZE);
  const requests = await ledger.claimOpenRequests(REQUEST_BATCH_SIZE);
  const stats = emptyStats(actions.length, requests.length);

  for (const [environment, rows] of groupBy(actions, (row) => row.environment)) {
    const cluster = earnClusterFor(environment);
    const rpcUrl = resolveClusterRpcUrl(env, cluster);
    const rpc = createRpc(env, { rpcUrl });
    let statuses: Array<SignatureStatusInfo | null>;
    try {
      statuses = await getSignatureStatuses(
        rpc,
        rows.map((row) => row.signature as Signature),
        { searchTransactionHistory: true }
      );
    } catch (error) {
      stats.errors += rows.length;
      getLogger().error(
        { environment, actions: rows.length, error },
        "earn queued withdrawal reconciliation: signature batch unreadable"
      );
      continue;
    }

    const needsHeight = rows.some(
      (row, index) =>
        statuses[index] === null &&
        (row.status === "requested" || (row.status === "submitted" && row.action === "cancel"))
    );
    let currentHeight: bigint | null = null;
    if (needsHeight) {
      try {
        currentHeight = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
      } catch (error) {
        stats.errors += 1;
        getLogger().error(
          { environment, error },
          "earn queued withdrawal reconciliation: block height unreadable"
        );
      }
    }

    for (const [index, actionRow] of rows.entries()) {
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- bounded reconciliation pacing protects the RPC and pool.
        const outcome = await reconcileAction(env, ledger, actionRow, statuses[index] ?? null, {
          rpc: rpc as unknown as RawHistoryRpc,
          rpcUrl,
          currentHeight,
        });
        if (outcome === "advanced") stats.actionsAdvanced += 1;
        else if (outcome === "failed") stats.actionsFailed += 1;
        else if (outcome === "rebroadcast") stats.actionsRebroadcast += 1;
      } catch (error) {
        stats.errors += 1;
        getLogger().error(
          { actionId: actionRow.id, requestId: actionRow.withdrawal_request_id, error },
          "earn queued withdrawal reconciliation: action remains unsettled"
        );
      }
    }
  }

  for (const request of requests) {
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- bounded reconciliation pacing protects provider RPC.
      const outcome = await reconcileRequest(env, ledger, request);
      if (outcome === "advanced") stats.requestsAdvanced += 1;
      else if (outcome === "closedUnknown") stats.requestsClosedUnknown += 1;
    } catch (error) {
      stats.errors += 1;
      await ledger.recordIndexError({
        withdrawalRequestId: request.id,
        error: describeError(error),
      });
      getLogger().error(
        { requestId: request.id, requestAddress: request.request_address, error },
        "earn queued withdrawal reconciliation: request remains unresolved"
      );
    }
  }

  logEvent(stats.errors > 0 ? "error" : "info", {
    event: "sdp_api_earn_vault_queued_withdrawal_reconciliation_tick",
    actions_claimed: stats.actionsClaimed,
    actions_advanced: stats.actionsAdvanced,
    actions_failed: stats.actionsFailed,
    actions_rebroadcast: stats.actionsRebroadcast,
    requests_claimed: stats.requestsClaimed,
    requests_advanced: stats.requestsAdvanced,
    requests_closed_unknown: stats.requestsClosedUnknown,
    errors: stats.errors,
  });
  if (stats.errors > 0) {
    throw new Error(`Earn queued withdrawal reconciliation had ${stats.errors} errors`);
  }
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const row of rows) {
    const value = key(row);
    const bucket = grouped.get(value);
    if (bucket) bucket.push(row);
    else grouped.set(value, [row]);
  }
  return grouped;
}

export async function reconcileAction(
  env: Env,
  ledger: QueueLedger,
  actionRow: EarnVaultWithdrawalRequestActionRow,
  status: SignatureStatusInfo | null,
  chain: { rpc: RawHistoryRpc; rpcUrl: string; currentHeight: bigint | null }
): Promise<"advanced" | "failed" | "rebroadcast" | "unchanged"> {
  if (status?.err) {
    await failAction(ledger, actionRow, describeError(status.err));
    return "failed";
  }
  if (status?.confirmationStatus === "finalized") {
    await ledger.advanceAction({
      actionId: actionRow.id,
      organizationId: actionRow.organization_id,
      toStatus: "finalized",
    });
    await projectFinalizedAction(env, ledger, actionRow, chain.rpc);
    return "advanced";
  }
  if (status?.confirmationStatus === "confirmed") {
    await ledger.advanceAction({
      actionId: actionRow.id,
      organizationId: actionRow.organization_id,
      toStatus: "confirmed",
    });
    return actionRow.status === "confirmed" ? "unchanged" : "advanced";
  }
  if (status !== null) {
    if (actionRow.status === "requested") {
      await ledger.advanceAction({
        actionId: actionRow.id,
        organizationId: actionRow.organization_id,
        toStatus: "submitted",
      });
      return "advanced";
    }
    return "unchanged";
  }

  // An already-submitted CREATE may have fallen out of this RPC's history;
  // its live request is reconciled through the PDA sweep. A submitted CANCEL
  // needs one extra recovery rule: once its blockhash expired, a still-live
  // expired PDA proves the cancel did not finalize and must reopen retry.
  if (actionRow.status !== "requested") {
    if (
      actionRow.status === "submitted" &&
      actionRow.action === "cancel" &&
      chain.currentHeight !== null &&
      chain.currentHeight > BigInt(actionRow.last_valid_block_height)
    ) {
      return recoverExpiredUnknownAction(env, ledger, actionRow, chain.rpc);
    }
    return "unchanged";
  }
  if (
    chain.currentHeight !== null &&
    chain.currentHeight > BigInt(actionRow.last_valid_block_height)
  ) {
    const observation = await ledger.observeExpiredUnknownSignature({
      actionId: actionRow.id,
      organizationId: actionRow.organization_id,
    });
    if (observation !== "repeat") return "unchanged";
    // A null signature lookup is not proof that the signed transaction never
    // landed: RPC history can omit an old signature while the queue PDA is
    // still live (or has already closed). Consult provider state before making
    // any terminal decision so a real escrow can never disappear from the
    // durable recovery queue merely because signature history was incomplete.
    return recoverExpiredUnknownAction(env, ledger, actionRow, chain.rpc);
  }
  if (chain.currentHeight === null) return "unchanged";

  await broadcastVaultTransaction(env, {
    cluster: earnClusterFor(actionRow.environment),
    deadline: createVaultDeadline(),
    bytes: Uint8Array.from(Buffer.from(actionRow.signed_transaction, "base64")),
    rpcUrl: chain.rpcUrl,
  });
  await ledger.advanceAction({
    actionId: actionRow.id,
    organizationId: actionRow.organization_id,
    toStatus: "submitted",
  });
  return "rebroadcast";
}

async function recoverExpiredUnknownAction(
  env: Env,
  ledger: QueueLedger,
  actionRow: EarnVaultWithdrawalRequestActionRow,
  rpc: RawHistoryRpc
): Promise<"advanced" | "failed" | "unchanged"> {
  const request = await ledger.getById({
    organizationId: actionRow.organization_id,
    environment: actionRow.environment,
    withdrawalRequestId: actionRow.withdrawal_request_id,
  });
  if (!request) throw new Error(`Missing queued withdrawal ${actionRow.withdrawal_request_id}`);

  const client = resolveVaultQueuedWithdrawClient(env, request.provider, createVaultDeadline());
  if (!client) throw new Error(`Queued withdrawal provider ${request.provider} is unavailable`);
  const lookup = await client.readQueuedWithdrawalRequest(
    { env, environment: request.environment },
    { providerReference: request.vault_address, requestAddress: request.request_address }
  );

  if (lookup.status !== "closedOrUnknown") {
    assertLiveRequest(request, lookup);
    if (actionRow.action === "cancel") {
      if (lookup.status !== "expiredCancelable") {
        throw new Error(
          `Expired cancellation ${actionRow.id} found queue request in ${lookup.status}`
        );
      }
      await ledger.failActionAndRecoverRequest({
        actionId: actionRow.id,
        organizationId: actionRow.organization_id,
        failureReason: "Cancellation blockhash expired while the queue request remained open",
        nonce: lookup.request.nonce,
        creationTimestamp: lookup.request.creationTimestamp,
        quotedAssets: lookup.request.assets,
        maturityTimestamp: lookup.request.maturityTimestamp,
        deadlineTimestamp: lookup.request.deadlineTimestamp,
        lastIndexError: null,
      });
      return "failed";
    }

    await ledger.advanceAction({
      actionId: actionRow.id,
      organizationId: actionRow.organization_id,
      toStatus: "submitted",
    });
    await projectLiveRequest(ledger, request, lookup);
    return "advanced";
  }

  const closing = await findClosingEvent(env, rpc, request, client);
  if (closing !== null) {
    assertClosingIdentity(request, closing.event);
    await projectClosingEvent(ledger, request, closing);
    if (actionRow.action === "cancel") {
      if (closing.event.kind === "withdrawalFulfilled") {
        await ledger.advanceAction({
          actionId: actionRow.id,
          organizationId: actionRow.organization_id,
          toStatus: "failed",
          failureReason: "Queue request was fulfilled before cancellation finalized",
        });
        return "failed";
      }
      if (closing.signature === actionRow.signature) {
        await ledger.advanceAction({
          actionId: actionRow.id,
          organizationId: actionRow.organization_id,
          toStatus: "finalized",
        });
        return "advanced";
      }
      await ledger.advanceAction({
        actionId: actionRow.id,
        organizationId: actionRow.organization_id,
        toStatus: "failed",
        failureReason: "Queue request was cancelled by a different transaction",
      });
      return "failed";
    }
    await ledger.advanceAction({
      actionId: actionRow.id,
      organizationId: actionRow.organization_id,
      toStatus: "submitted",
    });
    return "advanced";
  }

  if (actionRow.action === "cancel") {
    // The request existed before this cancellation was built, so its now-closed
    // PDA is authoritative evidence that some terminal path won. Keep the
    // signed action and request retryable while address history catches up.
    await ledger.advanceAction({
      actionId: actionRow.id,
      organizationId: actionRow.organization_id,
      toStatus: "submitted",
    });
    await ledger.advanceRequest({
      withdrawalRequestId: request.id,
      organizationId: request.organization_id,
      toStatus: "closed_or_unknown",
      lastIndexError: "Queue PDA closed while cancellation signature history was unavailable",
    });
    return "advanced";
  }

  // For a CREATE, an absent PDA plus absent history still is not proof of
  // non-landing. Leaving the action requested is intentionally conservative:
  // the fair claim cursor retries it without orphaning a possible escrow.
  return "unchanged";
}

async function failAction(
  ledger: QueueLedger,
  actionRow: EarnVaultWithdrawalRequestActionRow,
  reason: string
): Promise<void> {
  await ledger.failActionAndRecoverRequest({
    actionId: actionRow.id,
    organizationId: actionRow.organization_id,
    failureReason: reason,
  });
}

async function transactionLogs(
  rpc: RawHistoryRpc,
  signature: string
): Promise<readonly string[] | null> {
  const transaction = await rpc
    .getTransaction(signature as Signature, {
      commitment: "finalized",
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    })
    .send();
  if (!transaction || transaction.meta?.err) return null;
  return transaction.meta?.logMessages ?? null;
}

async function lifecycleEvents(
  env: Env,
  client: EarnVaultQueuedWithdrawProvider,
  request: EarnVaultWithdrawalRequestRow,
  logs: readonly string[] | null
): Promise<readonly EarnVaultQueuedWithdrawalLifecycleEvent[]> {
  return client.decodeQueuedWithdrawalLifecycleEvents(
    { env, environment: request.environment },
    {
      providerReference: request.vault_address,
      requestAddress: request.request_address,
      logs,
      shareDecimals: request.share_decimals,
      assetDecimals: request.asset_decimals,
    }
  );
}

async function projectFinalizedAction(
  env: Env,
  ledger: QueueLedger,
  actionRow: EarnVaultWithdrawalRequestActionRow,
  rpc: RawHistoryRpc
): Promise<void> {
  const request = await ledger.getById({
    organizationId: actionRow.organization_id,
    environment: actionRow.environment,
    withdrawalRequestId: actionRow.withdrawal_request_id,
  });
  if (!request) throw new Error(`Missing queued withdrawal ${actionRow.withdrawal_request_id}`);
  const client = resolveVaultQueuedWithdrawClient(env, request.provider, createVaultDeadline());
  if (!client) throw new Error(`Queued withdrawal provider ${request.provider} is unavailable`);
  const logs = await transactionLogs(rpc, actionRow.signature);
  const events = await lifecycleEvents(env, client, request, logs);
  if (actionRow.action === "request") {
    const event = events.find(
      (candidate) =>
        candidate.kind === "withdrawalRequested" &&
        String(candidate.requestAddress) === request.request_address
    );
    if (event?.kind !== "withdrawalRequested") {
      throw new Error(`Finalized request ${actionRow.signature} had no matching lifecycle event`);
    }
    assertRequestedEvent(request, event);
    await ledger.advanceRequest({
      withdrawalRequestId: request.id,
      organizationId: request.organization_id,
      toStatus: statusAt(event.maturityTimestamp, event.deadlineTimestamp),
      nonce: event.nonce,
      creationTimestamp: event.creationTimestamp,
      quotedAssets: event.assets,
      maturityTimestamp: event.maturityTimestamp,
      deadlineTimestamp: event.deadlineTimestamp,
    });
    return;
  }

  const event = events.find(
    (candidate) =>
      candidate.kind === "withdrawalCancelled" &&
      String(candidate.requestAddress) === request.request_address
  );
  if (event?.kind !== "withdrawalCancelled") {
    throw new Error(
      `Finalized cancellation ${actionRow.signature} had no matching lifecycle event`
    );
  }
  assertClosingIdentity(request, event);
  await ledger.advanceRequest({
    withdrawalRequestId: request.id,
    organizationId: request.organization_id,
    toStatus: "cancelled",
    closingSignature: actionRow.signature,
    nonce: event.nonce,
    cancelledAt: epochSecondsIso(event.cancelledAt),
  });
}

function statusAt(
  maturityTimestamp: string,
  deadlineTimestamp: string
): "pending" | "fulfillable" | "expired_cancelable" {
  const now = BigInt(Math.floor(Date.now() / 1_000));
  if (now < BigInt(maturityTimestamp)) return "pending";
  if (now <= BigInt(deadlineTimestamp)) return "fulfillable";
  return "expired_cancelable";
}

export function assertRequestedEvent(
  request: EarnVaultWithdrawalRequestRow,
  event: RequestedLifecycleEvent
): void {
  if (
    String(event.assetMint) !== request.token_mint ||
    event.shares !== request.shares ||
    String(event.owner) !== request.owner_address
  ) {
    throw new Error(`Queued withdrawal ${request.id} lifecycle event disagrees with signed intent`);
  }
}

export function assertClosingIdentity(
  request: EarnVaultWithdrawalRequestRow,
  event: ClosingLifecycleEvent
): void {
  if (
    String(event.requestAddress) !== request.request_address ||
    String(event.assetMint) !== request.token_mint ||
    String(event.owner) !== request.owner_address ||
    (request.nonce !== null && event.nonce !== request.nonce) ||
    (event.kind === "withdrawalCancelled"
      ? event.sharesReturned !== request.shares
      : event.sharesBurned !== request.shares)
  ) {
    throw new Error(`Queued withdrawal ${request.id} closing event has a foreign identity`);
  }
}

function assertLiveRequest(
  request: EarnVaultWithdrawalRequestRow,
  lookup: Exclude<EarnVaultQueuedWithdrawalRequestLookup, { status: "closedOrUnknown" }>
): void {
  // Both addresses the adapter returns must name the request this sweep set
  // out to read: a same-owner, same-vault neighbor returned here would
  // otherwise have its nonce and timing projected onto this request, and the
  // real close event would then fail the nonce check forever.
  if (
    lookup.requestAddress !== request.request_address ||
    lookup.request.requestAddress !== request.request_address
  ) {
    throw new Error(`Queued withdrawal ${request.id} PDA read returned a foreign request address`);
  }
  // The top-level status is the adapter's read verdict; `request.status` is
  // the account's own field. Projecting state only when they agree keeps a
  // partially decoded read from persisting half of the provider's truth.
  if (lookup.status !== lookup.request.status) {
    throw new Error(`Queued withdrawal ${request.id} PDA read has incoherent status`);
  }
  if (
    lookup.request.providerReference !== request.vault_address ||
    lookup.request.assetMint !== request.token_mint ||
    lookup.request.shares !== request.shares ||
    lookup.request.owner !== request.owner_address
  ) {
    throw new Error(`Queued withdrawal ${request.id} PDA identity disagrees with durable intent`);
  }
  if (
    request.nonce !== null &&
    (lookup.request.nonce !== request.nonce ||
      lookup.request.assets !== request.quoted_assets ||
      lookup.request.maturityTimestamp !== request.maturity_timestamp ||
      lookup.request.deadlineTimestamp !== request.deadline_timestamp)
  ) {
    throw new Error(`Queued withdrawal ${request.id} PDA terms changed after landing`);
  }
}

async function projectLiveRequest(
  ledger: QueueLedger,
  request: EarnVaultWithdrawalRequestRow,
  lookup: Exclude<EarnVaultQueuedWithdrawalRequestLookup, { status: "closedOrUnknown" }>
): Promise<void> {
  const providerStatus =
    lookup.status === "expiredCancelable" ? "expired_cancelable" : lookup.status;
  const toStatus = request.status === "cancelling" ? "cancelling" : providerStatus;
  await ledger.advanceRequest({
    withdrawalRequestId: request.id,
    organizationId: request.organization_id,
    toStatus,
    nonce: lookup.request.nonce,
    creationTimestamp: lookup.request.creationTimestamp,
    quotedAssets: lookup.request.assets,
    maturityTimestamp: lookup.request.maturityTimestamp,
    deadlineTimestamp: lookup.request.deadlineTimestamp,
    lastIndexError: null,
  });
}

async function reconcileRequest(
  env: Env,
  ledger: QueueLedger,
  request: EarnVaultWithdrawalRequestRow
): Promise<"advanced" | "closedUnknown" | "unchanged"> {
  const client = resolveVaultQueuedWithdrawClient(env, request.provider, createVaultDeadline());
  if (!client) throw new Error(`Queued withdrawal provider ${request.provider} is unavailable`);
  const lookup = await client.readQueuedWithdrawalRequest(
    { env, environment: request.environment },
    { providerReference: request.vault_address, requestAddress: request.request_address }
  );
  if (lookup.status !== "closedOrUnknown") {
    assertLiveRequest(request, lookup);
    const providerStatus =
      lookup.status === "expiredCancelable" ? "expired_cancelable" : lookup.status;
    const toStatus = request.status === "cancelling" ? "cancelling" : providerStatus;
    await projectLiveRequest(ledger, request, lookup);
    return STATUS_EQUIVALENT[request.status] === lookup.status || toStatus === request.status
      ? "unchanged"
      : "advanced";
  }

  const rpc = createRpc(env, {
    rpcUrl: resolveClusterRpcUrl(env, earnClusterFor(request.environment)),
  }) as unknown as RawHistoryRpc;
  const closing = await findClosingEvent(env, rpc, request, client);
  if (closing === null) {
    await ledger.advanceRequest({
      withdrawalRequestId: request.id,
      organizationId: request.organization_id,
      toStatus: "closed_or_unknown",
      lastIndexError: "Queue PDA closed without a matching finalized lifecycle event yet",
    });
    return "closedUnknown";
  }
  assertClosingIdentity(request, closing.event);
  await projectClosingEvent(ledger, request, closing);
  return "advanced";
}

export async function projectClosingEvent(
  ledger: QueueLedger,
  request: EarnVaultWithdrawalRequestRow,
  closing: ClosingEventObservation
): Promise<void> {
  if (closing.event.kind === "withdrawalCancelled") {
    await ledger.advanceRequest({
      withdrawalRequestId: request.id,
      organizationId: request.organization_id,
      toStatus: "cancelled",
      closingSignature: closing.signature,
      nonce: closing.event.nonce,
      cancelledAt: epochSecondsIso(closing.event.cancelledAt),
      lastIndexError: null,
    });
    return;
  }
  await ledger.advanceRequest({
    withdrawalRequestId: request.id,
    organizationId: request.organization_id,
    toStatus: "fulfilled",
    closingSignature: closing.signature,
    nonce: closing.event.nonce,
    assetsPaid: closing.event.assetsPaid,
    fulfilledAt: epochSecondsIso(closing.event.fulfilledAt),
    lastIndexError: null,
  });
}

const STATUS_EQUIVALENT: Record<string, string> = {
  pending: "pending",
  fulfillable: "fulfillable",
  expired_cancelable: "expiredCancelable",
};

async function findClosingEvent(
  env: Env,
  rpc: RawHistoryRpc,
  request: EarnVaultWithdrawalRequestRow,
  client: EarnVaultQueuedWithdrawProvider
): Promise<ClosingEventObservation | null> {
  let before: Signature | undefined;
  for (let page = 0; page < CLOSING_HISTORY_MAX_PAGES; page += 1) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- pagination follows newest-first history to the known request-creation boundary.
    const history = await rpc
      .getSignaturesForAddress(address(request.request_address), {
        commitment: "finalized",
        limit: CLOSING_HISTORY_PAGE_SIZE,
        ...(before ? { before } : {}),
        ...(request.creation_signature ? { until: request.creation_signature as Signature } : {}),
      })
      .send();
    for (const entry of history) {
      if (entry.err !== null) continue;
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- history is newest-first and stops at the first authoritative close event.
      const logs = await transactionLogs(rpc, entry.signature);
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- provider decoding may resolve provider-owned lifecycle configuration per finalized transaction.
      const events = await lifecycleEvents(env, client, request, logs);
      const event = events.find(
        (candidate) =>
          (candidate.kind === "withdrawalCancelled" || candidate.kind === "withdrawalFulfilled") &&
          String(candidate.requestAddress) === request.request_address
      );
      if (event?.kind === "withdrawalCancelled" || event?.kind === "withdrawalFulfilled") {
        return { signature: entry.signature, event };
      }
    }
    if (history.length < CLOSING_HISTORY_PAGE_SIZE) return null;
    const oldest = history.at(-1)?.signature;
    if (!oldest) return null;
    before = oldest as Signature;
  }
  throw new Error(
    `Queued withdrawal ${request.id} closing history exceeded ${CLOSING_HISTORY_MAX_PAGES} pages`
  );
}
