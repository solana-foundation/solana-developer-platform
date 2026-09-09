import type { DashboardData, YieldMovement } from "../src/types.ts";
import { addDecimals, floorForTolerance } from "./decimal.ts";
import { getConfig, getDemoSigner } from "./env.ts";
import { EmbeddedYieldClient, SdpApiError } from "./sdp-client.ts";
import { readWalletBalances, signTransaction } from "./solana.ts";

const DEPOSIT_PATTERN = /^(?=.*[1-9])\d+(\.\d+)?$/;

export async function loadDashboard(): Promise<DashboardData> {
  const config = getConfig();
  const signer = await getDemoSigner();
  const client = new EmbeddedYieldClient(config);
  const strategies = await client.listStrategies();

  const [positions, movements, earnings, walletBalances] = await Promise.all([
    client.listPositions(signer.address),
    client.listActivity(signer.address),
    client.getEarnings(signer.address),
    readWalletBalances(config.SOLANA_RPC_URL, signer.address, strategies),
  ]);

  const available = addDecimals(
    walletBalances.tokens.map((balance) => balance.amount)
  );
  const fundedDepositMints = new Set(
    walletBalances.tokens
      .filter((balance) => balance.amount !== "0")
      .map((balance) => balance.mint)
  );
  const unavailableYieldPositions = positions.filter(
    (position) => position.tokenValue === undefined
  ).length;
  const inYield = unavailableYieldPositions
    ? undefined
    : addDecimals(positions.map((position) => position.tokenValue ?? "0"));
  const earnedValues = earnings
    .map((item) => item.earned)
    .filter((value): value is string => value !== undefined);
  const earned = earnings.some((item) => item.earned === undefined)
    ? undefined
    : addDecimals(earnedValues);

  return {
    wallet: {
      address: signer.address,
      solBalance: walletBalances.solBalance,
      cluster: "devnet",
    },
    balances: walletBalances.tokens,
    strategies: strategies.filter(
      (strategy) =>
        strategy.fundable &&
        strategy.status === "active" &&
        strategy.hostCluster === "devnet" &&
        fundedDepositMints.has(strategy.depositMints[0] ?? "")
    ),
    positions,
    movements,
    earnings,
    totals: {
      available,
      inYield,
      portfolio:
        inYield === undefined ? undefined : addDecimals([available, inYield]),
      earned,
      unavailableYieldPositions,
    },
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
  const signer = await getDemoSigner();
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
    ownerAddress: signer.address,
    amount,
    sourceTokenMint,
    ...(minSharesOut ? { minSharesOut } : {}),
  });

  // 3. The wallet signs locally. The private key never reaches the browser.
  const signedTransaction = await signTransaction(built.transaction, signer);

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
  const signer = await getDemoSigner();
  const client = new EmbeddedYieldClient(config);
  const [positions, strategies] = await Promise.all([
    client.listPositions(signer.address),
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

  // Quote only where the catalogue requires it. A null policy means the
  // provider supports building the exit without a quote-derived floor.
  let minAmountOut: string | undefined;
  if (strategy?.withdrawalSlippage?.quoteRequired) {
    const preview = await client.previewWithdrawal(position.id, shares);
    assertNoBlockingIssues(preview.blockingIssues);
    minAmountOut = floorForTolerance(
      preview.assetsOut,
      preview.assetDecimals,
      strategy.withdrawalSlippage.defaultToleranceBps
    );
  }

  const built = await client.buildWithdrawal({
    positionId: position.id,
    shares,
    ...(minAmountOut ? { minAmountOut } : {}),
  });
  const signedTransaction = await signTransaction(built.transaction, signer);
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
  if (!DEPOSIT_PATTERN.test(amount))
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
