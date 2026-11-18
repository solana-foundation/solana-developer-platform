import { isPendingMovement, isSettledMovement } from "../src/lib/movements";
import "server-only";

import type { KeyPairSigner } from "@solana/kit";
import { isPositiveDecimal } from "../src/lib/decimal";
import type { PreparedIntent } from "../src/lib/prepared-intent";
import type {
  DashboardData,
  WithdrawalIntent,
  YieldMovement,
  YieldStrategy,
} from "../src/types";
import { getConfig, getDemoSigner, getFeePayerSigner } from "./env";
import {
  belongsToStrategy,
  canDeposit,
  isOpenPosition,
  pickSavingsStrategy,
  requireDepositMint,
  summarizeSavings,
} from "./savings";
import { EmbeddedYieldClient, SdpApiError } from "./sdp-client";
import { assertRpcCluster, readTokenBalance, signTransaction } from "./solana";

const STRATEGY_CACHE_MS = 5 * 60_000;

let strategyCache:
  | { strategies: YieldStrategy[]; expiresAt: number }
  | undefined;

/**
 * The catalogue changes rarely and the dashboard polls often. Reading it once
 * every few minutes keeps it out of the steady-state refresh. The live refresh
 * reads positions, movements, queued requests, withdrawal routes, and the
 * token balance. An actively watched movement adds one short-lived chain-aware
 * detail read so confirmation reaches the UI without waiting for the sweep.
 */
async function listStrategies(
  client: EmbeddedYieldClient
): Promise<YieldStrategy[]> {
  if (strategyCache && strategyCache.expiresAt > Date.now()) {
    return strategyCache.strategies;
  }
  const strategies = await client.listStrategies();
  strategyCache = { strategies, expiresAt: Date.now() + STRATEGY_CACHE_MS };
  return strategies;
}

export async function loadDashboard(
  activeMovementIds: readonly string[] = []
): Promise<DashboardData> {
  const config = getConfig();
  const { owner, feePayer } = await getTransactionSigners();
  const client = new EmbeddedYieldClient(config);
  await assertRpcCluster(config.SOLANA_RPC_URL, config.SOLANA_CLUSTER);
  const strategy = pickSavingsStrategy(
    await listStrategies(client),
    config.SOLANA_CLUSTER,
    config.DEMO_STRATEGY_ID
  );
  const tokenMint = requireDepositMint(strategy);

  // Legacy history remains an internal compatibility read until its IDs are mapped to operations.
  const [allMovements, operations] = await Promise.all([
    client.listMovements(owner.address),
    client.listOperations(owner.address),
  ]);

  // Scope by strategy, never by open-position ids: SDP drops a position from
  // the list once it closes, but its movements (and their payouts) remain.
  const confirmation = await refreshConfirmingMovements(
    client,
    allMovements.filter((movement) => belongsToStrategy(movement, strategy)),
    activeMovementIds
  );
  const movements = confirmation.movements;

  // Start balances after the ledger/detail observations. This also covers a
  // movement already confirmed in the list, not only a detail-read transition.
  const [positions, checking, allWithdrawalRequests] = await Promise.all([
    client.listPositions(owner.address),
    readTokenBalance(config.SOLANA_RPC_URL, owner.address, tokenMint),
    client.listPendingWithdrawalRequests(owner.address),
  ]);

  const position =
    positions
      .filter((candidate) => belongsToStrategy(candidate, strategy))
      .find(isOpenPosition) ?? null;
  const withdrawalRequests = allWithdrawalRequests.filter((request) =>
    belongsToStrategy(request, strategy)
  );
  const strategyPositionIds = new Set([
    ...positions
      .filter((candidate) => belongsToStrategy(candidate, strategy))
      .map((candidate) => candidate.id),
    ...movements.map((movement) => movement.positionId),
  ]);
  const strategyOperations = operations.filter((operation) =>
    operation.intent.kind === "earn.deposit"
      ? operation.intent.strategyId === strategy.id
      : strategyPositionIds.has(operation.intent.positionId) ||
        (operation.result !== null &&
          strategyPositionIds.has(operation.result.positionId))
  );
  const withdrawalOptions = null;
  const { total, ...savings } = summarizeSavings(
    checking,
    position,
    movements,
    withdrawalRequests
  );

  return {
    wallet: {
      address: owner.address,
      cluster: config.SOLANA_CLUSTER,
      feesPaidBy: feePayer ? "northstar" : "customer",
    },
    token: { mint: tokenMint, symbol: checking.symbol },
    checking: { balance: checking.amount },
    savings: { strategy, position, withdrawalOptions, ...savings },
    total,
    movements,
    operations: strategyOperations,
    withdrawalRequests: withdrawalRequests.filter(
      (request) =>
        !operations.some(
          (operation) =>
            operation.resourceRef?.kind === "earn.withdrawal_request" &&
            operation.resourceRef.id === request.withdrawalRequestId
        )
    ),
    connection: {
      apiLabel: localApiLabel(config.SDP_API_BASE_URL),
      checkedAt: new Date().toISOString(),
    },
  };
}

