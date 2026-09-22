import { notImplemented } from "@sdp/earn/errors";
import type {
  EarnRuntimeContext,
  EarnVaultParRedemptionQuote,
  EarnVaultParRedemptionRequestPlan,
  EarnVaultQueuedWithdrawalQuote,
  EarnVaultQueuedWithdrawalRequestPlan,
  EarnVaultTransactionPlan,
} from "@sdp/earn/types";
import { compareDecimalAmounts } from "@sdp/solana/amount";
import type { SdpEnvironment } from "@sdp/types";
import { address } from "@solana/kit";
import { type AppDb, getDb } from "@/db";
import {
  createPostgresEarnVaultWithdrawalRequestsRepository,
  type EarnExternalWalletWithdrawalRequestTransactionRow,
  type EarnVaultWithdrawalMechanism,
  type EarnVaultWithdrawalRequestActionRow,
  type EarnVaultWithdrawalRequestRow,
  generateEarnExternalWalletWithdrawalRequestTransactionId,
  generateEarnVaultWithdrawalRequestActionId,
  generateEarnVaultWithdrawalRequestId,
  generateEarnVaultWithdrawalRequestReservationId,
} from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import {
  AppError,
  badRequest,
  conflict,
  internalError,
  notFound,
  transactionExpired,
} from "@/lib/errors";
import {
  buildEarnVaultParRedemptionFingerprint,
  buildEarnVaultQueuedWithdrawalCancelFingerprint,
  buildEarnVaultQueuedWithdrawalFingerprint,
} from "@/lib/idempotency";
import { getLogger } from "@/runtime/logger";
import * as solanaServices from "@/services/solana";
import type { Env } from "@/types/env";
import {
  earnClusterFor,
  resolveClusterRpcUrl,
  resolveVaultParRedemptionClient,
  resolveVaultQueuedWithdrawClient,
} from "./execution-registry";
import { createVaultDeadline } from "./vault-deadline";
import {
  appendVaultRequestMemo,
  broadcastVaultTransaction,
  compileUnsignedVaultTransaction,
  type SignedVaultTransaction,
  signVaultPlan,
  simulateVaultPlan,
} from "./vault-execution.service";
import { verifySignedExternalWalletTransaction } from "./vault-external-wallet.service";
import { readConfirmedBlockHeight } from "./vault-intent-execution.service";
import { rethrowVaultProviderFailure } from "./vault-refusals";
import { rawSimulationDetails } from "./vault-simulation-error";
import { resolveVaultSponsorship, type VaultFeeMode, vaultRentPayer } from "./vault-sponsorship";

export interface QueuedWithdrawalPosition {
  id: string;
  provider: string;
  vaultAddress: string;
  tokenMint: string;
  shareMint: string;
  ownerAddress: string;
  custodyWalletId?: string | null;
}

export interface QueuedWithdrawalActor {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  userId?: string | null;
  apiKeyId?: string | null;
}

export interface CustodyQueuedWithdrawalActor extends QueuedWithdrawalActor {
  custodyWalletId: string;
  custodyWalletPublicKey: string;
}

export interface QueuedWithdrawalTermsInput {
  shares: string;
  discountBps: number;
  deadlineSeconds: number;
  mechanism?: "solver_queue";
}

export interface ParRedemptionTermsInput {
  shares: string;
  mechanism: "operator_redemption";
}

export type AsyncWithdrawalTermsInput = QueuedWithdrawalTermsInput | ParRedemptionTermsInput;

export interface QueuedWithdrawalMutationResult {
  request: EarnVaultWithdrawalRequestRow;
  action: EarnVaultWithdrawalRequestActionRow;
  replayed: boolean;
}

export interface QueuedWithdrawalExecutionOptions {
  /** Couple an approved-operation effect fence to the first durable mutation. */
  runIntentTransaction?: <T>(mutation: (db: AppDb) => Promise<T>) => Promise<T>;
}

export interface ExternalQueuedWithdrawalBuiltTransaction {
  id: string;
  environment: SdpEnvironment;
  provider: string;
  position_id: string | null;
  withdrawal_request_id: string | null;
  action: "request" | "cancel";
  mechanism: EarnVaultWithdrawalMechanism;
  owner_address: string;
  vault_address: string;
  token_mint: string;
  share_mint: string;
  request_address: string;
  shares: string | null;
  quoted_assets: string | null;
  share_decimals: number | null;
  asset_decimals: number | null;
  intermediate_mint: string | null;
  intermediate_amount: string | null;
  discount_bps: number | null;
  maturity_timestamp: string | null;
  deadline_timestamp: string | null;
  fee_payer: string | null;
  unsigned_transaction: string;
  last_valid_block_height: string;
}

const QUEUED_REQUEST_RESERVATION_MS = 5 * 60 * 1_000;

export function assertQueuePlan(
  plan: EarnVaultQueuedWithdrawalRequestPlan,
  position: QueuedWithdrawalPosition,
  terms: QueuedWithdrawalTermsInput
): void {
  if (
    plan.assetIdentity.depositTokenMint !== position.tokenMint ||
    plan.assetIdentity.shareMint !== position.shareMint ||
    plan.expectedRequest.assetMint !== position.tokenMint
  ) {
    throw internalError("Queued withdrawal builder returned asset identity outside the position");
  }
  // The caller's approved intent is `terms`, not the provider's own quote:
  // an adapter that drifted the built quantity in both the quote and the plan
  // would otherwise pass a provider-to-provider comparison. Shares are
  // decimal strings, so the built quantity is compared to the caller's
  // requested quantity numerically.
  if (
    compareDecimalAmounts(plan.expectedRequest.shares, terms.shares) !== 0 ||
    plan.expectedRequest.discountBps !== terms.discountBps ||
    BigInt(plan.expectedRequest.deadlineTimestamp) -
      BigInt(plan.expectedRequest.maturityTimestamp) !==
      BigInt(terms.deadlineSeconds)
  ) {
    throw internalError("Queued withdrawal builder changed the caller's stable queue intent");
  }
}

