import "server-only";

import type { KeyPairSigner } from "@solana/kit";
import { floorForTolerance, isPositiveDecimal } from "../src/lib/decimal";
import type { DashboardData, YieldMovement, YieldStrategy } from "../src/types";
import { getConfig, getDemoSigner, getFeePayerSigner } from "./env";
import {
  belongsToStrategy,
  canDeposit,
  isOpenPosition,
  pickSavingsStrategy,
  requireDepositMint,
  sharesForAmount,
  summarizeSavings,
} from "./savings";
import { EmbeddedYieldClient, SdpApiError } from "./sdp-client";
import { readTokenBalance, signTransaction } from "./solana";

const DEFAULT_WITHDRAWAL_TOLERANCE_BPS = 10;
const STRATEGY_CACHE_MS = 5 * 60_000;

let strategyCache:
  | { strategies: YieldStrategy[]; expiresAt: number }
  | undefined;

/**
 * The catalogue changes rarely and the dashboard polls often. Reading it once
 * every few minutes keeps each refresh to three SDP calls and one RPC read.
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

export async function loadDashboard(): Promise<DashboardData> {
  const config = getConfig();
  const { owner, feePayer } = await getTransactionSigners();
  const client = new EmbeddedYieldClient(config);
  const strategy = pickSavingsStrategy(
    await listStrategies(client),
    config.DEMO_STRATEGY_ID
  );
  const tokenMint = requireDepositMint(strategy);

  const [positions, movements, earnings, checking] = await Promise.all([
    client.listPositions(owner.address),
    client.listActivity(owner.address),
    client.getEarnings(owner.address),
    readTokenBalance(config.SOLANA_RPC_URL, owner.address, tokenMint),
  ]);

  const strategyPositions = positions.filter((position) =>
    belongsToStrategy(position, strategy)
  );
  const position = strategyPositions.find(isOpenPosition) ?? null;
  const positionIds = new Set(strategyPositions.map((item) => item.id));
  const { total, ...savings } = summarizeSavings(
    checking,
    position,
    earnings.find((item) => item.tokenMint === tokenMint)
  );

  return {
    wallet: {
      address: owner.address,
      cluster: "devnet",
      feesPaidBy: feePayer ? "northstar" : "customer",
    },
    token: { mint: tokenMint, symbol: checking.symbol },
    checking: { balance: checking.amount },
    savings: { strategy, position, ...savings },
    total,
    movements: movements.filter((movement) =>
      positionIds.has(movement.positionId)
    ),
    connection: {
      apiLabel: localApiLabel(config.SDP_API_BASE_URL),
      checkedAt: new Date().toISOString(),
    },
  };
}

/** Move money from checking into savings. */
export async function deposit(amount: string): Promise<YieldMovement> {
  assertAmount(amount);
  const config = getConfig();
  const { owner, feePayer, all } = await getTransactionSigners();
  const client = new EmbeddedYieldClient(config);
  const strategy = pickSavingsStrategy(
    await listStrategies(client),
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
  const signedTransaction = await signTransaction(built.transaction, all);

  // 4. Submit with a unique key. An uncertain retry must reuse this exact key.
  const idempotencyKey = `northstar-deposit-${crypto.randomUUID()}`;
  return retryUncertainSubmit(() =>
    client.submitDeposit(built.transactionId, signedTransaction, idempotencyKey)
  );
  // Settlement is polled by the browser through the dashboard route, which
  // keeps this handler short enough for serverless functions.
}

/** Move money from savings back into checking. */
export async function withdraw(amount: string): Promise<YieldMovement> {
  assertAmount(amount);
  const config = getConfig();
  const { owner, feePayer, all } = await getTransactionSigners();
  const client = new EmbeddedYieldClient(config);
  const [strategies, positions] = await Promise.all([
    listStrategies(client),
    client.listPositions(owner.address),
  ]);
  const strategy = pickSavingsStrategy(strategies, config.DEMO_STRATEGY_ID);
  const position = positions
    .filter((candidate) => belongsToStrategy(candidate, strategy))
    .find(isOpenPosition);
  if (!position) throw new Error("Savings is empty");

  // The customer thinks in tokens; the vault redeems shares.
  const shares = sharesForAmount(amount, position);
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
  const signedTransaction = await signTransaction(built.transaction, all);
  const idempotencyKey = `northstar-withdrawal-${crypto.randomUUID()}`;
  return retryUncertainSubmit(() =>
    client.submitWithdrawal(
      built.transactionId,
      signedTransaction,
      idempotencyKey
    )
  );
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

async function retryUncertainSubmit(
  submit: () => Promise<YieldMovement>
): Promise<YieldMovement> {
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
