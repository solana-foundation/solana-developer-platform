/**
 * The per-project settlement wallet, against real Postgres.
 *
 * The claim worth proving is UNIQUENESS. Provisioning calls out to a custody
 * provider, which cannot be made atomic with the database write, so two trade
 * creations racing will both mint a wallet. Exactly one must become the
 * project's authority — because the authority is a PDA seed, every trade
 * created under the loser's wallet would be permanently unsettleable.
 */

import { Context } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import {
  insertTestCustodyConfigRow,
  insertTestCustodyWalletRow,
  type TestCustodyWalletOwner,
} from "@/test/helpers/custody";
import { seedTestPrivyConnection } from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";

type ProvisionApiKeyWallet =
  typeof import("@/services/api-key-wallet-provisioning.service").provisionApiKeyWallet;

const provisionApiKeyWallet = vi.hoisted(() => vi.fn<ProvisionApiKeyWallet>());
vi.mock("@/services/api-key-wallet-provisioning.service", () => ({ provisionApiKeyWallet }));

const { getOrCreateDvpSettlementWallet } = await import("./settlement-wallet");

const auditContext = new Context<{ Bindings: Env }>(new Request("http://localhost/dvp"), { env });

const PROJECT_ID = "prj_dvp_settlement";
const PRODUCTION_PROJECT_ID = `${PROJECT_ID}_production`;
const CUSTODY_CONFIG_ID = "cust_dvp_settlement";
const scope = { organizationId: TEST_ORG.id, projectId: PROJECT_ID };
const productionScope = { organizationId: TEST_ORG.id, projectId: PRODUCTION_PROJECT_ID };

const ADDRESSES = {
  first: "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC",
  second: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
  third: "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg",
  settlement: "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU",
} as const;

async function resetTenant(): Promise<void> {
  await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  const db = getDb(env);
  await db.prepare("DELETE FROM dvp_settlement_wallets").run();
  await db.prepare("DELETE FROM custody_wallets").run();
  await db.prepare("DELETE FROM custody_configs").run();
  await db.prepare("DELETE FROM projects").run();
  await db
    .prepare(
      "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
    )
    .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
    .run();
  await db
    .prepare(
      "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
    )
    .bind(TEST_USER.id, TEST_USER.email)
    .run();
  await seedDefaultProjects(db, {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [],
    ids: { sandbox: PROJECT_ID, production: PRODUCTION_PROJECT_ID },
  });
}

/** Registers a custody wallet the provisioner can pretend it just minted. */
/**
 * Seeds a wallet whose THREE identifiers are all different.
 *
 * Deliberate: `id` (cwlt_...), `wallet_id` (the provider's) and `public_key`
 * are distinct things that a caller can confuse for one another, and a fixture
 * that sets them equal cannot catch that confusion. One did exactly that, and
 * a candidate passing the address where the provider id belonged went unnoticed
 * until it failed against a real project.
 */
async function seedCustodyWallet(id: string, publicKey: string): Promise<void> {
  await insertTestCustodyWalletRow(getDb(env), {
    id,
    owner: { kind: "config", custodyConfigId: CUSTODY_CONFIG_ID },
    walletId: `provider_${id}`,
    publicKey,
    label: null,
    purpose: null,
    status: "active",
  });
}