interface NormalizedAsyncWithdrawalQuote {
  shares: string;
  shareDecimals: number;
  assets: string;
  assetDecimals: number;
  blockingIssues: EarnVaultQueuedWithdrawalQuote["blockingIssues"];
  intermediateMint: string | null;
  intermediateAmount: string | null;
}

interface NormalizedAsyncWithdrawalPlan extends EarnVaultTransactionPlan {
  requestAddress: string;
  expectedRequest: {
    shares: string;
    assets: string;
    intermediateMint: string | null;
    intermediateAmount: string | null;
    discountBps: number | null;
    maturityTimestamp: string | null;
    deadlineTimestamp: string | null;
  };
}

function asyncMechanism(terms: AsyncWithdrawalTermsInput): EarnVaultWithdrawalMechanism {
  return terms.mechanism === "operator_redemption" ? "operator_redemption" : "solver_queue";
}

function requestFingerprint(input: {
  environment: SdpEnvironment;
  provider: string;
  positionId: string;
  terms: AsyncWithdrawalTermsInput;
  transactionId?: string;
}): string {
  if (input.terms.mechanism === "operator_redemption") {
    return buildEarnVaultParRedemptionFingerprint({
      environment: input.environment,
      provider: input.provider,
      positionId: input.positionId,
      shares: input.terms.shares,
      ...(input.transactionId ? { transactionId: input.transactionId } : {}),
    });
  }
  return buildEarnVaultQueuedWithdrawalFingerprint({
    environment: input.environment,
    provider: input.provider,
    positionId: input.positionId,
    shares: input.terms.shares,
    discountBps: input.terms.discountBps,
    deadlineSeconds: input.terms.deadlineSeconds,
    ...(input.transactionId ? { transactionId: input.transactionId } : {}),
  });
}

function throwBlockingQuote(quote: {
  blockingIssues: readonly { code: string; message: string }[];
}): void {
  const issue = quote.blockingIssues[0];
  if (issue)
    throw badRequest(`Asynchronous withdrawal is not currently available: ${issue.message}`);
}

async function quoteAndBuildRequest(
  env: Env,
  input: {
    actor: Pick<QueuedWithdrawalActor, "environment">;
    position: QueuedWithdrawalPosition;
    terms: AsyncWithdrawalTermsInput;
    memoId: string;
    rentPayer?: string;
    memoKind: "vault-withdrawal-request" | "external-withdrawal-request";
  }
): Promise<{
  quote: NormalizedAsyncWithdrawalQuote;
  plan: NormalizedAsyncWithdrawalPlan;
  mechanism: EarnVaultWithdrawalMechanism;
}> {
  const deadline = createVaultDeadline();
  const runtime: EarnRuntimeContext = { env, environment: input.actor.environment };
  let quote: NormalizedAsyncWithdrawalQuote;
  let built: NormalizedAsyncWithdrawalPlan;
  const mechanism = asyncMechanism(input.terms);
  try {
    if (input.terms.mechanism === "operator_redemption") {
      const client = resolveVaultParRedemptionClient(env, input.position.provider, deadline);
      if (!client) throw notImplemented(input.position.provider, "par redemptions");
      const parQuote: EarnVaultParRedemptionQuote = await client.quoteParRedemption(runtime, {
        providerReference: input.position.vaultAddress,
        shares: input.terms.shares,
      });
      throwBlockingQuote(parQuote);
      const parPlan: EarnVaultParRedemptionRequestPlan = await client.buildParRedemptionRequest(
        runtime,
        {
          providerReference: input.position.vaultAddress,
          owner: input.position.ownerAddress,
          shares: input.terms.shares,
        }
      );
      if (
        parPlan.assetIdentity.depositTokenMint !== input.position.tokenMint ||
        parPlan.assetIdentity.shareMint !== input.position.shareMint ||
        parPlan.expectedRequest.assetMint !== input.position.tokenMint ||
        compareDecimalAmounts(parPlan.expectedRequest.shares, input.terms.shares) !== 0
      ) {
        throw internalError("Par-redemption builder changed the position asset identity or shares");
      }
      quote = {
        shares: parQuote.shares,
        shareDecimals: parQuote.shareDecimals,
        assets: parQuote.assets,
        assetDecimals: parQuote.assetDecimals,
        blockingIssues: parQuote.blockingIssues,
        intermediateMint: parQuote.intermediateMint,
        intermediateAmount: parQuote.intermediateAmount,
      };
      built = {
        ...parPlan,
        expectedRequest: {
          shares: parPlan.expectedRequest.shares,
          assets: parPlan.expectedRequest.assets,
          intermediateMint: parPlan.expectedRequest.intermediateMint,
          intermediateAmount: parPlan.expectedRequest.intermediateAmount,
          discountBps: null,
          maturityTimestamp: null,
          deadlineTimestamp: null,
        },
      };
    } else {
      const client = resolveVaultQueuedWithdrawClient(env, input.position.provider, deadline);
      if (!client) throw notImplemented(input.position.provider, "queued vault withdrawals");
      const queueQuote = await client.quoteQueuedWithdrawal(runtime, {
        providerReference: input.position.vaultAddress,
        shares: input.terms.shares,
        discountBps: input.terms.discountBps,
        deadlineSeconds: input.terms.deadlineSeconds,
      });
      throwBlockingQuote(queueQuote);
      const queuePlan = await client.buildQueuedWithdrawalRequest(runtime, {
        providerReference: input.position.vaultAddress,
        owner: input.position.ownerAddress,
        shares: input.terms.shares,
        discountBps: input.terms.discountBps,
        deadlineSeconds: input.terms.deadlineSeconds,
        ...(input.rentPayer === undefined ? {} : { rentPayer: input.rentPayer }),
      });
      assertQueuePlan(queuePlan, input.position, input.terms);
      quote = {
        shares: queueQuote.shares,
        shareDecimals: queueQuote.shareDecimals,
        assets: queueQuote.assets,
        assetDecimals: queueQuote.assetDecimals,
        blockingIssues: queueQuote.blockingIssues,
        intermediateMint: null,
        intermediateAmount: null,
      };
      built = {
        ...queuePlan,
        expectedRequest: {
          shares: queuePlan.expectedRequest.shares,
          assets: queuePlan.expectedRequest.assets,
          intermediateMint: null,
          intermediateAmount: null,
          discountBps: queuePlan.expectedRequest.discountBps,
          maturityTimestamp: queuePlan.expectedRequest.maturityTimestamp,
          deadlineTimestamp: queuePlan.expectedRequest.deadlineTimestamp,
        },
      };
    }
  } catch (error) {
    rethrowVaultProviderFailure(error);
  }
  if (built.cluster !== earnClusterFor(input.actor.environment)) {
    throw internalError(
      `Asynchronous withdrawal builder returned a ${built.cluster} plan for the configured ${earnClusterFor(input.actor.environment)} cluster`
    );
  }
  return {
    quote,
    plan: {
      ...built,
      ...appendVaultRequestMemo(built, input.memoKind, input.memoId),
      requestAddress: built.requestAddress,
      expectedRequest: built.expectedRequest,
    },
    mechanism,
  };
}

