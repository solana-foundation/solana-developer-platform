import { readFileSync } from "node:fs";
import path from "node:path";
import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import {
  EARN_EXECUTION_MODELS,
  EARN_MOVEMENT_DIRECTIONS,
  EARN_MOVEMENT_STATUSES,
  EARN_MOVEMENT_TRANSITIONS,
  EARN_TERMINAL_MOVEMENT_STATUSES,
} from "@sdp/types/earn";
import { beforeEach, describe, expect, it } from "vitest";
import { asTransactionalClient, getDb } from "@/db/client";
import { insertTestCustodyConfigRow, insertTestCustodyWalletRow } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import {
  type CreateSignedVaultDepositIntentInput,
  createPostgresEarnMovementsRepository,
  EARN_POSITION_ID_PREFIX,
  type EarnMovementRow,
  type EarnMovementsRepository,
  type EarnPositionRow,
  generateEarnPositionId,
} from "./earn-movements.repository";
import { createPostgresEarnWalletTransactionsRepository } from "./earn-wallet-transactions.repository";

/**
 * The unified movement ledger (PRO-1705).
 *
 * Prove atomic signed-intent persistence, exact amount accounting, settlement
 * evidence, idempotency and environment isolation for strategy operations.
 */

const ORG = "org_earn_mv";
const ORG_OTHER = "org_earn_mv_other";
const USER = "usr_earn_mv";
const PROJECT = "prj_earn_mv";
const WALLET = "cw_earn_mv";
const CONFIG = "cc_earn_mv";
const TOKEN_MINT = "TokenMint1111111111111111111111111111111111";
const SHARE_MINT = "ShareMint1111111111111111111111111111111111";
// Exposure spans organizations, so this vault must be unique to the suite.
const VAULT = "EarnMovementVault11111111111111111111111111";
const WALLET_PUBKEY = "DepositorPublicKey11111111111111111111111111";
const WALLET_OWNER = "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF";
const PROJECT_BY_ENVIRONMENT = {
  sandbox: PROJECT,
  production: `${PROJECT}_production`,
} as const satisfies Record<SdpEnvironment, string>;

