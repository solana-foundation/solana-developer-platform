import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

/**
 * Regression tests for the last-wallet guard on custody-wallet deactivation
 * (Apex SOLA9-145): two concurrent authorized deletes must never both pass the
 * guard and zero out a custody configuration's active wallets.
 *
 * The concurrency case drives the production store against real PostgreSQL
 * with repeated trials so the statement-snapshot race is observable without
 * stubbing the database.
 */

async function seedCustodyConfig(configId: string, slug: string, walletIds: [string, string]) {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, ?, ?, 'enterprise', 'active')`
      )
      .bind(`org_${configId}`, "Custody guard org", slug),
    db
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, provider, config_encrypted, default_wallet_id, status)
         VALUES (?, ?, 'anchorage', 'test-config', ?, 'active')`
      )
      .bind(configId, `org_${configId}`, walletIds[0]),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, '11111111111111111111111111111111', 'active')`
      )
      .bind(`row_${configId}_a`, configId, walletIds[0]),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, '11111111111111111111111111111111', 'active')`
      )
      .bind(`row_${configId}_b`, configId, walletIds[1]),
  ]);
}

async function countActiveWallets(configId: string): Promise<number> {
  const row = await getDb(env)
    .prepare(
      `SELECT COUNT(*) AS count
       FROM custody_wallets
       WHERE custody_config_id = ? AND status = 'active'`
    )
    .bind(configId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

describe("CustodyConfigStore deactivateWalletIfNotLast", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
  });

  it("deactivates one of two wallets and rejects the second (sequential control)", async () => {
    const store = new CustodyConfigStore(getDb(env), env);
    await seedCustodyConfig("cfg_seq_control", "custody-guard-seq", ["wal_seq_a", "wal_seq_b"]);

    expect(await store.deactivateWalletIfNotLast("cfg_seq_control", "wal_seq_a")).toBe(
      "deactivated"
    );
    expect(await store.deactivateWalletIfNotLast("cfg_seq_control", "wal_seq_b")).toBe(
      "last_wallet"
    );

    expect(await countActiveWallets("cfg_seq_control")).toBe(1);

    const survivor = await getDb(env)
      .prepare(
        `SELECT wallet_id, status FROM custody_wallets
         WHERE custody_config_id = 'cfg_seq_control' AND status = 'active'`
      )
      .first<{ wallet_id: string; status: string }>();
    expect(survivor?.wallet_id).toBe("wal_seq_b");
  });

  it("refuses to deactivate the only active wallet", async () => {
    const db = getDb(env);
    const store = new CustodyConfigStore(db, env);
    await seedCustodyConfig("cfg_single_wallet", "custody-guard-single", [
      "wal_only",
      "wal_already_gone",
    ]);
    await db
      .prepare(
        `UPDATE custody_wallets SET status = 'inactive' WHERE wallet_id = 'wal_already_gone'`
      )
      .run();

    expect(await store.deactivateWalletIfNotLast("cfg_single_wallet", "wal_only")).toBe(
      "last_wallet"
    );
    expect(await countActiveWallets("cfg_single_wallet")).toBe(1);
  });

  it("returns wallet_not_found for unknown and already-inactive wallets", async () => {
    const store = new CustodyConfigStore(getDb(env), env);
    await seedCustodyConfig("cfg_not_found", "custody-guard-not-found", ["wal_nf_a", "wal_nf_b"]);

    expect(await store.deactivateWalletIfNotLast("cfg_not_found", "wal_missing")).toBe(
      "wallet_not_found"
    );
    expect(await store.deactivateWalletIfNotLast("cfg_missing_config", "wal_nf_a")).toBe(
      "wallet_not_found"
    );

    expect(await store.deactivateWalletIfNotLast("cfg_not_found", "wal_nf_a")).toBe("deactivated");
    expect(await store.deactivateWalletIfNotLast("cfg_not_found", "wal_nf_a")).toBe(
      "wallet_not_found"
    );
    expect(await countActiveWallets("cfg_not_found")).toBe(1);
  });

  it("lets only one of two concurrent deletes pass the last-wallet guard", async () => {
    const db = getDb(env);
    const storeA = new CustodyConfigStore(db, env);
    const storeB = new CustodyConfigStore(db, env);

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const configId = `cfg_concurrent_${attempt}`;
      const walletA = `wal_concurrent_a_${attempt}`;
      const walletB = `wal_concurrent_b_${attempt}`;
      await seedCustodyConfig(configId, `custody-guard-concurrent-${attempt}`, [walletA, walletB]);

      const results = await Promise.all([
        storeA.deactivateWalletIfNotLast(configId, walletA),
        storeB.deactivateWalletIfNotLast(configId, walletB),
      ]);

      // Security invariant (SOLA9-145): exactly one request may deactivate;
      // the loser must be rejected by the last-wallet guard, and the custody
      // configuration must always retain an active wallet.
      expect(results.sort(), `attempt ${attempt}`).toEqual(["deactivated", "last_wallet"]);
      expect(await countActiveWallets(configId), `attempt ${attempt}`).toBe(1);
    }
  });
});