async function prepareCustodyTransaction(
  env: Env,
  input: {
    actor: CustodyQueuedWithdrawalActor;
    position: QueuedWithdrawalPosition;
    plan: EarnVaultTransactionPlan;
  }
): Promise<{ signed: SignedVaultTransaction; fee: VaultFeeMode }> {
  const deadline = createVaultDeadline();
  const cluster = earnClusterFor(input.actor.environment);
  const rpcUrl = resolveClusterRpcUrl(env, cluster);
  const fee = await resolveVaultSponsorship(env, {
    organizationId: input.actor.organizationId,
    projectId: input.actor.projectId,
    walletId: input.actor.custodyWalletId,
    cluster,
    deadline,
  });
  const expectedAssetIdentity = {
    depositTokenMint: input.position.tokenMint,
    shareMint: input.position.shareMint,
  };
  const simulation = await simulateVaultPlan(env, {
    cluster,
    deadline,
    expectedAssetIdentity,
    plan: input.plan,
    owner: address(input.actor.custodyWalletPublicKey),
    rpcUrl,
    fee,
  });
  if (!simulation.ok) {
    throw badRequest(
      `Asynchronous withdrawal simulation failed: ${simulation.error}`,
      rawSimulationDetails(simulation.raw)
    );
  }
  const signer = await deadline.run("Resolving the queued withdrawal signer", () =>
    solanaServices.createOrgSignerForCustodyWallet(
      env,
      input.actor.organizationId,
      input.actor.projectId,
      input.actor.custodyWalletId
    )
  );
  if (signer.address !== input.actor.custodyWalletPublicKey) {
    throw badRequest("Resolved signing wallet does not match the queued withdrawal position");
  }
  const signed = await signVaultPlan(env, {
    cluster,
    deadline,
    expectedAssetIdentity,
    plan: input.plan,
    owner: signer,
    rpcUrl,
    fee,
    prepared: simulation.prepared,
  });
  return { signed, fee };
}

async function broadcastQueuedAction(
  env: Env,
  result: QueuedWithdrawalMutationResult
): Promise<QueuedWithdrawalMutationResult> {
  if (result.replayed) return result;
  const cluster = earnClusterFor(result.request.environment);
  const rpcUrl = resolveClusterRpcUrl(env, cluster);
  try {
    await broadcastVaultTransaction(env, {
      cluster,
      deadline: createVaultDeadline(),
      bytes: Uint8Array.from(Buffer.from(result.action.signed_transaction, "base64")),
      rpcUrl,
    });
  } catch (error) {
    getLogger().error(
      { requestId: result.request.id, actionId: result.action.id, error },
      "queued withdrawal broadcast outcome unknown; left reconcilable"
    );
    return result;
  }
  const advanced = await createPostgresEarnVaultWithdrawalRequestsRepository(
    getDb(env)
  ).advanceAction({
    actionId: result.action.id,
    organizationId: result.request.organization_id,
    toStatus: "submitted",
  });
  return { ...result, action: advanced ?? result.action };
}

