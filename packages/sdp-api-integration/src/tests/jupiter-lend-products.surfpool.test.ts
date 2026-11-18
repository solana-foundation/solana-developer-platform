import { apiTestSupport } from "@sdp/api/test-support";
import type { EarnCorePosition, EarnPositionsResponse } from "@sdp/types/earn-core";
import { JUPITER_LEND_USDT } from "@sdp/types/jupiter-lend-programs";
import type { Operation, OperationResponse, OperationSource } from "@sdp/types/operations";
import {
  address,
  generateKeyPair,
  getAddressFromPublicKey,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  cleanupIntegrationSuite,
  createFundedIntegrationWallet,
  initIntegrationSuite,
  requestWithApiKey,
  TEST_ORG,
  TEST_PROJECT,
} from "#/helpers/integration";
import { env } from "#env-impl";

const {
  createPostgresEarnRepository,
  findAssociatedTokenPda,
  getDb,
  runEarnWorkers,
  TOKEN_PROGRAM_ADDRESS,
} = apiTestSupport;

const ENABLED = process.env.JUPITER_LEND_SURFPOOL_E2E === "true";
const DEPOSIT_AMOUNT = "5";
const SLIPPAGE_TOLERANCE_BPS = 10;
const api = requestWithApiKey();

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

function floorFromQuote(value: string): string {
  const floor =
    (decimalAtoms(value, JUPITER_LEND_USDT.decimals) * BigInt(10_000 - SLIPPAGE_TOLERANCE_BPS)) /
    10_000n;
  if (floor <= 0n) throw new Error("Jupiter Lend quote is too small for a positive slippage floor");
  return decimalFromAtoms(floor, JUPITER_LEND_USDT.decimals);
}

async function requestData<T>(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const response = await api(path, {
    method,
    headers:
      method === "POST"
        ? { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }
        : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: 120_000,
  });
  const payload = (await response.json()) as { data?: T; error?: { message?: string } };
  if (!response.ok || payload.data === undefined) {
    throw new Error(
      `${path} failed (${response.status}): ${payload.error?.message ?? JSON.stringify(payload)}`
    );
  }
  expect(response.status).toBe(method === "POST" ? 202 : 200);
  return payload.data;
}

async function expectSlippageRefusal(path: string, body: Record<string, unknown>): Promise<void> {
  const response = await api(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ ...body, slippageBps: 501 }),
    timeoutMs: 120_000,
  });
  expect(response.status).toBe(400);
}

async function cheat(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(env.SOLANA_RPC_URL ?? "", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method} failed (${response.status})`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result;
}

async function putForkClockAheadOfLazyClones(): Promise<void> {
  const slot = await cheat("getSlot", [{ commitment: "confirmed" }]);
  if (!Number.isSafeInteger(slot)) throw new Error("Surfnet returned an invalid slot");
  // A lazy account clone can arrive from an upstream node ahead of the fork's
  // seed clock. Move the fresh fork forward before cloning Jupiter reserves.
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

async function usdtBalance(owner: string): Promise<bigint> {
  const [account] = await findAssociatedTokenPda({
    owner: address(owner),
    mint: address(JUPITER_LEND_USDT.assetMint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const balance = z
    .object({ value: z.object({ amount: z.string().regex(/^\d+$/) }) })
    .parse(await cheat("getTokenAccountBalance", [account, { commitment: "finalized" }]));
  return BigInt(balance.value.amount);
}

async function position(source: OperationSource): Promise<EarnCorePosition | undefined> {
  const query = new URLSearchParams(source);
  const page = await requestData<EarnPositionsResponse>("GET", `/v1/earn/positions?${query}`);
  return page.positions.find(
    (holding) =>
      holding.provider === "jupiter_lend" &&
      holding.providerReference === JUPITER_LEND_USDT.assetMint
  );
}

async function waitForShares(source: OperationSource, expectedZero: boolean) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const current = await position(source);
    if (current === undefined || current.shares !== undefined) {
      const isZero = current === undefined || current.shares === "0";
      if (isZero === expectedZero) return current;
    }
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

function expectProtectedTerms(operation: Operation, outputMint: string) {
  expect(operation.status).toBe("prepared");
  expect(operation.resourceRef).toBeNull();
  expect(operation.result).toBeNull();
  const { estimate, minimum } = operation.terms;
  if (estimate === null || minimum === null)
    throw new Error("Jupiter Lend omitted protected terms");
  expect(estimate.mint).toBe(outputMint);
  expect(minimum).toEqual({ mint: outputMint, value: floorFromQuote(estimate.value) });
}

async function submitAndSettle(operation: Operation, keyPair?: CryptoKeyPair): Promise<Operation> {
  const action = operation.nextAction;
  if (action?.type !== "submit" && action?.type !== "sign_transaction") {
    throw new Error(`Unexpected Jupiter Lend next action: ${action?.type}`);
  }
  if (action.type === "sign_transaction" && keyPair === undefined) {
    throw new Error("The owner must sign the reviewed Jupiter Lend transaction");
  }
  const signedTransaction =
    action.type === "sign_transaction" && keyPair !== undefined
      ? await signBuilt(action.transaction, keyPair)
      : undefined;
  const accepted = await requestData<OperationResponse>(
    "POST",
    `/v1/operations/${operation.id}/submit`,
    { actionId: operation.actionId, version: operation.version, signedTransaction }
  );
  expect(accepted.operation.status).toBe("queued");
  expect(accepted.operation.resourceRef).toBeNull();
  expect(accepted.operation.result).toBeNull();
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    await runEarnWorkers(env, "production");
    const { operation: current } = await requestData<OperationResponse>(
      "GET",
      `/v1/operations/${operation.id}`
    );
    if (current.status === "failed" || current.status === "cancelled") {
      throw new Error(`Jupiter Lend operation ended ${current.status}: ${current.error?.message}`);
    }
    if (current.status === "completed") {
      expect(current.result?.signature).toBeTruthy();
      expect(current.result?.settlementOutcome).toBe("delivered");
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out settling Jupiter Lend operation ${operation.id}`);
}

