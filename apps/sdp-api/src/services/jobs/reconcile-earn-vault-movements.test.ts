import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresEarnVaultRepository } from "@/db/repositories/earn-vault.repository";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const getSignatureStatuses = vi.hoisted(() => vi.fn());
const getBlockHeight = vi.hoisted(() => vi.fn());
const broadcastVaultTransaction = vi.hoisted(() => vi.fn());

vi.mock("@sdp/rpc/solana", () => ({
  createRpc: () => ({ getBlockHeight: () => ({ send: getBlockHeight }) }),
  getSignatureStatuses,
}));
vi.mock("@/services/earn/execution-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/earn/execution-registry")>()),
  assertClusterEndpoint: vi.fn(async () => {}),
  resolveClusterRpcUrl: () => "https://rpc.example.invalid",
}));
vi.mock("@/services/earn/vault-execution.service", () => ({ broadcastVaultTransaction }));

const { reconcileEarnVaultMovements } = await import("./reconcile-earn-vault-movements");

const ORG = "org_vault_reconcile";
const PROJECT = "prj_vault_reconcile";
const USER = "usr_vault_reconcile";
const WALLET = "cwlt_vault_reconcile";

beforeEach(async () => {
  await seedTestDatabase(env);
  vi.clearAllMocks();
  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG, "Vault Reconcile", "vault-reconcile", "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER, "vault-reconcile@example.com"),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Vault Reconcile', 'vault-reconcile', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT, ORG, USER),
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES ('cfg_vault_reconcile', ?, ?, 'privy', 'test', 'active')`
      )
      .bind(ORG, PROJECT),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, 'cfg_vault_reconcile', 'privy_vault_reconcile',
                 '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'active')`
      )
      .bind(WALLET),
  ]);
  broadcastVaultTransaction.mockResolvedValue(undefined);
});

async function seedMovement(lastValidBlockHeight = "100") {
  return createPostgresEarnVaultRepository(getDb(env)).createSignedDepositIntent({
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox",
    provider: "kamino",
    providerReference: `vault_${crypto.randomUUID()}`,
    custodyWalletId: WALLET,
    shareMint: "So11111111111111111111111111111111111111112",
    tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    label: "USDC Vault",
    requestedAmount: "1",
    acceptedAmount: "1",
    signature: `sig_${crypto.randomUUID()}`,
    signedTransaction: Buffer.from([1, 2, 3]).toString("base64"),
    lastValidBlockHeight,
    requestId: crypto.randomUUID(),
    idempotencyFingerprint: crypto.randomUUID(),
  });
}

describe("reconcileEarnVaultMovements", () => {
  it("marks an observed successful signature confirmed", async () => {
    const seeded = await seedMovement();
    getSignatureStatuses.mockResolvedValue([
      { slot: 1n, confirmations: 1n, err: null, confirmationStatus: "confirmed" },
    ]);

    await reconcileEarnVaultMovements(env);

    await expect(
      createPostgresEarnVaultRepository(getDb(env)).getMovementById({
        movementId: seeded.movement.id,
        organizationId: ORG,
      })
    ).resolves.toMatchObject({ status: "confirmed" });
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
  });

  it("fails a missing signature after its recorded blockhash expires", async () => {
    const seeded = await seedMovement("100");
    getSignatureStatuses.mockResolvedValue([null]);
    getBlockHeight.mockResolvedValue(101n);

    await reconcileEarnVaultMovements(env);

    await expect(
      createPostgresEarnVaultRepository(getDb(env)).getMovementById({
        movementId: seeded.movement.id,
        organizationId: ORG,
      })
    ).resolves.toMatchObject({
      status: "failed",
      failure_reason: "Transaction blockhash expired before confirmation",
    });
  });

  it("rebroadcasts the exact recorded bytes while the blockhash is valid", async () => {
    const seeded = await seedMovement("100");
    getSignatureStatuses.mockResolvedValue([null]);
    getBlockHeight.mockResolvedValue(99n);

    await reconcileEarnVaultMovements(env);

    expect(broadcastVaultTransaction).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ bytes: new Uint8Array([1, 2, 3]) })
    );
    await expect(
      createPostgresEarnVaultRepository(getDb(env)).getMovementById({
        movementId: seeded.movement.id,
        organizationId: ORG,
      })
    ).resolves.toMatchObject({ status: "submitted" });
  });
});
