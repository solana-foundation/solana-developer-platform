import type { KeyPairSigner } from "@solana/kit";
import type {
  DashboardData,
  TokenBalance,
  TokenEarnings,
  YieldMovement,
  YieldPosition,
  YieldStrategy,
} from "../src/types.ts";
import { addDecimals, floorForTolerance } from "./decimal.ts";
import { getConfig, getDemoSigner, getFeePayerSigner } from "./env.ts";
import { EmbeddedYieldClient, SdpApiError } from "./sdp-client.ts";
import { readWalletBalances, signTransaction } from "./solana.ts";

const POSITIVE_DECIMAL_PATTERN = /^(?=.*[1-9])\d+(\.\d+)?$/;
const DEFAULT_WITHDRAWAL_TOLERANCE_BPS = 10;

export async function loadDashboard(): Promise<DashboardData> {
  const config = getConfig();
  const { owner, feePayer } = await getTransactionSigners();
  const client = new EmbeddedYieldClient(config);
  const strategies = await client.listStrategies();

  const [positions, movements, earnings, walletBalances] = await Promise.all([
    client.listPositions(owner.address),
    client.listActivity(owner.address),
    client.getEarnings(owner.address),
    readWalletBalances(config.SOLANA_RPC_URL, owner.address, strategies),
  ]);

  const fundedDepositMints = new Set(
    walletBalances.tokens
      .filter((balance) => balance.amount !== "0")
      .map((balance) => balance.mint)
  );
  const livePositions = positions.filter((position) =>
    position.shares === undefined
      ? true
      : POSITIVE_DECIMAL_PATTERN.test(position.shares)
  );
  return {
    wallet: {
      address: owner.address,
      solBalance: walletBalances.solBalance,
      cluster: "devnet",
      feesPaidBy: feePayer ? "northstar" : "customer",
    },
    balances: walletBalances.tokens,
    strategies: strategies.filter(
      (strategy) =>
        strategy.fundable &&
        strategy.status === "active" &&
        strategy.hostCluster === "devnet" &&
        fundedDepositMints.has(strategy.depositMints[0] ?? "")
    ),
    positions: livePositions,
    movements,
    earnings,
    totals: summarizeAccountToken(
      walletBalances.tokens,
      livePositions,
      earnings
    ),
    connection: {
      apiLabel: localApiLabel(config.SDP_API_BASE_URL),
      projectScoped: true,
      checkedAt: new Date().toISOString(),
    },
  };
}

export async function deposit(
  strategyId: string,
  amount: string
): Promise<YieldMovement> {
  assertAmount(amount);
  const config = getConfig();
  const { owner, feePayer, all } = await getTransactionSigners();
  const client = new EmbeddedYieldClient(config);
  const strategy = (await client.listStrategies()).find(
    (candidate) => candidate.id === strategyId
  );
  if (
    !strategy?.fundable ||
    strategy.status !== "active" ||
    strategy.hostCluster !== "devnet"
  ) {
    throw new Error("This strategy is not available for devnet deposits");
  }
  const sourceTokenMint = strategy.depositMints[0];
  if (!sourceTokenMint)
    throw new Error("This strategy does not publish a direct deposit mint");

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

  // 2. Build an unsigned transaction for the managed demo wallet.
  const built = await client.buildDeposit({
    strategyId: strategy.id,
    ownerAddress: owner.address,
    ...(feePayer ? { feePayer: feePayer.address } : {}),
    amount,
    sourceTokenMint,
    ...(minSharesOut ? { minSharesOut } : {}),
  });
  assertBuiltFeePayer(built.feePayer, feePayer?.address);

  // 3. The owner signs locally, joined by Northstar when it pays the fees.
  // Private keys never reach the browser.
  const signedTransaction = await signTransaction(built.transaction, all);

  // 4. Submit with a unique key. An uncertain retry must reuse this exact key.
  const idempotencyKey = `northstar-deposit-${crypto.randomUUID()}`;
  const movement = await retryUncertainSubmit(() =>
    client.submitDeposit(built.transactionId, signedTransaction, idempotencyKey)
  );

  // 5. Poll through confirmed. Only finalized and failed are terminal.
  return client.waitForMovement(movement.movementId);
}

export async function withdraw(
  positionId: string,
  shares: string
): Promise<YieldMovement> {
  assertAmount(shares);
  const config = getConfig();
  const { owner, feePayer, all } = await getTransactionSigners();
  const client = new EmbeddedYieldClient(config);
  const [positions, strategies] = await Promise.all([
    client.listPositions(owner.address),
    client.listStrategies(),
  ]);
  const position = positions.find((candidate) => candidate.id === positionId);
  if (!position)
    throw new Error("The position is not available to this demo wallet");
  if (position.withdrawableShares === undefined) {
    throw new Error(
      "Live withdrawable shares are unavailable; refresh before retrying"
    );
  }

  const strategy = strategies.find(
    (candidate) =>
      candidate.provider === position.provider &&
      candidate.providerReference === position.providerReference
  );

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
  const movement = await retryUncertainSubmit(() =>
    client.submitWithdrawal(
      built.transactionId,
      signedTransaction,
      idempotencyKey
    )
  );
  return client.waitForMovement(movement.movementId);
}

export function summarizeAccountToken(
  balances: readonly TokenBalance[],
  positions: readonly YieldPosition[],
  earnings: readonly TokenEarnings[]
): DashboardData["totals"] {
  const accountBalance =
    balances.find((balance) => balance.symbol === "USDC") ?? balances[0];
  const tokenMint = accountBalance?.mint ?? null;
  const accountPositions = tokenMint
    ? positions.filter((position) => position.tokenMint === tokenMint)
    : [];
  const accountEarnings = tokenMint
    ? earnings.filter((item) => item.tokenMint === tokenMint)
    : [];
  const unavailableYieldPositions = accountPositions.filter(
    (position) => position.tokenValue === undefined
  ).length;
  const available = accountBalance?.amount ?? "0";
  const inYield = unavailableYieldPositions
    ? undefined
    : addDecimals(
        accountPositions.map((position) => position.tokenValue ?? "0")
      );
  const earned = accountEarnings.some((item) => item.earned === undefined)
    ? undefined
    : addDecimals(
        accountEarnings
          .map((item) => item.earned)
          .filter((value): value is string => value !== undefined)
      );

  return {
    tokenMint,
    tokenSymbol: accountBalance?.symbol ?? null,
    available,
    inYield,
    portfolio:
      inYield === undefined ? undefined : addDecimals([available, inYield]),
    earned,
    unavailableYieldPositions,
  };
}

export async function deriveWithdrawalFloor(
  client: Pick<EmbeddedYieldClient, "previewWithdrawal">,
  position: Pick<YieldPosition, "id">,
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
  if (!POSITIVE_DECIMAL_PATTERN.test(amount))
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
