import { readFileSync } from "node:fs";
import path from "node:path";
import {
  EARN_EXECUTION_MODELS,
  EARN_MOVEMENT_DIRECTIONS,
  EARN_MOVEMENT_STATUSES,
  EARN_MOVEMENT_TRANSITIONS,
  EARN_TERMINAL_MOVEMENT_STATUSES,
} from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { env } from "@/test/helpers/env";
import type { EarnRepository } from "./earn.repository";
import { createPostgresEarnRepository } from "./earn.repository.postgres";
import {
  type CreateSignedVaultDepositIntentInput,
  createPostgresEarnMovementsRepository,
  EARN_POSITION_ID_PREFIX,
  type EarnMovementRow,
  type EarnMovementsRepository,
  type EarnPositionRow,
  generateEarnPositionId,
} from "./earn-movements.repository";

/**
 * The unified movement ledger (PRO-1705).
 *
 * Two jobs here. First, prove the DUAL-WRITE: every legacy write lands in the
 * unified shape, in the same transaction, projected correctly — because until
 * reads switch, a mirror that silently misses a row is a money movement that
 * vanishes from history. Second, prove the ACCOUNTING invariants that motivated
 * the unification, above all that USD, mint units and vault shares cannot be
 * confused once both execution models share a table.
 */

const ORG = "org_earn_mv";
const ORG_OTHER = "org_earn_mv_other";
const USER = "usr_earn_mv";
const PROJECT = "prj_earn_mv";
const PROJECT_SIBLING = "prj_earn_mv_sibling";
const WALLET = "cw_earn_mv";
const CONFIG = "cc_earn_mv";
const TOKEN_MINT = "TokenMint1111111111111111111111111111111111";
const SHARE_MINT = "ShareMint1111111111111111111111111111111111";
const VAULT = "VaultAddress11111111111111111111111111111111";
const WALLET_PUBKEY = "DepositorPublicKey11111111111111111111111111";