export async function createCustodyQueuedWithdrawal(
  env: Env,
  input: {
    actor: CustodyQueuedWithdrawalActor;
    position: QueuedWithdrawalPosition;
    terms: AsyncWithdrawalTermsInput;
    clientRequestId: string;
  },
  options: QueuedWithdrawalExecutionOptions = {}
): Promise<QueuedWithdrawalMutationResult> {
  const repository = createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
  const fingerprint = requestFingerprint({
    environment: input.actor.environment,
    provider: input.position.provider,
    positionId: input.position.id,
    terms: input.terms,
  });
  const prior = await repository.findByClientRequestId({
    organizationId: input.actor.organizationId,
    clientRequestId: input.clientRequestId,
  });
  if (prior) {
    if (
      prior.idempotency_fingerprint !== fingerprint ||
      prior.project_id !== input.actor.projectId
    ) {
      throw conflict("Idempotency key already used with different request payload");
    }
    const action = await repository.getLatestAction({
      withdrawalRequestId: prior.id,
      action: "request",
    });
    if (!action) throw internalError(`Asynchronous withdrawal ${prior.id} has no request action`);
    return { request: prior, action, replayed: true };
  }

  const requestId = generateEarnVaultWithdrawalRequestId();
  const actionId = generateEarnVaultWithdrawalRequestActionId();
  const deadline = createVaultDeadline();
  const fee = await resolveVaultSponsorship(env, {
    organizationId: input.actor.organizationId,
    projectId: input.actor.projectId,
    walletId: input.actor.custodyWalletId,
    cluster: earnClusterFor(input.actor.environment),
    deadline,
  });
  const { quote, plan, mechanism } = await quoteAndBuildRequest(env, {
    actor: input.actor,
    position: input.position,
    terms: input.terms,
    memoId: input.clientRequestId,
    rentPayer: vaultRentPayer(fee),
    memoKind: "vault-withdrawal-request",
  });
  const reservationId = generateEarnVaultWithdrawalRequestReservationId();
  await repository.acquireRequestReservation({
    id: reservationId,
    organizationId: input.actor.organizationId,
    projectId: input.actor.projectId,
    environment: input.actor.environment,
    provider: input.position.provider,
    vaultAddress: input.position.vaultAddress,
    ownerAddress: input.position.ownerAddress,
    requestAddress: plan.requestAddress,
    clientRequestId: input.clientRequestId,
    idempotencyFingerprint: fingerprint,
    expiresAt: new Date(Date.now() + QUEUED_REQUEST_RESERVATION_MS).toISOString(),
    mechanism,
  });
  try {
    // Reuse the already resolved sponsorship identity in signing. Resolving it
    // twice could put a different payer in the message than in the plan.
    const cluster = earnClusterFor(input.actor.environment);
    const rpcUrl = resolveClusterRpcUrl(env, cluster);
    const executionDeadline = createVaultDeadline();
    const expectedAssetIdentity = {
      depositTokenMint: input.position.tokenMint,
      shareMint: input.position.shareMint,
    };
    const simulation = await simulateVaultPlan(env, {
      cluster,
      deadline: executionDeadline,
      expectedAssetIdentity,
      plan,
      owner: address(input.actor.custodyWalletPublicKey),
      rpcUrl,
      fee,
    });
    if (!simulation.ok) {
      throw badRequest(
        `Asynchronous withdrawal simulation failed: ${simulation.error}`,
        rawSimulationDetails(simulation.raw)
      );
    }
    const signer = await executionDeadline.run("Resolving the queued withdrawal signer", () =>
      solanaServices.createOrgSignerForCustodyWallet(
        env,
        input.actor.organizationId,
        input.actor.projectId,
        input.actor.custodyWalletId
      )
    );
    if (signer.address !== input.actor.custodyWalletPublicKey) {
      throw badRequest("Resolved signing wallet does not match the queued withdrawal position");
    }
    const signed = await signVaultPlan(env, {
      cluster,
      deadline: executionDeadline,
      expectedAssetIdentity,
      plan,
      owner: signer,
      rpcUrl,
      fee,
      prepared: simulation.prepared,
    });
    const persist = (db: AppDb) =>
      createPostgresEarnVaultWithdrawalRequestsRepository(db).createSignedRequest({
        requestId,
        actionId,
        organizationId: input.actor.organizationId,
        projectId: input.actor.projectId,
        environment: input.actor.environment,
        provider: input.position.provider,
        positionId: input.position.id,
        custodyWalletId: input.actor.custodyWalletId,
        ownerAddress: input.position.ownerAddress,
        vaultAddress: input.position.vaultAddress,
        tokenMint: input.position.tokenMint,
        shareMint: input.position.shareMint,
        requestAddress: plan.requestAddress,
        mechanism,
        shares: plan.expectedRequest.shares,
        quotedAssets: plan.expectedRequest.assets,
        shareDecimals: quote.shareDecimals,
        assetDecimals: quote.assetDecimals,
        intermediateMint: plan.expectedRequest.intermediateMint,
        intermediateAmount: plan.expectedRequest.intermediateAmount,
        discountBps: plan.expectedRequest.discountBps,
        maturityTimestamp: plan.expectedRequest.maturityTimestamp,
        deadlineTimestamp: plan.expectedRequest.deadlineTimestamp,
        signature: signed.signature,
        signedTransaction: Buffer.from(signed.bytes).toString("base64"),
        lastValidBlockHeight: signed.lastValidBlockHeight,
        clientRequestId: input.clientRequestId,
        idempotencyFingerprint: fingerprint,
        pdaLeaseToken: reservationId,
        createdBy: input.actor.userId ?? null,
        initiatedByKeyId: input.actor.apiKeyId ?? null,
      });
    const result = options.runIntentTransaction
      ? await options.runIntentTransaction(persist)
      : await persist(getDb(env));
    return broadcastQueuedAction(env, result);
  } finally {
    try {
      await repository.releaseRequestReservation({
        id: reservationId,
        organizationId: input.actor.organizationId,
      });
    } catch (error) {
      getLogger().warn(
        { reservationId, requestAddress: plan.requestAddress, error },
        "queued withdrawal reservation release failed; expiry will recover it"
      );
    }
  }
}