/**
 * Detail reads check the exact signature on Solana and advance a submitted
 * movement immediately. Confirmation is the UI finish line; finalized rows no
 * longer need a fast read because SDP continues that bookkeeping itself.
 */
export async function refreshConfirmingMovements(
  client: Pick<EmbeddedYieldClient, "getMovement">,
  movements: readonly YieldMovement[],
  activeMovementIds: readonly string[]
): Promise<{
  movements: YieldMovement[];
  reachedConfirmation: boolean;
}> {
  const active = new Set(activeMovementIds);
  const refreshed = await Promise.all(
    movements.map(async (movement) => {
      if (!active.has(movement.movementId) || !isPendingMovement(movement)) {
        return movement;
      }
      try {
        return await client.getMovement(movement.movementId);
      } catch {
        // Keep the last durable state on a transient detail-read failure. The
        // next browser refresh and SDP's background reconciler both retry.
        return movement;
      }
    })
  );
  return {
    movements: refreshed,
    reachedConfirmation: refreshed.some((movement, index) => {
      const previous = movements[index];
      return (
        previous !== undefined &&
        isPendingMovement(previous) &&
        isSettledMovement(movement)
      );
    }),
  };
}

/** Recover escrowed shares after SDP reports that the queue deadline passed. */
export async function prepareQueuedWithdrawalCancellation(
  withdrawalRequestId: string
): Promise<PreparedIntent> {
  const config = getConfig();
  const { owner, feePayer, all } = await getTransactionSigners();
  const client = new EmbeddedYieldClient(config);
  await assertRpcCluster(config.SOLANA_RPC_URL, config.SOLANA_CLUSTER);
  const built = await client.buildQueuedWithdrawalCancellation({
    withdrawalRequestId,
    ...(feePayer ? { feePayer: feePayer.address } : {}),
  });
  assertBuiltFeePayer(built.feePayer, feePayer?.address);
  const signedTransaction = await signTransaction(
    built.transaction,
    all,
    feePayer?.address ?? owner.address
  );
  return {
    kind: "cancel",
    transactionId: built.transactionId,
    signedTransaction,
    idempotencyKey: `northstar-withdrawal-cancel-${crypto.randomUUID()}`,
  };
}

/** Submit only the exact signed intent saved by the browser. Never rebuild here. */
export async function submitPreparedIntent(intent: PreparedIntent) {
  const client = new EmbeddedYieldClient(getConfig());
  const args = [
    intent.transactionId,
    intent.signedTransaction,
    intent.idempotencyKey,
  ] as const;
  switch (intent.kind) {
    case "deposit":
      return {
        kind: "movement" as const,
        movement: await retryUncertainSubmit(() =>
          client.submitDeposit(...args)
        ),
      };
    case "withdrawal":
      return {
        kind: "movement" as const,
        movement: await retryUncertainSubmit(() =>
          client.submitWithdrawal(...args)
        ),
      };
    case "queued":
      return {
        kind: "queued" as const,
        withdrawalRequest: await retryUncertainSubmit(() =>
          client.submitQueuedWithdrawalRequest(...args)
        ),
      };
    case "cancel":
      return {
        kind: "cancel" as const,
        withdrawalRequest: await retryUncertainSubmit(() =>
          client.submitQueuedWithdrawalCancellation(...args)
        ),
      };
  }
}

export function assertBuiltFeePayer(
  builtFeePayer: string | undefined,
  expectedFeePayer: string | undefined
): void {
  if (builtFeePayer !== expectedFeePayer) {
    throw new Error("SDP returned a transaction with an unexpected fee payer");
  }
}

async function getTransactionSigners(): Promise<{
  owner: KeyPairSigner;
  feePayer: KeyPairSigner | undefined;
  all: readonly KeyPairSigner[];
}> {
  const [owner, configuredFeePayer] = await Promise.all([
    getDemoSigner(),
    getFeePayerSigner(),
  ]);
  const feePayer =
    configuredFeePayer?.address === owner.address
      ? undefined
      : configuredFeePayer;

  return {
    owner,
    feePayer,
    all: feePayer ? [owner, feePayer] : [owner],
  };
}

async function retryUncertainSubmit<T>(submit: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await submit();
    } catch (error) {
      lastError = error;
      if (error instanceof SdpApiError && error.status < 500) throw error;
      if (attempt < 2)
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }

  throw lastError;
}

function assertAmount(amount: string): void {
  if (!isPositiveDecimal(amount))
    throw new Error("Enter a positive decimal amount");
}

function localApiLabel(baseUrl: string): string {
  const url = new URL(baseUrl);
  return ["localhost", "127.0.0.1"].includes(url.hostname)
    ? "Local SDP"
    : url.hostname;
}

