import { notImplemented } from "@sdp/earn/errors";
import type {
  EarnRuntimeContext,
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
  buildEarnVaultQueuedWithdrawalCancelFingerprint,
  buildEarnVaultQueuedWithdrawalFingerprint,
} from "@/lib/idempotency";
import { getLogger } from "@/runtime/logger";
import * as solanaServices from "@/services/solana";
import type { Env } from "@/types/env";
import {
  earnClusterFor,
  resolveClusterRpcUrl,
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
}

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
  owner_address: string;
  vault_address: string;
  token_mint: string;
  share_mint: string;
  request_address: string;
  shares: string | null;
  quoted_assets: string | null;
  share_decimals: number | null;
  asset_decimals: number | null;
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

function throwBlockingQuote(quote: EarnVaultQueuedWithdrawalQuote): void {
  const issue = quote.blockingIssues[0];
  if (issue) throw badRequest(`Queued withdrawal is not currently available: ${issue.message}`);
}

async function quoteAndBuildRequest(
  env: Env,
  input: {
    actor: Pick<QueuedWithdrawalActor, "environment">;
    position: QueuedWithdrawalPosition;
    terms: QueuedWithdrawalTermsInput;
    memoId: string;
    rentPayer?: string;
    memoKind: "vault-withdrawal-request" | "external-withdrawal-request";
  }
): Promise<{ quote: EarnVaultQueuedWithdrawalQuote; plan: EarnVaultQueuedWithdrawalRequestPlan }> {
  const deadline = createVaultDeadline();
  const client = resolveVaultQueuedWithdrawClient(env, input.position.provider, deadline);
  if (!client) throw notImplemented(input.position.provider, "queued vault withdrawals");
  const runtime: EarnRuntimeContext = { env, environment: input.actor.environment };
  let quote: EarnVaultQueuedWithdrawalQuote;
  let built: EarnVaultQueuedWithdrawalRequestPlan;
  try {
    quote = await client.quoteQueuedWithdrawal(runtime, {
      providerReference: input.position.vaultAddress,
      ...input.terms,
    });
    throwBlockingQuote(quote);
    built = await client.buildQueuedWithdrawalRequest(runtime, {
      providerReference: input.position.vaultAddress,
      owner: input.position.ownerAddress,
      ...input.terms,
      ...(input.rentPayer === undefined ? {} : { rentPayer: input.rentPayer }),
    });
  } catch (error) {
    rethrowVaultProviderFailure(error);
  }
  if (built.cluster !== earnClusterFor(input.actor.environment)) {
    throw internalError(
      `Queued withdrawal builder returned a ${built.cluster} plan for the configured ${earnClusterFor(input.actor.environment)} cluster`
    );
  }
  assertQueuePlan(built, input.position, input.terms);
  return {
    quote,
    plan: {
      ...built,
      ...appendVaultRequestMemo(built, input.memoKind, input.memoId),
      requestAddress: built.requestAddress,
      expectedRequest: built.expectedRequest,
    },
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
      `Queued withdrawal simulation failed: ${simulation.error}`,
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
    terms: QueuedWithdrawalTermsInput;
    clientRequestId: string;
  },
  options: QueuedWithdrawalExecutionOptions = {}
): Promise<QueuedWithdrawalMutationResult> {
  const repository = createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
  const fingerprint = buildEarnVaultQueuedWithdrawalFingerprint({
    environment: input.actor.environment,
    provider: input.position.provider,
    positionId: input.position.id,
    ...input.terms,
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
    if (!action) throw internalError(`Queued withdrawal ${prior.id} has no request action`);
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
  const { quote, plan } = await quoteAndBuildRequest(env, {
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
        `Queued withdrawal simulation failed: ${simulation.error}`,
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
        shares: plan.expectedRequest.shares,
        quotedAssets: plan.expectedRequest.assets,
        shareDecimals: quote.shareDecimals,
        assetDecimals: quote.assetDecimals,
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
  const client = resolveVaultQueuedWithdrawClient(
    env,
    input.request.provider,
    createVaultDeadline()
  );
  if (!client) throw notImplemented(input.request.provider, "queued vault withdrawals");
  let plan: EarnVaultTransactionPlan;
  try {
    const built = await client.buildQueuedWithdrawalCancel(
      { env, environment: input.actor.environment },
      {
        providerReference: input.request.vault_address,
        owner: input.position.ownerAddress,
        requestAddress: input.request.request_address,
      }
    );
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
      `Queued withdrawal simulation failed: ${simulation.error}`,
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
    terms: QueuedWithdrawalTermsInput;
    feePayer?: string;
  }
): Promise<ExternalQueuedWithdrawalBuiltTransaction> {
  const transactionId = generateEarnExternalWalletWithdrawalRequestTransactionId();
  const feePayer = input.feePayer === input.position.ownerAddress ? undefined : input.feePayer;
  const { quote, plan } = await quoteAndBuildRequest(env, {
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
    owner_address: input.position.ownerAddress,
    vault_address: input.position.vaultAddress,
    token_mint: input.position.tokenMint,
    share_mint: input.position.shareMint,
    request_address: plan.requestAddress,
    shares: plan.expectedRequest.shares,
    quoted_assets: plan.expectedRequest.assets,
    share_decimals: quote.shareDecimals,
    asset_decimals: quote.assetDecimals,
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
    ownerAddress: built.owner_address,
    vaultAddress: built.vault_address,
    tokenMint: built.token_mint,
    shareMint: built.share_mint,
    requestAddress: built.request_address,
    shares: built.shares,
    quotedAssets: built.quoted_assets,
    shareDecimals: built.share_decimals,
    assetDecimals: built.asset_decimals,
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
  if (input.request) {
    await requireCancelableProviderRequest(env, input.request, input.position.ownerAddress);
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
  const client = resolveVaultQueuedWithdrawClient(
    env,
    input.position.provider,
    createVaultDeadline()
  );
  if (!client) throw notImplemented(input.position.provider, "queued vault withdrawals");
  const transactionId = generateEarnExternalWalletWithdrawalRequestTransactionId();
  let plan: EarnVaultTransactionPlan;
  try {
    const built = await client.buildQueuedWithdrawalCancel(
      { env, environment: input.actor.environment },
      {
        providerReference: input.position.vaultAddress,
        owner: input.position.ownerAddress,
        requestAddress: input.requestAddress,
      }
    );
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
    owner_address: input.position.ownerAddress,
    vault_address: input.position.vaultAddress,
    token_mint: input.position.tokenMint,
    share_mint: input.position.shareMint,
    request_address: input.requestAddress,
    shares: null,
    quoted_assets: null,
    share_decimals: null,
    asset_decimals: null,
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
      build.discount_bps === null ||
      build.maturity_timestamp === null ||
      build.deadline_timestamp === null
    ) {
      throw internalError(`Queued withdrawal build ${build.id} is missing request terms`);
    }
    const fingerprint = buildEarnVaultQueuedWithdrawalFingerprint({
      environment: build.environment,
      provider: build.provider,
      positionId: build.position_id,
      shares: build.shares,
      discountBps: build.discount_bps,
      deadlineSeconds: Number(BigInt(build.deadline_timestamp) - BigInt(build.maturity_timestamp)),
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
      shares: build.shares,
      quotedAssets: build.quoted_assets,
      shareDecimals: build.share_decimals,
      assetDecimals: build.asset_decimals,
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
