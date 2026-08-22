import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type AppDb, getDb } from "@/db";
import { env } from "@/test/helpers/env";
import { splitSqlStatements } from "../../../scripts/lib/run-postgres-migrations.mjs";
import type { EarnMovementRow, EarnPositionRow } from "./earn-movements.repository";

/**
 * The backfill half of the movement unification (PRO-1705, migration 0064).
 *
 * The dual-write suite proves NEW writes reach the ledger. This proves EXISTING
 * history does — legacy rows written long before the unified tables existed, and
 * rows an outgoing revision writes or updates during a rollout window, which can
 * miss the first backfill pass or leave its projection stale. A later convergence
 * migration sweeps those changes, so "idempotent" is a shipped requirement and
 * not a nicety.
 *
 * It runs the REAL migration file rather than a copy of its statements: a test
 * against a transcription would pass while the shipped artifact was broken.
 */

const MIGRATIONS = path.join(__dirname, "../migrations/postgres");
const BACKFILL_SQL = path.join(MIGRATIONS, "0064_earn_movements_backfill.sql");
/**
 * The later release re-runs the same projection to sweep rows the outgoing
 * revision wrote or updated during the rollout window. It is a separate
 * migration because editing applied history would not run it again; unlike the
 * insert-only first pass, this convergence pass also refreshes stale rows.
 */
const BACKFILL_SWEEP_SQL = path.join(MIGRATIONS, "0065_earn_movements_backfill_sweep.sql");

const ORG = "org_earn_bf";
const USER = "usr_earn_bf";
const PROJECT = "prj_earn_bf";
const CONFIG = "cc_earn_bf";
const WALLET = "cw_earn_bf";
const WALLET_PUBKEY = "BackfillDepositorPublicKey11111111111111111";
const TOKEN_MINT = "BackfillTokenMint111111111111111111111111111";
const VAULT = "BackfillVaultAddress1111111111111111111111";

/**
 * Split the migration into statements so it can run through the pooled client,
 * which binds parameters and therefore speaks the extended protocol (one
 * statement per round trip). Uses the migration runner's own splitter rather
 * than a local one, so this test cannot disagree with the shipped tool about
 * where a statement ends.
 */
function backfillStatements(file: string = BACKFILL_SQL): string[] {
  return splitSqlStatements(readFileSync(file, "utf8"));
}

async function runBackfill(db: AppDb, file: string = BACKFILL_SQL): Promise<void> {
  for (const statement of backfillStatements(file)) {
    await db.prepare(statement).run();
  }
}