describe("getOrCreateDvpSettlementWallet", () => {
  beforeEach(async () => {
    provisionApiKeyWallet.mockReset();
    await resetTenant();
    await insertTestCustodyConfigRow(getDb(env), {
      id: CUSTODY_CONFIG_ID,
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      provider: "privy",
      configEncrypted: "x",
      status: "active",
    });
  });

  it("provisions a wallet on first use", async () => {
    await seedCustodyWallet("cwlt_first", "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC");
    provisionApiKeyWallet.mockResolvedValue({ id: "cwlt_first", walletId: "provider_first" });

    const wallet = await getOrCreateDvpSettlementWallet(env, auditContext, scope);

    expect(wallet.custodyWalletId).toBe("cwlt_first");
    expect(provisionApiKeyWallet).toHaveBeenCalledTimes(1);
  });

  it("returns the same wallet on every later call, without provisioning again", async () => {
    await seedCustodyWallet("cwlt_first", "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC");
    provisionApiKeyWallet.mockResolvedValue({ id: "cwlt_first", walletId: "provider_first" });

    const first = await getOrCreateDvpSettlementWallet(env, auditContext, scope);
    const second = await getOrCreateDvpSettlementWallet(env, auditContext, scope);

    expect(second).toEqual(first);
    expect(provisionApiKeyWallet).toHaveBeenCalledTimes(1);
  });

  // The address it returns has to be the wallet's real public key: it becomes a
  // PDA seed, so a wrong one derives a trade address nobody can settle.
  it("returns the wallet's on-chain address, not its record id", async () => {
    await seedCustodyWallet("cwlt_first", "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC");
    provisionApiKeyWallet.mockResolvedValue({ id: "cwlt_first", walletId: "provider_first" });

    await getOrCreateDvpSettlementWallet(env, auditContext, scope);
    const reread = await getOrCreateDvpSettlementWallet(env, auditContext, scope);

    expect(reread.address).toBe("AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC");
    // All three identifiers are distinct.
    expect(reread.custodyWalletId).toBe("cwlt_first");
    expect(reread.providerWalletId).toBe("provider_cwlt_first");
  });

  // The race. Both callers mint a wallet; the database decides which one is the
  // project's authority, and the loser returns the winner rather than its own.
  it("gives concurrent callers the same wallet", async () => {
    await seedCustodyWallet("cwlt_a", "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC");
    await seedCustodyWallet("cwlt_b", "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn");
    provisionApiKeyWallet
      .mockResolvedValueOnce({ id: "cwlt_a", walletId: "provider_a" })
      .mockResolvedValueOnce({ id: "cwlt_b", walletId: "provider_b" });

    const [first, second] = await Promise.all([
      getOrCreateDvpSettlementWallet(env, auditContext, scope),
      getOrCreateDvpSettlementWallet(env, auditContext, scope),
    ]);

    expect(first.custodyWalletId).toBe(second.custodyWalletId);

    // And the database holds exactly one mapping, not two.
    const rows = await getDb(env)
      .prepare("SELECT custody_wallet_id FROM dvp_settlement_wallets WHERE project_id = ?")
      .bind(PROJECT_ID)
      .all<{ custody_wallet_id: string }>();
    expect(rows.results).toHaveLength(1);
  });

  // A deactivated settlement wallet cannot sign, so returning it would produce
  // trades that are born unsettleable. It is replaced so new trades can still
  // be created — but only trades created AFTER the swap can be settled, because
  // the old authority is baked into the older trades' addresses.
  it("replaces a deactivated settlement wallet", async () => {
    await seedCustodyWallet("cwlt_dead", "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC");
    provisionApiKeyWallet.mockResolvedValue({ id: "cwlt_dead", walletId: "provider_dead" });
    await getOrCreateDvpSettlementWallet(env, auditContext, scope);

    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
      .bind("cwlt_dead")
      .run();

    await seedCustodyWallet("cwlt_new", "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn");
    provisionApiKeyWallet.mockResolvedValue({ id: "cwlt_new", walletId: "provider_new" });

    const replacement = await getOrCreateDvpSettlementWallet(env, auditContext, scope);

    expect(replacement.custodyWalletId).toBe("cwlt_new");
    expect(replacement.address).toBe("5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn");
    expect(provisionApiKeyWallet).toHaveBeenCalledTimes(2);

    // Still exactly one mapping — replaced, not duplicated.
    const rows = await getDb(env)
      .prepare("SELECT custody_wallet_id FROM dvp_settlement_wallets WHERE project_id = ?")
      .bind(PROJECT_ID)
      .all<{ custody_wallet_id: string }>();
    expect(rows.results.map((r) => r.custody_wallet_id)).toEqual(["cwlt_new"]);
  });

  // The authority is not an ordinary transfer wallet: it holds the only key
  // that can close any trade in the project and is a PDA seed on every one of
  // them. Marking it lets the wallets list say so.
  it("marks the wallet as a settlement authority, not a transfer wallet", async () => {
    await seedCustodyWallet("cwlt_first", "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC");
    provisionApiKeyWallet.mockResolvedValue({ id: "cwlt_first", walletId: "provider_first" });

    await getOrCreateDvpSettlementWallet(env, auditContext, scope);

    expect(provisionApiKeyWallet).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ purpose: "dvp_settlement_authority" })
    );
  });
});

