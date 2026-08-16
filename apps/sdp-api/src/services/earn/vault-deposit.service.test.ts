import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresEarnVaultRepository } from "@/db/repositories/earn-vault.repository";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

/**
 * The idempotency contract for a non-custodial vault deposit.
 *
 * Two titles here are named verbatim by
 * `apps/sdp-api/src/security/value-moving-conformance.node.test.ts` as the
 * `earn` family's replay evidence — renaming one fails that test rather than
 * quietly dropping the guarantee it stands for.
 *
 * The chain is stubbed at the module boundary. What is under test is the ORDER
 * and the DECISIONS around the transfer, not the transfer: which row is written
 * before anything is signed, whether a reused key is a replay or a conflict,
 * and whether a mismatch can mutate state before it is refused.
 */

const buildVaultDeposit = vi.hoisted(() => vi.fn());
const signVaultPlan = vi.hoisted(() => vi.fn());
const broadcastVaultTransaction = vi.hoisted(() => vi.fn());
const simulateVaultPlan = vi.hoisted(() => vi.fn());
const createOrgSigner = vi.hoisted(() => vi.fn());

vi.mock("./execution-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./execution-registry")>()),
  resolveVaultDirectClient: () => ({ buildVaultDeposit }),
  resolveClusterRpcUrl: () => "https://rpc.example.invalid",
  assertClusterEndpoint: async () => undefined,
}));

vi.mock("./vault-execution.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vault-execution.service")>()),
  signVaultPlan,
  broadcastVaultTransaction,
  simulateVaultPlan,
}));

vi.mock("@/services/solana", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/solana")>()),
  createOrgSigner,
}));

const { depositIntoVault } = await import("./vault-deposit.service");

const ORG = "org_vault_deposit";
const PROJECT = "prj_vault_deposit";
const USER = "usr_vault_deposit";
const WALLET_ROW_ID = "cwlt_vault_deposit";
const CUSTODY_CONFIG_ID = "cfg_vault_deposit";
const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const VAULT_A = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
const VAULT_B = "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF";

const wallet = {
  id: WALLET_ROW_ID,
  walletId: "privy_vault_deposit",
  publicKey: WALLET_ADDRESS,
} as unknown as CustodyWallet;

function depositInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox" as const,
    provider: "kamino",
    providerReference: VAULT_A,
    wallet,
    amount: "10",
    requestId: "11111111-1111-4111-8111-111111111111",
    userId: USER,
    apiKeyId: null,
    ...overrides,
  };
}

