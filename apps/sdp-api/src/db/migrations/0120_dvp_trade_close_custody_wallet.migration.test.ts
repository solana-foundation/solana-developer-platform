/**
 * Regression test for the 0120 backfill's contract over pre-deploy data.
 *
 * Closes recorded before `close_custody_wallet_id` existed — and closes the
 * reconciler lifted from `closed_unknown`, which records no wallet — fall back
 * to resolving `settlement_authority` through today's wallets and today's
 * mapping in the unified feed. When a project's mapping has since rotated, or
 * the same key is recorded on more than one wallet, that scan can name a wallet
 * that did not sign. The audit ledger has held the durable answer since
 * PRO-1992: every settle and cancel that returned a signature logged a row
 * naming the wallet the handler authorized. The backfill copies that answer
 * onto the trade, so the feed attributes those closes to the wallet that signed
 * them instead of re-resolving the key.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { runWithTenantDatabaseIdentity } from "@/db/identity";
import { createPostgresUnifiedTransactionsRepository } from "@/db/repositories/unified-transactions.repository.postgres";
import { adminDatabaseUrl as databaseUrl, env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { runPostgresMigrations } from "../../../scripts/lib/run-postgres-migrations.mjs";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres");
const migrationFile = "0120_dvp_trade_close_custody_wallet.sql";

const ORG = "org_dvp_0120_backfill";
const USER = "usr_dvp_0120_backfill";
const PROJECT = "prj_dvp_0120_backfill";
const AUTHORITY = "Dvp0120BackfillAuthority111";
// The wallet that signed, the same-key duplicate the provisioning race left
// behind, and the rotated mapping's wallet, whose key is not the trade's
// authority at all.
const WALLET_SIGNED = "cwlt_dvp_0120_signed";
const WALLET_IMPOSTOR = "cwlt_dvp_0120_impostor";
const WALLET_ROTATED = "cwlt_dvp_0120_rotated";
// Another tenant's wallet: the backfill must never copy a foreign id even
// when an audit row asks it to.
const OTHER_ORG = "org_dvp_0120_other";
const OTHER_PROJECT = "prj_dvp_0120_other";
const OTHER_WALLET = "cwlt_dvp_0120_other";
let client: Client;

async function seedFixture(): Promise<void> {
  await seedTestDatabase(env);
  const db = getDb(env);

  await db.batch([
    db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(ORG, "DvP 0120 Backfill", "dvp-0120-backfill"),
    db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(OTHER_ORG, "DvP 0120 Other", "dvp-0120-other"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER, "dvp-0120-backfill@example.test"),
  ]);

  await seedDefaultProjects(db, {
    organizationId: ORG,
    createdBy: USER,
    members: [],
    ids: { sandbox: PROJECT, production: `${PROJECT}_production` },
  });
  await seedDefaultProjects(db, {
    organizationId: OTHER_ORG,
    createdBy: USER,
    members: [],
    ids: { sandbox: OTHER_PROJECT, production: `${OTHER_PROJECT}_production` },
  });

  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'local', 'poc-only', 'active')`
      )
      .bind("cfg_dvp_0120", ORG, PROJECT),
    db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'local', 'poc-only', 'active')`
      )
      .bind("cfg_dvp_0120_other", OTHER_ORG, OTHER_PROJECT),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, label, status)
         VALUES (?, 'cfg_dvp_0120', 'provider-0120-signed', ?, '0120 signer', 'active'),
                (?, 'cfg_dvp_0120', 'provider-0120-impostor', ?, '0120 impostor', 'active'),
                (?, 'cfg_dvp_0120', 'provider-0120-rotated', ?, '0120 rotated', 'active'),
                (?, 'cfg_dvp_0120_other', 'provider-0120-other', ?, '0120 other', 'active')`
      )
      .bind(
        WALLET_SIGNED,
        AUTHORITY,
        WALLET_IMPOSTOR,
        AUTHORITY,
        WALLET_ROTATED,
        "Dvp0120OtherKey111",
        OTHER_WALLET,
        "Dvp0120OtherWallet111"
      ),
    // The project's settlement mapping names the duplicate, not the signer:
    // whichever wallet the scan prefers, the recorded answer outranks it.
    db
      .prepare(
        `INSERT INTO dvp_settlement_wallets (project_id, organization_id, custody_wallet_id)
         VALUES (?, ?, ?)`
      )
      .bind(PROJECT, ORG, WALLET_IMPOSTOR),
  ]);
}

/**
 * Plants a closed trade recorded before 0120: a close signature, no signing
 * wallet, and the audit row the close request logged after the effect.
 */
