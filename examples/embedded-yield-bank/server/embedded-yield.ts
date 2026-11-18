import "server-only";

import type { KeyPairSigner } from "@solana/kit";
import { isPositiveDecimal } from "../src/lib/decimal";
import type {
  DashboardData,
  WithdrawalIntent,
  YieldStrategy,
} from "../src/types";
import { getConfig, getDemoSigner, getFeePayerSigner } from "./env";
import {
  operationsForSavingsStrategy,
  summarizeSavingsOperations,
} from "./operation-savings";
import {
  belongsToStrategy,
  canDeposit,
  isOpenPosition,
  pickSavingsStrategy,
  requireDepositMint,
} from "./savings";
import { EmbeddedYieldClient, SdpApiError } from "./sdp-client";
import { assertRpcCluster, readTokenBalance, signTransaction } from "./solana";

const STRATEGY_CACHE_MS = 5 * 60_000;

let strategyCache:
  | { strategies: YieldStrategy[]; expiresAt: number }
  | undefined;

/** Cache the catalogue; poll durable operations, live positions and token balances. */
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
  const owner = await getDemoSigner();
  const client = new EmbeddedYieldClient(config);
  await assertRpcCluster(config.SOLANA_RPC_URL, config.SOLANA_CLUSTER);
  const strategy = pickSavingsStrategy(
    await listStrategies(client),
    config.SOLANA_CLUSTER,
    config.DEMO_STRATEGY_ID
  );
  const tokenMint = requireDepositMint(strategy);

  // Observe durable work before reading either side of the balance.
  const operations = await client.listOperations(owner.address);
  const [positions, checking] = await Promise.all([
    client.listPositions(owner.address),
    readTokenBalance(config.SOLANA_RPC_URL, owner.address, tokenMint),
  ]);
  const strategyPositions = positions.filter((candidate) =>
    belongsToStrategy(candidate, strategy)
  );
  const position = strategyPositions.find(isOpenPosition) ?? null;
  const strategyOperations = operationsForSavingsStrategy(
    operations,
    strategy.id,
    strategyPositions
  );
  const { total, ...savings } = summarizeSavingsOperations(
    checking,
    position,
    strategyOperations,
    tokenMint
  );

  return {
    wallet: {
      address: owner.address,
      cluster: config.SOLANA_CLUSTER,
    },
    token: { mint: tokenMint, symbol: checking.symbol },
    checking: { balance: checking.amount },
    savings: { strategy, position, ...savings },
    total,
    operations: strategyOperations,
    connection: {
      apiLabel: localApiLabel(config.SDP_API_BASE_URL),
      checkedAt: new Date().toISOString(),
    },
  };
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
  const { owner, feePayer, all } = await getTransactionSigners();
  const operation = await getOwnedOperation(client, id, owner.address);
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

async function getOwnedOperation(
  client: EmbeddedYieldClient,
  id: string,
  ownerAddress: string
) {
  const operation = await client.getOperation(id);
  const source =
    operation.intent.kind === "earn.deposit"
      ? operation.intent.source
      : operation.result?.source;
  if (source) {
    if (!("ownerAddress" in source && source.ownerAddress === ownerAddress))
      throw new Error("Operation owner does not match the demo wallet");
  } else if (operation.intent.kind === "earn.withdraw") {
    const positionId = operation.intent.positionId;
    const positions = await client.listPositions(ownerAddress);
    if (!positions.some((position) => position.id === positionId))
      throw new Error("Operation position is not owned by the demo wallet");
  }
  return operation;
}

export async function cancelCoreOperation(id: string, idempotencyKey: string) {
  const client = new EmbeddedYieldClient(getConfig());
  await getOwnedOperation(client, id, (await getDemoSigner()).address);
  return client.cancelOperation(id, idempotencyKey);
}

/** Preparing replacement terms never signs or requests execution. */
export async function refreshCoreOperation(id: string, idempotencyKey: string) {
  const client = new EmbeddedYieldClient(getConfig());
  await getOwnedOperation(client, id, (await getDemoSigner()).address);
  return client.refreshOperation(id, idempotencyKey);
}
