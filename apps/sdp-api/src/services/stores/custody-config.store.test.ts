/**
 * The guarded wallet-deactivation paths, against real Postgres.
 *
 * The DvP authority is a PDA seed on every trade created under it, so a
 * settlement wallet with open trades must refuse deactivation through BOTH
 * guarded paths — and `deactivateWalletIfNotLast` must check that inside its
 * single conditional UPDATE, not in a read-before-write pair that a concurrent
 * trade creation can race past.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { CustodyConfigStore } from "./custody-config.store";

const PROJECT_ID = "prj_cust_deactivate";
const CUSTODY_CONFIG_ID = "cust_cust_deactivate";
const AUTHORITY_ADDRESS = "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC";
const REPLACEMENT_ADDRESS = "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY";
const OTHER_ADDRESS = "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn";

async function seedWallet(id: string, publicKey: string, purpose: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, purpose, status)
       VALUES (?, ?, ?, ?, ?, 'active')`
    )
    .bind(id, CUSTODY_CONFIG_ID, `provider_${id}`, publicKey, purpose)
    .run();
}

async function seedOpenTrade(
  id: string,
  swapDvp: string,
  settlementAuthority: string = AUTHORITY_ADDRESS
): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO dvp_trades (
         id, organization_id, project_id, swap_dvp,
         settlement_authority, user_a, user_b, mint_a, mint_b, nonce,
         token_program_a, token_program_b,
         amount_a, amount_b, expiry_timestamp,
         user_a_settlement_destination, user_b_settlement_destination,
         escrow_a, escrow_b, status
       ) VALUES (
         ?, ?, ?, ?,
         ?, ?, ?,
         'ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1',
         'AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE',
         '42',
         'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
         'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
         '1000', '2000', '1800003600',
         'FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU',
         '6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y',
         'FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU',
         '6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y',
         'created'
       )`
    )
    .bind(
      id,
      TEST_ORG.id,
      PROJECT_ID,
      swapDvp,
      settlementAuthority,
      AUTHORITY_ADDRESS,
      OTHER_ADDRESS
    )
    .run();
}

/**
 * Seeds the replacement scenario: an INACTIVE old authority whose open trades
 * still name its address, plus the NEW mapped replacement wallet. The mapping
 * is the only thing the old guard joined through, which is why open trades
 * under the dead authority used to block the replacement.
 */
async function seedReplacedAuthority(): Promise<void> {
  await seedWallet("cwlt_old_authority", AUTHORITY_ADDRESS, "dvp_settlement_authority");
  await seedWallet("cwlt_new_authority", REPLACEMENT_ADDRESS, "dvp_settlement_authority");
  await seedWallet("cwlt_survivor", OTHER_ADDRESS, "transfer");
  await getDb(env)
    .prepare(
      `INSERT INTO dvp_settlement_wallets (project_id, organization_id, custody_wallet_id)
       VALUES (?, ?, 'cwlt_new_authority')`
    )
    .bind(PROJECT_ID, TEST_ORG.id)
    .run();
  await getDb(env)
    .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = 'cwlt_old_authority'")
    .run();
  await seedOpenTrade(
    "trade_old_authority",
    "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
    AUTHORITY_ADDRESS
  );
}