async function insertClosedTrade(params: {
  tradeId: string;
  action: "settle" | "cancel";
  audit: { organizationId: string | null; signature: string; custodyWalletId: string } | null;
}): Promise<void> {
  const db = getDb(env);
  const batch = [
    db
      .prepare(
        `INSERT INTO dvp_trades
           (id, organization_id, project_id, swap_dvp, settlement_authority, user_a, user_b,
            mint_a, mint_b, nonce, token_program_a, token_program_b, amount_a, amount_b,
            expiry_timestamp, user_a_settlement_destination, user_b_settlement_destination,
            escrow_a, escrow_b, status, escrow_a_amount, escrow_b_amount,
            escrow_a_peak_amount, escrow_b_peak_amount, decimals_a, decimals_b,
            close_signature, closed_at)
         VALUES (?, ?, ?, ?, ?, 'Dvp0120BackfillA111', 'Dvp0120BackfillB111',
                 'DvpMint0120A111', 'DvpMint0120B111', '1', 'DvpTokenProgram0120A111', 'DvpTokenProgram0120B111',
                 '1000000', '2000000', '2000000000', 'DvpDestination0120A111',
                 'DvpDestination0120B111', 'DvpEscrow0120A111', 'DvpEscrow0120B111', 'settled', '0', '0',
                 '1000000', '2000000', 6, 6,
                 ?, '2026-09-20T00:00:00.000Z')`
      )
      .bind(
        params.tradeId,
        ORG,
        PROJECT,
        `DvpSwap${params.tradeId}`,
        AUTHORITY,
        `${params.tradeId}_signature`
      ),
  ];
  if (params.audit !== null) {
    batch.push(
      db
        .prepare(
          `INSERT INTO audit_logs (id, organization_id, action, resource_type, resource_id, metadata, status)
           VALUES (?, ?, ?, 'dvp_trade', ?, ?, 'success')`
        )
        .bind(
          `aud_${params.tradeId}`,
          params.audit.organizationId,
          params.action,
          params.tradeId,
          JSON.stringify({
            settlementCustodyWalletId: params.audit.custodyWalletId,
            signature: params.audit.signature,
            confirmed: true,
          })
        )
    );
  }
  await db.batch(batch);
}

/**
 * Re-applies the 0120 backfill over the planted rows, exactly as a deploy
 * would: the runner re-runs the migration whose schema_migrations stamp is
 * removed, and nothing else.
 */
async function rerunBackfill(): Promise<void> {
  await client.query("DELETE FROM schema_migrations WHERE version = $1", [migrationFile]);
  await runPostgresMigrations({ databaseUrl, migrationsDir });
}

async function listDvp() {
  const repository = createPostgresUnifiedTransactionsRepository(getDb(env));
  return runWithTenantDatabaseIdentity({ organizationId: ORG }, () =>
    repository.list({
      organizationId: ORG,
      projectId: PROJECT,
      modules: ["dvp"],
      limit: 100,
    })
  );
}

describe("0120 dvp trade close custody wallet backfill", () => {
  beforeEach(seedFixture);

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it("names the audited signing wallet for a pre-0120 close, even after the mapping rotates to a same-key duplicate", async () => {
    await insertClosedTrade({
      tradeId: "dvp_0120_recorded",
      action: "settle",
      audit: {
        organizationId: ORG,
        signature: "dvp_0120_recorded_signature",
        custodyWalletId: WALLET_SIGNED,
      },
    });

    await rerunBackfill();

    const trade = await client.query(
      `SELECT close_custody_wallet_id FROM dvp_trades WHERE id = 'dvp_0120_recorded'`
    );
    expect(trade.rows).toEqual([{ close_custody_wallet_id: WALLET_SIGNED }]);

    // The feed names the wallet that signed, never the duplicate the project's
    // mapping names, and a read scoped to the signing wallet finds the closes
    // it signed.
    const feed = await listDvp();
    expect(feed.rows.filter((row) => row.moduleId === "dvp_0120_recorded")).toEqual([
      expect.objectContaining({
        kind: "close",
        signature: "dvp_0120_recorded_signature",
        custodyWalletId: WALLET_SIGNED,
        organizationId: ORG,
        projectId: PROJECT,
      }),
      expect.objectContaining({
        kind: "close",
        signature: "dvp_0120_recorded_signature",
        custodyWalletId: WALLET_SIGNED,
      }),
    ]);
  });

  it("leaves a close unnamed when the audit row belongs to another organization", async () => {
    await insertClosedTrade({
      tradeId: "dvp_0120_foreign_org",
      action: "settle",
      audit: {
        organizationId: OTHER_ORG,
        signature: "dvp_0120_foreign_org_signature",
        custodyWalletId: WALLET_SIGNED,
      },
    });

    await rerunBackfill();

    const trade = await client.query(
      `SELECT close_custody_wallet_id FROM dvp_trades WHERE id = 'dvp_0120_foreign_org'`
    );
    expect(trade.rows).toEqual([{ close_custody_wallet_id: null }]);
  });

  it("leaves a close unnamed when the audited wallet belongs to another organization", async () => {
    await insertClosedTrade({
      tradeId: "dvp_0120_foreign_wallet",
      action: "settle",
      audit: {
        organizationId: ORG,
        signature: "dvp_0120_foreign_wallet_signature",
        custodyWalletId: OTHER_WALLET,
      },
    });

    await rerunBackfill();

    const trade = await client.query(
      `SELECT close_custody_wallet_id FROM dvp_trades WHERE id = 'dvp_0120_foreign_wallet'`
    );
    expect(trade.rows).toEqual([{ close_custody_wallet_id: null }]);
  });

  it("leaves a close unnamed when the audited signature is not the close that landed", async () => {
    // An unconfirmed broadcast logged its own signature; the trade closed on a
    // later attempt. Only the landed close's audit may answer.
    await insertClosedTrade({
      tradeId: "dvp_0120_unconfirmed",
      action: "settle",
      audit: {
        organizationId: ORG,
        signature: "dvp_0120_unconfirmed_broadcast",
        custodyWalletId: WALLET_SIGNED,
      },
    });

    await rerunBackfill();

    const trade = await client.query(
      `SELECT close_custody_wallet_id FROM dvp_trades WHERE id = 'dvp_0120_unconfirmed'`
    );
    expect(trade.rows).toEqual([{ close_custody_wallet_id: null }]);
  });
});