describe("Unified earn movement ledger (postgres)", () => {
  let ledger: EarnMovementsRepository;
  let sequence = 0;

  async function movements(): Promise<EarnMovementRow[]> {
    const result = await getDb(env)
      .prepare(
        `SELECT * FROM earn_movements WHERE organization_id IN (?, ?)
         ORDER BY created_at ASC, id ASC`
      )
      .bind(ORG, ORG_OTHER)
      .all<EarnMovementRow>();
    return result.results ?? [];
  }

  async function positions(): Promise<EarnPositionRow[]> {
    const result = await getDb(env)
      .prepare(
        `SELECT * FROM earn_positions WHERE organization_id IN (?, ?)
         ORDER BY kind ASC, created_at ASC, id ASC`
      )
      .bind(ORG, ORG_OTHER)
      .all<EarnPositionRow>();
    return result.results ?? [];
  }

  async function onlyMovement(): Promise<EarnMovementRow> {
    const rows = await movements();
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  beforeEach(async () => {
    const db = getDb(env);

    for (const table of ["earn_wallet_transactions", "earn_movements", "earn_positions"]) {
      await db
        .prepare(`DELETE FROM ${table} WHERE organization_id IN (?, ?)`)
        .bind(ORG, ORG_OTHER)
        .run();
    }
    await db.prepare("DELETE FROM custody_wallets WHERE id = ?").bind(WALLET).run();
    await db.prepare("DELETE FROM custody_configs WHERE id = ?").bind(CONFIG).run();
    await db.prepare("DELETE FROM projects WHERE id = ?").bind(PROJECT).run();
    await db.prepare("DELETE FROM organizations WHERE id IN (?, ?)").bind(ORG, ORG_OTHER).run();
    await db.prepare("DELETE FROM users WHERE id = ?").bind(USER).run();

    await db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'earn-movements@example.com', 1, 'active')`
      )
      .bind(USER)
      .run();
    await db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status) VALUES
           (?, 'Earn Movements', 'earn-movements', 'individual', 'active'),
           (?, 'Earn Movements Other', 'earn-movements-other', 'individual', 'active')`
      )
      .bind(ORG, ORG_OTHER)
      .run();
    await seedDefaultProjects(db, {
      organizationId: ORG,
      createdBy: USER,
      members: [],
      ids: { sandbox: PROJECT, production: `${PROJECT}_production` },
    });
    await seedDefaultProjects(db, {
      organizationId: ORG_OTHER,
      createdBy: USER,
      members: [],
      ids: { sandbox: "prj_earn_mv_other", production: "prj_earn_mv_other_production" },
    });
    await insertTestCustodyConfigRow(db, {
      id: CONFIG,
      organizationId: ORG,
      projectId: PROJECT,
      provider: "local",
      configEncrypted: "encrypted",
      status: "active",
    });
    await insertTestCustodyWalletRow(db, {
      id: WALLET,
      owner: { kind: "config", custodyConfigId: CONFIG },
      walletId: "earn-mv-wallet",
      publicKey: WALLET_PUBKEY,
      label: "Earn movements wallet",
      purpose: null,
      status: "active",
    });

    ledger = createPostgresEarnMovementsRepository(db);
    sequence = 0;
  });

  function intent(
    overrides: Partial<CreateSignedVaultDepositIntentInput> = {}
  ): CreateSignedVaultDepositIntentInput {
    sequence += 1;
    return {
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      provider: "kamino",
      vaultAddress: VAULT,
      sourceAddress: WALLET_PUBKEY,
      custodyWalletId: WALLET,
      shareMint: SHARE_MINT,
      tokenMint: TOKEN_MINT,
      label: "USDC vault",
      requestedAmount: "100",
      acceptedMinSharesOut: "99.000000",
      signature: `earn-mv-signature-${sequence}`,
      signedTransaction: `earn-mv-transaction-${sequence}`,
      lastValidBlockHeight: "123456",
      requestId: `earn-mv-request-${sequence}`,
      idempotencyFingerprint: `earn-mv-fingerprint-${sequence}`,
      createdBy: USER,
      initiatedByKeyId: null,
      ...overrides,
    };
  }

  describe("provider settlement accounting", () => {
    it("records a cancelled redemption as returned shares with zero payout", async () => {
      const { position } = await ledger.createSignedVaultDepositIntent(
        intent({ provider: "plume" })
      );
      const { movement } = await ledger.createSignedVaultWithdrawalIntent({
        organizationId: ORG,
        projectId: PROJECT,
        environment: "sandbox",
        provider: "plume",
        positionId: position.id,
        vaultAddress: VAULT,
        custodyWalletId: WALLET,
        shareMint: SHARE_MINT,
        requestedShares: "10",
        walletAddress: WALLET_PUBKEY,
        signature: "cancel-parent-source",
        signedTransaction: "signed",
        lastValidBlockHeight: "123456",
        requestId: "withdraw-key",
        idempotencyFingerprint: "withdraw-fingerprint",
        redemptionMode: "standard",
      });
      expect(movement.provider_data.redemptionMode).toBe("standard");
      await expect(
        ledger.advanceVaultMovement({
          organizationId: ORG,
          movementId: movement.id,
          toStatus: "finalized",
          confirmedAt: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          tokenAmountSettled: "0",
        })
      ).rejects.toThrow();
      const settled = await ledger.advanceVaultMovement({
        organizationId: ORG,
        movementId: movement.id,
        toStatus: "finalized",
        confirmedAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
        providerSettlement: {
          outcome: "cancelled",
          sourceSignature: "cancel-parent-source",
          destinationSignature: "share-return",
          ownerAddress: WALLET_PUBKEY,
          providerReference: VAULT,
          tokenMint: SHARE_MINT,
          amount: "10",
          observedSlot: "42",
        },
      });
      expect(settled?.amount_settled).toBe("0");
      expect(settled?.token_amount_settled).toBe("0");
      expect(settled?.provider_data.providerSettlement).toMatchObject({
        outcome: "cancelled",
        amount: "10",
      });
    });
  });

  describe("vocabulary conformance", () => {
    it("seeds exactly the execution models, directions and statuses @sdp/types declares", async () => {
      const db = getDb(env);

      const models = await db
        .prepare("SELECT id FROM earn_execution_models ORDER BY id")
        .all<{ id: string }>();
      expect((models.results ?? []).map((row) => row.id)).toEqual(
        [...EARN_EXECUTION_MODELS].sort()
      );

      const directions = await db
        .prepare("SELECT id FROM earn_movement_directions ORDER BY id")
        .all<{ id: string }>();
      expect((directions.results ?? []).map((row) => row.id)).toEqual(
        [...EARN_MOVEMENT_DIRECTIONS].sort()
      );

      const statuses = await db
        .prepare(
          "SELECT execution_model, status, is_terminal FROM earn_movement_statuses ORDER BY execution_model, status"
        )
        .all<{ execution_model: string; status: string; is_terminal: boolean }>();

      // Set equality in BOTH directions: a status seeded but not declared is as
      // much a drift as one declared but not seeded.
      const expected = EARN_EXECUTION_MODELS.flatMap((model) =>
        EARN_MOVEMENT_STATUSES[model].map((status) => ({
          execution_model: model,
          status,
          is_terminal: (EARN_TERMINAL_MOVEMENT_STATUSES[model] as readonly string[]).includes(
            status
          ),
        }))
      ).sort((left, right) =>
        `${left.execution_model}${left.status}`.localeCompare(
          `${right.execution_model}${right.status}`
        )
      );
      expect(statuses.results ?? []).toEqual(expected);
    });

    it("declares no transition into or out of a status the database does not know", async () => {
      const db = getDb(env);
      const rows = await db
        .prepare("SELECT execution_model, status FROM earn_movement_statuses")
        .all<{ execution_model: string; status: string }>();
      const known = new Set(
        (rows.results ?? []).map((row) => `${row.execution_model}:${row.status}`)
      );

      for (const model of EARN_EXECUTION_MODELS) {
        const matrix: Record<string, readonly string[]> = EARN_MOVEMENT_TRANSITIONS[model];
        for (const [target, sources] of Object.entries(matrix)) {
          expect(known).toContain(`${model}:${target}`);
          for (const source of sources) expect(known).toContain(`${model}:${source}`);
        }
      }
    });

    it("never lists a terminal status as a transition source", () => {
      for (const model of EARN_EXECUTION_MODELS) {
        const terminal = EARN_TERMINAL_MOVEMENT_STATUSES[model] as readonly string[];
        const matrix: Record<string, readonly string[]> = EARN_MOVEMENT_TRANSITIONS[model];
        for (const sources of Object.values(matrix)) {
          for (const source of sources) expect(terminal).not.toContain(source);
        }
      }
    });

    it("declares no vault transition migration 0062's CHECK constraints forbid", () => {
      // The matrix and the schema have to agree, not merely be internally
      // consistent. `confirmed_at` and `shares_out` are tied to the commitment
      // states, so a transition OUT of 'confirmed' into a state that may not hold
      // them could only be written by erasing an observation SDP actually made.
      for (const [target, sources] of Object.entries(EARN_MOVEMENT_TRANSITIONS.vault_direct)) {
        if (target === "finalized") continue;
        expect(sources).not.toContain("confirmed");
      }
    });
  });

  describe("minted id shape", () => {
    it("mints holding ids under the same prefix the backfill migration writes", () => {
      const backfill = readFileSync(
        path.join(__dirname, "../migrations/postgres/0064_earn_movements_backfill.sql"),
        "utf8"
      );
      expect(generateEarnPositionId()).toMatch(new RegExp(`^${EARN_POSITION_ID_PREFIX}`));
      // 0064 mints in SQL and cannot import the constant, so the literal is
      // pinned here instead.
      expect(backfill).toContain(`'${EARN_POSITION_ID_PREFIX}' || gen_random_uuid()`);
    });
  });

  describe("vault deposits", () => {
    it("claims untouched deposits before a larger retry backlog and spaces every retry", async () => {
      const now = Date.now();
      const retryBefore = new Date(now - 15 * 60_000).toISOString();
      const retried: string[] = [];
      const untouched: string[] = [];
      for (let index = 0; index < 5; index++) {
        const created = await ledger.createSignedVaultDepositIntent(intent());
        const settledAt = new Date(now - (120 - index) * 60_000).toISOString();
        await ledger.advanceVaultMovement({
          movementId: created.movement.id,
          organizationId: ORG,
          toStatus: "finalized",
          confirmedAt: settledAt,
          settledAt,
        });
        if (index < 3) {
          retried.push(created.movement.id);
          await getDb(env)
            .prepare("UPDATE earn_movements SET reconciliation_attempted_at = ? WHERE id = ?")
            .bind(new Date(now - (60 - index) * 60_000).toISOString(), created.movement.id)
            .run();
        } else {
          untouched.push(created.movement.id);
          // New deposits settled after all of the old rows' unsuccessful attempts.
          await getDb(env)
            .prepare("UPDATE earn_movements SET settled_at = ? WHERE id = ?")
            .bind(new Date(now - (5 - index) * 60_000).toISOString(), created.movement.id)
            .run();
        }
      }

      const claimIds = async (limit: number) =>
        (
          await ledger.claimUnvaluedKaminoDeposits({ environment: "sandbox", limit, retryBefore })
        ).map((row) => row.id);
      expect(new Set(await claimIds(2))).toEqual(new Set(untouched));
      expect(new Set(await claimIds(2))).toEqual(new Set(retried.slice(0, 2)));
      expect(await claimIds(2)).toEqual(retried.slice(2));
      expect(await claimIds(2)).toEqual([]);
      // Failed observations are delayed, never discarded or treated as valued.
      expect(
        await ledger.claimUnvaluedKaminoDeposits({
          environment: "sandbox",
          limit: 5,
          retryBefore: new Date(Date.now() + 1_000).toISOString(),
        })
      ).toHaveLength(5);
    });

    it("keeps a finalized Kamino amount unknown until a scoped receipt is recorded once", async () => {
      const created = await ledger.createSignedVaultDepositIntent(intent());
      const observedAt = new Date().toISOString();
      await ledger.advanceVaultMovement({
        movementId: created.movement.id,
        organizationId: ORG,
        toStatus: "finalized",
        confirmedAt: observedAt,
        settledAt: observedAt,
      });
      expect(await onlyMovement()).toMatchObject({
        amount_requested: "100",
        amount_settled: null,
        token_amount_settled: null,
      });
      const receipt = {
        movementId: created.movement.id,
        organizationId: ORG,
        amount: "3",
        sharesOut: "2.9",
      };
      expect(
        await ledger.recordKaminoDepositReceipt({ ...receipt, organizationId: ORG_OTHER })
      ).toBe(false);
      expect(await ledger.recordKaminoDepositReceipt({ ...receipt, amount: "100.000001" })).toBe(
        false
      );
      expect(await ledger.recordKaminoDepositReceipt(receipt)).toBe(true);
      expect(await ledger.recordKaminoDepositReceipt({ ...receipt, amount: "4" })).toBe(false);
      expect(await onlyMovement()).toMatchObject({
        amount_requested: "100",
        amount_settled: "3",
        token_amount_settled: "3",
        shares_out: "2.9",
      });
      expect(
        await ledger.sumVaultDepositExposure({
          environment: "sandbox",
          provider: "kamino",
          vaultAddress: VAULT,
        })
      ).toBe("3");
    });

    it("finalizes a provider deposit with the verified share amount in one step", async () => {
      // Mirrors reconcileEarnProviderOrders: a provider-order deposit whose
      // delivery the chain verifies goes straight to finalized, carrying the
      // observed share amount — no separate confirmation stop exists to hold it.
      const created = await ledger.createSignedVaultDepositIntent(
        intent({ provider: "plume", signature: "plume-delivery-source" })
      );
      const observedAt = new Date().toISOString();
      await ledger.advanceVaultMovement({
        movementId: created.movement.id,
        organizationId: ORG,
        toStatus: "finalized",
        confirmedAt: observedAt,
        settledAt: observedAt,
        sharesOut: "97.5",
        providerSettlement: {
          outcome: "delivered",
          sourceSignature: "plume-delivery-source",
          destinationSignature: "plume-delivery-destination",
          ownerAddress: WALLET_PUBKEY,
          providerReference: VAULT,
          tokenMint: SHARE_MINT,
          amount: "97.5",
          observedSlot: "123456789",
        },
      });
      expect(await onlyMovement()).toMatchObject({
        status: "finalized",
        shares_out: "97.5",
        settled_at: observedAt,
        confirmed_at: observedAt,
        provider_data: {
          providerSettlement: expect.objectContaining({
            outcome: "delivered",
            amount: "97.5",
          }),
        },
      });
    });

    it("hides legacy projections and rejects premature receipt provenance", async () => {
      const created = await ledger.createSignedVaultDepositIntent(intent());
      await getDb(env)
        .prepare("UPDATE earn_movements SET amount_settled = amount_requested WHERE id = ?")
        .bind(created.movement.id)
        .run();
      expect(
        await ledger.getMovementById({ organizationId: ORG, movementId: created.movement.id })
      ).toMatchObject({ amount_settled: null });
      await expect(
        getDb(env)
          .prepare(
            "UPDATE earn_movements SET deposit_receipt_observed_at = sdp_iso_now() WHERE id = ?"
          )
          .bind(created.movement.id)
          .run()
      ).rejects.toThrow(/kamino_deposit_receipt_check/);
      await expect(
        ledger.advanceVaultMovement({
          movementId: created.movement.id,
          organizationId: ORG,
          toStatus: "confirmed",
          confirmedAt: new Date().toISOString(),
          depositReceipt: { amount: "3", sharesOut: "2.9" },
        })
      ).rejects.toThrow(/finalized/);
    });

    it("migration 0121 preserves old-revision writes while new readers repair historical guesses", async () => {
      const created = await ledger.createSignedVaultDepositIntent(intent());
      const observedAt = new Date().toISOString();
      await ledger.advanceVaultMovement({
        movementId: created.movement.id,
        organizationId: ORG,
        toStatus: "finalized",
        confirmedAt: observedAt,
        settledAt: observedAt,
      });
      const migration = readFileSync(
        path.join(__dirname, "../migrations/postgres/0121_earn_kamino_deposit_receipts.sql"),
        "utf8"
      );
      // The repair index builds CONCURRENTLY on the live ledger, so it lives in
      // its own non-transactional migration and cannot run inside this block.
      const indexMigration = readFileSync(
        path.join(__dirname, "../migrations/postgres/0122_earn_kamino_receipt_repair_index.sql"),
        "utf8"
      );
      expect(indexMigration).toMatch(/^-- sdp:migration-mode: non-transactional$/m);
      expect(indexMigration).toContain(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_earn_movements_kamino_receipt_repair"
      );
      await getDb(env).transaction(async (tx) => {
        // Connection-local copies let the actual migration run against old data
        // without changing other tests' tables or dropping live constraints.
        await tx.execute(
          "CREATE TEMP TABLE earn_movements ON COMMIT DROP AS SELECT * FROM public.earn_movements WHERE id = ?",
          [created.movement.id]
        );
        // Re-add later columns after 0121 so SELECT * keeps the public table's
        // column order when this connection reuses a named repository query.
        await tx.execute("ALTER TABLE earn_movements DROP COLUMN strategy_reference");
        await tx.execute("ALTER TABLE earn_movements DROP COLUMN deposit_receipt_observed_at");
        await tx.execute(
          "UPDATE earn_movements SET amount_settled = amount_requested, token_amount_settled = amount_requested, shares_out = '99'"
        );
        await tx.execute(migration);
        await tx.execute("ALTER TABLE earn_movements ADD COLUMN strategy_reference TEXT");
        expect(
          await tx.queryOne(
            "SELECT amount_requested, amount_settled, token_amount_settled, shares_out, status, signature FROM earn_movements"
          )
        ).toMatchObject({
          amount_requested: "100",
          amount_settled: "100",
          token_amount_settled: "100",
          shares_out: "99",
          status: "finalized",
          signature: created.movement.signature,
        });
        const migratedLedger = createPostgresEarnMovementsRepository(asTransactionalClient(tx));
        const scope = { organizationId: ORG, movementId: created.movement.id };
        expect(await migratedLedger.getMovementById(scope)).toMatchObject({
          amount_settled: null,
          token_amount_settled: null,
          shares_out: null,
        });
        expect(
          await migratedLedger.claimUnvaluedKaminoDeposits({
            environment: "sandbox",
            limit: 1,
            retryBefore: new Date().toISOString(),
          })
        ).toHaveLength(1);
        expect(
          await migratedLedger.recordKaminoDepositReceipt({
            ...scope,
            amount: "3",
            sharesOut: "2.9",
          })
        ).toBe(true);
        expect(await migratedLedger.getMovementById(scope)).toMatchObject({
          amount_requested: "100",
          amount_settled: "3",
          token_amount_settled: "3",
          shares_out: "2.9",
        });
      });
    });

    it("projects the holding and the movement, with mint-denominated amounts", async () => {
      const created = await ledger.createSignedVaultDepositIntent(intent());

      const [position] = await positions();
      expect(position).toMatchObject({
        id: created.position.id,
        kind: "vault_direct",
        organization_id: ORG,
        project_id: PROJECT,
        environment: "sandbox",
        provider: "kamino",
        custody_wallet_id: WALLET,
        vault_address: VAULT,
        token_mint: TOKEN_MINT,
        share_mint: SHARE_MINT,
      });
      expect(position.activated_at).not.toBeNull();

      const movement = await onlyMovement();
      expect(movement).toMatchObject({
        // The legacy id is preserved, which is what keeps every stored reference
        // and GET-by-id working when reads switch.
        id: created.movement.id,
        position_id: created.position.id,
        execution_model: "vault_direct",
        direction: "deposit",
        // 0059's 'pending' under the one word both models share.
        status: "requested",
        denomination: TOKEN_MINT,
        amount_requested: "100",
        amount_settled: null,
        min_shares_out: "99.000000",
        shares_out: null,
        custody_wallet_id: WALLET,
        vault_address: VAULT,
        source_address: WALLET_PUBKEY,
        destination_address: VAULT,
        // A vault movement has no provider-side movement id; the vault is the
        // instrument and lives in vault_address.
        provider_reference: null,
        signature: created.movement.signature,
        request_id: created.movement.request_id,
        idempotency_fingerprint: created.movement.idempotency_fingerprint,
        payout_token: null,
        fee_amount: null,
      });
      expect(movement.created_at).toBe(created.movement.created_at);
      expect(movement.last_valid_block_height).toBe("123456");
    });

    it("advances through submitted, confirmed and finalized", async () => {
      const created = await ledger.createSignedVaultDepositIntent(intent());

      await ledger.advanceVaultMovement({
        movementId: created.movement.id,
        organizationId: ORG,
        toStatus: "submitted",
      });
      expect((await onlyMovement()).status).toBe("submitted");

      const confirmedAt = "2026-08-19T12:00:00.000Z";
      await ledger.advanceVaultMovement({
        movementId: created.movement.id,
        organizationId: ORG,
        toStatus: "confirmed",
        confirmedAt,
        sharesOut: "99.5",
      });
      expect(await onlyMovement()).toMatchObject({
        status: "confirmed",
        confirmed_at: confirmedAt,
        shares_out: "99.5",
        // Confirmation does not establish how much of Kamino's maximum moved.
        amount_settled: null,
        // Commitment is not settlement, so nothing is settled yet.
        settled_at: null,
      });

      const settledAt = "2026-08-19T12:30:00.000Z";
      await ledger.advanceVaultMovement({
        movementId: created.movement.id,
        organizationId: ORG,
        toStatus: "finalized",
        confirmedAt: settledAt,
        settledAt,
        depositReceipt: { amount: "100", sharesOut: "99.5" },
      });
      expect(await onlyMovement()).toMatchObject({
        status: "finalized",
        settled_at: settledAt,
        amount_settled: "100",
        // The moment commitment was ACTUALLY observed survives finalization; the
        // writer coalesces rather than overwriting it.
        confirmed_at: confirmedAt,
      });
    });

    it("mirrors a failure and the holding de-activation it triggers", async () => {
      const created = await ledger.createSignedVaultDepositIntent(intent());

      await ledger.advanceVaultMovement({
        movementId: created.movement.id,
        organizationId: ORG,
        toStatus: "failed",
        failureReason: "Transaction blockhash expired before confirmation",
      });

      const movement = await onlyMovement();
      expect(movement).toMatchObject({
        status: "failed",
        failure_reason: "Transaction blockhash expired before confirmation",
        confirmed_at: null,
        settled_at: null,
        // Nothing moved, so nothing is ever reported as settled.
        amount_settled: null,
      });
      // The only movement failed, so the holding loses its activation — and the
      // mirror has to reflect that, not just the movement's own state.
      const [position] = await positions();
      expect(position.activated_at).toBeNull();
    });

    it("leaves the mirror untouched when a guarded transition loses its race", async () => {
      const created = await ledger.createSignedVaultDepositIntent(intent());
      await ledger.advanceVaultMovement({
        movementId: created.movement.id,
        organizationId: ORG,
        toStatus: "confirmed",
        confirmedAt: "2026-08-19T12:00:00.000Z",
      });

      const lost = await ledger.advanceVaultMovement({
        movementId: created.movement.id,
        organizationId: ORG,
        toStatus: "submitted",
      });

      expect(lost).toBeNull();
      // A lost CAS wrote nothing legacy-side, so it must write nothing here: a
      // mirror that "helpfully" re-projected would regress a terminal state.
      expect((await onlyMovement()).status).toBe("confirmed");
    });

    it("records many deposits against one holding, and re-entry after a close", async () => {
      const db = getDb(env);
      const first = await ledger.createSignedVaultDepositIntent(intent());
      const second = await ledger.createSignedVaultDepositIntent(
        intent({ requestedAmount: "250" })
      );

      // Topping up the same vault from the same wallet is one HOLDING with many
      // movements — the grain the whole design turns on.
      expect(second.position.id).toBe(first.position.id);
      expect(await positions()).toHaveLength(1);
      const rows = await movements();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.position_id)).toEqual([first.position.id, first.position.id]);
      expect(rows.map((row) => row.amount_requested)).toEqual(["100", "250"]);

      // A closed holding that is re-entered reuses its row, and the mirror has to
      // follow the reopening rather than leave a stale closed_at behind.
      await db
        .prepare("UPDATE earn_positions SET closed_at = sdp_iso_now() WHERE id = ?")
        .bind(first.position.id)
        .run();
      await ledger.advanceVaultMovement({
        movementId: second.movement.id,
        organizationId: ORG,
        toStatus: "confirmed",
        confirmedAt: "2026-08-19T12:00:00.000Z",
      });

      const [reopened] = await positions();
      expect(reopened.closed_at).toBeNull();
      expect(reopened.activated_at).not.toBeNull();
    });

    it("refuses to close a holding while one of its movements is still unsettled", async () => {
      // A read can observe zero shares while a deposit is in flight (recorded,
      // not yet landed). Closing then would hide the position the landing
      // deposit is about to fill, so the guard waits for settlement.
      const created = await ledger.createSignedVaultDepositIntent(intent());
      const [pending] = await positions();
      expect(
        await ledger.closeVaultPositionIfEmpty({
          positionId: created.position.id,
          organizationId: ORG,
          observedUpdatedAt: pending.updated_at,
        })
      ).toBe(false);
      expect((await positions())[0].closed_at).toBeNull();

      const settledAt = "2026-08-19T12:30:00.000Z";
      await ledger.advanceVaultMovement({
        movementId: created.movement.id,
        organizationId: ORG,
        toStatus: "finalized",
        confirmedAt: settledAt,
        settledAt,
      });
      const [settled] = await positions();
      expect(
        await ledger.closeVaultPositionIfEmpty({
          positionId: created.position.id,
          organizationId: ORG,
          observedUpdatedAt: settled.updated_at,
        })
      ).toBe(true);
    });

    it("refuses a close whose zero-share snapshot predates a deposit that refilled the holding", async () => {
      const created = await ledger.createSignedVaultDepositIntent(intent());
      const settledAt = "2026-08-19T12:30:00.000Z";
      await ledger.advanceVaultMovement({
        movementId: created.movement.id,
        organizationId: ORG,
        toStatus: "finalized",
        confirmedAt: settledAt,
        settledAt,
      });
      // The observer read the row (and its live balance) here...
      const [observed] = await positions();
      // ...then a second deposit landed before the observer reached the lock.
      const refill = await ledger.createSignedVaultDepositIntent(intent({ requestedAmount: "5" }));
      await ledger.advanceVaultMovement({
        movementId: refill.movement.id,
        organizationId: ORG,
        toStatus: "finalized",
        confirmedAt: "2026-08-19T12:31:00.000Z",
        settledAt: "2026-08-19T12:31:00.000Z",
      });
      expect(
        await ledger.closeVaultPositionIfEmpty({
          positionId: created.position.id,
          organizationId: ORG,
          observedUpdatedAt: observed.updated_at,
        })
      ).toBe(false);
      expect((await positions())[0].closed_at).toBeNull();
    });

    it("closes a holding observed empty and lets a later deposit re-open it", async () => {
      const created = await ledger.createSignedVaultDepositIntent(intent());
      const settledAt = "2026-08-19T12:30:00.000Z";
      await ledger.advanceVaultMovement({
        movementId: created.movement.id,
        organizationId: ORG,
        toStatus: "finalized",
        confirmedAt: settledAt,
        settledAt,
      });
      const [observed] = await positions();

      // The settlement hook observed live shares "0" after an exit: the close
      // is idempotent (second call reports nothing to do) and org-scoped.
      expect(
        await ledger.closeVaultPositionIfEmpty({
          positionId: created.position.id,
          organizationId: ORG_OTHER,
          observedUpdatedAt: observed.updated_at,
        })
      ).toBe(false);
      expect(
        await ledger.closeVaultPositionIfEmpty({
          positionId: created.position.id,
          organizationId: ORG,
          observedUpdatedAt: observed.updated_at,
        })
      ).toBe(true);
      expect(
        await ledger.closeVaultPositionIfEmpty({
          positionId: created.position.id,
          organizationId: ORG,
          observedUpdatedAt: observed.updated_at,
        })
      ).toBe(false);
      const [closed] = await positions();
      expect(closed.closed_at).not.toBeNull();

      // Re-entry reuses the row and the deposit transition clears the close.
      const reentry = await ledger.createSignedVaultDepositIntent(intent({ requestedAmount: "5" }));
      expect(reentry.position.id).toBe(created.position.id);
      await ledger.advanceVaultMovement({
        movementId: reentry.movement.id,
        organizationId: ORG,
        toStatus: "confirmed",
        confirmedAt: "2026-08-20T12:00:00.000Z",
      });
      const [reopened] = await positions();
      expect(reopened.closed_at).toBeNull();
    });

    it("stamps the observed Kamino debit rather than its requested maximum", async () => {
      const deposit = await ledger.createSignedVaultDepositIntent(intent());
      const settledAt = "2026-08-19T12:30:00.000Z";
      // The receipt describes partial acceptance. Generic withdrawal payout
      // metadata cannot override the provider's deposit receipt.
      await ledger.advanceVaultMovement({
        movementId: deposit.movement.id,
        organizationId: ORG,
        toStatus: "finalized",
        confirmedAt: settledAt,
        settledAt,
        tokenAmountSettled: "999",
        depositReceipt: { amount: "99.9", sharesOut: "99.5" },
      });
      expect(await onlyMovement()).toMatchObject({
        amount_requested: "100",
        amount_settled: "99.9",
        token_amount_settled: "99.9",
        shares_out: "99.5",
      });

      const withdrawal = await ledger.createSignedVaultWithdrawalIntent({
        organizationId: ORG,
        projectId: PROJECT,
        environment: "sandbox",
        provider: "kamino",
        positionId: deposit.position.id,
        vaultAddress: VAULT,
        custodyWalletId: WALLET,
        shareMint: SHARE_MINT,
        requestedShares: "40",
        walletAddress: WALLET_PUBKEY,
        signature: `sig_${crypto.randomUUID()}`,
        signedTransaction: "AQ==",
        lastValidBlockHeight: "12345",
        requestId: crypto.randomUUID(),
        idempotencyFingerprint: crypto.randomUUID(),
      });
      // A withdrawal's token amount is only ever what the caller OBSERVED on
      // the landed transaction; shares never leak into the token column.
      await ledger.advanceVaultMovement({
        movementId: withdrawal.movement.id,
        organizationId: ORG,
        toStatus: "finalized",
        confirmedAt: settledAt,
        settledAt,
        tokenAmountSettled: "41.5",
      });
      const rows = await movements();
      expect(rows.find((row) => row.id === withdrawal.movement.id)).toMatchObject({
        direction: "withdrawal",
        amount_settled: "40",
        token_amount_settled: "41.5",
      });
    });

    it("leaves a withdrawal's token amount NULL when no payout was observed", async () => {
      const deposit = await ledger.createSignedVaultDepositIntent(intent());
      const withdrawal = await ledger.createSignedVaultWithdrawalIntent({
        organizationId: ORG,
        projectId: PROJECT,
        environment: "sandbox",
        provider: "kamino",
        positionId: deposit.position.id,
        vaultAddress: VAULT,
        custodyWalletId: WALLET,
        shareMint: SHARE_MINT,
        requestedShares: "40",
        walletAddress: WALLET_PUBKEY,
        signature: `sig_${crypto.randomUUID()}`,
        signedTransaction: "AQ==",
        lastValidBlockHeight: "12345",
        requestId: crypto.randomUUID(),
        idempotencyFingerprint: crypto.randomUUID(),
      });
      const settledAt = "2026-08-19T12:30:00.000Z";
      await ledger.advanceVaultMovement({
        movementId: withdrawal.movement.id,
        organizationId: ORG,
        toStatus: "finalized",
        confirmedAt: settledAt,
        settledAt,
        tokenAmountSettled: null,
      });
      const rows = await movements();
      expect(rows.find((row) => row.id === withdrawal.movement.id)).toMatchObject({
        status: "finalized",
        amount_settled: "40",
        token_amount_settled: null,
      });
      // The observation belongs to finalization and nowhere else.
      await expect(
        ledger.advanceVaultMovement({
          movementId: deposit.movement.id,
          organizationId: ORG,
          toStatus: "confirmed",
          confirmedAt: settledAt,
          tokenAmountSettled: "1",
        })
      ).rejects.toThrow(/tokenAmountSettled is only valid when finalizing/);
    });

    it("gives two organizations holding the same vault separate holdings and ledgers", async () => {
      const db = getDb(env);
      // 0059's founding constraint: a public vault is not claimable by whoever
      // deposits first. The unified holdings table must not quietly reintroduce a
      // global unique that would refuse the second organization.
      await insertTestCustodyConfigRow(db, {
        id: "cc_earn_mv_other",
        organizationId: ORG_OTHER,
        projectId: "prj_earn_mv_other",
        provider: "local",
        configEncrypted: "encrypted",
        status: "active",
      });
      await insertTestCustodyWalletRow(db, {
        id: "cw_earn_mv_other",
        owner: { kind: "config", custodyConfigId: "cc_earn_mv_other" },
        walletId: "other-wallet",
        publicKey: "OtherPubkey1111",
        label: "Other",
        purpose: null,
        status: "active",
      });

      const mine = await ledger.createSignedVaultDepositIntent(intent());
      const theirs = await ledger.createSignedVaultDepositIntent(
        intent({
          organizationId: ORG_OTHER,
          projectId: "prj_earn_mv_other",
          custodyWalletId: "cw_earn_mv_other",
        })
      );

      expect(theirs.position.id).not.toBe(mine.position.id);
      const rows = await positions();
      expect(rows).toHaveLength(2);
      // Same instrument, two holdings, one per organization.
      expect(rows.every((row) => row.vault_address === VAULT)).toBe(true);
      expect(rows.map((row) => row.organization_id).sort()).toEqual([ORG, ORG_OTHER].sort());

      const ledgerRows = await movements();
      expect(ledgerRows).toHaveLength(2);
      expect(ledgerRows.find((row) => row.organization_id === ORG_OTHER)?.position_id).toBe(
        theirs.position.id
      );

      await db
        .prepare("DELETE FROM earn_movements WHERE organization_id = ?")
        .bind(ORG_OTHER)
        .run();
      await db
        .prepare("DELETE FROM earn_positions WHERE organization_id = ?")
        .bind(ORG_OTHER)
        .run();
      await db
        .prepare("DELETE FROM earn_movements WHERE organization_id = ?")
        .bind(ORG_OTHER)
        .run();
      await db
        .prepare("DELETE FROM earn_positions WHERE organization_id = ?")
        .bind(ORG_OTHER)
        .run();
      await db.prepare("DELETE FROM custody_wallets WHERE id = 'cw_earn_mv_other'").run();
      await db.prepare("DELETE FROM custody_configs WHERE id = 'cc_earn_mv_other'").run();
      await db.prepare("DELETE FROM projects WHERE id = 'prj_earn_mv_other'").run();
    });

    it("runs the admission hook inside the transaction, before the claim, and rolls back on its throw", async () => {
      let positionsSeenByHook = -1;
      await expect(
        ledger.createSignedVaultDepositIntent(
          intent({
            admit: async (transaction) => {
              const row = await transaction.queryOne<{ n: number }>(
                "SELECT count(*)::int AS n FROM earn_positions WHERE organization_id = ?",
                [ORG]
              );
              positionsSeenByHook = Number(row?.n);
              throw new Error("admission refused");
            },
          })
        )
      ).rejects.toThrow("admission refused");

      // Nothing was claimed before the hook ran, and nothing survived its throw.
      expect(positionsSeenByHook).toBe(0);
      expect(await positions()).toEqual([]);
      expect(await movements()).toEqual([]);
    });

    it("keeps exactly one ledger row for an idempotent replay", async () => {
      const first = await ledger.createSignedVaultDepositIntent(intent({ requestId: "same-key" }));
      const replay = await ledger.createSignedVaultDepositIntent(
        intent({
          requestId: "same-key",
          idempotencyFingerprint: first.movement.idempotency_fingerprint,
          signature: "a-different-signature-never-broadcast",
        })
      );

      expect(replay.replayed).toBe(true);
      expect(replay.movement.id).toBe(first.movement.id);
      const rows = await movements();
      expect(rows).toHaveLength(1);
      expect(rows[0].signature).toBe(first.movement.signature);
    });

    it("writes no ledger row when a divergent replay rolls the whole claim back", async () => {
      const first = await ledger.createSignedVaultDepositIntent(
        intent({ requestId: "shared-key" })
      );

      await expect(
        ledger.createSignedVaultDepositIntent(
          intent({ requestId: "shared-key", idempotencyFingerprint: "a-different-fingerprint" })
        )
      ).rejects.toThrow(/Idempotency key already used/);

      // The rollback must take the mirror with it — an orphan ledger row for a
      // movement that never existed is exactly the divergence this design bans.
      const rows = await movements();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(first.movement.id);
    });
  });

  describe("idempotency anchors", () => {
    it("scopes the vault anchor to the organization", async () => {
      const db = getDb(env);
      await ledger.createSignedVaultDepositIntent(intent({ requestId: "shared-request-id" }));
      expect(await movements()).toHaveLength(1);

      // Vault: org-scoped, so a retry resolving to a different position is still
      // a key reuse and must not silently open a second movement.
      const duplicate = await db
        .prepare(
          `INSERT INTO earn_movements (
             id, organization_id, environment, provider, execution_model, direction,
             position_id, status, denomination, amount_requested,
             custody_wallet_id, vault_address, signature, signed_transaction,
             last_valid_block_height, request_id, idempotency_fingerprint
           )
           SELECT 'earn_movement_duplicate', organization_id, environment, provider,
                  execution_model, direction, position_id, status, denomination,
                  amount_requested, custody_wallet_id, vault_address,
                  'another-signature', signed_transaction, last_valid_block_height,
                  request_id, idempotency_fingerprint
           FROM earn_movements WHERE execution_model = 'vault_direct' AND organization_id = ?`
        )
        .bind(ORG)
        .run()
        .then(
          () => "inserted",
          () => "rejected"
        );
      expect(duplicate).toBe("rejected");
    });
  });

  describe("reconciliation queue", () => {
    beforeEach(async () => {
      await getDb(env).prepare("DELETE FROM earn_movements").run();
    });

    it("prioritizes blockhash-bound work over older confirmed rows", async () => {
      const db = getDb(env);
      const confirmed = await ledger.createSignedVaultDepositIntent(intent());
      await ledger.advanceVaultMovement({
        movementId: confirmed.movement.id,
        organizationId: ORG,
        toStatus: "confirmed",
        confirmedAt: "2026-08-19T12:00:00.000Z",
      });
      const requested = await ledger.createSignedVaultDepositIntent(intent());

      // A confirmed signature that RPC no longer remembers remains in this queue
      // indefinitely. Make it explicitly older so the former oldest-first query
      // would consume a one-row batch and starve the expiring requested movement.
      await db
        .prepare("UPDATE earn_movements SET created_at = ? WHERE id = ?")
        .bind("1900-01-01T00:00:00.000Z", confirmed.movement.id)
        .run();
      await db
        .prepare("UPDATE earn_movements SET created_at = ? WHERE id = ?")
        .bind("1900-01-02T00:00:00.000Z", requested.movement.id)
        .run();

      const queued = await createPostgresEarnMovementsRepository(db).claimUnsettledVaultMovements({
        environment: "sandbox",
        limit: 1,
      });
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ id: requested.movement.id, status: "requested" });
    });

    it("reserves capacity for finalization under sustained blockhash-bound work", async () => {
      const db = getDb(env);
      const confirmed = await ledger.createSignedVaultDepositIntent(intent());
      await ledger.advanceVaultMovement({
        movementId: confirmed.movement.id,
        organizationId: ORG,
        toStatus: "confirmed",
        confirmedAt: "2026-08-19T12:00:00.000Z",
      });
      await db
        .prepare("UPDATE earn_movements SET created_at = ? WHERE id = ?")
        .bind("1900-02-01T00:00:00.000Z", confirmed.movement.id)
        .run();

      for (let index = 0; index < 4; index += 1) {
        await ledger.createSignedVaultDepositIntent(intent());
      }

      // With four slots and both classes backlogged, three remain available to
      // the blockhash-sensitive queue and one is guaranteed to finalization.
      // The former absolute priority returned four requested rows forever.
      const repository = createPostgresEarnMovementsRepository(db);
      const queued = await repository.claimUnsettledVaultMovements({
        environment: "sandbox",
        limit: 4,
      });
      expect(queued).toHaveLength(4);
      expect(queued.filter((movement) => movement.status === "requested")).toHaveLength(3);
      expect(queued).toContainEqual(expect.objectContaining({ id: confirmed.movement.id }));
    });

    it("rotates unchanged confirmed rows through the reserved capacity", async () => {
      const db = getDb(env);
      const older = await ledger.createSignedVaultDepositIntent(intent());
      const newer = await ledger.createSignedVaultDepositIntent(intent());
      for (const [movement, confirmedAt] of [
        [older, "2026-08-19T12:00:00.000Z"],
        [newer, "2026-08-19T12:01:00.000Z"],
      ] as const) {
        await ledger.advanceVaultMovement({
          movementId: movement.movement.id,
          organizationId: ORG,
          toStatus: "confirmed",
          confirmedAt,
        });
      }
      await db
        .prepare("UPDATE earn_movements SET created_at = ? WHERE id = ?")
        .bind("1900-03-01T00:00:00.000Z", older.movement.id)
        .run();
      await db
        .prepare("UPDATE earn_movements SET created_at = ? WHERE id = ?")
        .bind("1900-03-02T00:00:00.000Z", newer.movement.id)
        .run();
      for (let index = 0; index < 4; index += 1) {
        await ledger.createSignedVaultDepositIntent(intent());
      }

      const repository = createPostgresEarnMovementsRepository(db);
      const beforeClaims = await repository.getMovementById({
        movementId: older.movement.id,
        organizationId: ORG,
      });
      const first = await repository.claimUnsettledVaultMovements({
        environment: "sandbox",
        limit: 4,
      });
      expect(first.filter((movement) => movement.status === "requested")).toHaveLength(3);
      expect(first.filter((movement) => movement.status === "confirmed")).toEqual([
        expect.objectContaining({ id: older.movement.id }),
      ]);
      const second = await repository.claimUnsettledVaultMovements({
        environment: "sandbox",
        limit: 4,
      });
      expect(second.filter((movement) => movement.status === "requested")).toHaveLength(3);
      expect(second.filter((movement) => movement.status === "confirmed")).toEqual([
        expect.objectContaining({ id: newer.movement.id }),
      ]);

      // A constant stream of never-attempted rows must not starve retries either.
      // Least-recently-seen ordering puts the earlier attempt back in front of a
      // fresh confirmed row; NULLS FIRST would select the fresh row forever.
      const fresh = await ledger.createSignedVaultDepositIntent(intent());
      await ledger.advanceVaultMovement({
        movementId: fresh.movement.id,
        organizationId: ORG,
        toStatus: "confirmed",
        confirmedAt: "2026-08-19T12:02:00.000Z",
      });
      const third = await repository.claimUnsettledVaultMovements({
        environment: "sandbox",
        limit: 4,
      });
      expect(third.filter((movement) => movement.status === "confirmed")).toEqual([
        expect.objectContaining({ id: older.movement.id }),
      ]);
      const afterClaims = await repository.getMovementById({
        movementId: older.movement.id,
        organizationId: ORG,
      });
      expect(afterClaims?.updated_at).toBe(beforeClaims?.updated_at);
    });
  });

  describe("environment scope", () => {
    // Each environment's sweep registration (a `cluster` Cron Definition)
    // claims and counts only its own rows, so a production movement is never
    // judged on devnet. Every case seeds rows in both environments, works one,
    // and proves the other's rows were neither returned nor touched. Owner-signed
    // movements keep the fixture free of custody: managed custody is
    // Sandbox-only (ADR 0006), and the claims do not look at the signer.

    function otherThan(environment: SdpEnvironment): SdpEnvironment {
      return environment === "sandbox" ? "production" : "sandbox";
    }

    async function attemptedAt(movementId: string): Promise<string | null> {
      const row = await getDb(env)
        .prepare("SELECT reconciliation_attempted_at FROM earn_movements WHERE id = ?")
        .bind(movementId)
        .first<{ reconciliation_attempted_at: string | null }>();
      if (row === null) throw new Error(`movement ${movementId} is missing`);
      return row.reconciliation_attempted_at;
    }

    /** Finalize with no observed payout: a withdrawal's token amount stays NULL. */
    async function finalize(movementId: string): Promise<void> {
      const settledAt = new Date().toISOString();
      await ledger.advanceVaultMovement({
        movementId,
        organizationId: ORG,
        toStatus: "finalized",
        confirmedAt: settledAt,
        settledAt,
      });
    }

    async function buildFor(
      environment: SdpEnvironment,
      build: { direction: "deposit" | "withdrawal"; vaultAddress: string }
    ): Promise<string> {
      const id = `earn_ewt_${crypto.randomUUID()}`;
      await createPostgresEarnWalletTransactionsRepository(getDb(env)).create({
        id,
        organizationId: ORG,
        projectId: PROJECT_BY_ENVIRONMENT[environment],
        environment,
        provider: "kamino",
        direction: build.direction,
        ownerAddress: WALLET_OWNER,
        vaultAddress: build.vaultAddress,
        tokenMint: TOKEN_MINT,
        shareMint: SHARE_MINT,
        label: "USDC vault",
        denomination: build.direction === "deposit" ? TOKEN_MINT : SHARE_MINT,
        amountRequested: "1",
        createsShareAccount: false,
        unsignedTransaction: "AQ==",
        lastValidBlockHeight: "100",
      });
      return id;
    }

    /** An owner-signed Kamino deposit in `environment`, still `requested`, into a fresh vault. */
    async function depositIn(environment: SdpEnvironment) {
      const vaultAddress = `vault_${crypto.randomUUID()}`;
      const deposit = await ledger.createSignedWalletDepositIntent({
        organizationId: ORG,
        projectId: PROJECT_BY_ENVIRONMENT[environment],
        environment,
        provider: "kamino",
        vaultAddress,
        ownerAddress: WALLET_OWNER,
        shareMint: SHARE_MINT,
        tokenMint: TOKEN_MINT,
        label: "USDC vault",
        requestedAmount: "1",
        signature: `sig_${crypto.randomUUID()}`,
        signedTransaction: "AQ==",
        lastValidBlockHeight: "100",
        requestId: crypto.randomUUID(),
        idempotencyFingerprint: crypto.randomUUID(),
        walletTransactionId: await buildFor(environment, {
          direction: "deposit",
          vaultAddress,
        }),
      });
      return { ...deposit, vaultAddress };
    }

    /** A finalized owner-signed withdrawal in `environment` whose payout was never observed. */
    async function unvaluedWithdrawalIn(environment: SdpEnvironment): Promise<string> {
      const deposit = await depositIn(environment);
      await finalize(deposit.movement.id);
      const { vaultAddress } = deposit;
      const withdrawal = await ledger.createSignedWalletWithdrawalIntent({
        organizationId: ORG,
        projectId: PROJECT_BY_ENVIRONMENT[environment],
        environment,
        provider: "kamino",
        positionId: deposit.position.id,
        vaultAddress,
        ownerAddress: WALLET_OWNER,
        shareMint: SHARE_MINT,
        requestedShares: "1",
        signature: `sig_${crypto.randomUUID()}`,
        signedTransaction: "AQ==",
        lastValidBlockHeight: "100",
        requestId: crypto.randomUUID(),
        idempotencyFingerprint: crypto.randomUUID(),
        walletTransactionId: await buildFor(environment, {
          direction: "withdrawal",
          vaultAddress,
        }),
      });
      await finalize(withdrawal.movement.id);
      return withdrawal.movement.id;
    }

    it.each(SDP_ENVIRONMENTS)(
      "claims and counts only %s unsettled movements",
      async (environment) => {
        const own = await depositIn(environment);
        const others = [
          await depositIn(otherThan(environment)),
          await depositIn(otherThan(environment)),
        ];

        const claimed = await ledger.claimUnsettledVaultMovements({ environment, limit: 256 });

        expect(claimed.map((row) => row.id)).toEqual([own.movement.id]);
        for (const other of others) {
          expect(await attemptedAt(other.movement.id)).toBeNull();
        }
        await expect(ledger.getUnsettledVaultMovementStats({ environment })).resolves.toMatchObject(
          {
            backlog: 1,
            backlogBlockhashBound: 1,
          }
        );
      }
    );

    it.each(SDP_ENVIRONMENTS)("claims only %s unvalued withdrawal payouts", async (environment) => {
      const own = await unvaluedWithdrawalIn(environment);
      const other = await unvaluedWithdrawalIn(otherThan(environment));

      const claimed = await ledger.claimUnvaluedWithdrawalPayouts({
        environment,
        limit: 25,
        settledAfter: new Date(Date.now() - 60_000).toISOString(),
        retryBefore: new Date().toISOString(),
      });

      expect(claimed.map((row) => row.id)).toEqual([own]);
      expect(await attemptedAt(other)).toBeNull();
    });

    it.each(SDP_ENVIRONMENTS)(
      "claims only %s Kamino deposits awaiting a receipt",
      async (environment) => {
        const own = await depositIn(environment);
        const other = await depositIn(otherThan(environment));
        await finalize(own.movement.id);
        await finalize(other.movement.id);

        const claimed = await ledger.claimUnvaluedKaminoDeposits({
          environment,
          limit: 25,
          retryBefore: new Date().toISOString(),
        });

        expect(claimed.map((row) => row.id)).toEqual([own.movement.id]);
        expect(await attemptedAt(other.movement.id)).toBeNull();
      }
    );
  });
});