async function roundTrip(
  strategyId: string,
  source: OperationSource,
  owner: string,
  keyPair?: CryptoKeyPair
) {
  const beforeDeposit = await usdtBalance(owner);
  const depositBody = {
    strategyId,
    source,
    amount: { mint: JUPITER_LEND_USDT.assetMint, value: DEPOSIT_AMOUNT },
  };
  await expectSlippageRefusal("/v1/earn/deposit", depositBody);
  const { operation: deposit } = await requestData<OperationResponse>("POST", "/v1/earn/deposit", {
    ...depositBody,
    slippageBps: SLIPPAGE_TOLERANCE_BPS,
  });
  expectProtectedTerms(deposit, JUPITER_LEND_USDT.shareMint);
  expect(deposit.nextAction?.type).toBe("walletId" in source ? "submit" : "sign_transaction");
  const deposited = await submitAndSettle(deposit, keyPair);
  expect(deposited.result?.source).toEqual(source);
  const holding = await waitForShares(source, false);
  if (holding === undefined || holding.shares === undefined)
    throw new Error("Jupiter Lend holding is unavailable");
  expect(holding.source).toEqual(source);
  expect(deposited.result?.positionId).toBe(holding.id);
  expect(decimalAtoms(holding.shares, JUPITER_LEND_USDT.decimals)).toBeGreaterThan(0n);
  const afterDeposit = await usdtBalance(owner);
  expect(beforeDeposit - afterDeposit).toBe(
    decimalAtoms(DEPOSIT_AMOUNT, JUPITER_LEND_USDT.decimals)
  );

  const withdrawalBody = { positionId: holding.id, amount: { kind: "all" } };
  await expectSlippageRefusal("/v1/earn/withdraw", withdrawalBody);
  const { operation: withdrawal } = await requestData<OperationResponse>(
    "POST",
    "/v1/earn/withdraw",
    {
      ...withdrawalBody,
      slippageBps: SLIPPAGE_TOLERANCE_BPS,
    }
  );
  expectProtectedTerms(withdrawal, JUPITER_LEND_USDT.assetMint);
  const withdrawn = await submitAndSettle(withdrawal, keyPair);
  expect(withdrawn.result?.source).toEqual(source);
  expect(withdrawn.result?.positionId).toBe(holding.id);
  expect((await waitForShares(source, true))?.shares ?? "0").toBe("0");
  const minimum = withdrawal.terms.minimum;
  if (minimum === null) throw new Error("Jupiter Lend withdrawal omitted its output floor");
  expect((await usdtBalance(owner)) - afterDeposit).toBeGreaterThanOrEqual(
    decimalAtoms(minimum.value, JUPITER_LEND_USDT.decimals)
  );
}

describe.skipIf(!ENABLED)("Jupiter Lend USDT through core Earn operations", () => {
  let strategyId: string;

  beforeAll(async () => {
    await putForkClockAheadOfLazyClones();
    await initIntegrationSuite();
    await getDb(env)
      .prepare("UPDATE projects SET environment = 'production' WHERE id = ?")
      .bind(TEST_PROJECT.id)
      .run();
    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(
        JSON.stringify({
          enableProductionProject: true,
          providerOverrides: { custody: { local: true }, earn: { jupiter_lend: true } },
        }),
        TEST_ORG.id
      )
      .run();
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
    await cleanupIntegrationSuite();
  });

  it("signs walletId deposits and full exits in the worker on the mainnet fork", async () => {
    const wallet = await createFundedIntegrationWallet({ label: "Jupiter Earn" });
    await fundUsdt(wallet.publicKey);
    await roundTrip(strategyId, { walletId: wallet.id }, wallet.publicKey);
  }, 240_000);

  it("accepts ownerAddress signatures and settles both actions on the mainnet fork", async () => {
    const ownerKeyPair = await generateKeyPair();
    const ownerAddress = await getAddressFromPublicKey(ownerKeyPair.publicKey);
    await fundSol(ownerAddress);
    await fundUsdt(ownerAddress);
    await roundTrip(strategyId, { ownerAddress }, ownerAddress, ownerKeyPair);
  }, 240_000);
});