async function requireCancelableProviderRequest(
  env: Env,
  request: EarnVaultWithdrawalRequestRow,
  expectedOwner: string
): Promise<void> {
  if (request.mechanism === "operator_redemption") {
    const client = resolveVaultParRedemptionClient(env, request.provider, createVaultDeadline());
    if (!client) throw notImplemented(request.provider, "par redemptions");
    let lookup: Awaited<ReturnType<typeof client.readParRedemptionRequest>>;
    try {
      lookup = await client.readParRedemptionRequest(
        { env, environment: request.environment },
        { providerReference: request.vault_address, requestAddress: request.request_address }
      );
    } catch (error) {
      rethrowVaultProviderFailure(error);
    }
    if (lookup.status === "closedOrUnknown") {
      throw conflict("Par redemption is already closed; refresh its status before cancelling");
    }
    if (
      lookup.requestAddress !== request.request_address ||
      lookup.request.requestAddress !== request.request_address ||
      lookup.request.owner !== expectedOwner ||
      lookup.request.providerReference !== request.vault_address ||
      lookup.request.intermediateMint !== request.intermediate_mint ||
      lookup.request.intermediateAmount !== request.intermediate_amount
    ) {
      throw internalError("Par-redemption owner or intermediate amount no longer matches");
    }
    await createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env)).advanceRequest({
      withdrawalRequestId: request.id,
      organizationId: request.organization_id,
      toStatus: "pending",
    });
    return;
  }
  const client = resolveVaultQueuedWithdrawClient(env, request.provider, createVaultDeadline());
  if (!client) throw notImplemented(request.provider, "queued vault withdrawals");
  let lookup: Awaited<ReturnType<typeof client.readQueuedWithdrawalRequest>>;
  try {
    lookup = await client.readQueuedWithdrawalRequest(
      { env, environment: request.environment },
      { providerReference: request.vault_address, requestAddress: request.request_address }
    );
  } catch (error) {
    rethrowVaultProviderFailure(error);
  }
  if (lookup.status === "closedOrUnknown") {
    throw conflict("Queued withdrawal is already closed; refresh its status before cancelling");
  }
  if (
    lookup.requestAddress !== request.request_address ||
    lookup.request.requestAddress !== request.request_address ||
    lookup.request.owner !== expectedOwner ||
    lookup.request.providerReference !== request.vault_address ||
    lookup.request.assetMint !== request.token_mint
  ) {
    throw internalError("Queued withdrawal owner no longer matches recorded request identity");
  }
  if (lookup.status !== "expiredCancelable") {
    throw conflict(`Queued withdrawal cannot be cancelled while status is ${lookup.status}`);
  }
  await createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env)).advanceRequest({
    withdrawalRequestId: request.id,
    organizationId: request.organization_id,
    toStatus: "expired_cancelable",
    creationTimestamp: lookup.request.creationTimestamp,
  });
}

export async function cancelCustodyQueuedWithdrawal(
  env: Env,
  input: {
    actor: CustodyQueuedWithdrawalActor;
    position: QueuedWithdrawalPosition;
    request: EarnVaultWithdrawalRequestRow;
    clientRequestId: string;
  }
): Promise<QueuedWithdrawalMutationResult> {
  const repository = createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
  const fingerprint = buildEarnVaultQueuedWithdrawalCancelFingerprint({
    environment: input.actor.environment,
    withdrawalRequestId: input.request.id,
    requestAddress: input.request.request_address,
  });
  const prior = await repository.getActionByClientRequestId({
    organizationId: input.actor.organizationId,
    clientRequestId: input.clientRequestId,
  });
  if (prior) {
    if (
      prior.idempotency_fingerprint !== fingerprint ||
      prior.withdrawal_request_id !== input.request.id ||
      prior.action !== "cancel"
    ) {
      throw conflict("Idempotency key already used with different request payload");
    }
    return { request: input.request, action: prior, replayed: true };
  }
  await requireCancelableProviderRequest(env, input.request, input.position.ownerAddress);
  let plan: EarnVaultTransactionPlan;
  try {
    const runtime = { env, environment: input.actor.environment };
    const cancelInput = {
      providerReference: input.request.vault_address,
      owner: input.position.ownerAddress,
      requestAddress: input.request.request_address,
    };
    const built =
      input.request.mechanism === "operator_redemption"
        ? await (() => {
            const parClient = resolveVaultParRedemptionClient(
              env,
              input.request.provider,
              createVaultDeadline()
            );
            if (!parClient) throw notImplemented(input.request.provider, "par redemptions");
            return parClient.buildParRedemptionCancel(runtime, cancelInput);
          })()
        : await (() => {
            const queueClient = resolveVaultQueuedWithdrawClient(
              env,
              input.request.provider,
              createVaultDeadline()
            );
            if (!queueClient) {
              throw notImplemented(input.request.provider, "queued vault withdrawals");
            }
            return queueClient.buildQueuedWithdrawalCancel(runtime, cancelInput);
          })();
    plan = appendVaultRequestMemo(built, "vault-withdrawal-cancel", input.clientRequestId);
  } catch (error) {
    rethrowVaultProviderFailure(error);
  }
  const { signed } = await prepareCustodyTransaction(env, {
    actor: input.actor,
    position: input.position,
    plan,
  });
  const result = await repository.createSignedCancel({
    actionId: generateEarnVaultWithdrawalRequestActionId(),
    organizationId: input.actor.organizationId,
    projectId: input.actor.projectId,
    environment: input.actor.environment,
    withdrawalRequestId: input.request.id,
    signature: signed.signature,
    signedTransaction: Buffer.from(signed.bytes).toString("base64"),
    lastValidBlockHeight: signed.lastValidBlockHeight,
    clientRequestId: input.clientRequestId,
    idempotencyFingerprint: fingerprint,
    createdBy: input.actor.userId ?? null,
    initiatedByKeyId: input.actor.apiKeyId ?? null,
  });
  return broadcastQueuedAction(env, result);
}

type ExternalBuildActor = QueuedWithdrawalActor | { environment: SdpEnvironment };

function isKeyedExternalActor(actor: ExternalBuildActor): actor is QueuedWithdrawalActor {
  return "organizationId" in actor;
}