describe("DvP settlement owner", () => {
  beforeEach(async () => {
    provisionApiKeyWallet.mockReset();
    await resetTenant();
  });

  async function seedManagedConfig(params: {
    id: string;
    projectId: string;
    provider: "privy" | "local";
    status: "active" | "inactive";
  }): Promise<void> {
    await insertTestCustodyConfigRow(getDb(env), {
      ...params,
      organizationId: TEST_ORG.id,
      configEncrypted: "x",
    });
  }

  async function seedPrivyConnection(params: {
    connectionId: string;
    projectId: string;
    publicKey: string;
    lastCheckStatus: "success" | "retry_unknown";
  }): Promise<void> {
    const walletRecordId = `cwlt_${params.connectionId}`;
    const shared = {
      organizationId: TEST_ORG.id,
      projectId: params.projectId,
      connectionId: params.connectionId,
      credentialId: `pcred_${params.connectionId}`,
      createdBy: TEST_USER.id,
      stored: { storageBackend: "encrypted_db" as const, encryptedSecretPayload: "ciphertext" },
      providerAccountFingerprint: `sha256:${params.connectionId}`,
      wallets: [
        {
          id: walletRecordId,
          walletId: `privy_${params.connectionId}`,
          publicKey: params.publicKey,
          label: null,
          purpose: null,
          status: "active" as const,
        },
      ],
    };
    await getDb(env).transaction(async (tx) => {
      if (params.lastCheckStatus === "success") {
        await seedTestPrivyConnection(tx, {
          ...shared,
          lastCheckStatus: "success",
          defaultCustodyWalletId: walletRecordId,
        });
      } else {
        await seedTestPrivyConnection(tx, { ...shared, lastCheckStatus: "retry_unknown" });
      }
    });
  }

  function provisionUnder(owner: TestCustodyWalletOwner): void {
    provisionApiKeyWallet.mockImplementation(async () => {
      await insertTestCustodyWalletRow(getDb(env), {
        id: "cwlt_settlement_new",
        owner,
        walletId: "privy_settlement_new",
        publicKey: ADDRESSES.settlement,
        label: "DvP settlement authority",
        purpose: "dvp_settlement_authority",
        status: "active",
      });
      return { id: "cwlt_settlement_new", walletId: "privy_settlement_new" };
    });
  }

  async function custodyWalletIds(): Promise<string[]> {
    const rows = await getDb(env).queryMany<{ id: string }>(
      "SELECT id FROM custody_wallets ORDER BY id"
    );
    return rows.map((row) => row.id);
  }

  async function expectSettlementMapped(projectId: string): Promise<void> {
    expect(
      await getDb(env).queryMany(
        "SELECT project_id, custody_wallet_id FROM dvp_settlement_wallets ORDER BY project_id"
      )
    ).toEqual([{ project_id: projectId, custody_wallet_id: "cwlt_settlement_new" }]);
  }

  async function expectRefusedWithoutSpend(target: typeof scope, message: string): Promise<void> {
    const walletsBefore = await custodyWalletIds();

    await expect(getOrCreateDvpSettlementWallet(env, auditContext, target)).rejects.toMatchObject({
      code: "CONFLICT",
      statusCode: 409,
      message,
      details: { reason: "dvp_settlement_privy_unavailable" },
    });

    expect(provisionApiKeyWallet).not.toHaveBeenCalled();
    expect(await custodyWalletIds()).toEqual(walletsBefore);
    expect(await getDb(env).queryMany("SELECT project_id FROM dvp_settlement_wallets")).toEqual([]);
  }

  it("creates a Production settlement wallet under the project's one active Privy connection", async () => {
    await seedPrivyConnection({
      connectionId: "cconn_dvp_production",
      projectId: PRODUCTION_PROJECT_ID,
      publicKey: ADDRESSES.first,
      lastCheckStatus: "success",
    });
    provisionUnder({ kind: "connection", custodyConnectionId: "cconn_dvp_production" });

    const wallet = await getOrCreateDvpSettlementWallet(env, auditContext, productionScope);

    expect(wallet).toEqual({
      custodyWalletId: "cwlt_settlement_new",
      address: ADDRESSES.settlement,
      providerWalletId: "privy_settlement_new",
    });
    expect(provisionApiKeyWallet).toHaveBeenCalledOnce();
    expect(provisionApiKeyWallet).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        organizationId: TEST_ORG.id,
        projectId: PRODUCTION_PROJECT_ID,
        owner: { connectionId: "cconn_dvp_production" },
      })
    );
    await expectSettlementMapped(PRODUCTION_PROJECT_ID);
  });

  it("refuses a Production project whose only Privy backend is Managed", async () => {
    await seedManagedConfig({
      id: "cust_dvp_production_privy",
      projectId: PRODUCTION_PROJECT_ID,
      provider: "privy",
      status: "active",
    });

    await expectRefusedWithoutSpend(
      productionScope,
      "DvP settlement needs a Privy custody backend for this project"
    );
  });

  it("creates a Sandbox settlement wallet under Managed Privy even when a Privy connection is active", async () => {
    await seedManagedConfig({
      id: CUSTODY_CONFIG_ID,
      projectId: PROJECT_ID,
      provider: "privy",
      status: "active",
    });
    await seedPrivyConnection({
      connectionId: "cconn_dvp_sandbox",
      projectId: PROJECT_ID,
      publicKey: ADDRESSES.first,
      lastCheckStatus: "success",
    });
    provisionUnder({ kind: "config", custodyConfigId: CUSTODY_CONFIG_ID });

    const wallet = await getOrCreateDvpSettlementWallet(env, auditContext, scope);

    expect(wallet.custodyWalletId).toBe("cwlt_settlement_new");
    expect(provisionApiKeyWallet).toHaveBeenCalledOnce();
    expect(provisionApiKeyWallet).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ projectId: PROJECT_ID, owner: { provider: "privy" } })
    );
    await expectSettlementMapped(PROJECT_ID);
  });

  it("creates a Sandbox settlement wallet under the one active Privy connection when there is no Managed Privy", async () => {
    await seedPrivyConnection({
      connectionId: "cconn_dvp_sandbox",
      projectId: PROJECT_ID,
      publicKey: ADDRESSES.first,
      lastCheckStatus: "success",
    });
    provisionUnder({ kind: "connection", custodyConnectionId: "cconn_dvp_sandbox" });

    const wallet = await getOrCreateDvpSettlementWallet(env, auditContext, scope);

    expect(wallet.custodyWalletId).toBe("cwlt_settlement_new");
    expect(provisionApiKeyWallet).toHaveBeenCalledOnce();
    expect(provisionApiKeyWallet).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        projectId: PROJECT_ID,
        owner: { connectionId: "cconn_dvp_sandbox" },
      })
    );
    await expectSettlementMapped(PROJECT_ID);
  });

  it.each([
    { environment: "sandbox", target: scope },
    { environment: "production", target: productionScope },
  ])(
    "refuses a $environment project with two active Privy connections and no Managed Privy",
    async ({ target }) => {
      await seedPrivyConnection({
        connectionId: "cconn_dvp_one",
        projectId: target.projectId,
        publicKey: ADDRESSES.first,
        lastCheckStatus: "success",
      });
      await seedPrivyConnection({
        connectionId: "cconn_dvp_two",
        projectId: target.projectId,
        publicKey: ADDRESSES.second,
        lastCheckStatus: "success",
      });

      await expectRefusedWithoutSpend(
        target,
        "DvP settlement needs exactly one active Privy connection for this project"
      );
    }
  );

  it("refuses a project with no active Privy backend", async () => {
    await seedManagedConfig({
      id: "cust_dvp_local",
      projectId: PROJECT_ID,
      provider: "local",
      status: "active",
    });
    await seedManagedConfig({
      id: "cust_dvp_inactive_privy",
      projectId: PROJECT_ID,
      provider: "privy",
      status: "inactive",
    });
    await seedPrivyConnection({
      connectionId: "cconn_dvp_pending",
      projectId: PROJECT_ID,
      publicKey: ADDRESSES.third,
      lastCheckStatus: "retry_unknown",
    });

    await expectRefusedWithoutSpend(
      scope,
      "DvP settlement needs a Privy custody backend for this project"
    );
  });
});