describe("Earn movement backfill (migration 0064)", () => {
  beforeEach(async () => {
    const db = getDb(env);
    for (const table of [
      "earn_movements",
      "earn_positions",
      "earn_vault_movements",
      "earn_vault_positions",
      "earn_program_withdrawals",
      "earn_provider_wallets",
    ]) {
      await db.prepare(`DELETE FROM ${table} WHERE organization_id = ?`).bind(ORG).run();
    }
    await db.prepare("DELETE FROM custody_wallets WHERE id = ?").bind(WALLET).run();
    await db.prepare("DELETE FROM custody_configs WHERE id = ?").bind(CONFIG).run();
    await db.prepare("DELETE FROM projects WHERE id = ?").bind(PROJECT).run();
    await db.prepare("DELETE FROM organizations WHERE id = ?").bind(ORG).run();
    await db.prepare("DELETE FROM users WHERE id = ?").bind(USER).run();

    await db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'earn-backfill@example.com', 1, 'active')`
      )
      .bind(USER)
      .run();
    await db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'Earn Backfill', 'earn-backfill', 'individual', 'active')`
      )
      .bind(ORG)
      .run();
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Backfill', 'earn-backfill', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT, ORG, USER)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted)
         VALUES (?, ?, NULL, 'local', 'encrypted')`
      )
      .bind(CONFIG, ORG)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, label)
         VALUES (?, ?, 'earn-bf-wallet', ?, 'Backfill wallet')`
      )
      .bind(WALLET, CONFIG, WALLET_PUBKEY)
      .run();
  });

  /**
   * Write the legacy world DIRECTLY, bypassing the repositories, so the rows look
   * exactly like history predating the unified tables: no mirror, no holdings.
   */
  async function seedLegacyHistory(db: AppDb): Promise<void> {
    await db
      .prepare(
        `INSERT INTO earn_provider_wallets
           (id, organization_id, project_id, environment, provider, provider_wallet_ref,
            label, created_by, created_at, updated_at)
         VALUES
           ('epw_bf_labelled', ?, ?, 'production', 'ground', 'gw-bf-1', 'Treasury', ?,
            '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z'),
           ('epw_bf_unlabelled', ?, ?, 'sandbox', 'ground', 'gw-bf-2', NULL, ?,
            '2026-01-03T03:04:05.000Z', '2026-01-03T03:04:05.000Z')`
      )
      .bind(ORG, PROJECT, USER, ORG, PROJECT, USER)
      .run();

    await db
      .prepare(
        `INSERT INTO earn_program_withdrawals
           (id, organization_id, project_id, wallet_id, provider, status,
            amount_requested_usd, amount_paid_usd, fee_usd, token, destination_address,
            failure_reason, request_id, idempotency_fingerprint, provider_reference,
            provider_data, created_by, initiated_by_key_id, created_at, updated_at, completed_at)
         VALUES
           ('earn_program_withdrawal_bf_done', ?, ?, 'epw_bf_labelled', 'ground', 'completed',
            '1000.50', '995.25', '5.25', 'usdc', 'BackfillDest1',
            NULL, 'bf-req-1', 'bf-fp-1', 'gw-withdrawal-bf-1',
            '{"lastObservation":{"status":"completed"}}', ?, 'key_bf',
            '2026-02-01T00:00:00.000Z', '2026-02-01T01:00:00.000Z', '2026-02-01T01:00:00.000Z'),
           ('earn_program_withdrawal_bf_intent', ?, ?, 'epw_bf_unlabelled', 'ground', 'requested',
            '250', NULL, NULL, 'usdt', 'BackfillDest2',
            NULL, 'bf-req-2', 'bf-fp-2', NULL, '{}', NULL, NULL,
            '2026-02-02T00:00:00.000Z', '2026-02-02T00:00:00.000Z', NULL)`
      )
      .bind(ORG, PROJECT, USER, ORG, PROJECT)
      .run();

    await db
      .prepare(
        `INSERT INTO earn_vault_positions
           (id, organization_id, project_id, environment, provider, provider_reference,
            custody_wallet_id, share_mint, token_mint, label, created_by,
            created_at, updated_at, activated_at, closed_at)
         VALUES ('earn_vault_position_bf', ?, ?, 'sandbox', 'kamino', ?, ?,
            'BackfillShareMint', ?, 'USDC vault', ?,
            '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:00.000Z', NULL)`
      )
      .bind(ORG, PROJECT, VAULT, WALLET, TOKEN_MINT, USER)
      .run();

    await db
      .prepare(
        `INSERT INTO earn_vault_movements
           (id, organization_id, project_id, environment, position_id, provider,
            provider_reference, custody_wallet_id, direction, status,
            requested_amount, amount, requested_min_shares_out, min_shares_out, shares,
            signature, signed_transaction, last_valid_block_height, failure_reason,
            request_id, idempotency_fingerprint, created_by, initiated_by_key_id,
            created_at, updated_at, confirmed_at)
         VALUES
           ('earn_vault_movement_bf_pending', ?, ?, 'sandbox', 'earn_vault_position_bf', 'kamino',
            ?, ?, 'deposit', 'pending', '100', '100.000000', '99', '99.000000', NULL,
            'BfSig1', 'BfBytes1', 123456, NULL, 'bf-v-1', 'bf-vfp-1', ?, NULL,
            '2026-03-02T00:00:00.000Z', '2026-03-02T00:00:00.000Z', NULL),
           ('earn_vault_movement_bf_confirmed', ?, ?, 'sandbox', 'earn_vault_position_bf', 'kamino',
            ?, ?, 'deposit', 'confirmed', '300', '300.000000', NULL, NULL, '299.5',
            'BfSig2', 'BfBytes2', 123458, NULL, 'bf-v-2', 'bf-vfp-2', ?, NULL,
            '2026-03-04T00:00:00.000Z', '2026-03-04T00:00:00.000Z', '2026-03-04T00:05:00.000Z')`
      )
      .bind(ORG, PROJECT, VAULT, WALLET, USER, ORG, PROJECT, VAULT, WALLET, USER)
      .run();
  }

  async function ledger(db: AppDb): Promise<EarnMovementRow[]> {
    const result = await db
      .prepare(
        `SELECT * FROM earn_movements WHERE organization_id = ? ORDER BY created_at ASC, id ASC`
      )
      .bind(ORG)
      .all<EarnMovementRow>();
    return result.results ?? [];
  }

  async function holdings(db: AppDb): Promise<EarnPositionRow[]> {
    const result = await db
      .prepare(
        `SELECT * FROM earn_positions WHERE organization_id = ? ORDER BY kind ASC, created_at ASC`
      )
      .bind(ORG)
      .all<EarnPositionRow>();
    return result.results ?? [];
  }

  it("projects every legacy holding and movement, preserving ids, amounts and timestamps", async () => {
    const db = getDb(env);
    await seedLegacyHistory(db);
    await runBackfill(db);

    const positions = await holdings(db);
    expect(positions).toHaveLength(3);
    const custodial = positions.filter((row) => row.kind === "custodial");
    expect(custodial).toHaveLength(2);
    expect(custodial.map((row) => row.provider_wallet_id).sort()).toEqual([
      "epw_bf_labelled",
      "epw_bf_unlabelled",
    ]);
    // Environment travels from the wallet, and each program keeps its own.
    expect(custodial.find((row) => row.provider_wallet_id === "epw_bf_labelled")?.environment).toBe(
      "production"
    );
    expect(
      custodial.find((row) => row.provider_wallet_id === "epw_bf_unlabelled")?.environment
    ).toBe("sandbox");
    // An unlabelled program falls back to its provider wallet ref.
    expect(custodial.find((row) => row.provider_wallet_id === "epw_bf_unlabelled")?.label).toBe(
      "gw-bf-2"
    );

    const vaultPosition = positions.find((row) => row.kind === "vault_direct");
    expect(vaultPosition).toMatchObject({
      // The legacy id is carried, so movement.position_id needs no translation.
      id: "earn_vault_position_bf",
      vault_address: VAULT,
      token_mint: TOKEN_MINT,
      provider_wallet_id: null,
    });

    const rows = await ledger(db);
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.id)).toEqual([
      "earn_program_withdrawal_bf_done",
      "earn_program_withdrawal_bf_intent",
      "earn_vault_movement_bf_pending",
      "earn_vault_movement_bf_confirmed",
    ]);

    const completed = rows[0];
    expect(completed).toMatchObject({
      execution_model: "custodial",
      direction: "withdrawal",
      status: "completed",
      environment: "production",
      denomination: "usd",
      // Byte-identical, not re-formatted: an audit ledger stores what was said.
      amount_requested: "1000.50",
      amount_settled: "995.25",
      fee_amount: "5.25",
      payout_token: "usdc",
      provider_reference: "gw-withdrawal-bf-1",
      settled_at: "2026-02-01T01:00:00.000Z",
      // The migration must not claim the movement happened today.
      created_at: "2026-02-01T00:00:00.000Z",
    });
    expect(completed.position_id).toBe(
      custodial.find((row) => row.provider_wallet_id === "epw_bf_labelled")?.id
    );

    const pending = rows[2];
    expect(pending).toMatchObject({
      execution_model: "vault_direct",
      // 'pending' becomes 'requested': one word, one meaning, both models.
      status: "requested",
      denomination: TOKEN_MINT,
      amount_requested: "100",
      amount_settled: null,
      min_shares_out: "99.000000",
      source_address: WALLET_PUBKEY,
      destination_address: VAULT,
      vault_address: VAULT,
      provider_reference: null,
      created_at: "2026-03-02T00:00:00.000Z",
    });

    const confirmed = rows[3];
    expect(confirmed).toMatchObject({
      status: "confirmed",
      amount_settled: "300.000000",
      shares_out: "299.5",
      confirmed_at: "2026-03-04T00:05:00.000Z",
      // Confirmation is not finalization; the sweep sets settlement honestly
      // rather than the backfill inventing a date SDP never observed.
      settled_at: null,
    });
  });

  it("changes nothing when re-run, which is how the rollout-window gap is closed", async () => {
    const db = getDb(env);
    await seedLegacyHistory(db);
    await runBackfill(db);

    const firstPositions = await holdings(db);
    const firstLedger = await ledger(db);

    await runBackfill(db);
    await runBackfill(db);

    // Same rows, same ids, same everything — including the minted custodial
    // holdings, whose ids are generated rather than carried and so are the one
    // thing a careless re-run would duplicate.
    expect(await holdings(db)).toEqual(firstPositions);
    expect(await ledger(db)).toEqual(firstLedger);
  });

  it("sweeps up a legacy row written after the first pass, leaving mirrored rows alone", async () => {
    const db = getDb(env);
    await seedLegacyHistory(db);
    await runBackfill(db);
    const before = await ledger(db);

    // Exactly the rollout window: the outgoing revision writes legacy only.
    await db
      .prepare(
        `INSERT INTO earn_vault_movements
           (id, organization_id, project_id, environment, position_id, provider,
            provider_reference, custody_wallet_id, direction, status,
            requested_amount, amount, signature, signed_transaction,
            last_valid_block_height, request_id, idempotency_fingerprint,
            created_at, updated_at)
         VALUES ('earn_vault_movement_bf_late', ?, ?, 'sandbox', 'earn_vault_position_bf',
            'kamino', ?, ?, 'deposit', 'submitted', '42', '42.000000',
            'BfSigLate', 'BfBytesLate', 999999, 'bf-v-late', 'bf-vfp-late',
            '2026-03-10T00:00:00.000Z', '2026-03-10T00:00:00.000Z')`
      )
      .bind(ORG, PROJECT, VAULT, WALLET)
      .run();

    await runBackfill(db);

    const after = await ledger(db);
    expect(after).toHaveLength(before.length + 1);
    expect(after.find((row) => row.id === "earn_vault_movement_bf_late")).toMatchObject({
      status: "submitted",
      amount_requested: "42",
      denomination: TOKEN_MINT,
    });
    // Rows that were already correct are untouched by the sweep.
    for (const row of before) {
      expect(after.find((candidate) => candidate.id === row.id)).toEqual(row);
    }
  });

  it("does not resurrect a ledger row whose legacy row was hard-deleted", async () => {
    const db = getDb(env);
    await seedLegacyHistory(db);
    await runBackfill(db);

    await db
      .prepare("DELETE FROM earn_vault_movements WHERE id = ?")
      .bind("earn_vault_movement_bf_pending")
      .run();
    await runBackfill(db);

    // The backfill projects what legacy holds; it is not a resurrection tool, and
    // the ledger row it already wrote stays as the durable record.
    const rows = await ledger(db);
    expect(rows.map((row) => row.id)).toContain("earn_vault_movement_bf_pending");
    expect(rows).toHaveLength(4);
  });

  it("sweeps a rollout-window row through the LATER migration exactly as the first pass would", async () => {
    const db = getDb(env);
    await seedLegacyHistory(db);
    await runBackfill(db);
    const before = await ledger(db);

    // The window 0065 exists for: migrations finish before the new revision takes
    // traffic, so the outgoing revision writes legacy alone for a moment.
    await db
      .prepare(
        `INSERT INTO earn_vault_movements
           (id, organization_id, project_id, environment, position_id, provider,
            provider_reference, custody_wallet_id, direction, status,
            requested_amount, amount, signature, signed_transaction,
            last_valid_block_height, request_id, idempotency_fingerprint,
            created_at, updated_at)
         VALUES ('earn_vault_movement_bf_window', ?, ?, 'sandbox', 'earn_vault_position_bf',
            'kamino', ?, ?, 'deposit', 'pending', '7', '7.000000',
            'BfSigWindow', 'BfBytesWindow', 424242, 'bf-v-window', 'bf-vfp-window',
            '2026-03-20T00:00:00.000Z', '2026-03-20T00:00:00.000Z')`
      )
      .bind(ORG, PROJECT, VAULT, WALLET)
      .run();

    await runBackfill(db, BACKFILL_SWEEP_SQL);

    const after = await ledger(db);
    expect(after).toHaveLength(before.length + 1);
    expect(after.find((row) => row.id === "earn_vault_movement_bf_window")).toMatchObject({
      status: "requested",
      amount_requested: "7",
      denomination: TOKEN_MINT,
      source_address: WALLET_PUBKEY,
    });
    // Sources that did not change after the first pass remain byte-identical.
    for (const row of before) {
      expect(after.find((candidate) => candidate.id === row.id)).toEqual(row);
    }

    // And it is itself idempotent, because it will run on databases that already
    // have nothing left to sweep.
    await runBackfill(db, BACKFILL_SWEEP_SQL);
    expect(await ledger(db)).toEqual(after);
  });

  it("refreshes rollout-window updates without changing ids or regressing finalization", async () => {
    const db = getDb(env);
    await seedLegacyHistory(db);
    await runBackfill(db);

    const beforePositions = await holdings(db);
    const beforeLedger = await ledger(db);

    // The outgoing legacy-only revision can advance rows that 0064 already
    // projected. Exercise both execution models and the vault holding state that
    // changes alongside terminal movement transitions.
    await db
      .prepare(
        `UPDATE earn_provider_wallets
            SET label = 'Treasury refreshed',
                updated_at = '2026-04-01T00:00:00.000Z'
          WHERE id = 'epw_bf_labelled'`
      )
      .run();
    await db
      .prepare(
        `UPDATE earn_vault_positions
            SET label = 'USDC vault refreshed',
                closed_at = '2026-04-01T00:05:00.000Z',
                updated_at = '2026-04-01T00:05:00.000Z'
          WHERE id = 'earn_vault_position_bf'`
      )
      .run();
    await db
      .prepare(
        `UPDATE earn_program_withdrawals
            SET status = 'completed',
                amount_paid_usd = '245',
                fee_usd = '5',
                provider_reference = 'gw-withdrawal-bf-2',
                provider_data = '{"lastObservation":{"status":"completed"}}'::jsonb,
                completed_at = '2026-04-02T00:00:00.000Z',
                updated_at = '2026-04-02T00:00:00.000Z'
          WHERE id = 'earn_program_withdrawal_bf_intent'`
      )
      .run();
    await db
      .prepare(
        `UPDATE earn_vault_movements
            SET status = 'confirmed',
                shares = '99.75',
                confirmed_at = '2026-04-03T00:00:00.000Z',
                updated_at = '2026-04-03T00:00:00.000Z'
          WHERE id = 'earn_vault_movement_bf_pending'`
      )
      .run();

    // `finalized` exists only in the unified ledger. Even a newer legacy
    // observation must not project `confirmed` back over it or erase settlement.
    await db
      .prepare(
        `UPDATE earn_movements
            SET status = 'finalized',
                settled_at = '2026-04-04T00:00:00.000Z',
                updated_at = '2026-04-04T00:00:00.000Z'
          WHERE id = 'earn_vault_movement_bf_confirmed'`
      )
      .run();
    await db
      .prepare(
        `UPDATE earn_vault_movements
            SET shares = '299.75',
                updated_at = '2026-04-05T00:00:00.000Z'
          WHERE id = 'earn_vault_movement_bf_confirmed'`
      )
      .run();

    await runBackfill(db, BACKFILL_SWEEP_SQL);

    const afterPositions = await holdings(db);
    const afterLedger = await ledger(db);
    expect(afterPositions.map((row) => row.id).sort()).toEqual(
      beforePositions.map((row) => row.id).sort()
    );
    expect(afterLedger.map((row) => row.id).sort()).toEqual(
      beforeLedger.map((row) => row.id).sort()
    );

    expect(
      afterPositions.find((row) => row.provider_wallet_id === "epw_bf_labelled")
    ).toMatchObject({
      id: beforePositions.find((row) => row.provider_wallet_id === "epw_bf_labelled")?.id,
      label: "Treasury refreshed",
      updated_at: "2026-04-01T00:00:00.000Z",
    });
    expect(afterPositions.find((row) => row.id === "earn_vault_position_bf")).toMatchObject({
      label: "USDC vault refreshed",
      closed_at: "2026-04-01T00:05:00.000Z",
      updated_at: "2026-04-01T00:05:00.000Z",
    });

    expect(afterLedger.find((row) => row.id === "earn_program_withdrawal_bf_intent")).toMatchObject(
      {
        status: "completed",
        amount_settled: "245",
        fee_amount: "5",
        provider_reference: "gw-withdrawal-bf-2",
        provider_data: { lastObservation: { status: "completed" } },
        settled_at: "2026-04-02T00:00:00.000Z",
        updated_at: "2026-04-02T00:00:00.000Z",
      }
    );
    expect(afterLedger.find((row) => row.id === "earn_vault_movement_bf_pending")).toMatchObject({
      status: "confirmed",
      amount_settled: "100.000000",
      shares_out: "99.75",
      confirmed_at: "2026-04-03T00:00:00.000Z",
      updated_at: "2026-04-03T00:00:00.000Z",
    });
    expect(afterLedger.find((row) => row.id === "earn_vault_movement_bf_confirmed")).toMatchObject({
      status: "finalized",
      shares_out: "299.5",
      settled_at: "2026-04-04T00:00:00.000Z",
      updated_at: "2026-04-04T00:00:00.000Z",
    });

    // The convergence pass is itself repeatable: once source and projection agree,
    // another run changes neither data nor canonical ids.
    await runBackfill(db, BACKFILL_SWEEP_SQL);
    expect(await holdings(db)).toEqual(afterPositions);
    expect(await ledger(db)).toEqual(afterLedger);
  });
});
