import {
  supportsVaultParRedemption,
  supportsVaultProviderOrderWithdraw,
  supportsVaultQueuedWithdraw,
  supportsVaultWithdraw,
  supportsVaultWithdrawQuote,
} from "@sdp/earn/capabilities";
import { currentClusterScope } from "@sdp/rpc/scope";
import { compareDecimalAmounts } from "@sdp/solana/amount";
import type { OperationTerms } from "@sdp/types/operations";
import { earnWithdrawSlippageFloor } from "@sdp/types/provider-access";
import { getDb } from "@/db/client";
import {
  createPostgresEarnVaultWithdrawalRequestsRepository,
  type EarnVaultWithdrawalRequestRow,
  type EarnWalletWithdrawalRequestTransactionRow,
} from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import { badRequest, conflict, notFound } from "@/lib/errors";
import type { Env } from "@/types/env";
import { isEarnDirectWithdrawalConfigured, resolveEarnExecutionClient } from "./execution-registry";
import { earnRuntime } from "./runtime";
import { strategyOutputFloor } from "./strategy-terms";
import { createVaultDeadline } from "./vault-deadline";
import {
  type AsyncWithdrawalTermsInput,
  buildWalletQueuedWithdrawalCancel,
  buildWalletQueuedWithdrawalRequest,
  type QueuedWithdrawalActor,
  type QueuedWithdrawalPosition,
  submitWalletQueuedWithdrawalAction,
  type WalletQueuedWithdrawalBuiltTransaction,
} from "./vault-queued-withdraw.service";
import type { VaultFeeMode } from "./vault-sponsorship";

export interface PreparedStrategyWithdrawalChoice {
  id: string;
  kind: "direct" | "queued";
  option: OperationTerms["options"][number];
  terms?: AsyncWithdrawalTermsInput;
}

export interface PreparedStrategyWithdrawalChoices {
  options: OperationTerms["options"];
  choices: PreparedStrategyWithdrawalChoice[];
}

/**
 * Read independent provider routes once, then quote each eligible route once.
 * No route is selected here. A delayed request never promises a payout time.
 */