async function compileExternalPlan(
  env: Env,
  input: {
    actor: ExternalBuildActor;
    position: QueuedWithdrawalPosition;
    plan: EarnVaultTransactionPlan;
    feePayer?: string;
  }
) {
  if (!isKeyedExternalActor(input.actor) && input.feePayer !== undefined) {
    throw badRequest("feePayer requires an API key; anonymous builds are paid by the owner");
  }
  const cluster = earnClusterFor(input.actor.environment);
  const rpcUrl = resolveClusterRpcUrl(env, cluster);
  const deadline = createVaultDeadline();
  const fee: VaultFeeMode = input.feePayer
    ? { kind: "caller-provided", feePayer: address(input.feePayer) }
    : { kind: "wallet-pays" };
  const expectedAssetIdentity = {
    depositTokenMint: input.position.tokenMint,
    shareMint: input.position.shareMint,
  };
  const simulation = await simulateVaultPlan(env, {
    cluster,
    deadline,
    expectedAssetIdentity,
    plan: input.plan,
    owner: address(input.position.ownerAddress),
    rpcUrl,
    fee,
  });
  if (!simulation.ok)
    throw badRequest(
      `Asynchronous withdrawal simulation failed: ${simulation.error}`,
      rawSimulationDetails(simulation.raw)
    );
  return compileUnsignedVaultTransaction({
    cluster,
    deadline,
    expectedAssetIdentity,
    plan: input.plan,
    owner: address(input.position.ownerAddress),
    ...(input.feePayer ? { feePayer: address(input.feePayer) } : {}),
    prepared: simulation.prepared,
  });
}