async function seedWallet(): Promise<void> {
  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG, "Vault Deposit Org", "vault-deposit", "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER, "vault-deposit@example.com", 1, "active"),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)`
      )
      .bind(PROJECT, ORG, "Vault Deposit Project", "vault-deposit-project", USER),
    // custody_wallets hangs off a custody_config, not off the org directly.
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'privy', 'test-encrypted', 'active')`
      )
      .bind(CUSTODY_CONFIG_ID, ORG, PROJECT),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(WALLET_ROW_ID, CUSTODY_CONFIG_ID, "privy_vault_deposit", WALLET_ADDRESS),
  ]);
}

beforeEach(async () => {
  await seedTestDatabase(env);
  await seedWallet();
  vi.clearAllMocks();

  buildVaultDeposit.mockResolvedValue({
    cluster: "devnet",
    transactions: [
      [{ programAddress: "11111111111111111111111111111111", accounts: [], data: "" }],
    ],
    lookupTables: [],
    accepted: { amount: "10" },
  });
  simulateVaultPlan.mockResolvedValue({ ok: true });
  createOrgSigner.mockResolvedValue({ address: WALLET_ADDRESS });
  signVaultPlan.mockResolvedValue({ bytes: new Uint8Array([1]), signature: "sig_original" });
  broadcastVaultTransaction.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("depositIntoVault — idempotency", () => {
  it("replays the original vault deposit for the same requestId and payload", async () => {
    const first = await depositIntoVault(env, depositInput());
    expect(first.replayed).toBe(false);

    const second = await depositIntoVault(env, depositInput());

    expect(second.replayed).toBe(true);
    expect(second.movement.id).toBe(first.movement.id);
    expect(second.position.id).toBe(first.position.id);
    // The whole point: a replay must not put a second transfer on the wire.
    expect(signVaultPlan).toHaveBeenCalledTimes(1);
    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
  });

  /**
   * The bug this closes was not just a missing 409. Because the position was
   * claimed BEFORE the movement, a key reused against a different vault opened
   * a real position row for vault B and then answered with vault A's signature.
   */
  it("rejects the same requestId with a different payload", async () => {
    const first = await depositIntoVault(env, depositInput());

    await expect(
      depositIntoVault(env, depositInput({ providerReference: VAULT_B }))
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Nothing was signed or sent for the mismatched request...
    expect(signVaultPlan).toHaveBeenCalledTimes(1);
    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);

    // ...and, critically, no position row was created for the other vault. The
    // refusal has to land BEFORE the claim, or the ledger records a position
    // the caller was never allowed to open.
    const repo = createPostgresEarnVaultRepository(getDb(env));
    const positions = await repo.listPositions({ organizationId: ORG, environment: "sandbox" });
    expect(positions).toHaveLength(1);
    expect(positions[0]?.id).toBe(first.position.id);
    expect(positions[0]?.provider_reference).toBe(VAULT_A);
  });

  it("treats a changed minSharesOut as a different request, not a replay", async () => {
    await depositIntoVault(env, depositInput());

    // The floor is baked into the built instruction, so reusing a key with a
    // weaker one must not silently return the stricter original.
    await expect(depositIntoVault(env, depositInput({ minSharesOut: "1" }))).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("depositIntoVault — recoverability", () => {
  /**
   * Signing determines the signature; broadcasting only publishes it. Recording
   * it first is what makes an ambiguous send reconcilable rather than an
   * untraceable orphan.
   */
  it("records the signature before the transaction is broadcast", async () => {
    const order: string[] = [];
    signVaultPlan.mockImplementation(async () => {
      order.push("sign");
      return { bytes: new Uint8Array([1]), signature: "sig_ordered" };
    });
    broadcastVaultTransaction.mockImplementation(async () => {
      // By the time the bytes are on the wire the row must already name them.
      const repo = createPostgresEarnVaultRepository(getDb(env));
      const rows = await repo.listMovements({ organizationId: ORG, positionId: positionId ?? "" });
      order.push(rows[0]?.signature === "sig_ordered" ? "recorded-before-send" : "not-recorded");
    });

    let positionId: string | undefined;
    buildVaultDeposit.mockImplementation(async () => {
      const repo = createPostgresEarnVaultRepository(getDb(env));
      const positions = await repo.listPositions({ organizationId: ORG, environment: "sandbox" });
      positionId = positions[0]?.id;
      return {
        cluster: "devnet",
        transactions: [
          [{ programAddress: "11111111111111111111111111111111", accounts: [], data: "" }],
        ],
        lookupTables: [],
        accepted: { amount: "10" },
      };
    });

    await depositIntoVault(env, depositInput());

    expect(order).toEqual(["sign", "recorded-before-send"]);
  });

  /**
   * A send error does NOT prove the transaction failed — it may have landed and
   * the response been lost. Marking it `failed` would assert that no money
   * moved, which is precisely the claim that cannot be made.
   */
  it("leaves an ambiguous broadcast reconcilable instead of marking it failed", async () => {
    broadcastVaultTransaction.mockRejectedValue(new Error("socket hang up"));

    const result = await depositIntoVault(env, depositInput());

    expect(result.movement.status).not.toBe("failed");
    expect(result.movement.signature).toBe("sig_original");
  });

  it("marks a pre-signature failure as failed, because nothing reached the chain", async () => {
    simulateVaultPlan.mockResolvedValue({ ok: false, error: "custom program error", logs: [] });

    const result = await depositIntoVault(env, depositInput());

    expect(result.movement.status).toBe("failed");
    expect(result.movement.signature).toBeNull();
    expect(signVaultPlan).not.toHaveBeenCalled();
  });
});