export async function prepareStrategyWithdrawalChoices(
  env: Env,
  input: {
    position: QueuedWithdrawalPosition;
    shares?: string;
    intermediateAmount?: string;
    slippageBps?: number;
  }
): Promise<PreparedStrategyWithdrawalChoices> {
  if ((input.shares === undefined) === (input.intermediateAmount === undefined))
    throw badRequest("Choose strategy shares or held intermediate, exclusively");
  const client = resolveEarnExecutionClient(env, input.position.provider, createVaultDeadline());
  if (client === null) throw badRequest("This strategy has no supported withdrawal adapter");
  const runtime = earnRuntime(env);
  const reference = { providerReference: input.position.vaultAddress };
  const queueClient = supportsVaultQueuedWithdraw(client) ? client : null;
  const parClient = supportsVaultParRedemption(client) ? client : null;
  const [queueRead, parRead] = await Promise.allSettled([
    queueClient?.getWithdrawalOptions(runtime, reference) ?? null,
    parClient?.getParRedemptionOptions(runtime, reference) ?? null,
  ]);
  const queue = queueRead.status === "fulfilled" ? queueRead.value : null;
  const par = parRead.status === "fulfilled" ? parRead.value : null;
  const choices: PreparedStrategyWithdrawalChoice[] = [];
  const quotes: Array<Promise<void>> = [];
  if (
    input.shares !== undefined &&
    isEarnDirectWithdrawalConfigured(env, input.position.provider) &&
    supportsVaultWithdraw(client) &&
    (queueClient === null || queue?.instant || supportsVaultProviderOrderWithdraw(client))
  ) {
    const shares = input.shares;
    quotes.push(
      (async () => {
        const quote = supportsVaultWithdrawQuote(client)
          ? await client.quoteVaultWithdrawal(runtime, { ...reference, shares })
          : null;
        if (quote !== null && quote.blockingIssues.length > 0) return;
        const policy = earnWithdrawSlippageFloor(input.position.provider);
        choices.push({
          id: "direct",
          kind: "direct",
          option: {
            id: "direct",
            label: supportsVaultProviderOrderWithdraw(client)
              ? "Provider redemption order"
              : "Direct withdrawal",
            settlement: supportsVaultProviderOrderWithdraw(client) ? "delayed" : "instant",
            estimatedSeconds: null,
            mechanism: supportsVaultProviderOrderWithdraw(client) ? "provider_order" : "direct",
            ...(quote === null
              ? {}
              : {
                  amount: { mint: input.position.tokenMint, value: quote.assetsOut },
                  minimum:
                    policy === null
                      ? null
                      : {
                          mint: input.position.tokenMint,
                          value: strategyOutputFloor(
                            quote.assetsOut,
                            quote.assetDecimals,
                            input.slippageBps ?? policy.defaultToleranceBps
                          ),
                        },
                }),
          },
        });
      })()
    );
  }
  const queueAsset = queue?.queueAsset;
  if (
    input.shares !== undefined &&
    queueClient !== null &&
    queue?.queued &&
    queueAsset?.allowWithdrawals &&
    compareDecimalAmounts(input.shares, queueAsset.minimumShares) >= 0
  ) {
    const terms: AsyncWithdrawalTermsInput = {
      mechanism: "solver_queue",
      shares: input.shares,
      discountBps: queueAsset.minimumDiscountBps,
      deadlineSeconds: queueAsset.minimumSecondsToDeadline,
    };
    quotes.push(
      (async () => {
        const quote = await queueClient.quoteQueuedWithdrawal(runtime, {
          ...reference,
          shares: terms.shares,
          discountBps: terms.discountBps,
          deadlineSeconds: terms.deadlineSeconds,
        });
        if (quote.assetMint !== input.position.tokenMint || quote.blockingIssues.length > 0) return;
        const id = `solver_queue:${terms.discountBps}:${terms.deadlineSeconds}`;
        choices.push({
          id,
          kind: "queued",
          terms,
          option: {
            id,
            label: `Solver queue (${terms.discountBps} bps discount, ${terms.deadlineSeconds}s window)`,
            settlement: "delayed",
            estimatedSeconds: null,
            mechanism: "solver_queue",
            amount: { mint: quote.assetMint, value: quote.assets },
            minimum: null,
          },
        });
      })()
    );
  }
  if (parClient !== null && par !== null && par.assetMint === input.position.tokenMint) {
    const terms: AsyncWithdrawalTermsInput | null =
      input.intermediateAmount !== undefined
        ? compareDecimalAmounts(input.intermediateAmount, par.minimumIntermediateAmount) >= 0
          ? { mechanism: "operator_redemption", intermediateAmount: input.intermediateAmount }
          : null
        : input.shares !== undefined &&
            par.minimumShares !== null &&
            compareDecimalAmounts(input.shares, par.minimumShares) >= 0
          ? { mechanism: "operator_redemption", shares: input.shares }
          : null;
    if (terms !== null)
      quotes.push(
        (async () => {
          const quote = await parClient.quoteParRedemption(
            runtime,
            terms.intermediateAmount === undefined
              ? { ...reference, shares: terms.shares }
              : { ...reference, intermediateAmount: terms.intermediateAmount }
          );
          if (
            quote.assetMint !== input.position.tokenMint ||
            quote.intermediateMint !== par.intermediateMint ||
            quote.blockingIssues.length > 0
          )
            return;
          const id = "operator_redemption";
          choices.push({
            id,
            kind: "queued",
            terms,
            option: {
              id,
              label: "Operator redemption at par",
              settlement: "delayed",
              estimatedSeconds: null,
              mechanism: "operator_redemption",
              amount: { mint: quote.assetMint, value: quote.assets },
              minimum: null,
            },
          });
        })()
      );
  }
  await Promise.allSettled(quotes);
  choices.sort((left, right) => left.id.localeCompare(right.id));
  if (choices.length === 0)
    throw badRequest("No supported withdrawal route is currently available");
  return { choices, options: choices.map((choice) => choice.option) };
}

/** Multiple economic routes require an explicit selection and a new review. */
export function selectStrategyWithdrawalChoice(
  prepared: PreparedStrategyWithdrawalChoices,
  optionId?: string
): PreparedStrategyWithdrawalChoice {
  const selected =
    optionId === undefined && prepared.choices.length === 1
      ? prepared.choices[0]
      : prepared.choices.find((choice) => choice.id === optionId);
  if (selected === undefined) throw badRequest("Choose one of the reviewed withdrawal options");
  return selected;
}

/** One unsigned approval target for either custody or an owner. */
export interface PreparedQueuedStrategyTransaction {
  id: string;
  unsignedTransaction: string;
  lastValidBlockHeight: string;
  ownerAddress: string;
  custodyWalletId: string | null;
  feeMode: "wallet" | "partner" | "sponsored";
  feePayer: string | null;
  action: "request" | "cancel";
  build: WalletQueuedWithdrawalBuiltTransaction;
}

interface QueuedStrategyPreparation {
  actor: QueuedWithdrawalActor;
  position: QueuedWithdrawalPosition;
  custodyWalletId?: string;
  fee?: VaultFeeMode;
  feePayer?: string;
  /** Only authorized live-discovered holdings use an unclaimed build. */
  discoveredStrategyId?: string;
}

