import { isPendingMovement, isSettledMovement } from "../src/lib/movements";
import "server-only";

import type { KeyPairSigner } from "@solana/kit";
import { floorForTolerance, isPositiveDecimal } from "../src/lib/decimal";
import type { PreparedIntent } from "../src/lib/prepared-intent";
import type {
  DashboardData,
  WithdrawalIntent,
  YieldMovement,
  YieldStrategy,
} from "../src/types";
import { getConfig, getDemoSigner, getFeePayerSigner } from "./env";
import {
  assertQueuedWithdrawalTerms,
  belongsToStrategy,
  canDeposit,
  isOpenPosition,
  pickSavingsStrategy,
  requireDepositMint,
  sharesForAmount,
  summarizeSavings,
} from "./savings";
import { EmbeddedYieldClient, SdpApiError } from "./sdp-client";
import { assertRpcCluster, readTokenBalance, signTransaction } from "./solana";

const DEFAULT_WITHDRAWAL_TOLERANCE_BPS = 10;
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

  const allMovements = await client.listMovements(owner.address);

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
  const withdrawalOptions = position
    ? await client.getWithdrawalOptions(position.id).catch(() => null)
    : null;
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
    withdrawalRequests,
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

/** Move money from checking into savings. */
export async function prepareDeposit(amount: string): Promise<PreparedIntent> {
  assertAmount(amount);
  const config = getConfig();
  const { owner, feePayer, all } = await getTransactionSigners();
  const client = new EmbeddedYieldClient(config);
  await assertRpcCluster(config.SOLANA_RPC_URL, config.SOLANA_CLUSTER);
  const strategy = pickSavingsStrategy(
    await listStrategies(client),
    config.SOLANA_CLUSTER,
    config.DEMO_STRATEGY_ID
  );
  if (!canDeposit(strategy)) {
    throw new Error(`${strategy.name} is not accepting deposits right now`);
  }
  const sourceTokenMint = requireDepositMint(strategy);

  // 1. Preview only when the strategy requires a quote-derived floor.
  let minSharesOut: string | undefined;
  if (strategy.depositSlippage?.quoteRequired) {
    const preview = await client.previewDeposit(strategy.id, amount);
    assertNoBlockingIssues(preview.blockingIssues);
    minSharesOut = floorForTolerance(
      preview.sharesOut,
      preview.shareDecimals,
      strategy.depositSlippage.defaultToleranceBps
    );
  }

  // 2. Build an unsigned transaction for the customer's managed wallet.
  const built = await client.buildDeposit({
    strategyId: strategy.id,
    ownerAddress: owner.address,
    ...(feePayer ? { feePayer: feePayer.address } : {}),
    amount,
    sourceTokenMint,
    ...(minSharesOut ? { minSharesOut } : {}),
  });
  assertBuiltFeePayer(built.feePayer, feePayer?.address);

  // 3. The owner signs on the server, joined by Northstar when it pays fees.
  // Private keys never reach the browser.
  const signedTransaction = await signTransaction(
    built.transaction,
    all,
    feePayer?.address ?? owner.address
  );

  return {
    kind: "deposit",
    transactionId: built.transactionId,
    signedTransaction,
    idempotencyKey: `northstar-deposit-${crypto.randomUUID()}`,
  };
}

/** Move money from savings back into checking. */
export async function prepareWithdrawal(
  input: WithdrawalIntent
): Promise<PreparedIntent> {
  assertAmount(input.amount);
  const config = getConfig();
  const { owner, feePayer, all } = await getTransactionSigners();
  const client = new EmbeddedYieldClient(config);
  await assertRpcCluster(config.SOLANA_RPC_URL, config.SOLANA_CLUSTER);
  const [strategies, positions] = await Promise.all([
    listStrategies(client),
    client.listPositions(owner.address),
  ]);
  const strategy = pickSavingsStrategy(
    strategies,
    config.SOLANA_CLUSTER,
    config.DEMO_STRATEGY_ID
  );
  const position = positions
    .filter((candidate) => belongsToStrategy(candidate, strategy))
    .find(isOpenPosition);
  if (!position) throw new Error("Savings is empty");

  // The customer thinks in tokens; the vault redeems shares.
  const shares = sharesForAmount(input.amount, position);
  const options = await client.getWithdrawalOptions(position.id);

  if (input.route === "queued") {
    assertQueuedWithdrawalTerms(
      options,
      shares,
      input.discountBps,
      input.deadlineSeconds
    );
    const preview = await client.previewQueuedWithdrawal({
      positionId: position.id,
      shares,
      discountBps: input.discountBps,
      deadlineSeconds: input.deadlineSeconds,
    });
    assertNoBlockingIssues(preview.blockingIssues);
    const built = await client.buildQueuedWithdrawalRequest({
      positionId: position.id,
      shares,
      discountBps: input.discountBps,
      deadlineSeconds: input.deadlineSeconds,
      ...(feePayer ? { feePayer: feePayer.address } : {}),
    });
    assertBuiltFeePayer(built.feePayer, feePayer?.address);
    const signedTransaction = await signTransaction(
      built.transaction,
      all,
      feePayer?.address ?? owner.address
    );
    return {
      kind: "queued",
      transactionId: built.transactionId,
      signedTransaction,
      idempotencyKey: `northstar-queued-withdrawal-${crypto.randomUUID()}`,
    };
  }

  if (!options.instant && !options.providerOrder) {
    throw new Error("A direct withdrawal is not currently available");
  }
  const minAmountOut = await deriveWithdrawalFloor(
    client,
    position,
    shares,
    strategy
  );
  const built = await client.buildWithdrawal({
    positionId: position.id,
    shares,
    ...(minAmountOut ? { minAmountOut } : {}),
    ...(feePayer ? { feePayer: feePayer.address } : {}),
  });
  assertBuiltFeePayer(built.feePayer, feePayer?.address);
  const signedTransaction = await signTransaction(
    built.transaction,
    all,
    feePayer?.address ?? owner.address
  );
  return {
    kind: "withdrawal",
    transactionId: built.transactionId,
    signedTransaction,
    idempotencyKey: `northstar-withdrawal-${crypto.randomUUID()}`,
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

export async function deriveWithdrawalFloor(
  client: Pick<EmbeddedYieldClient, "previewWithdrawal">,
  position: { id: string },
  shares: string,
  strategy: YieldStrategy | undefined
): Promise<string | undefined> {
  const policy = strategy?.withdrawalSlippage;
  if (strategy && !policy?.quoteRequired) return undefined;

  try {
    const preview = await client.previewWithdrawal(position.id, shares);
    assertNoBlockingIssues(preview.blockingIssues);
    return floorForTolerance(
      preview.assetsOut,
      preview.assetDecimals,
      policy?.defaultToleranceBps ?? DEFAULT_WITHDRAWAL_TOLERANCE_BPS
    );
  } catch (error) {
    if (!strategy && error instanceof SdpApiError && error.status === 501)
      return undefined;
    throw error;
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

function assertNoBlockingIssues(issues: Array<{ message: string }>): void {
  if (issues.length)
    throw new Error(issues.map((issue) => issue.message).join("; "));
}

function localApiLabel(baseUrl: string): string {
  const url = new URL(baseUrl);
  return ["localhost", "127.0.0.1"].includes(url.hostname)
    ? "Local SDP"
    : url.hostname;
}
