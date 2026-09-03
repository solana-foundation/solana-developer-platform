/**
 * The per-project settlement wallet, against real Postgres.
 *
 * The claim worth proving is UNIQUENESS. Provisioning calls out to a custody
 * provider, which cannot be made atomic with the database write, so two trade
 * creations racing will both mint a wallet. Exactly one must become the
 * project's authority — because the authority is a PDA seed, every trade
 * created under the loser's wallet would be permanently unsettleable.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const provisionApiKeyWallet = vi.hoisted(() => vi.fn());
vi.mock("@/services/api-key-wallet-provisioning.service", () => ({ provisionApiKeyWallet }));

const { getOrCreateDvpSettlementWallet } = await import("./settlement-wallet");

const PROJECT_ID = "prj_dvp_settlement";
const CUSTODY_CONFIG_ID = "cust_dvp_settlement";
const scope = { organizationId: TEST_ORG.id, projectId: PROJECT_ID };

/** Registers a custody wallet the provisioner can pretend it just minted. */
async function seedCustodyWallet(id: string, publicKey: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
       VALUES (?, ?, ?, ?, 'active')`
    )
    .bind(id, CUSTODY_CONFIG_ID, id, publicKey)
    .run();
}

describe("getOrCreateDvpSettlementWallet", () => {
  beforeEach(async () => {
    // reset, not clear: clearAllMocks wipes call history but leaves queued
    // `mockResolvedValueOnce` values, and a leftover one hands the next test a
    // wallet id that test never seeded.
    provisionApiKeyWallet.mockReset();
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
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, TEST_ORG.id, PROJECT_ID, TEST_USER.id)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, provider, config_encrypted, status)
         VALUES (?, ?, 'local', 'x', 'active')`
      )
      .bind(CUSTODY_CONFIG_ID, TEST_ORG.id)
      .run();
  });

  it("provisions a wallet on first use", async () => {
    await seedCustodyWallet("cwlt_first", "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC");
    provisionApiKeyWallet.mockResolvedValue({ id: "cwlt_first", walletId: "provider_first" });

    const wallet = await getOrCreateDvpSettlementWallet(env, scope);

    expect(wallet.custodyWalletId).toBe("cwlt_first");
    expect(provisionApiKeyWallet).toHaveBeenCalledTimes(1);
  });

  it("returns the same wallet on every later call, without provisioning again", async () => {
    await seedCustodyWallet("cwlt_first", "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC");
    provisionApiKeyWallet.mockResolvedValue({ id: "cwlt_first", walletId: "provider_first" });

    const first = await getOrCreateDvpSettlementWallet(env, scope);
    const second = await getOrCreateDvpSettlementWallet(env, scope);

    expect(second).toEqual(first);
    expect(provisionApiKeyWallet).toHaveBeenCalledTimes(1);
  });

  // The address it returns has to be the wallet's real public key: it becomes a
  // PDA seed, so a wrong one derives a trade address nobody can settle.
  it("returns the wallet's on-chain address, not its record id", async () => {
    await seedCustodyWallet("cwlt_first", "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC");
    provisionApiKeyWallet.mockResolvedValue({ id: "cwlt_first", walletId: "provider_first" });

    await getOrCreateDvpSettlementWallet(env, scope);
    const reread = await getOrCreateDvpSettlementWallet(env, scope);

    expect(reread.address).toBe("AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC");
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
      getOrCreateDvpSettlementWallet(env, scope),
      getOrCreateDvpSettlementWallet(env, scope),
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
    await getOrCreateDvpSettlementWallet(env, scope);

    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
      .bind("cwlt_dead")
      .run();

    await seedCustodyWallet("cwlt_new", "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn");
    provisionApiKeyWallet.mockResolvedValue({ id: "cwlt_new", walletId: "provider_new" });

    const replacement = await getOrCreateDvpSettlementWallet(env, scope);

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
});