describe("CustodyConfigStore wallet deactivation guards", () => {
  let store: CustodyConfigStore;

  beforeEach(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    const db = getDb(env);
    await db.prepare("DELETE FROM dvp_trades").run();
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
      ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
    });
    await db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'local', 'x', 'active')`
      )
      .bind(CUSTODY_CONFIG_ID, TEST_ORG.id, PROJECT_ID)
      .run();

    store = new CustodyConfigStore(getDb(env), env);
  });

  describe("deactivateWalletIfNotLast", () => {
    it("deactivates an ordinary wallet while another active wallet exists", async () => {
      await seedWallet("cwlt_ordinary", AUTHORITY_ADDRESS, "transfer");
      await seedWallet("cwlt_survivor", OTHER_ADDRESS, "transfer");

      await expect(
        store.deactivateWalletIfNotLast(CUSTODY_CONFIG_ID, "provider_cwlt_ordinary")
      ).resolves.toBe("deactivated");

      const row = await getDb(env)
        .prepare("SELECT status FROM custody_wallets WHERE id = ?")
        .bind("cwlt_ordinary")
        .first<{ status: string }>();
      expect(row?.status).toBe("inactive");
    });

    it("refuses to deactivate a settlement authority with an open trade", async () => {
      await seedWallet("cwlt_authority", AUTHORITY_ADDRESS, "dvp_settlement_authority");
      await seedWallet("cwlt_survivor", OTHER_ADDRESS, "transfer");
      await getDb(env)
        .prepare(
          `INSERT INTO dvp_settlement_wallets (project_id, organization_id, custody_wallet_id)
           VALUES (?, ?, ?)`
        )
        .bind(PROJECT_ID, TEST_ORG.id, "cwlt_authority")
        .run();
      await seedOpenTrade("trade_open", "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po");

      await expect(
        store.deactivateWalletIfNotLast(CUSTODY_CONFIG_ID, "provider_cwlt_authority")
      ).resolves.toBe("dvp_settlement_authority");

      const row = await getDb(env)
        .prepare("SELECT status FROM custody_wallets WHERE id = ?")
        .bind("cwlt_authority")
        .first<{ status: string }>();
      expect(row?.status).toBe("active");
    });

    // When both guards block, the DvP reason wins the diagnostic: a last-wallet
    // refusal is recoverable by creating another wallet, an authority refusal
    // is not — the caller should hear about the load-bearing one first.
    it("reports dvp_settlement_authority when the authority is also the last wallet", async () => {
      await seedWallet("cwlt_authority", AUTHORITY_ADDRESS, "dvp_settlement_authority");
      await getDb(env)
        .prepare(
          `INSERT INTO dvp_settlement_wallets (project_id, organization_id, custody_wallet_id)
           VALUES (?, ?, ?)`
        )
        .bind(PROJECT_ID, TEST_ORG.id, "cwlt_authority")
        .run();
      await seedOpenTrade("trade_open", "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po");

      await expect(
        store.deactivateWalletIfNotLast(CUSTODY_CONFIG_ID, "provider_cwlt_authority")
      ).resolves.toBe("dvp_settlement_authority");
    });

    it("allows deactivating a settlement authority once its trades are closed", async () => {
      await seedWallet("cwlt_authority", AUTHORITY_ADDRESS, "dvp_settlement_authority");
      await seedWallet("cwlt_survivor", OTHER_ADDRESS, "transfer");
      await getDb(env)
        .prepare(
          `INSERT INTO dvp_settlement_wallets (project_id, organization_id, custody_wallet_id)
           VALUES (?, ?, ?)`
        )
        .bind(PROJECT_ID, TEST_ORG.id, "cwlt_authority")
        .run();
      await seedOpenTrade("trade_settled", "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po");
      await getDb(env)
        .prepare("UPDATE dvp_trades SET status = 'settled' WHERE id = ?")
        .bind("trade_settled")
        .run();

      await expect(
        store.deactivateWalletIfNotLast(CUSTODY_CONFIG_ID, "provider_cwlt_authority")
      ).resolves.toBe("deactivated");
    });

    // The guard counts only trades whose recorded `settlement_authority` equals
    // the wallet's public key. An inactive authority is replaced by a new mapped
    // wallet while its old trades stay open; those trades are bound to the OLD
    // address forever, so they must not block deactivating the replacement.
    it("allows deactivating a replacement authority while the old authority's trades are open", async () => {
      await seedReplacedAuthority();

      await expect(
        store.deactivateWalletIfNotLast(CUSTODY_CONFIG_ID, "provider_cwlt_new_authority")
      ).resolves.toBe("deactivated");
    });

    it("still blocks a wallet whose address IS the open trade's recorded authority", async () => {
      await seedReplacedAuthority();
      // A second, ACTIVE wallet whose address matches the old open trade: the
      // mapping points at the replacement, but this wallet's key is the
      // authority on the trade, so it is the one that is load-bearing.
      await seedWallet("cwlt_address_match", AUTHORITY_ADDRESS, "transfer");

      await expect(
        store.deactivateWalletIfNotLast(CUSTODY_CONFIG_ID, "provider_cwlt_address_match")
      ).resolves.toBe("dvp_settlement_authority");
    });

    it("reports wallet_not_found for an unknown wallet", async () => {
      await seedWallet("cwlt_survivor", OTHER_ADDRESS, "transfer");

      await expect(
        store.deactivateWalletIfNotLast(CUSTODY_CONFIG_ID, "provider_missing")
      ).resolves.toBe("wallet_not_found");
    });
  });

  describe("deactivateWallet", () => {
    // The refusal must live in the conditional UPDATE itself, like
    // deactivateWalletIfNotLast: with the check in a separate read before the
    // write, a trade created between the two statements deactivates an
    // authority that just became load-bearing.
    it("refuses to deactivate a settlement authority with an open trade even when another active wallet exists", async () => {
      await seedWallet("cwlt_authority", AUTHORITY_ADDRESS, "dvp_settlement_authority");
      await seedWallet("cwlt_survivor", OTHER_ADDRESS, "transfer");
      await getDb(env)
        .prepare(
          `INSERT INTO dvp_settlement_wallets (project_id, organization_id, custody_wallet_id)
           VALUES (?, ?, ?)`
        )
        .bind(PROJECT_ID, TEST_ORG.id, "cwlt_authority")
        .run();
      await seedOpenTrade("trade_open", "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po");

      await expect(
        store.deactivateWallet(CUSTODY_CONFIG_ID, "provider_cwlt_authority")
      ).rejects.toThrow(/DvP settlement authority/);

      const row = await getDb(env)
        .prepare("SELECT status FROM custody_wallets WHERE id = ?")
        .bind("cwlt_authority")
        .first<{ status: string }>();
      expect(row?.status).toBe("active");
    });

    it("refuses to deactivate a settlement authority with an open trade when it is the last wallet", async () => {
      await seedWallet("cwlt_authority", AUTHORITY_ADDRESS, "dvp_settlement_authority");
      await getDb(env)
        .prepare(
          `INSERT INTO dvp_settlement_wallets (project_id, organization_id, custody_wallet_id)
           VALUES (?, ?, ?)`
        )
        .bind(PROJECT_ID, TEST_ORG.id, "cwlt_authority")
        .run();
      await seedOpenTrade("trade_open", "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po");

      await expect(
        store.deactivateWallet(CUSTODY_CONFIG_ID, "provider_cwlt_authority")
      ).rejects.toThrow(/DvP settlement authority/);

      const row = await getDb(env)
        .prepare("SELECT status FROM custody_wallets WHERE id = ?")
        .bind("cwlt_authority")
        .first<{ status: string }>();
      expect(row?.status).toBe("active");
    });

    it("deactivates an ordinary wallet with no open trades", async () => {
      await seedWallet("cwlt_ordinary", AUTHORITY_ADDRESS, "transfer");

      await store.deactivateWallet(CUSTODY_CONFIG_ID, "provider_cwlt_ordinary");

      const row = await getDb(env)
        .prepare("SELECT status FROM custody_wallets WHERE id = ?")
        .bind("cwlt_ordinary")
        .first<{ status: string }>();
      expect(row?.status).toBe("inactive");
    });

    // Mirror of the `deactivateWalletIfNotLast` replacement test: open trades
    // under the OLD authority bind its address, not the project, so they must
    // not block the NEW mapped wallet through the mapping row.
    it("allows deactivating a replacement authority while the old authority's trades are open", async () => {
      await seedReplacedAuthority();

      await store.deactivateWallet(CUSTODY_CONFIG_ID, "provider_cwlt_new_authority");

      const row = await getDb(env)
        .prepare("SELECT status FROM custody_wallets WHERE id = ?")
        .bind("cwlt_new_authority")
        .first<{ status: string }>();
      expect(row?.status).toBe("inactive");
    });

    it("still blocks a wallet whose address IS the open trade's recorded authority", async () => {
      await seedReplacedAuthority();
      await seedWallet("cwlt_address_match", AUTHORITY_ADDRESS, "transfer");

      await expect(
        store.deactivateWallet(CUSTODY_CONFIG_ID, "provider_cwlt_address_match")
      ).rejects.toThrow(/DvP settlement authority/);

      const row = await getDb(env)
        .prepare("SELECT status FROM custody_wallets WHERE id = ?")
        .bind("cwlt_address_match")
        .first<{ status: string }>();
      expect(row?.status).toBe("active");
    });

    it("throws when the wallet does not exist", async () => {
      await seedWallet("cwlt_survivor", OTHER_ADDRESS, "transfer");

      await expect(store.deactivateWallet(CUSTODY_CONFIG_ID, "provider_missing")).rejects.toThrow(
        "Wallet not found"
      );
    });
  });
});