export async function buildExternalQueuedWithdrawalRequest(
  env: Env,
  input: {
    actor: ExternalBuildActor;
    position: QueuedWithdrawalPosition;
    terms: AsyncWithdrawalTermsInput;
    feePayer?: string;
  }
): Promise<ExternalQueuedWithdrawalBuiltTransaction> {
  const transactionId = generateEarnExternalWalletWithdrawalRequestTransactionId();
  const feePayer = input.feePayer === input.position.ownerAddress ? undefined : input.feePayer;
  const { quote, plan, mechanism } = await quoteAndBuildRequest(env, {
    actor: input.actor,
    position: input.position,
    terms: input.terms,
    memoId: transactionId,
    rentPayer: feePayer,
    memoKind: "external-withdrawal-request",
  });
  const unsigned = await compileExternalPlan(env, {
    actor: input.actor,
    position: input.position,
    plan,
    ...(feePayer ? { feePayer } : {}),
  });
  const built: ExternalQueuedWithdrawalBuiltTransaction = {
    id: transactionId,
    environment: input.actor.environment,
    provider: input.position.provider,
    position_id: input.position.id || null,
    withdrawal_request_id: null,
    action: "request",
    mechanism,
    owner_address: input.position.ownerAddress,
    vault_address: input.position.vaultAddress,
    token_mint: input.position.tokenMint,
    share_mint: input.position.shareMint,
    request_address: plan.requestAddress,
    shares: plan.expectedRequest.shares,
    quoted_assets: plan.expectedRequest.assets,
    share_decimals: quote.shareDecimals,
    asset_decimals: quote.assetDecimals,
    intermediate_mint: plan.expectedRequest.intermediateMint,
    intermediate_amount: plan.expectedRequest.intermediateAmount,
    discount_bps: plan.expectedRequest.discountBps,
    maturity_timestamp: plan.expectedRequest.maturityTimestamp,
    deadline_timestamp: plan.expectedRequest.deadlineTimestamp,
    fee_payer: feePayer ?? null,
    unsigned_transaction: Buffer.from(unsigned.bytes).toString("base64"),
    last_valid_block_height: unsigned.lastValidBlockHeight,
  };
  if (!isKeyedExternalActor(input.actor)) return built;
  const currentBlockHeight = await readConfirmedBlockHeight(
    env,
    resolveClusterRpcUrl(env, earnClusterFor(input.actor.environment))
  );
  return createPostgresEarnVaultWithdrawalRequestsRepository(
    getDb(env)
  ).createExternalWalletTransaction({
    id: built.id,
    organizationId: input.actor.organizationId,
    projectId: input.actor.projectId,
    environment: built.environment,
    provider: built.provider,
    positionId: built.position_id,
    action: "request",
    mechanism: built.mechanism,
    ownerAddress: built.owner_address,
    vaultAddress: built.vault_address,
    tokenMint: built.token_mint,
    shareMint: built.share_mint,
    requestAddress: built.request_address,
    shares: built.shares,
    quotedAssets: built.quoted_assets,
    shareDecimals: built.share_decimals,
    assetDecimals: built.asset_decimals,
    intermediateMint: built.intermediate_mint,
    intermediateAmount: built.intermediate_amount,
    discountBps: built.discount_bps,
    maturityTimestamp: built.maturity_timestamp,
    deadlineTimestamp: built.deadline_timestamp,
    feePayer: built.fee_payer,
    unsignedTransaction: built.unsigned_transaction,
    lastValidBlockHeight: built.last_valid_block_height,
    currentBlockHeight: currentBlockHeight.toString(),
    reservationExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdBy: input.actor.userId ?? null,
    initiatedByKeyId: input.actor.apiKeyId ?? null,
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: authenticated and anonymous cancellation both validate provider truth before sharing one build/persist path.
export async function buildExternalQueuedWithdrawalCancel(
  env: Env,
  input: {
    actor: ExternalBuildActor;
    position: QueuedWithdrawalPosition;
    request: EarnVaultWithdrawalRequestRow | null;
    requestAddress: string;
    feePayer?: string;
  }
): Promise<ExternalQueuedWithdrawalBuiltTransaction> {
  const parClient = resolveVaultParRedemptionClient(
    env,
    input.position.provider,
    createVaultDeadline()
  );
  const mechanism: EarnVaultWithdrawalMechanism =
    input.request?.mechanism === "operator_redemption" || (!input.request && parClient)
      ? "operator_redemption"
      : "solver_queue";
  if (input.request) {
    await requireCancelableProviderRequest(env, input.request, input.position.ownerAddress);
  } else if (mechanism === "operator_redemption") {
    if (!parClient) throw notImplemented(input.position.provider, "par redemptions");
    let lookup: Awaited<ReturnType<typeof parClient.readParRedemptionRequest>>;
    try {
      lookup = await parClient.readParRedemptionRequest(
        { env, environment: input.actor.environment },
        {
          providerReference: input.position.vaultAddress,
          requestAddress: input.requestAddress,
        }
      );
    } catch (error) {
      rethrowVaultProviderFailure(error);
    }
    if (lookup.status === "closedOrUnknown") throw conflict("Par redemption is already closed");
    if (
      lookup.requestAddress !== input.requestAddress ||
      lookup.request.requestAddress !== input.requestAddress ||
      lookup.request.owner !== input.position.ownerAddress ||
      lookup.request.providerReference !== input.position.vaultAddress
    ) {
      throw badRequest("Par-redemption request does not match the supplied owner and strategy");
    }
  } else {
    const readClient = resolveVaultQueuedWithdrawClient(
      env,
      input.position.provider,
      createVaultDeadline()
    );
    if (!readClient) throw notImplemented(input.position.provider, "queued vault withdrawals");
    let lookup: Awaited<ReturnType<typeof readClient.readQueuedWithdrawalRequest>>;
    try {
      lookup = await readClient.readQueuedWithdrawalRequest(
        { env, environment: input.actor.environment },
        {
          providerReference: input.position.vaultAddress,
          requestAddress: input.requestAddress,
        }
      );
    } catch (error) {
      rethrowVaultProviderFailure(error);
    }
    if (lookup.status === "closedOrUnknown") {
      throw conflict("Queued withdrawal is already closed");
    }
    if (
      lookup.requestAddress !== input.requestAddress ||
      lookup.request.requestAddress !== input.requestAddress ||
      lookup.request.owner !== input.position.ownerAddress ||
      lookup.request.providerReference !== input.position.vaultAddress ||
      lookup.request.assetMint !== input.position.tokenMint
    ) {
      throw badRequest("Queued withdrawal request does not match the supplied owner and strategy");
    }
    if (lookup.status !== "expiredCancelable") {
      throw conflict(`Queued withdrawal cannot be cancelled while status is ${lookup.status}`);
    }
  }
  const transactionId = generateEarnExternalWalletWithdrawalRequestTransactionId();
  let plan: EarnVaultTransactionPlan;
  try {
    const runtime = { env, environment: input.actor.environment };
    const cancelInput = {
      providerReference: input.position.vaultAddress,
      owner: input.position.ownerAddress,
      requestAddress: input.requestAddress,
    };
    const built =
      mechanism === "operator_redemption"
        ? await (() => {
            if (!parClient) throw notImplemented(input.position.provider, "par redemptions");
            return parClient.buildParRedemptionCancel(runtime, cancelInput);
          })()
        : await (() => {
            const queueClient = resolveVaultQueuedWithdrawClient(
              env,
              input.position.provider,
              createVaultDeadline()
            );
            if (!queueClient) {
              throw notImplemented(input.position.provider, "queued vault withdrawals");
            }
            return queueClient.buildQueuedWithdrawalCancel(runtime, cancelInput);
          })();
    plan = appendVaultRequestMemo(built, "external-withdrawal-cancel", transactionId);
  } catch (error) {
    rethrowVaultProviderFailure(error);
  }
  if (plan.cluster !== earnClusterFor(input.actor.environment)) {
    throw internalError(
      `Queued cancellation builder returned a ${plan.cluster} plan for the configured ${earnClusterFor(input.actor.environment)} cluster`
    );
  }
  const feePayer = input.feePayer === input.position.ownerAddress ? undefined : input.feePayer;
  const unsigned = await compileExternalPlan(env, {
    actor: input.actor,
    position: input.position,
    plan,
    ...(feePayer ? { feePayer } : {}),
  });
  const built: ExternalQueuedWithdrawalBuiltTransaction = {
    id: transactionId,
    environment: input.actor.environment,
    provider: input.position.provider,
    position_id: input.position.id || null,
    withdrawal_request_id: input.request?.id ?? null,
    action: "cancel",
    mechanism,
    owner_address: input.position.ownerAddress,
    vault_address: input.position.vaultAddress,
    token_mint: input.position.tokenMint,
    share_mint: input.position.shareMint,
    request_address: input.requestAddress,
    shares: null,
    quoted_assets: null,
    share_decimals: null,
    asset_decimals: null,
    intermediate_mint: null,
    intermediate_amount: null,
    discount_bps: null,
    maturity_timestamp: null,
    deadline_timestamp: null,
    fee_payer: feePayer ?? null,
    unsigned_transaction: Buffer.from(unsigned.bytes).toString("base64"),
    last_valid_block_height: unsigned.lastValidBlockHeight,
  };
  if (!isKeyedExternalActor(input.actor)) return built;
  if (!input.request) {
    throw internalError("Authenticated queued cancellation requires a recorded request");
  }
  return createPostgresEarnVaultWithdrawalRequestsRepository(
    getDb(env)
  ).createExternalWalletTransaction({
    id: built.id,
    organizationId: input.actor.organizationId,
    projectId: input.actor.projectId,
    environment: built.environment,
    provider: built.provider,
    positionId: built.position_id,
    withdrawalRequestId: input.request.id,
    action: "cancel",
    mechanism: built.mechanism,
    ownerAddress: built.owner_address,
    vaultAddress: built.vault_address,
    tokenMint: built.token_mint,
    shareMint: built.share_mint,
    requestAddress: built.request_address,
    feePayer: built.fee_payer,
    unsignedTransaction: built.unsigned_transaction,
    lastValidBlockHeight: built.last_valid_block_height,
    createdBy: input.actor.userId ?? null,
    initiatedByKeyId: input.actor.apiKeyId ?? null,
  });
}

async function requireExternalBuild(
  env: Env,
  input: {
    actor: QueuedWithdrawalActor;
    transactionId: string;
    action: "request" | "cancel";
  }
): Promise<EarnExternalWalletWithdrawalRequestTransactionRow> {
  const build = await createPostgresEarnVaultWithdrawalRequestsRepository(
    getDb(env)
  ).getExternalWalletTransaction({
    organizationId: input.actor.organizationId,
    transactionId: input.transactionId,
  });
  if (
    !build ||
    build.project_id !== input.actor.projectId ||
    build.environment !== input.actor.environment ||
    build.action !== input.action
  ) {
    throw notFound("Earn external-wallet queued withdrawal transaction");
  }
  return build;
}

async function refuseExpiredExternalBuild(
  env: Env,
  build: ExternalQueuedWithdrawalBuiltTransaction
) {
  if ((build as EarnExternalWalletWithdrawalRequestTransactionRow).consumed_action_id) return;
  let current: bigint;
  try {
    current = await readConfirmedBlockHeight(
      env,
      resolveClusterRpcUrl(env, earnClusterFor(build.environment))
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    getLogger().warn({ transactionId: build.id, error }, "queued build height unreadable");
    return;
  }
  if (current > BigInt(build.last_valid_block_height)) {
    throw transactionExpired(
      "This queued withdrawal transaction expired. Build it again and collect fresh signatures."
    );
  }
}

export async function submitExternalQueuedWithdrawalAction(
  env: Env,
  input: {
    actor: QueuedWithdrawalActor;
    transactionId: string;
    signedTransaction: string;
    clientRequestId: string;
    action: "request" | "cancel";
  }
): Promise<QueuedWithdrawalMutationResult> {
  const build = await requireExternalBuild(env, input);
  await refuseExpiredExternalBuild(env, build);
  const signed = await verifySignedExternalWalletTransaction(build, input.signedTransaction);
  const repository = createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
  let result: QueuedWithdrawalMutationResult;
  if (input.action === "request") {
    if (
      !build.position_id ||
      build.shares === null ||
      build.quoted_assets === null ||
      build.share_decimals === null ||
      build.asset_decimals === null ||
      (build.mechanism === "solver_queue" &&
        (build.discount_bps === null ||
          build.maturity_timestamp === null ||
          build.deadline_timestamp === null)) ||
      (build.mechanism === "operator_redemption" &&
        (build.intermediate_mint === null || build.intermediate_amount === null))
    ) {
      throw internalError(`Asynchronous withdrawal build ${build.id} is missing request terms`);
    }
    const terms: AsyncWithdrawalTermsInput =
      build.mechanism === "operator_redemption"
        ? { mechanism: "operator_redemption", shares: build.shares }
        : {
            mechanism: "solver_queue",
            shares: build.shares,
            discountBps: build.discount_bps as number,
            deadlineSeconds: Number(
              BigInt(build.deadline_timestamp as string) -
                BigInt(build.maturity_timestamp as string)
            ),
          };
    const fingerprint = requestFingerprint({
      environment: build.environment,
      provider: build.provider,
      positionId: build.position_id,
      terms,
      transactionId: build.id,
    });
    result = await repository.createSignedRequest({
      requestId: generateEarnVaultWithdrawalRequestId(),
      actionId: generateEarnVaultWithdrawalRequestActionId(),
      organizationId: input.actor.organizationId,
      projectId: input.actor.projectId,
      environment: build.environment,
      provider: build.provider,
      positionId: build.position_id,
      ownerAddress: build.owner_address,
      vaultAddress: build.vault_address,
      tokenMint: build.token_mint,
      shareMint: build.share_mint,
      requestAddress: build.request_address,
      mechanism: build.mechanism,
      shares: build.shares,
      quotedAssets: build.quoted_assets,
      shareDecimals: build.share_decimals,
      assetDecimals: build.asset_decimals,
      intermediateMint: build.intermediate_mint,
      intermediateAmount: build.intermediate_amount,
      discountBps: build.discount_bps,
      maturityTimestamp: build.maturity_timestamp,
      deadlineTimestamp: build.deadline_timestamp,
      signature: signed.signature,
      signedTransaction: signed.signedTransactionBase64,
      lastValidBlockHeight: build.last_valid_block_height,
      clientRequestId: input.clientRequestId,
      idempotencyFingerprint: fingerprint,
      pdaLeaseToken: build.id,
      externalWalletTransactionId: build.id,
      createdBy: input.actor.userId ?? null,
      initiatedByKeyId: input.actor.apiKeyId ?? null,
    });
  } else {
    if (!build.withdrawal_request_id) {
      throw internalError(`Queued cancellation build ${build.id} names no request`);
    }
    const fingerprint = buildEarnVaultQueuedWithdrawalCancelFingerprint({
      environment: build.environment,
      withdrawalRequestId: build.withdrawal_request_id,
      requestAddress: build.request_address,
      transactionId: build.id,
    });
    result = await repository.createSignedCancel({
      actionId: generateEarnVaultWithdrawalRequestActionId(),
      organizationId: input.actor.organizationId,
      projectId: input.actor.projectId,
      environment: build.environment,
      withdrawalRequestId: build.withdrawal_request_id,
      signature: signed.signature,
      signedTransaction: signed.signedTransactionBase64,
      lastValidBlockHeight: build.last_valid_block_height,
      clientRequestId: input.clientRequestId,
      idempotencyFingerprint: fingerprint,
      externalWalletTransactionId: build.id,
      createdBy: input.actor.userId ?? null,
      initiatedByKeyId: input.actor.apiKeyId ?? null,
    });
  }
  return broadcastQueuedAction(env, result);
}