/** Adapter capabilities only; no provider admission gate applies to an exit. */
export function supportedQueuedStrategyMechanisms(env: Env, provider: string) {
  const client = resolveEarnExecutionClient(env, provider, createVaultDeadline());
  return {
    solverQueue: client !== null && supportsVaultQueuedWithdraw(client),
    operatorRedemption: client !== null && supportsVaultParRedemption(client),
  };
}

function requirePreparationSource(input: QueuedStrategyPreparation): void {
  if ((input.position.custodyWalletId ?? null) !== (input.custodyWalletId ?? null)) {
    throw conflict("Queued strategy source does not match the authorized position");
  }
  if (input.custodyWalletId !== undefined && input.feePayer !== undefined) {
    throw conflict("A custody withdrawal uses its configured fee payer");
  }
  if (input.custodyWalletId === undefined && input.fee?.kind === "sponsored") {
    throw conflict("An owner has no SDP custody sponsorship");
  }
}

function prepared(
  build: WalletQueuedWithdrawalBuiltTransaction
): PreparedQueuedStrategyTransaction {
  return {
    id: build.id,
    unsignedTransaction: build.unsigned_transaction,
    lastValidBlockHeight: build.last_valid_block_height,
    ownerAddress: build.owner_address,
    custodyWalletId: build.custody_wallet_id ?? null,
    feeMode: build.fee_mode ?? "wallet",
    feePayer: build.fee_payer,
    action: build.action,
    build,
  };
}

/** Build and reserve an unsigned queue request; never sign or broadcast it. */
export async function prepareQueuedStrategyWithdrawal(
  env: Env,
  input: QueuedStrategyPreparation & { terms: AsyncWithdrawalTermsInput }
): Promise<PreparedQueuedStrategyTransaction> {
  requirePreparationSource(input);
  return prepared(
    await buildWalletQueuedWithdrawalRequest(env, { ...input, asyncOperation: true })
  );
}

/** Build the provider's recovery action, preserving its actual economic outcome. */
export async function prepareQueuedStrategyCancellation(
  env: Env,
  input: QueuedStrategyPreparation & {
    request: EarnVaultWithdrawalRequestRow;
    requestAddress: string;
  }
): Promise<PreparedQueuedStrategyTransaction> {
  requirePreparationSource(input);
  if (
    input.request.position_id !== input.position.id ||
    input.request.custody_wallet_id !== (input.custodyWalletId ?? null) ||
    input.request.owner_address !== input.position.ownerAddress ||
    input.request.project_id !== input.actor.projectId ||
    input.request.organization_id !== input.actor.organizationId
  ) {
    throw notFound("Earn withdrawal request");
  }
  return prepared(await buildWalletQueuedWithdrawalCancel(env, { ...input, asyncOperation: true }));
}

/** Recover exactly the stored build under the operation's authorized source. */
export async function requirePreparedQueuedStrategyTransaction(
  env: Env,
  scope: { organizationId: string; projectId: string; custodyWalletId: string | null },
  transactionId: string
): Promise<EarnWalletWithdrawalRequestTransactionRow> {
  const build = await createPostgresEarnVaultWithdrawalRequestsRepository(
    getDb(env)
  ).getWalletTransaction({ organizationId: scope.organizationId, transactionId });
  if (
    build === null ||
    build.project_id !== scope.projectId ||
    build.environment !== currentClusterScope().environment ||
    (build.custody_wallet_id ?? null) !== scope.custodyWalletId
  )
    throw notFound("Prepared queued strategy transaction");
  return build;
}

/**
 * Verify the complete signed message, record its existing request/action
 * outbox, then broadcast. A confirmed request is still an unsettled obligation.
 */
export async function submitPreparedQueuedStrategyAction(
  env: Env,
  input: {
    actor: QueuedWithdrawalActor;
    custodyWalletId: string | null;
    transactionId: string;
    signedTransaction: string;
    clientRequestId: string;
    /** False only when operation recovery has already observed this signature. */
    broadcast?: boolean;
  }
) {
  const build = await requirePreparedQueuedStrategyTransaction(
    env,
    { ...input.actor, custodyWalletId: input.custodyWalletId },
    input.transactionId
  );
  const result = await submitWalletQueuedWithdrawalAction(env, {
    ...input,
    action: build.action,
    allowDiscoveredPosition: true,
    allowOperationBuild: true,
  });
  return {
    ...result,
    resourceRef: { kind: "earn.withdrawal_request" as const, id: result.request.id },
  };
}
