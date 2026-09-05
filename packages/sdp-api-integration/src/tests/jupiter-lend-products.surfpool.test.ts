import { apiTestSupport } from "@sdp/api/test-support";
import type {
  EarnExternalWalletDepositResponse,
  EarnExternalWalletDepositTransactionResponse,
  EarnExternalWalletWithdrawalResponse,
  EarnExternalWalletWithdrawalTransactionResponse,
  EarnVaultDeposit,
  EarnVaultWithdrawalResponse,
} from "@sdp/types";
import { JUPITER_LEND_USDT } from "@sdp/types/jupiter-lend-programs";
import {
  generateKeyPair,
  getAddressFromPublicKey,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupIntegrationSuite,
  createFundedIntegrationWallet,
  env,
  initIntegrationSuite,
  requestWithApiKey,
  TEST_ORG,
  TEST_PROJECT,
  TEST_PROJECT_CACHED_KEY,
} from "../helpers/integration";

const {
  createKVStoreSet,
  createPostgresEarnRepository,
  createVaultDeadline,
  getDb,
  resolveEarnExecutionClient,
  supportsVaultDirect,
} = apiTestSupport;

const ENABLED = process.env.JUPITER_LEND_SURFPOOL_E2E === "true";
const DEPOSIT_AMOUNT = "5";
const SLIPPAGE_TOLERANCE_BPS = 10;
const api = requestWithApiKey();

interface DepositPreview {
  sharesOut: string;
  shareDecimals: number;
  blockingIssues: Array<{ code: string; message: string }>;
}

interface WithdrawalPreview {
  assetsOut: string;
  assetDecimals: number;
  blockingIssues: Array<{ code: string; message: string }>;
}

function decimalAtoms(value: string, decimals: number): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
}

function decimalFromAtoms(atoms: bigint, decimals: number): string {
  const digits = atoms.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const rawFraction = digits.slice(-decimals);
  let fractionEnd = rawFraction.length;
  while (fractionEnd > 0 && rawFraction.charCodeAt(fractionEnd - 1) === 48) fractionEnd -= 1;
  const fraction = rawFraction.slice(0, fractionEnd);
  return fraction ? `${whole}.${fraction}` : whole;
}

function floorFromQuote(value: string, decimals: number): string {
  const floor = (decimalAtoms(value, decimals) * BigInt(10_000 - SLIPPAGE_TOLERANCE_BPS)) / 10_000n;
  if (floor <= 0n) throw new Error("Jupiter Lend quote is too small for a positive slippage floor");
  return decimalFromAtoms(floor, decimals);
}

async function post<T>(
  path: string,
  body: Record<string, unknown>,
  idempotent = false
): Promise<T> {
  const response = await api(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idempotent ? { "Idempotency-Key": crypto.randomUUID() } : {}),
    },
    body: JSON.stringify(body),
    timeoutMs: 120_000,
  });
  const payload = (await response.json()) as { data?: T; error?: { message?: string } };
  if (!response.ok || payload.data === undefined) {
    throw new Error(
      `${path} failed (${response.status}): ${payload.error?.message ?? JSON.stringify(payload)}`
    );
  }
  return payload.data;
}

async function expectSlippageRefusal(path: string, body: Record<string, unknown>): Promise<void> {
  const response = await api(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
    timeoutMs: 120_000,
  });
  const payload = (await response.json()) as { error?: { details?: { reason?: string } } };
  expect(response.status).toBe(400);
  expect(payload.error?.details?.reason).toBe("slippage_exceeded");
}

