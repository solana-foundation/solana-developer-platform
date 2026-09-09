import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";
import {
  expectSqlstate as expectSqlstateOn,
  FK_VIOLATION,
  seedOrgProject,
} from "@/test/helpers/migration-db";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0091_dvp_per_side_parties.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");
let client: Client;

const expectSqlstate = (work: () => Promise<unknown>, sqlstate: string) =>
  expectSqlstateOn(client, work, sqlstate);

const DROPPED_COLUMNS = [
  "sdp_side",
  "trade_kind",
  "sdp_wallet_id",
  "sdp_leg_funding_signature",
  "funding_claim_expiry_height",
  "sdp_leg_funding_tx",
] as const;

const NEW_COLUMNS = ["counterparty_account_id_a", "counterparty_account_id_b"] as const;

/**
 * Re-adds the six pre-0091 columns so the migration has something to drop and
 * backfill. The columns were dropped by 0091 in the global setup, so this
 * rewinds the schema inside the test transaction.
 *
 * @param params.walletId - An existing custody wallet, backfilled into every
 *   row's `sdp_wallet_id` so the re-added NOT NULL + FK can be restored.
 */
async function rewindPre0091Shape(params: { walletId: string }): Promise<void> {
  await client.query(
    `ALTER TABLE dvp_trades
       ADD COLUMN IF NOT EXISTS sdp_side TEXT,
       ADD COLUMN IF NOT EXISTS trade_kind TEXT NOT NULL DEFAULT 'principal',
       ADD COLUMN IF NOT EXISTS sdp_wallet_id TEXT,
       ADD COLUMN IF NOT EXISTS sdp_leg_funding_signature TEXT,
       ADD COLUMN IF NOT EXISTS funding_claim_expiry_height TEXT,
       ADD COLUMN IF NOT EXISTS sdp_leg_funding_tx TEXT`
  );
  await client.query(`UPDATE dvp_trades SET sdp_wallet_id = $1 WHERE sdp_wallet_id IS NULL`, [
    params.walletId,
  ]);
  await client.query(`ALTER TABLE dvp_trades ALTER COLUMN sdp_wallet_id SET NOT NULL`);
  // Re-add the named constraints 0088 introduced. PostgreSQL has no
  // ADD CONSTRAINT IF NOT EXISTS, so guard with a DO block.
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'dvp_trades_sdp_wallet_id_fk'
      ) THEN
        ALTER TABLE dvp_trades
          ADD CONSTRAINT dvp_trades_sdp_wallet_id_fk
            FOREIGN KEY (sdp_wallet_id) REFERENCES custody_wallets(id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'dvp_trades_trade_kind_check'
      ) THEN
        ALTER TABLE dvp_trades
          ADD CONSTRAINT dvp_trades_trade_kind_check
            CHECK (trade_kind IN ('principal', 'agent'));
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'dvp_trades_kind_side_check'
      ) THEN
        ALTER TABLE dvp_trades
          ADD CONSTRAINT dvp_trades_kind_side_check
            CHECK (
              (trade_kind = 'principal' AND sdp_side IS NOT NULL)
              OR (trade_kind = 'agent' AND sdp_side IS NULL)
            );
      END IF;
    END $$;
  `);
}

/**
 * Inserts a dvp_trades row with the pre-0091 column shape. Only the columns
 * the migration touches are parameterised; the rest are constants from 0077.
 */
async function insertTrade(params: {
  id: string;
  organizationId: string;
  projectId: string;
  walletId: string;
  sdpSide: string | null;
  tradeKind?: string;
  fundingSignature?: string | null;
  fundingExpiryHeight?: string | null;
  fundingTx?: string | null;
}): Promise<void> {
  await client.query(
    `INSERT INTO dvp_trades (
       id, organization_id, project_id, swap_dvp, settlement_authority,
       user_a, user_b, mint_a, mint_b, nonce, token_program_a, token_program_b,
       amount_a, amount_b, expiry_timestamp,
       user_a_settlement_destination, user_b_settlement_destination,
       escrow_a, escrow_b, sdp_side, trade_kind, sdp_wallet_id,
       sdp_leg_funding_signature, funding_claim_expiry_height, sdp_leg_funding_tx,
       status
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       '1000', '2000', '1800003600', $6, $7, 'FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU',
       '6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y', $13, $14, $15, $16, $17, $18, 'created'
     )`,
    [
      params.id,
      params.organizationId,
      params.projectId,
      `swap_${params.id}`,
      "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
      "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
      "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg",
      "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
      "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
      "42",
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      params.sdpSide,
      params.tradeKind ?? "principal",
      params.walletId,
      params.fundingSignature ?? null,
      params.fundingExpiryHeight ?? null,
      params.fundingTx ?? null,
    ]
  );
}

beforeAll(async () => {
  client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

// The global setup has already applied 0091, so the six pre-0091 columns are
// gone and the two new ones exist. Each test rewinds to the pre-0091 shape
// inside a transaction, seeds rows, runs the migration SQL, and asserts —
// all rolled back afterwards so the schema is pristine for the next test.
beforeEach(async () => {
  await client.query("BEGIN");
  await client.query("SET app.tenant_isolation_identity = 'system'");
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0091_dvp_per_side_parties", () => {
  it("backfills in-flight creator-leg funding into dvp_leg_funding_claims", async () => {
    const { organizationId, projectId } = await seedOrgProject(client, "backfill");
    await client.query(
      `INSERT INTO custody_configs (id, organization_id, provider, config_encrypted, status)
       VALUES ('cust_backfill', $1, 'local', 'x', 'active')`,
      [organizationId]
    );
    await client.query(
      `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
       VALUES ('cwlt_backfill', 'cust_backfill', 'w1', '5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn', 'active')`
    );

    await rewindPre0091Shape({ walletId: "cwlt_backfill" });

    // A trade with a live funding signature and a recorded expiry.
    await insertTrade({
      id: "trade_funded_claim",
      organizationId,
      projectId,
      walletId: "cwlt_backfill",
      sdpSide: "a",
      fundingSignature: "sig_claim_0091",
      fundingExpiryHeight: "500",
    });

    // A trade with a live signature but NO recorded expiry (pre-0084 lock).
    await insertTrade({
      id: "trade_null_expiry",
      organizationId,
      projectId,
      walletId: "cwlt_backfill",
      sdpSide: "a",
      fundingSignature: "sig_null_expiry_0091",
      fundingExpiryHeight: null,
    });

    // An already-funded trade with both signature and funding_tx set.
    await insertTrade({
      id: "trade_receipt",
      organizationId,
      projectId,
      walletId: "cwlt_backfill",
      sdpSide: "b",
      fundingSignature: "sig_receipt_0091",
      fundingExpiryHeight: "300",
      fundingTx: "tx_receipt_0091",
    });

    // A funded leg whose claim the sweep released: receipt only (sig NULL).
    await insertTrade({
      id: "trade_receipt_only",
      organizationId,
      projectId,
      walletId: "cwlt_backfill",
      sdpSide: "a",
      fundingSignature: null,
      fundingExpiryHeight: null,
      fundingTx: "tx_receipt_only_0091",
    });

    // A trade with no funding at all — must produce no claim.
    await insertTrade({
      id: "trade_unfunded",
      organizationId,
      projectId,
      walletId: "cwlt_backfill",
      sdpSide: "a",
      fundingSignature: null,
    });

    // A pre-existing claim on the same (trade, side) — must NOT be overwritten.
    await client.query(
      `INSERT INTO dvp_leg_funding_claims
         (trade_id, side, organization_id, project_id, custody_wallet_id, signature, expiry_height)
       VALUES ('trade_funded_claim', 'a', $1, $2, 'cwlt_backfill', 'sig_fresher_0091', '999')`,
      [organizationId, projectId]
    );

    await client.query(migrationSql);

    const claims = await client.query<{
      trade_id: string;
      side: string;
      organization_id: string;
      project_id: string;
      custody_wallet_id: string;
      signature: string;
      expiry_height: string;
      funding_tx: string | null;
    }>(
      `SELECT trade_id, side, organization_id, project_id, custody_wallet_id,
              signature, expiry_height, funding_tx
         FROM dvp_leg_funding_claims
        WHERE trade_id IN ('trade_funded_claim', 'trade_null_expiry', 'trade_receipt', 'trade_receipt_only')
        ORDER BY trade_id, side`
    );

    const byTrade = new Map(claims.rows.map((row) => [`${row.trade_id}|${row.side}`, row]));

    // The pre-existing claim wins: ON CONFLICT DO NOTHING kept its signature.
    expect(byTrade.get("trade_funded_claim|a")).toMatchObject({
      signature: "sig_fresher_0091",
      expiry_height: "999",
    });

    // The NULL-expiry row got expiry_height '0', and the backfill carried the
    // trade's own org/project/wallet/signature — not some other row's.
    expect(byTrade.get("trade_null_expiry|a")).toMatchObject({
      organization_id: organizationId,
      project_id: projectId,
      custody_wallet_id: "cwlt_backfill",
      signature: "sig_null_expiry_0091",
      expiry_height: "0",
      funding_tx: null,
    });

    // The already-funded trade's receipt survives in the claims table, keyed to
    // the leg the trade actually funded.
    expect(byTrade.get("trade_receipt|b")).toMatchObject({
      signature: "sig_receipt_0091",
      expiry_height: "300",
      funding_tx: "tx_receipt_0091",
    });

    // The receipt-only row (claim already swept on main) migrates as a receipt:
    // the receipt signature stands in for the swept lock.
    expect(byTrade.get("trade_receipt_only|a")).toMatchObject({
      signature: "tx_receipt_only_0091",
      expiry_height: "0",
      funding_tx: "tx_receipt_only_0091",
    });

    // The unfunded trade produced no claim.
    const unfundedClaim = await client.query(
      `SELECT 1 FROM dvp_leg_funding_claims WHERE trade_id = 'trade_unfunded'`
    );
    expect(unfundedClaim.rows).toHaveLength(0);
  });

  it("drops the six columns", async () => {
    const { organizationId } = await seedOrgProject(client, "droptest");
    await client.query(
      `INSERT INTO custody_configs (id, organization_id, provider, config_encrypted, status)
       VALUES ('cust_droptest', $1, 'local', 'x', 'active')`,
      [organizationId]
    );
    await client.query(
      `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
       VALUES ('cwlt_droptest', 'cust_droptest', 'w1', '5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn', 'active')`
    );

    await rewindPre0091Shape({ walletId: "cwlt_droptest" });

    await client.query(migrationSql);

    for (const column of DROPPED_COLUMNS) {
      const result = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'dvp_trades' AND column_name = $1`,
        [column]
      );
      expect(result.rows, `column ${column} should be gone`).toHaveLength(0);
    }
  });

  it("adds the two counterparty_account_id columns, nullable, FK ON DELETE RESTRICT", async () => {
    const { organizationId, projectId } = await seedOrgProject(client, "newcols");

    await client.query(migrationSql);

    for (const column of NEW_COLUMNS) {
      const result = await client.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'dvp_trades' AND column_name = $1`,
        [column]
      );
      expect(result.rows, `column ${column} should exist`).toHaveLength(1);
      expect(result.rows[0].is_nullable).toBe("YES");
    }

    // A counterparty account to reference.
    await client.query(
      `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name)
       VALUES ('cpty_newcols', $1, $2, 'individual', 'Ada')`,
      [organizationId, projectId]
    );
    await client.query(
      `INSERT INTO counterparty_accounts (id, organization_id, project_id, counterparty_id, account_kind)
       VALUES ('cpa_newcols', $1, $2, 'cpty_newcols', 'crypto_wallet')`,
      [organizationId, projectId]
    );

    // Insert a trade referencing the account.
    await client.query(
      `INSERT INTO dvp_trades (
         id, organization_id, project_id, swap_dvp, settlement_authority,
         user_a, user_b, mint_a, mint_b, nonce, token_program_a, token_program_b,
         amount_a, amount_b, expiry_timestamp,
         user_a_settlement_destination, user_b_settlement_destination,
         escrow_a, escrow_b, status, counterparty_account_id_a
       ) VALUES (
         'trade_cp_test', $1, $2, 'swap_cp_test', '9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY',
         '5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn',
         '7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg',
         'ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1',
         'AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE', '42',
         'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
         'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
         '1000', '2000', '1800003600',
         '5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn',
         '7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg',
         'FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU',
         '6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y',
         'created', 'cpa_newcols'
       )`,
      [organizationId, projectId]
    );

    // Deleting the referenced counterparty account must fail (ON DELETE RESTRICT).
    await expectSqlstate(
      () => client.query("DELETE FROM counterparty_accounts WHERE id = 'cpa_newcols'"),
      FK_VIOLATION
    );
  });

  it("is idempotent when re-run", async () => {
    await client.query(migrationSql);
    // A second run must not throw — every statement is IF NOT EXISTS / IF EXISTS.
    await expect(client.query(migrationSql)).resolves.toBeDefined();
  });
});
