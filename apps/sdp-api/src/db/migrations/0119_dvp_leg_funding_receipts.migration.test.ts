/**
 * Regression test for the 0119 backfill's contract over pre-deploy data.
 *
 * The backfill copies every existing broadcast funding claim into the new
 * receipts table with the amount the deployed unified feed showed for it —
 * the side's escrow peak. The peak columns (0092) were added without a
 * backfill, so a trade's peak can be NULL, and the deployed feed rendered
 * such a row with a NULL amount. The backfill must keep the row and the NULL:
 * requiring a value would abort the whole deploy over one historical claim,
 * and a closed trade can still hold a broadcast claim (its reconciler keeps
 * re-checking it), so the row is not hypothetical.
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
const migrationFile = "0119_dvp_leg_funding_receipts.sql";

const ORG = "org_dvp_0119_backfill";
const USER = "usr_dvp_0119_backfill";
const PROJECT = "prj_dvp_0119_backfill";
const WALLET_FUNDER = "cwlt_dvp_0119_backfill";
let client: Client;

async function seedFixture(): Promise<void> {
  await seedTestDatabase(env);
  const db = getDb(env);

  await db.batch([
    db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(ORG, "DvP 0119 Backfill", "dvp-0119-backfill"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER, "dvp-0119-backfill@example.test"),
  ]);

  await seedDefaultProjects(db, {
    organizationId: ORG,
    createdBy: USER,
    members: [],
    ids: { sandbox: PROJECT, production: `${PROJECT}_production` },
  });

  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'local', 'poc-only', 'active')`
      )
      .bind("cfg_dvp_0119_backfill", ORG, PROJECT),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, label, status)
         VALUES (?, 'cfg_dvp_0119_backfill', ?, ?, ?, 'active')`
      )
      .bind(WALLET_FUNDER, "provider-0119-backfill", "Dvp0119Backfill111", "0119 funder"),
  ]);
}

/**
 * Plants the pre-deploy state the backfill runs over: an open trade whose
 * escrow peak may never have been populated, and a claim already broadcast on
 * it (the reconciler can leave one on a closed trade, where it keeps
 * re-checking the chain).
 */
async function insertBroadcastClaim(params: {
  tradeId: string;
  peak: string | null;
  fundingTx: string;
}): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO dvp_trades
           (id, organization_id, project_id, swap_dvp, settlement_authority, user_a, user_b,
            mint_a, mint_b, nonce, token_program_a, token_program_b, amount_a, amount_b,
            expiry_timestamp, user_a_settlement_destination, user_b_settlement_destination,
            escrow_a, escrow_b, status, escrow_a_amount, escrow_b_amount,
            escrow_a_peak_amount, escrow_b_peak_amount, decimals_a, decimals_b)
         VALUES (?, ?, ?, ?, 'Dvp0119BackfillAuthority111', 'Dvp0119BackfillA111', 'Dvp0119BackfillB111',
                 'DvpMintA111', 'DvpMintB111', '1', 'DvpTokenProgramA111', 'DvpTokenProgramB111',
                 '1000000', '2000000', '2000000000', 'DvpDestinationA111',
                 'DvpDestinationB111', 'DvpEscrowA111', 'DvpEscrowB111', 'partially_funded', '0', '0',
                 ?, ?, 6, 6)`
      )
      .bind(params.tradeId, ORG, PROJECT, `DvpSwap${params.tradeId}`, params.peak, params.peak),
    db
      .prepare(
        `INSERT INTO dvp_leg_funding_claims
           (trade_id, side, organization_id, project_id, custody_wallet_id, signature, expiry_height, funding_tx)
         VALUES (?, 'a', ?, ?, ?, ?, '999999', ?)`
      )
      .bind(params.tradeId, ORG, PROJECT, WALLET_FUNDER, params.fundingTx, params.fundingTx),
  ]);
}

/**
 * Re-applies the 0119 backfill over the planted rows, exactly as a deploy
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

describe("0119 dvp leg funding receipts backfill", () => {
  beforeEach(seedFixture);

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it("backs up a broadcast claim whose trade has no escrow peak as a NULL amount instead of aborting", async () => {
    await insertBroadcastClaim({
      tradeId: "dvp_0119_null_peak",
      peak: null,
      fundingTx: "sig_0119_null_peak",
    });

    // A NOT NULL amount here aborted the whole migration before the fix.
    await rerunBackfill();

    const receipts = await client.query(
      `SELECT trade_id, side, custody_wallet_id, signature, amount
         FROM dvp_leg_funding_receipts
        WHERE trade_id = 'dvp_0119_null_peak'`
    );
    expect(receipts.rows).toEqual([
      {
        trade_id: "dvp_0119_null_peak",
        side: "a",
        custody_wallet_id: WALLET_FUNDER,
        signature: "sig_0119_null_peak",
        amount: null,
      },
    ]);

    // The deployed feed showed this row with a NULL amount, and the receipt
    // keeps showing exactly that.
    const feed = await listDvp();
    expect(feed.rows.filter((row) => row.moduleId === "dvp_0119_null_peak")).toEqual([
      expect.objectContaining({
        kind: "fund",
        signature: "sig_0119_null_peak",
        custodyWalletId: WALLET_FUNDER,
        organizationId: ORG,
        projectId: PROJECT,
        amount: null,
      }),
    ]);
  });

  it("keeps the escrow peak as the backfilled amount when the trade has one", async () => {
    await insertBroadcastClaim({
      tradeId: "dvp_0119_peaked",
      peak: "1500000",
      fundingTx: "sig_0119_peaked",
    });

    await rerunBackfill();

    const feed = await listDvp();
    expect(feed.rows.filter((row) => row.moduleId === "dvp_0119_peaked")).toEqual([
      expect.objectContaining({
        kind: "fund",
        signature: "sig_0119_peaked",
        custodyWalletId: WALLET_FUNDER,
        amount: "1.5",
      }),
    ]);
  });
});