async function cheat(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(env.SOLANA_RPC_URL ?? "", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result;
}

async function putForkClockAheadOfLazyClones(): Promise<void> {
  const slot = await cheat("getSlot", [{ commitment: "confirmed" }]);
  if (!Number.isSafeInteger(slot)) throw new Error("Surfnet returned an invalid slot");
  // Remote-mode Surfnet seeds its clock from one upstream RPC request, then
  // clones each protocol account lazily. A load-balanced public endpoint can
  // serve a clone from a node a few slots ahead of that seed; Jupiter Liquidity
  // correctly refuses the resulting future-dated reserve state. Move the fresh
  // fork forward before its first clone so every account is safely in the past.
  await cheat("surfnet_timeTravel", [{ absoluteSlot: Number(slot) + 10_000 }]);
}

async function fundUsdt(owner: string): Promise<void> {
  await cheat("surfnet_setTokenAccount", [
    owner,
    JUPITER_LEND_USDT.assetMint,
    { amount: 100_000_000 },
  ]);
}

async function fundSol(owner: string): Promise<void> {
  await cheat("surfnet_setAccount", [
    owner,
    {
      lamports: 100_000_000,
      owner: "11111111111111111111111111111111",
      data: "",
      executable: false,
      rentEpoch: 0,
    },
  ]);
}

async function position(owner: string) {
  const client = resolveEarnExecutionClient(env, "jupiter_lend", createVaultDeadline());
  if (!client || !supportsVaultDirect(client)) throw new Error("Jupiter Lend execution is absent");
  return (
    await client.readVaultPositions(
      { env, environment: "production" },
      { owner, providerReferences: [JUPITER_LEND_USDT.assetMint] }
    )
  )[0];
}

async function waitForShares(owner: string, expectedZero: boolean) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const current = await position(owner);
    const isZero = !current || current.shares === "0";
    if (isZero === expectedZero) return current;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Timed out waiting for Jupiter Lend shares (${expectedZero ? "zero" : "non-zero"})`
  );
}

async function signBuilt(unsignedBase64: string, keyPair: CryptoKeyPair): Promise<string> {
  const transaction = getTransactionDecoder().decode(
    Uint8Array.from(Buffer.from(unsignedBase64, "base64"))
  );
  const signed = await partiallySignTransaction([keyPair], transaction);
  return Buffer.from(getTransactionEncoder().encode(signed)).toString("base64");
}

describe.skipIf(!ENABLED)("Jupiter Lend USDT through both SDP Earn products", () => {
  let originalMarketsEnabled: string | undefined;
  let originalEarnEnabled: string | undefined;
  let strategyId: string;

  beforeAll(async () => {
    originalMarketsEnabled = env.MARKETS_ENABLED;
    originalEarnEnabled = env.EARN_ENABLED;
    env.MARKETS_ENABLED = "true";
    env.EARN_ENABLED = "true";
    await putForkClockAheadOfLazyClones();
    const { apiKeyHash } = await initIntegrationSuite();
    await getDb(env)
      .prepare("UPDATE projects SET environment = 'production' WHERE id = ?")
      .bind(TEST_PROJECT.id)
      .run();
    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(
        JSON.stringify({
          providerOverrides: { custody: { local: true }, earn: { jupiter_lend: true } },
        }),
        TEST_ORG.id
      )
      .run();
    await createKVStoreSet(env).apiKeys.put(
      `key:${apiKeyHash}`,
      JSON.stringify({ ...TEST_PROJECT_CACHED_KEY, environment: "production" })
    );
    const strategy = await createPostgresEarnRepository(getDb(env)).upsertStrategy({
      provider: "jupiter_lend",
      providerReference: JUPITER_LEND_USDT.assetMint,
      name: "Jupiter Lend USDT",
      sourceKind: "defi",
      underlyingSource: "Jupiter Lend",
      depositMints: [JUPITER_LEND_USDT.assetMint],
      shareMint: JUPITER_LEND_USDT.shareMint,
      apyType: "variable",
      currentApy: null,
      liquidityTerm: "instant",
      redemptionDelayDays: null,
      riskMetadata: { curator: "jupiter" },
      status: "active",
      hostCluster: "mainnet-beta",
      environment: "production",
    });
    if (!strategy) throw new Error("Failed to seed the Jupiter Lend USDT strategy");
    strategyId = strategy.id;
  });

  afterAll(async () => {
    env.MARKETS_ENABLED = originalMarketsEnabled;
    env.EARN_ENABLED = originalEarnEnabled;
    await cleanupIntegrationSuite();
  });

  it("Treasury Solutions custody deposits and withdraws on the mainnet fork", async () => {
    const wallet = await createFundedIntegrationWallet({ label: "Jupiter treasury" });
    await fundUsdt(wallet.publicKey);

    const depositPreview = await post<DepositPreview>("/v1/earn/vault-deposit-previews", {
      strategyId,
      amount: DEPOSIT_AMOUNT,
    });
    expect(depositPreview.blockingIssues).toEqual([]);
    const minSharesOut = floorFromQuote(depositPreview.sharesOut, depositPreview.shareDecimals);

    await expectSlippageRefusal("/v1/earn/vault-deposits", {
      strategyId,
      custodyWalletId: wallet.id,
      amount: DEPOSIT_AMOUNT,
      minSharesOut: "1000000",
    });

    const deposited = await post<EarnVaultDeposit>(
      "/v1/earn/vault-deposits",
      {
        strategyId,
        custodyWalletId: wallet.id,
        amount: DEPOSIT_AMOUNT,
        minSharesOut,
      },
      true
    );
    expect(deposited.signature).toBeTruthy();

    const holding = await waitForShares(wallet.publicKey, false);
    expect(Number(holding?.shares ?? "0")).toBeGreaterThan(0);

    const withdrawalPreview = await post<WithdrawalPreview>("/v1/earn/vault-withdrawal-previews", {
      positionId: deposited.positionId,
      shares: holding?.shares ?? "0",
    });
    expect(withdrawalPreview.blockingIssues).toEqual([]);
    const minAmountOut = floorFromQuote(
      withdrawalPreview.assetsOut,
      withdrawalPreview.assetDecimals
    );

    await expectSlippageRefusal("/v1/earn/vault-withdrawals", {
      positionId: deposited.positionId,
      shares: holding?.shares ?? "0",
      minAmountOut: "1000000",
    });

    const withdrawn = await post<EarnVaultWithdrawalResponse>(
      "/v1/earn/vault-withdrawals",
      {
        positionId: deposited.positionId,
        shares: holding?.shares ?? "0",
        minAmountOut,
      },
      true
    );
    expect(withdrawn.withdrawal.signature).toBeTruthy();
    expect((await waitForShares(wallet.publicKey, true))?.shares ?? "0").toBe("0");
  }, 180_000);

  it("Embedded Yield external-wallet API deposits and withdraws on the mainnet fork", async () => {
    const ownerKeyPair = await generateKeyPair();
    const ownerAddress = await getAddressFromPublicKey(ownerKeyPair.publicKey);
    await fundSol(ownerAddress);
    await fundUsdt(ownerAddress);

    const depositPreview = await post<DepositPreview>("/v1/earn/vault-deposit-previews", {
      strategyId,
      amount: DEPOSIT_AMOUNT,
    });
    expect(depositPreview.blockingIssues).toEqual([]);
    const minSharesOut = floorFromQuote(depositPreview.sharesOut, depositPreview.shareDecimals);

    const depositBuild = await post<EarnExternalWalletDepositTransactionResponse>(
      "/v1/earn/external-wallet/deposit-transactions",
      { strategyId, ownerAddress, amount: DEPOSIT_AMOUNT, minSharesOut }
    );
    const depositResult = await post<EarnExternalWalletDepositResponse>(
      "/v1/earn/external-wallet/deposits",
      {
        transactionId: depositBuild.transaction.transactionId,
        signedTransaction: await signBuilt(depositBuild.transaction.transaction, ownerKeyPair),
      },
      true
    );
    expect(depositResult.deposit.signature).toBeTruthy();

    const holding = await waitForShares(ownerAddress, false);
    expect(Number(holding?.shares ?? "0")).toBeGreaterThan(0);

    const withdrawalPreview = await post<WithdrawalPreview>(
      "/v1/earn/external-wallet/withdrawal-previews",
      { positionId: depositResult.deposit.positionId, shares: holding?.shares ?? "0" }
    );
    expect(withdrawalPreview.blockingIssues).toEqual([]);
    const minAmountOut = floorFromQuote(
      withdrawalPreview.assetsOut,
      withdrawalPreview.assetDecimals
    );

    const withdrawalBuild = await post<EarnExternalWalletWithdrawalTransactionResponse>(
      "/v1/earn/external-wallet/withdrawal-transactions",
      {
        positionId: depositResult.deposit.positionId,
        shares: holding?.shares ?? "0",
        minAmountOut,
      }
    );
    const withdrawalResult = await post<EarnExternalWalletWithdrawalResponse>(
      "/v1/earn/external-wallet/withdrawals",
      {
        transactionId: withdrawalBuild.transaction.transactionId,
        signedTransaction: await signBuilt(withdrawalBuild.transaction.transaction, ownerKeyPair),
      },
      true
    );
    expect(withdrawalResult.withdrawal.signature).toBeTruthy();
    expect((await waitForShares(ownerAddress, true))?.shares ?? "0").toBe("0");
  }, 180_000);
});