/** New transfers prepare one generic operation; signing waits for explicit execution. */
export async function prepareCoreDeposit(
  amount: string,
  idempotencyKey: string
) {
  assertAmount(amount);
  const config = getConfig();
  const { owner, feePayer } = await getTransactionSigners();
  const client = new EmbeddedYieldClient(config);
  const strategy = pickSavingsStrategy(
    await listStrategies(client),
    config.SOLANA_CLUSTER,
    config.DEMO_STRATEGY_ID
  );
  if (!canDeposit(strategy))
    throw new Error("This strategy is not accepting deposits");
  return client.prepareDeposit(
    {
      strategyId: strategy.id,
      source: { ownerAddress: owner.address },
      amount: { mint: requireDepositMint(strategy), value: amount },
      ...(strategy.depositSlippage
        ? { slippageBps: strategy.depositSlippage.defaultToleranceBps }
        : {}),
      ...(feePayer ? { feePayer: feePayer.address } : {}),
    },
    idempotencyKey
  );
}

export async function prepareCoreWithdrawal(
  input: WithdrawalIntent,
  idempotencyKey: string
) {
  assertAmount(input.amount);
  const config = getConfig();
  const { owner, feePayer } = await getTransactionSigners();
  const client = new EmbeddedYieldClient(config);
  const strategy = pickSavingsStrategy(
    await listStrategies(client),
    config.SOLANA_CLUSTER,
    config.DEMO_STRATEGY_ID
  );
  const position = (await client.listPositions(owner.address)).find(
    (candidate) =>
      belongsToStrategy(candidate, strategy) && isOpenPosition(candidate)
  );
  if (!position) throw new Error("Savings is empty");
  return client.prepareWithdrawal(
    {
      positionId: position.id,
      amount: { kind: "token", mint: position.tokenMint, value: input.amount },
      ...(strategy.withdrawalSlippage
        ? { slippageBps: strategy.withdrawalSlippage.defaultToleranceBps }
        : {}),
      ...(feePayer ? { feePayer: feePayer.address } : {}),
    },
    idempotencyKey
  );
}

/** The browser persists this action before asking the server-held demo owner to sign. */
export async function executeCoreOperation(
  id: string,
  action: {
    actionId: string;
    version: number;
    optionId?: string;
    idempotencyKey: string;
  }
) {
  const config = getConfig();
  const client = new EmbeddedYieldClient(config);
  const operation = await client.getOperation(id);
  const { owner, feePayer, all } = await getTransactionSigners();
  const source =
    operation.intent.kind === "earn.deposit"
      ? operation.intent.source
      : operation.result?.source;
  if (
    source &&
    !("ownerAddress" in source && source.ownerAddress === owner.address)
  )
    throw new Error("Operation owner does not match the demo wallet");
  if (!source && operation.intent.kind === "earn.withdraw") {
    const positionId = operation.intent.positionId;
    const position = (await client.listPositions(owner.address)).find(
      (position) => position.id === positionId
    );
    if (!position)
      throw new Error("Operation position is not owned by the demo wallet");
  }
  // A lost response can leave the original action durably advanced already.
  if (
    operation.actionId !== action.actionId ||
    operation.version !== action.version
  )
    return operation;
  const nextAction = operation.nextAction;
  if (nextAction?.type !== "sign_transaction" && nextAction?.type !== "execute")
    return operation;
  await assertRpcCluster(config.SOLANA_RPC_URL, config.SOLANA_CLUSTER);
  const signedTransaction =
    nextAction.type === "sign_transaction"
      ? await signTransaction(
          nextAction.transaction,
          all,
          feePayer?.address ?? owner.address
        )
      : undefined;
  return retryUncertainSubmit(() =>
    client.executeOperation(
      id,
      {
        actionId: action.actionId,
        version: action.version,
        ...(action.optionId ? { optionId: action.optionId } : {}),
        ...(signedTransaction ? { signedTransaction } : {}),
      },
      action.idempotencyKey
    )
  );
}

async function assertDemoOperationOwner(
  client: EmbeddedYieldClient,
  id: string
) {
  const [operation, owner] = await Promise.all([
    client.getOperation(id),
    getDemoSigner(),
  ]);
  const source =
    operation.intent.kind === "earn.deposit"
      ? operation.intent.source
      : operation.result?.source;
  if (source) {
    if (!("ownerAddress" in source && source.ownerAddress === owner.address))
      throw new Error("Operation owner does not match the demo wallet");
  } else if (operation.intent.kind === "earn.withdraw") {
    const positionId = operation.intent.positionId;
    const positions = await client.listPositions(owner.address);
    if (!positions.some((position) => position.id === positionId))
      throw new Error("Operation position is not owned by the demo wallet");
  }
}

export async function cancelCoreOperation(id: string, idempotencyKey: string) {
  const client = new EmbeddedYieldClient(getConfig());
  await assertDemoOperationOwner(client, id);
  return client.cancelOperation(id, idempotencyKey);
}

/** Preparing replacement terms never signs or requests execution. */
export async function refreshCoreOperation(id: string, idempotencyKey: string) {
  const client = new EmbeddedYieldClient(getConfig());
  await assertDemoOperationOwner(client, id);
  return client.refreshOperation(id, idempotencyKey);
}
