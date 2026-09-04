import { apiTestSupport } from "@sdp/api/test-support";
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
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
} from "../helpers/integration";

const {
  buildExternalWalletDepositTransaction,
  buildExternalWalletWithdrawalTransaction,
  createVaultDeadline,
  depositIntoVault,
  getDb,
  resolveEarnExecutionClient,
  submitExternalWalletDeposit,
  submitExternalWalletWithdrawal,
  supportsVaultDirect,
  withdrawFromVault,
} = apiTestSupport;

const ENABLED = process.env.JUPITER_LEND_SURFPOOL_E2E === "true";
const DEPOSIT_AMOUNT = "5";

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
  beforeAll(async () => {
    await putForkClockAheadOfLazyClones();
    await initIntegrationSuite();
    await getDb(env)
      .prepare("UPDATE projects SET environment = 'production' WHERE id = ?")
      .bind(TEST_PROJECT.id)
      .run();
  });

  afterAll(async () => cleanupIntegrationSuite());

  it("Treasury Solutions custody deposits and withdraws on the mainnet fork", async () => {
    const wallet = await createFundedIntegrationWallet({ label: "Jupiter treasury" });
    await fundUsdt(wallet.publicKey);

    const deposited = await depositIntoVault(env, {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      environment: "production",
      provider: "jupiter_lend",
      providerReference: JUPITER_LEND_USDT.assetMint,
      wallet: { id: wallet.id, walletId: wallet.walletId, publicKey: wallet.publicKey },
      tokenMint: JUPITER_LEND_USDT.assetMint,
      shareMint: JUPITER_LEND_USDT.shareMint,
      label: "Jupiter Lend USDT",
      amount: DEPOSIT_AMOUNT,
      requestId: crypto.randomUUID(),
      userId: TEST_USER.id,
    });
    expect(deposited.movement.signature).toBeTruthy();

    const holding = await waitForShares(wallet.publicKey, false);
    expect(Number(holding?.shares ?? "0")).toBeGreaterThan(0);

    const withdrawn = await withdrawFromVault(env, {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      environment: "production",
      provider: "jupiter_lend",
      positionId: deposited.position.id,
      vaultAddress: JUPITER_LEND_USDT.assetMint,
      tokenMint: JUPITER_LEND_USDT.assetMint,
      shareMint: JUPITER_LEND_USDT.shareMint,
      wallet: { id: wallet.id, walletId: wallet.walletId, publicKey: wallet.publicKey },
      shares: holding?.shares ?? "0",
      requestId: crypto.randomUUID(),
      userId: TEST_USER.id,
    });
    expect(withdrawn.movement.signature).toBeTruthy();
    expect((await waitForShares(wallet.publicKey, true))?.shares ?? "0").toBe("0");
  }, 180_000);

  it("Embedded Yield external-wallet build/submit deposits and withdraws", async () => {
    const ownerKeyPair = await generateKeyPair();
    const ownerAddress = await getAddressFromPublicKey(ownerKeyPair.publicKey);
    await fundSol(ownerAddress);
    await fundUsdt(ownerAddress);

    const depositBuild = await buildExternalWalletDepositTransaction(env, {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      environment: "production",
      provider: "jupiter_lend",
      providerReference: JUPITER_LEND_USDT.assetMint,
      ownerAddress,
      tokenMint: JUPITER_LEND_USDT.assetMint,
      shareMint: JUPITER_LEND_USDT.shareMint,
      label: "Jupiter Lend USDT",
      amount: DEPOSIT_AMOUNT,
      userId: TEST_USER.id,
    });
    expect(depositBuild.kind).toBe("built");
    if (depositBuild.kind !== "built") throw new Error("Unexpected split swap build");
    const depositResult = await submitExternalWalletDeposit(env, {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      environment: "production",
      transactionId: depositBuild.built.id,
      signedTransaction: await signBuilt(depositBuild.built.unsigned_transaction, ownerKeyPair),
      requestId: crypto.randomUUID(),
      userId: TEST_USER.id,
    });
    expect(depositResult.movement.signature).toBeTruthy();

    const holding = await waitForShares(ownerAddress, false);
    expect(Number(holding?.shares ?? "0")).toBeGreaterThan(0);

    const withdrawalBuild = await buildExternalWalletWithdrawalTransaction(env, {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      environment: "production",
      provider: "jupiter_lend",
      positionId: depositResult.position.id,
      vaultAddress: JUPITER_LEND_USDT.assetMint,
      tokenMint: JUPITER_LEND_USDT.assetMint,
      shareMint: JUPITER_LEND_USDT.shareMint,
      ownerAddress,
      label: "Jupiter Lend USDT",
      shareAtaRentFunder: depositResult.position.share_ata_rent_funder,
      shares: holding?.shares ?? "0",
      userId: TEST_USER.id,
    });
    const withdrawalResult = await submitExternalWalletWithdrawal(env, {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      environment: "production",
      transactionId: withdrawalBuild.id,
      signedTransaction: await signBuilt(withdrawalBuild.unsigned_transaction, ownerKeyPair),
      requestId: crypto.randomUUID(),
      userId: TEST_USER.id,
    });
    expect(withdrawalResult.movement.signature).toBeTruthy();
    expect((await waitForShares(ownerAddress, true))?.shares ?? "0").toBe("0");
  }, 180_000);
});