describe("Unified earn movement ledger (postgres)", () => {
  let ledger: EarnMovementsRepository;
  let earnRepo: EarnRepository;
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

    for (const table of ["earn_movements", "earn_positions", "earn_provider_wallets"]) {
      await db
        .prepare(`DELETE FROM ${table} WHERE organization_id IN (?, ?)`)
        .bind(ORG, ORG_OTHER)
        .run();
    }
    await db.prepare("DELETE FROM custody_wallets WHERE id = ?").bind(WALLET).run();
    await db.prepare("DELETE FROM custody_configs WHERE id = ?").bind(CONFIG).run();
    await db
      .prepare("DELETE FROM projects WHERE id IN (?, ?)")
      .bind(PROJECT, PROJECT_SIBLING)
      .run();
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
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES
           (?, ?, 'Primary', 'earn-mv-primary', 'sandbox', 'active', ?),
           (?, ?, 'Sibling', 'earn-mv-sibling', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT, ORG, USER, PROJECT_SIBLING, ORG, USER)
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
         VALUES (?, ?, 'earn-mv-wallet', ?, 'Earn movements wallet')`
      )
      .bind(WALLET, CONFIG, WALLET_PUBKEY)
      .run();

    ledger = createPostgresEarnMovementsRepository(db);
    earnRepo = createPostgresEarnRepository(db);
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

  async function linkProgram(walletRef = "gw-ref-1", label: string | null = "Treasury program") {
    const wallet = await earnRepo.insertProviderWallet({
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      // Nothing in the ledger is Ground-specific, so the pluggability proof uses
      // a registered provider that is not the live one. A real `EarnProviderId`,
      // so the union check the typed id exists for still applies.
      provider: "veda",
      providerWalletRef: walletRef,
      label,
      createdBy: USER,
    });
    if (!wallet) throw new Error("failed to link program wallet");
    return wallet;
  }

  async function createWithdrawal(
    overrides: { walletId: string; projectId?: string } & Partial<{
      amountRequestedUsd: string;
      requestId: string;
      idempotencyFingerprint: string;
    }>
  ) {
    return ledger.createCustodialMovement({
      organizationId: ORG,
      projectId: overrides.projectId ?? PROJECT,
      providerWalletId: overrides.walletId,
      environment: "sandbox",
      provider: "veda",
      amountRequestedUsd: overrides.amountRequestedUsd ?? "250.50",
      payoutToken: "usdc",
      destinationAddress: "DestinationAddress111111111111111111111111",
      requestId: overrides.requestId ?? "wd-request-1",
      idempotencyFingerprint: overrides.idempotencyFingerprint ?? "wd-fingerprint-1",
      providerData: {},
      createdBy: USER,
      initiatedByKeyId: null,
    });
  }

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
        provider_wallet_id: null,
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
        // Never a custodial column.
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
        // The chain has spoken, so what moved is known: the requested amount,
        // which the service pinned numerically equal to the plan's canonical
        // amount before signing.
        amount_settled: "100",
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

    it("gives two organizations holding the same vault separate holdings and ledgers", async () => {
      const db = getDb(env);
      // 0059's founding constraint: a public vault is not claimable by whoever
      // deposits first. The unified holdings table must not quietly reintroduce a
      // global unique that would refuse the second organization.
      await db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES ('prj_earn_mv_other', ?, 'Other', 'earn-mv-other', 'sandbox', 'active', ?)`
        )
        .bind(ORG_OTHER, USER)
        .run();
      await db
        .prepare(
          `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted)
           VALUES ('cc_earn_mv_other', ?, NULL, 'local', 'encrypted')`
        )
        .bind(ORG_OTHER)
        .run();
      await db
        .prepare(
          `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, label)
           VALUES ('cw_earn_mv_other', 'cc_earn_mv_other', 'other-wallet', 'OtherPubkey1111', 'Other')`
        )
        .run();

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

  describe("custodial withdrawals", () => {
    it("mints exactly one custodial holding per program wallet, and labels an unlabelled one", async () => {
      const labelled = await linkProgram("gw-ref-1", "Treasury program");
      const unlabelled = await linkProgram("gw-ref-2", null);

      const rows = await positions();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.provider_wallet_id).sort()).toEqual(
        [labelled.id, unlabelled.id].sort()
      );
      for (const row of rows) {
        expect(row).toMatchObject({
          kind: "custodial",
          custody_wallet_id: null,
          vault_address: null,
          token_mint: null,
          share_mint: null,
        });
        // A custodial holding is live from the moment its program exists.
        expect(row.activated_at).not.toBeNull();
      }
      expect(rows.find((row) => row.provider_wallet_id === unlabelled.id)?.label).toBe("gw-ref-2");
    });

    it("projects a withdrawal intent as a USD-denominated movement on the program's holding", async () => {
      const wallet = await linkProgram();
      const withdrawal = await createWithdrawal({ walletId: wallet.id });
      const [position] = await positions();

      const movement = await onlyMovement();
      expect(movement).toMatchObject({
        id: withdrawal?.id,
        position_id: position.id,
        execution_model: "custodial",
        direction: "withdrawal",
        status: "requested",
        // USD, not a mint — and the payout stablecoin is a separate column so the
        // two can never be read as the same fact.
        denomination: "usd",
        payout_token: "usdc",
        amount_requested: "250.50",
        amount_settled: null,
        fee_amount: null,
        // environment is derived from the wallet: 0055 has no such column.
        environment: "sandbox",
        provider_reference: null,
        // Never a vault column.
        custody_wallet_id: null,
        vault_address: null,
        signature: null,
        min_shares_out: null,
        shares_out: null,
      });
    });

    it("preserves a shared program and cross-project history when its provisioning project is deleted", async () => {
      const db = getDb(env);
      const wallet = await linkProgram();
      const primary = await createWithdrawal({
        walletId: wallet.id,
        requestId: "wd-project-delete-primary",
        idempotencyFingerprint: "wd-project-delete-primary-fingerprint",
      });
      const sibling = await createWithdrawal({
        walletId: wallet.id,
        projectId: PROJECT_SIBLING,
        requestId: "wd-project-delete-sibling",
        idempotencyFingerprint: "wd-project-delete-sibling-fingerprint",
      });
      if (!primary || !sibling) throw new Error("withdrawal not created");
      const [positionBefore] = await positions();

      await db.prepare("DELETE FROM projects WHERE id = ?").bind(PROJECT).run();

      // The program is organization-scoped. Deleting the project that first
      // provisioned it clears only forensic attribution, so sibling projects do
      // not lose the funded provider account or its global ownership anchor.
      await expect(
        earnRepo.getProviderWalletById({
          organizationId: ORG,
          environment: "sandbox",
          walletId: wallet.id,
        })
      ).resolves.toMatchObject({ id: wallet.id, project_id: null });

      const [positionAfter] = await positions();
      expect(positionAfter).toMatchObject({
        id: positionBefore.id,
        project_id: null,
        provider_wallet_id: wallet.id,
      });

      const unified = await movements();
      expect(unified).toHaveLength(2);
      expect(unified.find((row) => row.id === primary.id)?.project_id).toBeNull();
      expect(unified.find((row) => row.id === sibling.id)?.project_id).toBe(PROJECT_SIBLING);
    });

    it("mirrors a provider observation, including a zero fee and a scientific-notation amount", async () => {
      const wallet = await linkProgram();
      const withdrawal = await createWithdrawal({ walletId: wallet.id });
      if (!withdrawal) throw new Error("withdrawal not created");

      await ledger.updateCustodialMovementGuarded({
        selector: { movementId: withdrawal.id },
        organizationId: ORG,
        toStatus: "completed",
        providerReference: "wd-provider-ref-1",
        // Values a provider legitimately reports and 0055 never constrained. The
        // ledger must accept them verbatim rather than fail the money write.
        amountSettled: "1e-7",
        feeAmount: "0",
        settledAt: "2026-08-19T13:00:00.000Z",
        providerData: { lastObservation: { status: "completed" } },
      });

      const movement = await onlyMovement();
      expect(movement).toMatchObject({
        status: "completed",
        provider_reference: "wd-provider-ref-1",
        amount_settled: "1e-7",
        fee_amount: "0",
        settled_at: "2026-08-19T13:00:00.000Z",
      });
      expect(movement.provider_data).toMatchObject({
        lastObservation: { status: "completed" },
      });
    });

    it("leaves the mirror at its terminal state when an observation loses the guard", async () => {
      const wallet = await linkProgram();
      const withdrawal = await createWithdrawal({ walletId: wallet.id });
      if (!withdrawal) throw new Error("withdrawal not created");

      await ledger.updateCustodialMovementGuarded({
        selector: { movementId: withdrawal.id },
        organizationId: ORG,
        toStatus: "completed",
        settledAt: "2026-08-19T13:00:00.000Z",
      });
      const regressed = await ledger.updateCustodialMovementGuarded({
        selector: { movementId: withdrawal.id },
        organizationId: ORG,
        toStatus: "processing",
      });

      expect(regressed).toBeNull();
      expect((await onlyMovement()).status).toBe("completed");
    });

    it("opens a missing holding rather than failing a withdrawal against it", async () => {
      const db = getDb(env);
      const wallet = await linkProgram();
      // The state a program reaches when it was linked by a revision that
      // predates the ledger, or during a rollout or rollback window: the wallet
      // exists and has no holding. Failing here would take the program's whole
      // withdrawal endpoint down permanently, so the writer opens one and
      // retries. It still fails loudly when the program wallet itself is absent.
      await db
        .prepare("DELETE FROM earn_positions WHERE provider_wallet_id = ?")
        .bind(wallet.id)
        .run();
      expect(await positions()).toHaveLength(0);

      const withdrawal = await createWithdrawal({ walletId: wallet.id });
      if (!withdrawal) throw new Error("withdrawal not created");

      const [healed] = await positions();
      expect(healed).toMatchObject({
        kind: "custodial",
        provider_wallet_id: wallet.id,
        organization_id: ORG,
      });
      expect(await onlyMovement()).toMatchObject({
        id: withdrawal.id,
        execution_model: "custodial",
        position_id: healed.id,
        status: "requested",
      });
    });

    it("keeps USD, mint units and share counts in separate, self-describing columns", async () => {
      const wallet = await linkProgram();
      await createWithdrawal({ walletId: wallet.id, amountRequestedUsd: "250.50" });
      await ledger.createSignedVaultDepositIntent(intent({ requestedAmount: "100" }));

      const rows = await movements();
      expect(rows).toHaveLength(2);

      const custodial = rows.find((row) => row.execution_model === "custodial");
      const vault = rows.find((row) => row.execution_model === "vault_direct");

      // The same numeric column holds two different assets, and each row states
      // which — the concrete hazard the unification could have introduced.
      expect(custodial?.denomination).toBe("usd");
      expect(vault?.denomination).toBe(TOKEN_MINT);
      expect(custodial?.denomination).not.toBe(vault?.denomination);

      // Share quantities exist only in share-named columns, on neither model's
      // amount columns.
      expect(custodial?.min_shares_out).toBeNull();
      expect(custodial?.shares_out).toBeNull();
      expect(vault?.min_shares_out).toBe("99.000000");

      // A USD payout symbol never appears on a mint-denominated movement.
      expect(custodial?.payout_token).toBe("usdc");
      expect(vault?.payout_token).toBeNull();
    });

    it("preserves decimal spelling byte for byte, never normalizing an amount", async () => {
      const wallet = await linkProgram();
      // Trailing zeroes and a bare integer are different SPELLINGS of the same
      // value. An audit ledger stores what was said, so no coercion may happen.
      await createWithdrawal({ walletId: wallet.id, amountRequestedUsd: "1000.500000" });
      await ledger.createSignedVaultDepositIntent(intent({ requestedAmount: "100" }));

      const rows = await movements();
      const custodial = rows.find((row) => row.execution_model === "custodial");
      const vault = rows.find((row) => row.execution_model === "vault_direct");
      expect(custodial?.amount_requested).toBe("1000.500000");
      expect(vault?.amount_requested).toBe("100");
    });

    it("serves one chronological history across both execution models", async () => {
      const wallet = await linkProgram();
      await createWithdrawal({ walletId: wallet.id });
      await ledger.createSignedVaultDepositIntent(intent());

      const rows = await getDb(env)
        .prepare(
          `SELECT execution_model, direction FROM earn_movements
           WHERE organization_id = ? AND environment = ?
           ORDER BY created_at DESC, id DESC`
        )
        .bind(ORG, "sandbox")
        .all<{ execution_model: string; direction: string }>();

      // One query, no union, both mechanisms — the read PRO-1669 promised and
      // neither legacy table could serve alone.
      expect((rows.results ?? []).map((row) => `${row.execution_model}:${row.direction}`)).toEqual(
        expect.arrayContaining(["custodial:withdrawal", "vault_direct:deposit"])
      );
      expect(rows.results).toHaveLength(2);
    });
  });

  describe("idempotency anchors", () => {
    it("scopes the custodial anchor to the holding and the vault anchor to the organization", async () => {
      const db = getDb(env);
      const wallet = await linkProgram();

      // The SAME caller key on both models is two different requests, and each
      // anchor is a partial index over its own model's rows — so they coexist.
      await createWithdrawal({ walletId: wallet.id, requestId: "shared-request-id" });
      await ledger.createSignedVaultDepositIntent(intent({ requestId: "shared-request-id" }));
      expect(await movements()).toHaveLength(2);

      // Custodial: position-scoped, which is 0055's wallet scope in the new
      // shape — a sibling project sharing the program hits the same anchor.
      await expect(
        createWithdrawal({
          walletId: wallet.id,
          projectId: PROJECT_SIBLING,
          requestId: "shared-request-id",
          idempotencyFingerprint: "a-different-fingerprint",
        })
      ).rejects.toThrow();

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

      const queued =
        await createPostgresEarnMovementsRepository(db).claimUnsettledVaultMovements(1);
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
      const queued = await repository.claimUnsettledVaultMovements(4);
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
      const first = await repository.claimUnsettledVaultMovements(4);
      expect(first.filter((movement) => movement.status === "requested")).toHaveLength(3);
      expect(first.filter((movement) => movement.status === "confirmed")).toEqual([
        expect.objectContaining({ id: older.movement.id }),
      ]);
      const second = await repository.claimUnsettledVaultMovements(4);
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
      const third = await repository.claimUnsettledVaultMovements(4);
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
});
