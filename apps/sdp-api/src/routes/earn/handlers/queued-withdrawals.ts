import { supportsVaultProviderOrderWithdraw } from "@sdp/earn/capabilities";
import { notImplemented } from "@sdp/earn/errors";
import type { EarnVaultQueuedWithdrawalQuote, EarnVaultWithdrawalOptions } from "@sdp/earn/types";
import type { SdpEnvironment } from "@sdp/types";
import type { z } from "zod";
import { getDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import {
  createPostgresEarnVaultWithdrawalRequestsRepository,
  type EarnVaultWithdrawalRequestRow,
  type EarnVaultWithdrawalRequestStatus,
} from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import { type ApiKeyContext, getAuth, getOptionalAuth, requireProjectId } from "@/lib/auth";
import { badRequest, conflict, internalError, notFound } from "@/lib/errors";
import { buildEarnVaultQueuedWithdrawalFingerprint } from "@/lib/idempotency";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/keyset-cursor";
import { success } from "@/lib/response";
import { isDryRunRequest } from "@/middleware/dry-run";
import { IDEMPOTENCY_KEY_HEADER } from "@/middleware/idempotency-key";
import { getPolicyGateContext, type PolicyGateExtraction } from "@/middleware/policy-gate";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { getLogger } from "@/runtime/logger";
import { assertApiKeyWalletAccess } from "@/services/api-key-scope.service";
import { AuditService } from "@/services/audit.service";
import {
  CustodyRuntimeTargets,
  type CustodyRuntimeWalletProjection,
} from "@/services/domain/signing/custody-runtime-target";
import {
  resolveVaultQueuedWithdrawClient,
  resolveVaultWithdrawClient,
} from "@/services/earn/execution-registry";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import {
  buildExternalQueuedWithdrawalCancel,
  buildExternalQueuedWithdrawalRequest,
  type CustodyQueuedWithdrawalActor,
  cancelCustodyQueuedWithdrawal,
  createCustodyQueuedWithdrawal,
  type ExternalQueuedWithdrawalBuiltTransaction,
  type QueuedWithdrawalActor,
  type QueuedWithdrawalMutationResult,
  type QueuedWithdrawalPosition,
  type QueuedWithdrawalTermsInput,
  submitExternalQueuedWithdrawalAction,
} from "@/services/earn/vault-queued-withdraw.service";
import { rethrowVaultProviderFailure } from "@/services/earn/vault-refusals";
import {
  approvedWalletOperationId,
  beginApprovedWalletOperationEffect,
  runApprovedWalletOperationEffectTransaction,
} from "@/services/policy/approved-operation-replay";
import { walletOperationActorFromAuth } from "@/services/policy/enforcement.service";
import type { AppContext } from "../context";
import { resolveSdpEnvironment } from "../context";
import {
  type earnExternalWalletQueuedWithdrawalPreviewSchema,
  type earnExternalWalletSubmitSchema,
  type earnExternalWalletWithdrawalOptionsSchema,
  type earnExternalWalletWithdrawalRequestCancelTransactionSchema,
  earnExternalWalletWithdrawalRequestsQuerySchema,
  type earnExternalWalletWithdrawalRequestTransactionSchema,
  type earnVaultQueuedWithdrawalPreviewSchema,
  type earnVaultWithdrawalOptionsSchema,
  type earnVaultWithdrawalRequestCancelSchema,
  earnVaultWithdrawalRequestParamsSchema,
  type earnVaultWithdrawalRequestSchema,
  earnVaultWithdrawalRequestsQuerySchema,
} from "../schemas";
import { resolveExternalWalletExit } from "./external-wallet";
import { throwOnPriorEarnPolicyOperation } from "./policy-replay";
import { parseParams, parseQuery } from "./shared";
import {
  assertBoundWalletIdentifierIsUnique,
  listReadableEarnVaultWallets,
  resolveEarnVaultCustodyWallet,
  toVaultHolding,
} from "./vault";

type CustodyRequestBody = z.output<typeof earnVaultWithdrawalRequestSchema>;
type ExternalRequestBuildBody = z.output<
  typeof earnExternalWalletWithdrawalRequestTransactionSchema
>;
type ExternalCancelBuildBody = z.output<
  typeof earnExternalWalletWithdrawalRequestCancelTransactionSchema
>;
type ExternalSubmitBody = z.output<typeof earnExternalWalletSubmitSchema>;

interface ResolvedCustodyQueueTarget {
  auth: ApiKeyContext;
  projectId: string;
  environment: SdpEnvironment;
  actor: CustodyQueuedWithdrawalActor;
  position: QueuedWithdrawalPosition;
  policyWalletId: string;
}

interface ResolvedCustodyQueueRequest extends ResolvedCustodyQueueTarget {
  requestId: string | null;
  idempotencyFingerprint: string;
}

const STATUS_TO_WIRE: Record<EarnVaultWithdrawalRequestStatus, string> = {
  creating: "creating",
  pending: "pending",
  fulfillable: "fulfillable",
  expired_cancelable: "expiredCancelable",
  cancelling: "cancelling",
  closed_or_unknown: "closedOrUnknown",
  fulfilled: "fulfilled",
  cancelled: "cancelled",
  failed: "failed",
};

const STATUS_FROM_WIRE = Object.fromEntries(
  Object.entries(STATUS_TO_WIRE).map(([database, wire]) => [wire, database])
) as Record<string, EarnVaultWithdrawalRequestStatus>;

function withdrawalRequestWire(row: EarnVaultWithdrawalRequestRow, replayed?: boolean) {
  return {
    withdrawalRequestId: row.id,
    positionId: row.position_id,
    provider: row.provider,
    providerReference: row.vault_address,
    ownerAddress: row.owner_address,
    requestAddress: row.request_address,
    status: STATUS_TO_WIRE[row.status],
    assetMint: row.token_mint,
    shareMint: row.share_mint,
    shares: row.shares,
    quotedAssets: row.quoted_assets,
    shareDecimals: row.share_decimals,
    assetDecimals: row.asset_decimals,
    discountBps: row.discount_bps,
    nonce: row.nonce,
    creationTimestamp: row.creation_timestamp,
    maturityTimestamp: row.maturity_timestamp,
    deadlineTimestamp: row.deadline_timestamp,
    creationSignature: row.creation_signature,
    cancelSignature: row.cancel_signature,
    closingSignature: row.closing_signature,
    assetsPaid: row.assets_paid,
    failureReason: row.failure_reason,
    fulfilledAt: row.fulfilled_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(replayed === undefined ? {} : { replayed }),
  };
}

export async function recordQueuedWithdrawalActionAudit(
  c: AppContext,
  result: QueuedWithdrawalMutationResult
): Promise<void> {
  try {
    await new AuditService(getDb(c.env)).log(c, {
      organizationId: result.request.organization_id,
      userId: result.action.created_by ?? undefined,
      apiKeyId: result.action.initiated_by_key_id ?? undefined,
      action: result.action.action === "request" ? "withdraw_request" : "withdraw_cancel",
      resourceType: "earn_vault_withdrawal_request",
      // One audit event per signed owner action. A failed cancellation can be
      // retried with a new action without hiding either attempt.
      resourceId: result.action.id,
      metadata: {
        withdrawalRequestId: result.request.id,
        actionId: result.action.id,
        actionStatus: result.action.status,
        provider: result.request.provider,
        positionId: result.request.position_id,
        custodyWalletId: result.request.custody_wallet_id,
        ownerAddress: result.request.owner_address,
        requestAddress: result.request.request_address,
        shares: result.request.shares,
        signature: result.action.signature,
        replayed: result.replayed,
        ...(result.replayed ? { backfilledOnReplay: true } : {}),
      },
    });
  } catch (error) {
    if (isUniqueViolationDeep(error)) return;
    getLogger().error(
      {
        event: "earn_audit_write_failed",
        withdrawalRequestId: result.request.id,
        actionId: result.action.id,
        error,
      },
      "Earn queued withdrawal audit record was not persisted; the request/action ledger remains authoritative"
    );
  }
}

function isUniqueViolationDeep(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (isPostgresUniqueViolation(current)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

export function builtTransactionWire(built: ExternalQueuedWithdrawalBuiltTransaction) {
  return {
    transactionId: built.id,
    transaction: built.unsigned_transaction,
    lastValidBlockHeight: built.last_valid_block_height,
    sponsored: false,
    ownerAddress: built.owner_address,
    ...(built.fee_payer === null ? {} : { feePayer: built.fee_payer }),
    provider: built.provider,
    providerReference: built.vault_address,
    tokenMint: built.token_mint,
    shareMint: built.share_mint,
    action: built.action,
    requestAddress: built.request_address,
    ...(built.position_id ? { positionId: built.position_id } : {}),
    ...(built.withdrawal_request_id ? { withdrawalRequestId: built.withdrawal_request_id } : {}),
    ...(built.shares === null
      ? {}
      : {
          shares: built.shares,
          assets: built.quoted_assets,
          discountBps: built.discount_bps,
          maturityTimestamp: built.maturity_timestamp,
          deadlineTimestamp: built.deadline_timestamp,
        }),
  };
}

function queuedTerms(body: {
  shares: string;
  discountBps: number;
  deadlineSeconds: number;
}): QueuedWithdrawalTermsInput {
  return {
    shares: body.shares,
    discountBps: body.discountBps,
    deadlineSeconds: body.deadlineSeconds,
  };
}

async function resolveCustodyQueueTarget(
  c: AppContext,
  positionId: string,
  access: "read" | "write"
): Promise<ResolvedCustodyQueueTarget> {
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const positionRow = await createPostgresEarnMovementsRepository(getDb(c.env)).getPositionById({
    organizationId: auth.organizationId,
    environment,
    positionId,
  });
  if (positionRow?.kind !== "vault_direct" || !positionRow.custody_wallet_id) {
    throw notFound("Earn vault position");
  }
  const position = toVaultHolding(positionRow);

  let wallet: CustodyRuntimeWalletProjection;
  if (access === "read") {
    const wallets = await listReadableEarnVaultWallets(c, auth, projectId);
    const readableWallet = wallets.find((candidate) => candidate.id === position.custodyWalletId);
    if (!readableWallet) throw notFound("Earn vault position");
    wallet = readableWallet;
  } else {
    const wallets = await new CustodyRuntimeTargets(getDb(c.env), c.env, new Map()).listWallets({
      organizationId: auth.organizationId,
      projectId,
      includeAllProviders: true,
    });
    wallet = resolveEarnVaultCustodyWallet(wallets, position.custodyWalletId);
    assertBoundWalletIdentifierIsUnique(auth, wallets, wallet);
    assertApiKeyWalletAccess(auth, wallet.walletId, ["earn:write"]);
  }

  return {
    auth,
    projectId,
    environment,
    actor: {
      organizationId: auth.organizationId,
      projectId,
      environment,
      custodyWalletId: wallet.id,
      custodyWalletPublicKey: wallet.publicKey,
      userId: auth.userId ?? null,
      apiKeyId: auth.apiKeyId ?? null,
    },
    position: {
      id: position.id,
      provider: position.provider,
      vaultAddress: position.vaultAddress,
      tokenMint: position.tokenMint,
      shareMint: position.shareMint,
      ownerAddress: wallet.publicKey,
      custodyWalletId: wallet.id,
    },
    policyWalletId: wallet.walletId,
  };
}

export async function readOptions(
  c: AppContext,
  environment: SdpEnvironment,
  position: QueuedWithdrawalPosition
): Promise<
  Omit<EarnVaultWithdrawalOptions, "withdrawAuthority"> & { withdrawAuthority: string | null }
> {
  const deadline = createVaultDeadline();
  const withdrawalClient = resolveVaultWithdrawClient(c.env, position.provider, deadline);
  const providerOrder =
    withdrawalClient !== null && supportsVaultProviderOrderWithdraw(withdrawalClient);
  const instant = withdrawalClient !== null && !providerOrder;
  const client = resolveVaultQueuedWithdrawClient(c.env, position.provider, deadline);
  if (!client) {
    if (!withdrawalClient) throw notImplemented(position.provider, "vault withdrawals");
    return {
      instant,
      providerOrder,
      queued: false,
      withdrawAuthority: null,
      queueState: null,
      queueAsset: null,
    };
  }
  try {
    const options = await client.getWithdrawalOptions(
      { env: c.env, environment },
      { providerReference: position.vaultAddress }
    );
    return { ...options, instant: instant && options.instant, providerOrder };
  } catch (error) {
    rethrowVaultProviderFailure(error);
  }
}

async function readPreview(
  c: AppContext,
  environment: SdpEnvironment,
  position: QueuedWithdrawalPosition,
  terms: QueuedWithdrawalTermsInput
): Promise<EarnVaultQueuedWithdrawalQuote> {
  const client = resolveVaultQueuedWithdrawClient(c.env, position.provider, createVaultDeadline());
  if (!client) throw notImplemented(position.provider, "queued vault withdrawals");
  try {
    return await client.quoteQueuedWithdrawal(
      { env: c.env, environment },
      { providerReference: position.vaultAddress, ...terms }
    );
  } catch (error) {
    rethrowVaultProviderFailure(error);
  }
}

export async function getEarnVaultWithdrawalOptions(
  c: ValidatedBodyContext<typeof earnVaultWithdrawalOptionsSchema>
) {
  const body = c.req.valid("json");
  const target = await resolveCustodyQueueTarget(c, body.positionId, "read");
  const options = await readOptions(c, target.environment, target.position);
  return success(c, { positionId: target.position.id, ...options });
}

export async function createEarnVaultQueuedWithdrawalPreview(
  c: ValidatedBodyContext<typeof earnVaultQueuedWithdrawalPreviewSchema>
) {
  const body = c.req.valid("json");
  const target = await resolveCustodyQueueTarget(c, body.positionId, "read");
  const quote = await readPreview(c, target.environment, target.position, queuedTerms(body));
  return success(c, { positionId: target.position.id, ...quote });
}

export async function extractEarnVaultWithdrawalRequestPolicyCandidate(
  c: ValidatedBodyContext<typeof earnVaultWithdrawalRequestSchema>
): Promise<PolicyGateExtraction> {
  const rawBody: Record<string, unknown> = await c.req.json();
  const body = c.req.valid("json");
  const requestId = c.req.header(IDEMPOTENCY_KEY_HEADER) ?? null;
  if (requestId === null && !isDryRunRequest(c)) {
    throw badRequest(`${IDEMPOTENCY_KEY_HEADER} is required for queued vault withdrawals`);
  }
  const target = await resolveCustodyQueueTarget(c, body.positionId, "write");
  const idempotencyFingerprint = buildEarnVaultQueuedWithdrawalFingerprint({
    environment: target.environment,
    provider: target.position.provider,
    positionId: target.position.id,
    ...queuedTerms(body),
  });
  const resolved: ResolvedCustodyQueueRequest = {
    ...target,
    requestId,
    idempotencyFingerprint,
  };
  return {
    candidate: {
      organizationId: target.auth.organizationId,
      projectId: target.projectId,
      custodyWalletId: target.actor.custodyWalletId,
      walletId: target.policyWalletId,
      apiKeyId: target.auth.apiKeyId ?? null,
      actor: walletOperationActorFromAuth(target.auth),
      source: "earn_vault_withdrawal",
      operationFamily: "program",
      operationType: "earn_vault_withdrawal",
      asset: target.position.shareMint,
      amount: body.shares,
      destination: target.position.vaultAddress,
      context: {
        provider: target.position.provider,
        positionId: target.position.id,
        tokenMint: target.position.tokenMint,
        environment: target.environment,
        depositStyle: "vault_direct",
        withdrawalRoute: "queued",
        discountBps: body.discountBps,
        deadlineSeconds: body.deadlineSeconds,
      },
      providerExtensions: {},
    },
    legs: [],
    body,
    resolved,
    rawPayload: { ...rawBody, idempotencyFingerprint },
    idempotencyKey: requestId,
  };
}

export async function findEarnVaultWithdrawalRequestIdempotentKeyReplay(
  c: AppContext,
  extraction: PolicyGateExtraction,
  idempotencyKey: string
): Promise<Response | null> {
  if (approvedWalletOperationId(c)) return null;
  const resolved = extraction.resolved as ResolvedCustodyQueueRequest;
  const prior = await createPostgresEarnVaultWithdrawalRequestsRepository(
    getDb(c.env)
  ).findByClientRequestId({
    organizationId: resolved.auth.organizationId,
    clientRequestId: idempotencyKey,
  });
  if (prior) {
    if (
      prior.project_id !== resolved.projectId ||
      prior.idempotency_fingerprint !== resolved.idempotencyFingerprint
    ) {
      throw conflict("Idempotency key already used with different request payload");
    }
    if (prior.status === "failed") {
      throw conflict("The recorded queued vault withdrawal failed and cannot be replayed");
    }
    const action = await createPostgresEarnVaultWithdrawalRequestsRepository(
      getDb(c.env)
    ).getLatestAction({ withdrawalRequestId: prior.id, action: "request" });
    if (!action || action.status === "failed") {
      throw conflict(
        "Queued vault withdrawal execution is incomplete and requires manual reconciliation"
      );
    }
    await recordQueuedWithdrawalActionAudit(c, { request: prior, action, replayed: true });
    return success(c, { withdrawalRequest: withdrawalRequestWire(prior, true) });
  }
  await throwOnPriorEarnPolicyOperation(c, {
    organizationId: resolved.auth.organizationId,
    scope: { kind: "project", projectId: resolved.projectId },
    idempotencyKey,
    idempotencyFingerprint: resolved.idempotencyFingerprint,
    operationNoun: "vault withdrawal",
  });
  return null;
}

export async function createEarnVaultWithdrawalRequest(
  c: ValidatedBodyContext<typeof earnVaultWithdrawalRequestSchema>
) {
  const { body, resolved } = getPolicyGateContext<CustodyRequestBody, ResolvedCustodyQueueRequest>(
    c
  );
  if (!resolved.requestId) {
    throw internalError(
      "Queued withdrawal execution reached the handler without an idempotency key"
    );
  }
  const result = await createCustodyQueuedWithdrawal(
    c.env,
    {
      actor: resolved.actor,
      position: resolved.position,
      terms: queuedTerms(body),
      clientRequestId: resolved.requestId,
    },
    {
      runIntentTransaction: (mutation) => runApprovedWalletOperationEffectTransaction(c, mutation),
    }
  );
  if (result.replayed && approvedWalletOperationId(c)) {
    await beginApprovedWalletOperationEffect(c);
    if (result.request.status === "failed" || result.action.status === "failed") {
      throw conflict(
        "Approved queued vault withdrawal execution is incomplete and requires manual reconciliation"
      );
    }
  }
  await recordQueuedWithdrawalActionAudit(c, result);
  return success(c, {
    withdrawalRequest: withdrawalRequestWire(result.request, result.replayed),
  });
}

function decodeRequestCursor(cursor: string | undefined) {
  if (!cursor) return undefined;
  const decoded = decodeKeysetCursor(cursor);
  if (!decoded || Number.isNaN(Date.parse(decoded.value)))
    throw badRequest("Invalid before cursor");
  return { createdAt: decoded.value, id: decoded.id };
}

export async function listEarnVaultWithdrawalRequests(c: AppContext) {
  const query = parseQuery(c, earnVaultWithdrawalRequestsQuerySchema);
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const wallets = await listReadableEarnVaultWallets(c, auth, projectId);
  const page = await createPostgresEarnVaultWithdrawalRequestsRepository(getDb(c.env)).list({
    organizationId: auth.organizationId,
    projectId,
    environment,
    custodyWalletIds: wallets.map((wallet) => wallet.id),
    ...(query.status ? { status: STATUS_FROM_WIRE[query.status] } : {}),
    ...(query.settled === undefined ? {} : { settled: query.settled }),
    ...(query.before ? { before: decodeRequestCursor(query.before) } : {}),
    limit: query.limit,
  });
  const last = page.rows.at(-1);
  return success(c, {
    withdrawalRequests: page.rows.map((row) => withdrawalRequestWire(row)),
    hasMore: page.hasMore,
    nextCursor: page.hasMore && last ? encodeKeysetCursor(last.created_at, last.id) : null,
  });
}

async function requireReadableCustodyRequest(c: AppContext, withdrawalRequestId: string) {
  const environment = resolveSdpEnvironment(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const request = await createPostgresEarnVaultWithdrawalRequestsRepository(getDb(c.env)).getById({
    organizationId: auth.organizationId,
    environment,
    withdrawalRequestId,
  });
  if (!request?.custody_wallet_id || request.project_id !== projectId) {
    throw notFound("Earn vault withdrawal request");
  }
  const wallets = await listReadableEarnVaultWallets(c, auth, projectId);
  if (!wallets.some((wallet) => wallet.id === request.custody_wallet_id)) {
    throw notFound("Earn vault withdrawal request");
  }
  return request;
}

/**
 * Cancellation is the custody recovery path, so its project boundary follows
 * the org-owned signing wallet rather than the request's historical project.
 * A deleted project sets `project_id` null, and an organization-level wallet
 * may intentionally be writable by a sibling project. The later write-target
 * resolution proves that this caller can use the exact custody wallet; list
 * and detail remain exact-project reads and therefore do not widen history.
 */
async function requireRecoverableCustodyRequest(c: AppContext, withdrawalRequestId: string) {
  const request = await createPostgresEarnVaultWithdrawalRequestsRepository(getDb(c.env)).getById({
    organizationId: getAuth(c).organizationId,
    environment: resolveSdpEnvironment(c),
    withdrawalRequestId,
  });
  if (!request?.custody_wallet_id) throw notFound("Earn vault withdrawal request");
  return request;
}

export async function getEarnVaultWithdrawalRequest(c: AppContext) {
  const { withdrawalRequestId } = parseParams(c, earnVaultWithdrawalRequestParamsSchema);
  return success(c, {
    withdrawalRequest: withdrawalRequestWire(
      await requireReadableCustodyRequest(c, withdrawalRequestId)
    ),
  });
}

export async function cancelEarnVaultWithdrawalRequest(
  c: ValidatedBodyContext<typeof earnVaultWithdrawalRequestCancelSchema>
) {
  const { withdrawalRequestId } = parseParams(c, earnVaultWithdrawalRequestParamsSchema);
  const clientRequestId = requireIdempotencyKey(c, "queued vault withdrawal cancellations");
  const request = await requireRecoverableCustodyRequest(c, withdrawalRequestId);
  const target = await resolveCustodyQueueTarget(c, request.position_id, "write");
  if (request.custody_wallet_id !== target.actor.custodyWalletId) {
    throw notFound("Earn vault withdrawal request");
  }
  const result = await cancelCustodyQueuedWithdrawal(c.env, {
    actor: target.actor,
    position: target.position,
    request,
    clientRequestId,
  });
  await recordQueuedWithdrawalActionAudit(c, result);
  return success(c, {
    withdrawalRequest: withdrawalRequestWire(result.request, result.replayed),
  });
}

function externalActor(
  c: AppContext,
  environment: SdpEnvironment
):
  | QueuedWithdrawalActor
  | {
      environment: SdpEnvironment;
    } {
  const auth = getOptionalAuth(c);
  if (!auth) return { environment };
  return {
    organizationId: auth.organizationId,
    projectId: requireProjectId(c),
    environment,
    userId: auth.userId ?? null,
    apiKeyId: auth.apiKeyId ?? null,
  };
}

function externalPosition(target: Awaited<ReturnType<typeof resolveExternalWalletExit>>) {
  return {
    id: target.positionId ?? "",
    provider: target.provider,
    vaultAddress: target.vaultAddress,
    tokenMint: target.tokenMint,
    shareMint: target.shareMint,
    ownerAddress: target.ownerAddress,
  } satisfies QueuedWithdrawalPosition;
}

export async function getEarnExternalWalletWithdrawalOptions(
  c: ValidatedBodyContext<typeof earnExternalWalletWithdrawalOptionsSchema>
) {
  const body = c.req.valid("json");
  const target = await resolveExternalWalletExit(c, body);
  const options = await readOptions(c, target.environment, externalPosition(target));
  return success(c, {
    ...(target.positionId ? { positionId: target.positionId } : { strategyId: target.strategyId }),
    ...options,
  });
}

export async function createEarnExternalWalletQueuedWithdrawalPreview(
  c: ValidatedBodyContext<typeof earnExternalWalletQueuedWithdrawalPreviewSchema>
) {
  const body = c.req.valid("json");
  const target = await resolveExternalWalletExit(c, body);
  const quote = await readPreview(
    c,
    target.environment,
    externalPosition(target),
    queuedTerms(body)
  );
  return success(c, {
    ...(target.positionId ? { positionId: target.positionId } : { strategyId: target.strategyId }),
    ...quote,
  });
}

export async function createEarnExternalWalletWithdrawalRequestTransaction(
  c: ValidatedBodyContext<typeof earnExternalWalletWithdrawalRequestTransactionSchema>
) {
  const body: ExternalRequestBuildBody = c.req.valid("json");
  const target = await resolveExternalWalletExit(c, body);
  const built = await buildExternalQueuedWithdrawalRequest(c.env, {
    actor: externalActor(c, target.environment),
    position: externalPosition(target),
    terms: queuedTerms(body),
    ...(body.feePayer ? { feePayer: body.feePayer } : {}),
  });
  return success(c, {
    transaction: {
      ...builtTransactionWire(built),
      ...(target.positionId
        ? { positionId: target.positionId }
        : { strategyId: target.strategyId }),
    },
  });
}

export async function createEarnExternalWalletWithdrawalRequestCancelTransaction(
  c: ValidatedBodyContext<typeof earnExternalWalletWithdrawalRequestCancelTransactionSchema>
) {
  const body: ExternalCancelBuildBody = c.req.valid("json");
  const auth = getOptionalAuth(c);
  if (auth) {
    const environment = resolveSdpEnvironment(c);
    if (!("withdrawalRequestId" in body)) {
      throw badRequest("withdrawalRequestId is required for an authenticated cancellation build");
    }
    const projectId = requireProjectId(c);
    const request = await createPostgresEarnVaultWithdrawalRequestsRepository(getDb(c.env)).getById(
      {
        organizationId: auth.organizationId,
        environment,
        withdrawalRequestId: body.withdrawalRequestId,
      }
    );
    if (!request || request.custody_wallet_id !== null || request.project_id !== projectId) {
      throw notFound("Earn external-wallet withdrawal request");
    }
    const target = await resolveExternalWalletExit(c, { positionId: request.position_id });
    if (target.ownerAddress !== request.owner_address) {
      throw notFound("Earn external-wallet withdrawal request");
    }
    const built = await buildExternalQueuedWithdrawalCancel(c.env, {
      actor: externalActor(c, environment),
      position: externalPosition(target),
      request,
      requestAddress: request.request_address,
      ...(body.feePayer ? { feePayer: body.feePayer } : {}),
    });
    return success(c, {
      transaction: { ...builtTransactionWire(built), positionId: target.positionId },
    });
  }

  if (!("strategyId" in body)) {
    throw badRequest("strategyId, ownerAddress and requestAddress are required anonymously");
  }
  const target = await resolveExternalWalletExit(c, body);
  const built = await buildExternalQueuedWithdrawalCancel(c.env, {
    actor: { environment: target.environment },
    position: externalPosition(target),
    request: null,
    requestAddress: body.requestAddress,
    ...(body.feePayer ? { feePayer: body.feePayer } : {}),
  });
  return success(c, {
    transaction: { ...builtTransactionWire(built), strategyId: target.strategyId },
  });
}

function requireIdempotencyKey(c: AppContext, noun: string): string {
  if (isDryRunRequest(c)) throw badRequest(`Dry-Run is not supported for ${noun}`);
  const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
  if (!key) throw badRequest(`${IDEMPOTENCY_KEY_HEADER} is required for ${noun}`);
  return key;
}

async function submitExternalQueueAction(
  c: ValidatedBodyContext<typeof earnExternalWalletSubmitSchema>,
  action: "request" | "cancel"
) {
  const body: ExternalSubmitBody = c.req.valid("json");
  const actor: QueuedWithdrawalActor = {
    organizationId: getAuth(c).organizationId,
    projectId: requireProjectId(c),
    environment: resolveSdpEnvironment(c),
    userId: getAuth(c).userId ?? null,
    apiKeyId: getAuth(c).apiKeyId ?? null,
  };
  const result = await submitExternalQueuedWithdrawalAction(c.env, {
    actor,
    transactionId: body.transactionId,
    signedTransaction: body.signedTransaction,
    clientRequestId: requireIdempotencyKey(c, `external-wallet queued withdrawal ${action}s`),
    action,
  });
  await recordQueuedWithdrawalActionAudit(c, result);
  return success(c, {
    withdrawalRequest: withdrawalRequestWire(result.request, result.replayed),
  });
}

export async function createEarnExternalWalletWithdrawalRequest(
  c: ValidatedBodyContext<typeof earnExternalWalletSubmitSchema>
) {
  return submitExternalQueueAction(c, "request");
}

export async function createEarnExternalWalletWithdrawalRequestCancellation(
  c: ValidatedBodyContext<typeof earnExternalWalletSubmitSchema>
) {
  return submitExternalQueueAction(c, "cancel");
}

export async function listEarnExternalWalletWithdrawalRequests(c: AppContext) {
  const query = parseQuery(c, earnExternalWalletWithdrawalRequestsQuerySchema);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const page = await createPostgresEarnVaultWithdrawalRequestsRepository(getDb(c.env)).list({
    organizationId: auth.organizationId,
    projectId,
    environment: resolveSdpEnvironment(c),
    ownerAddress: query.ownerAddress,
    externalWalletOnly: true,
    ...(query.status ? { status: STATUS_FROM_WIRE[query.status] } : {}),
    ...(query.settled === undefined ? {} : { settled: query.settled }),
    ...(query.before ? { before: decodeRequestCursor(query.before) } : {}),
    limit: query.limit,
  });
  const last = page.rows.at(-1);
  return success(c, {
    withdrawalRequests: page.rows.map((row) => withdrawalRequestWire(row)),
    hasMore: page.hasMore,
    nextCursor: page.hasMore && last ? encodeKeysetCursor(last.created_at, last.id) : null,
  });
}

export async function getEarnExternalWalletWithdrawalRequest(c: AppContext) {
  const { withdrawalRequestId } = parseParams(c, earnVaultWithdrawalRequestParamsSchema);
  const auth = getAuth(c);
  const request = await createPostgresEarnVaultWithdrawalRequestsRepository(getDb(c.env)).getById({
    organizationId: auth.organizationId,
    environment: resolveSdpEnvironment(c),
    withdrawalRequestId,
  });
  if (
    !request ||
    request.custody_wallet_id !== null ||
    request.project_id !== requireProjectId(c)
  ) {
    throw notFound("Earn external-wallet withdrawal request");
  }
  return success(c, { withdrawalRequest: withdrawalRequestWire(request) });
}
