import { DVP_SETTLEMENT_AVAILABILITY } from "@sdp/types";
import { type Address, address, getBase58Decoder, signature } from "@solana/kit";
import { generateKeyPairSigner } from "@solana/signers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { deriveDvpSettlementAvailability } from "@/services/dvp/observe";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import {
  expectProjectScoped,
  type SeededDefaultProjects,
  seedDefaultProjects,
} from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type {
  DvpInboundScope,
  DvpTradeInsert,
  DvpTradeListFilters,
  DvpTradeRepository,
} from "./dvp-trade.repository";
import { createPostgresDvpTradeRepository } from "./dvp-trade.repository.postgres";

const TEST_PROJECT_ID = "prj_dvp_repo_test";
const CUSTODY_CONFIG_ID = "cust_dvp_repo_test";
const CUSTODY_WALLET_ID = "cwlt_dvp_repo_test";
const OTHER_CUSTODY_WALLET_ID = "cwlt_dvp_repo_other";

// The public keys seeded into custody_wallets below. A wallet-scoped read
// now admits trades where a bound wallet's public key is a PARTY
// (user_a/user_b), so the trade seeds must name these addresses.
const WALLET_A_PUBKEY = "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn";
const WALLET_B_PUBKEY = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";

// Deliberately above Number.MAX_SAFE_INTEGER (9007199254740991). The nonce is a
// PDA seed, so if anything in the storage path routes it through a JS number it
// rounds here, and the trade's SwapDvp address stops matching the one the
// counterparty was told to fund.
const BIG_NONCE = "18446744073709551610";
const BIG_AMOUNT = "18446744073709551615";
const CLOSE_SIGNATURE = signature("1".repeat(64));
const CREATE_SIGNATURE = signature(
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
);

function tradeInsert(overrides: Partial<DvpTradeInsert> = {}): DvpTradeInsert {
  return {
    id: "dvp_trade_test_1",
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    swapDvp: address("BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po"),
    settlementAuthority: address("9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY"),
    userA: address(WALLET_A_PUBKEY),
    userB: address(WALLET_B_PUBKEY),
    mintA: address("ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1"),
    mintB: address("AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE"),
    nonce: BIG_NONCE,
    tokenProgramA: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    tokenProgramB: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    decimalsA: 6,
    decimalsB: 6,
    symbolA: "ATD",
    symbolB: "USDC",
    nameA: "Acme Treasury Debt",
    nameB: "USD Coin",
    amountA: "1000",
    amountB: "2000",
    expiryTimestamp: "1800003600",
    earliestSettlementTimestamp: null,
    userASettlementDestination: address(WALLET_A_PUBKEY),
    userBSettlementDestination: address(WALLET_B_PUBKEY),
    refString: null,
    escrowA: address("FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU"),
    escrowB: address("6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y"),
    counterpartyAccountIdA: null,
    counterpartyAccountIdB: null,
    idempotencyKey: null,
    idempotencyFingerprint: null,
    createSignature: null,
    createLastValidBlockHeight: null,
    ...overrides,
  };
}

const scope = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };

/** The explicit no-filter filters: unfiltered is a choice, never a default. */
const UNFILTERED: DvpTradeListFilters = { statuses: null, settlementAvailability: null, q: null };

describe("DvpTradeRepository (postgres)", () => {
  let repo: DvpTradeRepository;
  let projects: SeededDefaultProjects;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM dvp_trades").run();
    await db.prepare("DELETE FROM counterparty_accounts").run();
    await db.prepare("DELETE FROM counterparties").run();
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
    projects = await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT_ID, production: `${TEST_PROJECT_ID}_production` },
    });
    await db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, provider, config_encrypted, status)
         VALUES (?, ?, 'local', 'x', 'active')`
      )
      .bind(CUSTODY_CONFIG_ID, TEST_ORG.id)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, 'w1', ?, 'active')`
      )
      .bind(CUSTODY_WALLET_ID, CUSTODY_CONFIG_ID, WALLET_A_PUBKEY)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, 'w2', ?, 'active')`
      )
      .bind(OTHER_CUSTODY_WALLET_ID, CUSTODY_CONFIG_ID, WALLET_B_PUBKEY)
      .run();

    repo = createPostgresDvpTradeRepository(db);
  });

  it.each([
    [
      "id",
      (projectId: string, id: string) =>
        repo.getById({ organizationId: TEST_ORG.id, projectId }, id),
    ],
    [
      "swap address",
      (projectId: string, id: string) =>
        repo.getBySwapDvp({ organizationId: TEST_ORG.id, projectId }, address(id)),
    ],
  ])("does not leak a trade across projects by %s", async (kind, read) => {
    const created = await repo.create(tradeInsert());
    const identifier = kind === "id" ? created.id : created.swapDvp;
    await expectProjectScoped(
      (projectId) => read(projectId, identifier),
      { own: projects.sandbox, other: projects.production },
      (row) => row === null
    );
  });

  // The row is written before the create transaction is broadcast, so its
  // opening state has to be "outcome unknown" rather than "created". Anything
  // else would claim an on-chain fact nothing has observed yet.
  it("persists a trade and defaults it to creating", async () => {
    const created = await repo.create(tradeInsert());

    expect(created.status).toBe("creating");
    expect(created.swapDvp).toBe("BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po");
    expect(created.counterpartyAccountIdA).toBeNull();
    expect(created.counterpartyAccountIdB).toBeNull();
    expect(created.nameA).toBe("Acme Treasury Debt");
    expect(created.nameB).toBe("USD Coin");
    expect(created.createdAt).toBeTruthy();
    await expect(repo.getById(scope, created.id)).resolves.toMatchObject({
      nameA: "Acme Treasury Debt",
      nameB: "USD Coin",
    });
  });

  it("attaches a create signature exactly once", async () => {
    const created = await repo.create(tradeInsert());

    const attached = await repo.attachCreateSignature(created.id, CREATE_SIGNATURE, "1500");
    const second = await repo.attachCreateSignature(created.id, CREATE_SIGNATURE, "1500");

    expect(attached).toMatchObject({
      createSignature: CREATE_SIGNATURE,
      createLastValidBlockHeight: "1500",
    });
    expect(second).toBeNull();
  });

  it("does not attach a signature to a failed claim", async () => {
    const created = await repo.create(tradeInsert());
    await repo.resolveCreate(created.id, "create_failed");

    await expect(
      repo.attachCreateSignature(created.id, CREATE_SIGNATURE, "1500")
    ).resolves.toBeNull();
    await expect(repo.getById(scope, created.id)).resolves.toMatchObject({
      status: "create_failed",
      createSignature: null,
      createLastValidBlockHeight: null,
    });
  });

  it("round-trips counterparty account attribution", async () => {
    const db = getDb(env);
    await db
      .prepare(
        `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name)
         VALUES ('cpty_attribution', ?, ?, 'individual', 'Ada')`
      )
      .bind(TEST_ORG.id, TEST_PROJECT_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO counterparty_accounts (id, organization_id, project_id, counterparty_id, account_kind)
         VALUES ('cpa_test_attribution', ?, ?, 'cpty_attribution', 'crypto_wallet')`
      )
      .bind(TEST_ORG.id, TEST_PROJECT_ID)
      .run();

    const created = await repo.create(
      tradeInsert({ counterpartyAccountIdA: "cpa_test_attribution" })
    );

    expect(created.counterpartyAccountIdA).toBe("cpa_test_attribution");
    expect(created.counterpartyAccountIdB).toBeNull();

    const read = await repo.getById(scope, created.id);
    expect(read?.counterpartyAccountIdA).toBe("cpa_test_attribution");
    expect(read?.counterpartyAccountIdB).toBeNull();
  });

  it("resolves a creating trade to created once the broadcast is accepted", async () => {
    const created = await repo.create(tradeInsert());

    const resolved = await repo.resolveCreate(created.id, "created");

    expect(resolved?.status).toBe("created");
    // The program just made both escrows, so they hold nothing. Leaving that to
    // the once-a-minute sweep made every new trade open on "Not checked —
    // nothing has read this escrow", which is a statement about the reconciler
    // rather than about the trade.
    expect(resolved?.escrowAAmount).toBe("0");
    expect(resolved?.escrowBAmount).toBe("0");
    expect(resolved?.observedAt).toBeTruthy();
    await expect(repo.getById(scope, created.id)).resolves.toMatchObject({ status: "created" });
  });

  it("resolves a creating trade to create_failed when the broadcast is rejected", async () => {
    const created = await repo.create(tradeInsert());

    const resolved = await repo.resolveCreate(created.id, "create_failed");

    expect(resolved?.status).toBe("create_failed");
    // Nothing was created, so there is no escrow to have observed. Claiming a
    // zero balance here would describe accounts that do not exist.
    expect(resolved?.escrowAAmount).toBeNull();
    expect(resolved?.observedAt).toBeNull();
    // The seed tuple survives a failed create. It is the only durable copy of
    // what RecoverDvp needs, and a preflight rejection is not proof that a
    // retransmission of the same bytes can never land.
    expect(resolved?.nonce).toBe(BIG_NONCE);
    expect(resolved?.swapDvp).toBe(created.swapDvp);
  });

  it("remembers the peak open balance when a later observation is lower", async () => {
    const created = await repo.create(tradeInsert());
    await repo.resolveCreate(created.id, "created");
    const first = await repo.recordObservation({
      id: created.id,
      expectedStatus: "created",
      status: "partially_funded",
      escrowAAmount: "900",
      escrowBAmount: "0",
      escrowAFrozen: false,
      escrowBFrozen: false,
      closeSignature: null,
      observedAt: "2026-09-10T00:00:00.000Z",
      observedClusterTimestamp: "1800000000",
    });
    const reclaimed = await repo.recordObservation({
      id: created.id,
      expectedStatus: "partially_funded",
      status: "partially_funded",
      escrowAAmount: "100",
      escrowBAmount: "0",
      escrowAFrozen: false,
      escrowBFrozen: false,
      closeSignature: null,
      observedAt: "2026-09-10T00:01:00.000Z",
      observedClusterTimestamp: "1800000060",
    });

    // The cluster clock rides with every observation, the latest one kept.
    expect(first?.observedClusterTimestamp).toBe("1800000000");
    expect(reclaimed?.observedClusterTimestamp).toBe("1800000060");
    expect(first?.escrowAPeakAmount).toBe("900");
    expect(reclaimed?.escrowAPeakAmount).toBe("900");
    expect(reclaimed?.escrowAAmount).toBe("100");
  });

  it("defers close resolution with a status compare-and-swap", async () => {
    const created = await repo.create(tradeInsert());
    await repo.resolveCreate(created.id, "created");
    const after = "2026-09-11T02:00:00.000Z";

    await expect(
      repo.deferCloseResolution({
        id: created.id,
        expectedStatus: "creating",
        attempts: 1,
        after,
      })
    ).resolves.toBe(false);
    await expect(repo.getById(scope, created.id)).resolves.toMatchObject({
      closeResolutionAttempts: 0,
      closeResolutionAfter: null,
    });

    await expect(
      repo.deferCloseResolution({
        id: created.id,
        expectedStatus: "created",
        attempts: 1,
        after,
      })
    ).resolves.toBe(true);
    await expect(repo.getById(scope, created.id)).resolves.toMatchObject({
      closeResolutionAttempts: 1,
      closeResolutionAfter: after,
    });
  });

  it("resets close-resolution backoff when a known close is recorded", async () => {
    const created = await repo.create(tradeInsert());
    await repo.resolveCreate(created.id, "created");
    await repo.deferCloseResolution({
      id: created.id,
      expectedStatus: "created",
      attempts: 3,
      after: "2026-09-11T04:00:00.000Z",
    });

    const observed = await repo.recordObservation({
      id: created.id,
      expectedStatus: "created",
      status: "settled",
      escrowAAmount: null,
      escrowBAmount: null,
      escrowAFrozen: null,
      escrowBFrozen: null,
      closeSignature: CLOSE_SIGNATURE,
      observedAt: "2026-09-11T00:00:00.000Z",
      observedClusterTimestamp: "1800000000",
    });

    expect(observed).toMatchObject({
      closeResolutionAttempts: 0,
      closeResolutionAfter: null,
      closedAt: "2026-09-11T00:00:00.000Z",
    });
  });

  /**
   * PRO-1973. One close lock per trade, so of a settle and a cancel sent
   * together only one goes out. Every write names the signature it holds, so a
   * slow request can never free or move a lock taken after its own was swept.
   */
  describe("close lock", () => {
    const signatureOf = (byte: number) =>
      signature(getBase58Decoder().decode(new Uint8Array(64).fill(byte)));
    const AUTHORITY_SIGNATURE = signatureOf(2);
    const SPONSORED_SIGNATURE = signatureOf(3);
    const OTHER_SIGNATURE = signatureOf(4);

    async function openTrade() {
      const created = await repo.create(tradeInsert());
      await repo.resolveCreate(created.id, "created");
      return created;
    }

    it("admits exactly one close lock on a trade", async () => {
      const created = await openTrade();

      const [first, second] = await Promise.all([
        repo.claimClose(created.id, {
          action: "settle",
          signature: AUTHORITY_SIGNATURE,
          expiryHeight: "500",
        }),
        repo.claimClose(created.id, {
          action: "cancel",
          signature: OTHER_SIGNATURE,
          expiryHeight: "500",
        }),
      ]);

      expect([first, second].filter(Boolean)).toHaveLength(1);
      const read = await repo.getById(scope, created.id);
      expect(read?.closeClaim?.action).toBe(first ? "settle" : "cancel");
    });

    it("refuses a close lock on a trade that is already closed", async () => {
      const created = await openTrade();
      await repo.recordClose(created.id, "settled", CLOSE_SIGNATURE);

      await expect(
        repo.claimClose(created.id, {
          action: "cancel",
          signature: AUTHORITY_SIGNATURE,
          expiryHeight: "500",
        })
      ).resolves.toBe(false);
    });

    it("moves the lock only from the signature it holds", async () => {
      const created = await openTrade();
      await repo.claimClose(created.id, {
        action: "settle",
        signature: AUTHORITY_SIGNATURE,
        expiryHeight: "500",
      });

      await expect(
        repo.rebindCloseClaim(created.id, OTHER_SIGNATURE, SPONSORED_SIGNATURE)
      ).resolves.toBe(false);
      await expect(
        repo.rebindCloseClaim(created.id, AUTHORITY_SIGNATURE, SPONSORED_SIGNATURE)
      ).resolves.toBe(true);
      await expect(repo.getById(scope, created.id)).resolves.toMatchObject({
        closeClaim: { action: "settle", signature: SPONSORED_SIGNATURE, expiryHeight: "500" },
      });
    });

    it("frees the lock only for the signature it holds", async () => {
      const created = await openTrade();
      await repo.claimClose(created.id, {
        action: "cancel",
        signature: AUTHORITY_SIGNATURE,
        expiryHeight: "500",
      });

      await repo.releaseCloseClaim(created.id, OTHER_SIGNATURE);
      expect((await repo.getById(scope, created.id))?.closeClaim).not.toBeNull();

      await repo.releaseCloseClaim(created.id, AUTHORITY_SIGNATURE);
      expect((await repo.getById(scope, created.id))?.closeClaim).toBeNull();
    });

    // A request that died holding the lock must not hold the trade forever,
    // and one that can still land must not be freed under it.
    it("sweeps only locks past their last valid height", async () => {
      const created = await openTrade();
      const other = await repo.create(
        tradeInsert({
          id: "dvp_trade_test_2",
          swapDvp: address("FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU"),
        })
      );
      await repo.resolveCreate(other.id, "created");
      await repo.claimClose(created.id, {
        action: "settle",
        signature: AUTHORITY_SIGNATURE,
        expiryHeight: "500",
      });
      await repo.claimClose(other.id, {
        action: "cancel",
        signature: OTHER_SIGNATURE,
        expiryHeight: "900",
      });

      await expect(repo.releaseExpiredCloseClaims(900n)).resolves.toBe(1);
      expect((await repo.getById(scope, created.id))?.closeClaim).toBeNull();
      expect((await repo.getById(scope, other.id))?.closeClaim?.signature).toBe(OTHER_SIGNATURE);
    });

    it("clears the lock when the close is recorded", async () => {
      const created = await openTrade();
      await repo.claimClose(created.id, {
        action: "settle",
        signature: CLOSE_SIGNATURE,
        expiryHeight: "500",
      });

      const closed = await repo.recordClose(created.id, "settled", CLOSE_SIGNATURE);

      expect(closed).toMatchObject({ status: "settled", closeClaim: null });
    });
  });

  it("sets the close time on the first closed observation and never moves it", async () => {
    const db = getDb(env);
    const created = await repo.create(tradeInsert());
    await repo.resolveCreate(created.id, "created");
    await repo.recordObservation({
      id: created.id,
      expectedStatus: "created",
      status: "closed_unknown",
      escrowAAmount: null,
      escrowBAmount: null,
      escrowAFrozen: null,
      escrowBFrozen: null,
      closeSignature: null,
      observedAt: "2026-09-10T00:00:00.000Z",
      observedClusterTimestamp: "1800000000",
    });
    const first = await db
      .prepare("SELECT closed_at, updated_at FROM dvp_trades WHERE id = ?")
      .bind(created.id)
      .first<{ closed_at: string; updated_at: string }>();
    await db
      .prepare("UPDATE dvp_trades SET updated_at = '2026-09-01T00:00:00.000Z' WHERE id = ?")
      .bind(created.id)
      .run();

    await repo.recordObservation({
      id: created.id,
      expectedStatus: "closed_unknown",
      status: "closed_unknown",
      escrowAAmount: "1",
      escrowBAmount: null,
      escrowAFrozen: false,
      escrowBFrozen: null,
      closeSignature: null,
      observedAt: "2026-09-10T00:01:00.000Z",
      observedClusterTimestamp: "1800000000",
    });
    const second = await db
      .prepare("SELECT closed_at, updated_at FROM dvp_trades WHERE id = ?")
      .bind(created.id)
      .first<{ closed_at: string; updated_at: string }>();

    expect(first).not.toBeNull();
    expect(second?.closed_at).toBe(first?.closed_at);
    expect(second?.updated_at).not.toBe("2026-09-01T00:00:00.000Z");
  });

  it("sets the close time when recording a close on an open trade", async () => {
    const db = getDb(env);
    const created = await repo.create(tradeInsert());
    await db.prepare("UPDATE dvp_trades SET status = 'funded' WHERE id = ?").bind(created.id).run();

    await repo.recordClose(created.id, "settled", CLOSE_SIGNATURE);
    const row = await db
      .prepare("SELECT closed_at FROM dvp_trades WHERE id = ?")
      .bind(created.id)
      .first<{ closed_at: string }>();

    expect(row?.closed_at).toBeTruthy();
  });

  it("keeps the first close time when a closed_unknown trade is resolved", async () => {
    const db = getDb(env);
    const created = await repo.create(tradeInsert());
    const firstClosedAt = "2026-09-01T00:00:00.000Z";
    await db
      .prepare("UPDATE dvp_trades SET status = 'closed_unknown', closed_at = ? WHERE id = ?")
      .bind(firstClosedAt, created.id)
      .run();

    await repo.recordClose(created.id, "cancelled", CLOSE_SIGNATURE);
    const row = await db
      .prepare("SELECT closed_at FROM dvp_trades WHERE id = ?")
      .bind(created.id)
      .first<{ closed_at: string }>();

    expect(row?.closed_at).toBe(firstClosedAt);
  });

  it("sweeps closed trades by close time and always includes open trades", async () => {
    const db = getDb(env);
    await repo.create(tradeInsert({ id: "dvp_closed_old" }));
    await repo.create(
      tradeInsert({
        id: "dvp_closed_recent",
        swapDvp: address("SwapR11111111111111111111111111111111111111"),
      })
    );
    await repo.create(
      tradeInsert({
        id: "dvp_open_old",
        swapDvp: address("SwapP11111111111111111111111111111111111111"),
      })
    );
    await db
      .prepare(
        `UPDATE dvp_trades
            SET status = 'settled',
                closed_at = CURRENT_TIMESTAMP - INTERVAL '8 days',
                updated_at = sdp_iso_now()
          WHERE id = 'dvp_closed_old'`
      )
      .run();
    await db
      .prepare(
        `UPDATE dvp_trades
            SET status = 'cancelled',
                closed_at = CURRENT_TIMESTAMP - INTERVAL '6 days'
          WHERE id = 'dvp_closed_recent'`
      )
      .run();
    await db
      .prepare(
        `UPDATE dvp_trades
            SET status = 'created',
                updated_at = CURRENT_TIMESTAMP - INTERVAL '30 days'
          WHERE id = 'dvp_open_old'`
      )
      .run();

    const listed = await repo.listOpenForReconciliation(10);

    expect(listed.map((trade) => trade.id).sort()).toEqual(["dvp_closed_recent", "dvp_open_old"]);
  });

  /**
   * PRO-1930, PRO-1974. The sweep's limit is shared out between live trades,
   * expired trades still holding something, and trades kept only for late
   * deposits, so a crowd in one lane can slow the others but never shut them out.
   */
  describe("reconciliation lanes", () => {
    const swapFor = (index: number) =>
      address(getBase58Decoder().decode(new Uint8Array(32).fill(index + 1)));

    /** Inserts a trade and forces the row into the state the lane reads. */
    async function seedLaned(
      id: string,
      index: number,
      state: {
        status: string;
        observedAt: string;
        escrows?: [string | null, string | null];
        expiryTimestamp?: string;
        closedDaysAgo?: number;
      }
    ) {
      await repo.create(
        tradeInsert({
          id,
          swapDvp: swapFor(index),
          ...(state.expiryTimestamp === undefined
            ? {}
            : { expiryTimestamp: state.expiryTimestamp }),
        })
      );
      await getDb(env)
        .prepare(
          `UPDATE dvp_trades
              SET status = ?, observed_at = ?, escrow_a_amount = ?, escrow_b_amount = ?,
                  closed_at = CASE WHEN ?::int IS NULL THEN NULL
                                   ELSE (CURRENT_TIMESTAMP - make_interval(days => ?::int))::text END
            WHERE id = ?`
        )
        .bind(
          state.status,
          state.observedAt,
          state.escrows?.[0] ?? null,
          state.escrows?.[1] ?? null,
          state.closedDaysAgo ?? null,
          state.closedDaysAgo ?? null,
          id
        )
        .run();
    }

    /** An expiry an hour ago, in unix seconds. */
    const RECENT_EXPIRY = String(Math.floor(Date.now() / 1000) - 3_600);

    it("gives expired and late-deposit work their share when live trades fill the limit", async () => {
      for (let index = 0; index < 6; index += 1) {
        await seedLaned(`dvp_live_${index}`, index, {
          status: "created",
          observedAt: `2026-09-01T00:00:0${index}.000Z`,
        });
      }
      // Observed long after every live trade, so stalest-first alone would
      // never reach these two.
      await seedLaned("dvp_expired_funded", 10, {
        status: "expired",
        observedAt: "2026-09-10T00:00:00.000Z",
        escrows: ["1000", "0"],
        expiryTimestamp: RECENT_EXPIRY,
      });
      await seedLaned("dvp_recently_settled", 11, {
        status: "settled",
        observedAt: "2026-09-10T00:00:00.000Z",
        closedDaysAgo: 1,
      });

      const listed = await repo.listOpenForReconciliation(4);

      expect(listed.map((trade) => trade.id)).toEqual([
        "dvp_live_0",
        "dvp_live_1",
        "dvp_expired_funded",
        "dvp_recently_settled",
      ]);
    });

    it("gives an empty lane's turns to the lanes that have work", async () => {
      for (let index = 0; index < 5; index += 1) {
        await seedLaned(`dvp_live_${index}`, index, {
          status: "funded",
          observedAt: `2026-09-01T00:00:0${index}.000Z`,
        });
      }

      const listed = await repo.listOpenForReconciliation(4);

      expect(listed).toHaveLength(4);
    });

    // An expired trade with nothing left in it and nothing moving on its legs
    // has no work, so it stops taking a live trade's turn.
    it("moves an emptied expired trade out of the live lanes, and a claim keeps it in", async () => {
      for (let index = 0; index < 4; index += 1) {
        await seedLaned(`dvp_live_${index}`, index, {
          status: "created",
          observedAt: `2026-09-01T00:00:0${index}.000Z`,
        });
      }
      await seedLaned("dvp_expired_empty", 10, {
        status: "expired",
        observedAt: "2026-08-01T00:00:00.000Z",
        escrows: ["0", "0"],
        expiryTimestamp: RECENT_EXPIRY,
      });
      await seedLaned("dvp_expired_claimed", 11, {
        status: "expired",
        observedAt: "2026-08-02T00:00:00.000Z",
        escrows: ["0", "0"],
        expiryTimestamp: RECENT_EXPIRY,
      });
      await getDb(env)
        .prepare(
          `INSERT INTO dvp_leg_funding_claims
             (trade_id, side, organization_id, project_id, custody_wallet_id, signature, expiry_height, funding_tx)
           VALUES ('dvp_expired_claimed', 'a', ?, ?, ?, 'sig_receipt', '100', 'sig_receipt')`
        )
        .bind(TEST_ORG.id, TEST_PROJECT_ID, CUSTODY_WALLET_ID)
        .run();

      const lanes = await repo.listOpenForReconciliation(8);

      // Round one: two live, the claimed expired trade, then the emptied one in
      // the late-deposit lane even though it is the stalest row of all.
      expect(lanes.slice(0, 4).map((trade) => trade.id)).toEqual([
        "dvp_live_0",
        "dvp_live_1",
        "dvp_expired_claimed",
        "dvp_expired_empty",
      ]);
    });

    it("drops an emptied expired trade a week past its expiry, like a closed one", async () => {
      await seedLaned("dvp_expired_long_ago", 1, {
        status: "expired",
        observedAt: "2026-08-01T00:00:00.000Z",
        escrows: ["0", "0"],
        expiryTimestamp: String(Math.floor(Date.now() / 1000) - 8 * 86_400),
      });
      await seedLaned("dvp_expired_unobserved", 2, {
        status: "expired",
        observedAt: "2026-08-01T00:00:00.000Z",
        escrows: [null, null],
        expiryTimestamp: String(Math.floor(Date.now() / 1000) - 8 * 86_400),
      });

      const listed = await repo.listOpenForReconciliation(8);

      // Never observed empty is not known empty: that one keeps its lane.
      expect(listed.map((trade) => trade.id)).toEqual(["dvp_expired_unobserved"]);
    });
  });

  // Compare-and-swap: whoever moved the row off `creating` first had better
  // information, and a late caller must not overwrite it.
  it("refuses to resolve a trade that is no longer creating", async () => {
    const created = await repo.create(tradeInsert());
    await repo.resolveCreate(created.id, "created");

    await expect(repo.resolveCreate(created.id, "create_failed")).resolves.toBeNull();
    await expect(repo.getById(scope, created.id)).resolves.toMatchObject({ status: "created" });
  });

  it("returns null resolving a trade that does not exist", async () => {
    await expect(repo.resolveCreate("dvp_nope", "created")).resolves.toBeNull();
  });

  // The reason nonce and the amounts are TEXT columns.
  it("round-trips a u64 nonce above 2^53 without losing a digit", async () => {
    const created = await repo.create(tradeInsert({ nonce: BIG_NONCE, amountA: BIG_AMOUNT }));

    expect(created.nonce).toBe(BIG_NONCE);
    expect(created.amountA).toBe(BIG_AMOUNT);
    // The value survives the trip to a bigint too, which is what actually
    // derives the PDA.
    expect(BigInt(created.nonce).toString()).toBe(BIG_NONCE);
    expect(Number(created.nonce).toString()).not.toBe(BIG_NONCE);
  });

  it("reads a trade back by id", async () => {
    const created = await repo.create(tradeInsert());

    await expect(repo.getById(scope, created.id)).resolves.toMatchObject({ id: created.id });
  });

  it("reads a trade back by the address a counterparty sees", async () => {
    const created = await repo.create(tradeInsert());

    await expect(repo.getBySwapDvp(scope, created.swapDvp)).resolves.toMatchObject({
      id: created.id,
    });
  });

  it("lists a project's trades, newest first", async () => {
    await repo.create(
      tradeInsert({ id: "dvp_a", swapDvp: address("SwapA11111111111111111111111111111111111111") })
    );
    await repo.create(
      tradeInsert({ id: "dvp_b", swapDvp: address("SwapB11111111111111111111111111111111111111") })
    );

    const listed = await repo.listByProject(scope, UNFILTERED, 10);

    expect(listed).toHaveLength(2);
    expect(listed.map((t) => t.id).sort()).toEqual(["dvp_a", "dvp_b"]);
  });

  // A retry after an ambiguous broadcast must find the original rather than
  // create a second trade at a different address.
  it("finds a trade by the key its request carried", async () => {
    const created = await repo.create(tradeInsert({ idempotencyKey: "key-1" }));

    await expect(repo.getByIdempotencyKey(TEST_PROJECT_ID, "key-1")).resolves.toMatchObject({
      id: created.id,
    });
    await expect(repo.getByIdempotencyKey(TEST_PROJECT_ID, "other")).resolves.toBeNull();
  });

  it("refuses a second trade reusing a key within one project", async () => {
    await repo.create(tradeInsert({ idempotencyKey: "key-1" }));

    await expect(
      repo.create(
        tradeInsert({
          id: "dvp_trade_test_2",
          swapDvp: address("SwapZ11111111111111111111111111111111111111"),
          idempotencyKey: "key-1",
        })
      )
    ).rejects.toThrow();
  });

  // The guard lives in the statement rather than in the caller, because
  // `create_failed` is the only status proving nothing is on chain. Freeing a
  // key from any other status would let a retry create a SECOND trade while the
  // first one exists, which is what the key is there to prevent.
  describe("releaseIdempotencyKey", () => {
    it("frees the key of a definitively failed create", async () => {
      const created = await repo.create(tradeInsert({ idempotencyKey: "key-1" }));
      await repo.resolveCreate(created.id, "create_failed");

      await expect(repo.releaseIdempotencyKey(created.id)).resolves.toBe(true);
      await expect(repo.getByIdempotencyKey(TEST_PROJECT_ID, "key-1")).resolves.toBeNull();
    });

    it("lets the freed key be claimed by a new trade", async () => {
      const created = await repo.create(tradeInsert({ idempotencyKey: "key-1" }));
      await repo.resolveCreate(created.id, "create_failed");
      await repo.releaseIdempotencyKey(created.id);

      await expect(
        repo.create(
          tradeInsert({
            id: "dvp_trade_test_2",
            swapDvp: address("SwapZ11111111111111111111111111111111111111"),
            idempotencyKey: "key-1",
          })
        )
      ).resolves.toMatchObject({ id: "dvp_trade_test_2" });
    });

    it.each(["creating", "created"] as const)(
      "refuses to free a %s trade's key",
      async (status) => {
        const created = await repo.create(tradeInsert({ idempotencyKey: "key-1" }));
        if (status === "created") {
          await repo.resolveCreate(created.id, "created");
        }

        await expect(repo.releaseIdempotencyKey(created.id)).resolves.toBe(false);
        await expect(repo.getByIdempotencyKey(TEST_PROJECT_ID, "key-1")).resolves.toMatchObject({
          id: created.id,
        });
      }
    );

    // Second call finds no key left to free, so it reports false rather than
    // claiming it did the work twice.
    it("is idempotent", async () => {
      const created = await repo.create(tradeInsert({ idempotencyKey: "key-1" }));
      await repo.resolveCreate(created.id, "create_failed");

      await expect(repo.releaseIdempotencyKey(created.id)).resolves.toBe(true);
      await expect(repo.releaseIdempotencyKey(created.id)).resolves.toBe(false);
    });

    it("reports false for a trade that does not exist", async () => {
      await expect(repo.releaseIdempotencyKey("dvp_nope")).resolves.toBe(false);
    });
  });

  // Partial index: unkeyed trades all carry NULL and must not collide.
  it("allows any number of trades with no key", async () => {
    await repo.create(
      tradeInsert({ id: "dvp_n1", swapDvp: address("SwapN11111111111111111111111111111111111111") })
    );
    await repo.create(
      tradeInsert({ id: "dvp_n2", swapDvp: address("SwapN21111111111111111111111111111111111111") })
    );

    await expect(repo.listByProject(scope, UNFILTERED, 10)).resolves.toHaveLength(2);
  });

  // The program's nonce tombstone makes a (seeds, nonce) pair single-use forever,
  // so two rows for one on-chain trade should be impossible here too.
  it("refuses a second row for the same on-chain trade", async () => {
    await repo.create(tradeInsert());

    await expect(repo.create(tradeInsert({ id: "dvp_trade_test_2" }))).rejects.toThrow();
  });

  // A trade names two party addresses. A wallet-scoped API key is now admitted
  // iff a bound wallet's public key is a PARTY (user_a or user_b), which is the
  // correct reading of wallet scoping post-reshape. The dangerous case is the
  // empty list, which must deny rather than fall through to "no filter".
  describe("wallet scope", () => {
    // A third address that neither bound wallet's public key matches.
    const UNRELATED_PUBKEY = "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz";
    const UNRELATED_PUBKEY_2 = "DxR4Km2vQp8nRtYwZbCdFgHiJkLmNoPqRsTuVwXyZ12u";

    const bothTrades = async () => {
      // dvp_mine names WALLET_A's public key as user_a — visible to a key
      // bound to CUSTODY_WALLET_ID.
      await repo.create(
        tradeInsert({
          id: "dvp_mine",
          swapDvp: address("SwapA11111111111111111111111111111111111111"),
          userA: address(WALLET_A_PUBKEY),
          userB: address(UNRELATED_PUBKEY),
        })
      );
      // dvp_theirs names neither bound wallet's public key — invisible to a
      // key bound to either wallet.
      await repo.create(
        tradeInsert({
          id: "dvp_theirs",
          swapDvp: address("SwapB11111111111111111111111111111111111111"),
          userA: address(UNRELATED_PUBKEY),
          userB: address(UNRELATED_PUBKEY_2),
        })
      );
    };

    it("returns every trade when the scope is unrestricted", async () => {
      await bothTrades();

      const listed = await repo.listByProject({ ...scope, sdpWalletIds: null }, UNFILTERED, 10);

      expect(listed.map((t) => t.id).sort()).toEqual(["dvp_mine", "dvp_theirs"]);
    });

    it("admits only trades where a bound wallet's public key is a party", async () => {
      await bothTrades();

      const listed = await repo.listByProject(
        { ...scope, sdpWalletIds: [CUSTODY_WALLET_ID] },
        UNFILTERED,
        10
      );

      expect(listed.map((t) => t.id)).toEqual(["dvp_mine"]);
    });

    it("denies everything for a key with no usable bindings", async () => {
      await bothTrades();

      await expect(
        repo.listByProject({ ...scope, sdpWalletIds: [] }, UNFILTERED, 10)
      ).resolves.toEqual([]);
    });

    it("hides an out-of-scope trade from getById and getBySwapDvp", async () => {
      await bothTrades();
      const bound = { ...scope, sdpWalletIds: [CUSTODY_WALLET_ID] };

      await expect(repo.getById(bound, "dvp_theirs")).resolves.toBeNull();
      await expect(
        repo.getBySwapDvp(bound, address("SwapB11111111111111111111111111111111111111"))
      ).resolves.toBeNull();
      await expect(repo.getById(bound, "dvp_mine")).resolves.toMatchObject({ id: "dvp_mine" });
    });
  });

  // The filters narrow SERVER-SIDE, before the LIMIT, because the list is
  // capped with no cursor: a client-side filter over the newest page makes a
  // matching trade older than the page unfindable.
  describe("listByProject filters", () => {
    const SETTLED_SWAP = address("SwapS11111111111111111111111111111111111111");

    beforeEach(async () => {
      const db = getDb(env);
      await repo.create(tradeInsert({ id: "dvp_fl_open" }));
      await repo.create(tradeInsert({ id: "dvp_fl_settled", swapDvp: SETTLED_SWAP }));
      // The insert lands rows at `creating`, the only status a create may write;
      // advancing one to a terminal state is what a real close would leave.
      await db
        .prepare("UPDATE dvp_trades SET status = 'settled' WHERE id = ?")
        .bind("dvp_fl_settled")
        .run();
    });

    it("narrows to the listed statuses", async () => {
      const open = await repo.listByProject(
        scope,
        { statuses: ["created", "creating"], settlementAvailability: null, q: null },
        10
      );
      expect(open.map((t) => t.id)).toEqual(["dvp_fl_open"]);

      const settled = await repo.listByProject(
        scope,
        { statuses: ["settled"], settlementAvailability: null, q: null },
        10
      );
      expect(settled.map((t) => t.id)).toEqual(["dvp_fl_settled"]);
    });

    it("matches q against the trade id, a party address and a mint, case-insensitively", async () => {
      const byId = await repo.listByProject(
        scope,
        { statuses: null, settlementAvailability: null, q: "dvp_fl_open" },
        10
      );
      expect(byId.map((t) => t.id)).toEqual(["dvp_fl_open"]);

      // WALLET_A_PUBKEY is user_a on both seeded trades.
      const byParty = await repo.listByProject(
        scope,
        { statuses: null, settlementAvailability: null, q: WALLET_A_PUBKEY.toLowerCase() },
        10
      );
      expect(byParty.map((t) => t.id).sort()).toEqual(["dvp_fl_open", "dvp_fl_settled"]);

      // mint_a on both seeded trades.
      const byMint = await repo.listByProject(
        scope,
        {
          statuses: null,
          settlementAvailability: null,
          q: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
        },
        10
      );
      expect(byMint.map((t) => t.id).sort()).toEqual(["dvp_fl_open", "dvp_fl_settled"]);
    });

    it("matches q against a leg symbol", async () => {
      // tradeInsert seeds symbolA "ATD", symbolB "USDC".
      const bySymbol = await repo.listByProject(
        scope,
        { statuses: null, settlementAvailability: null, q: "usdc" },
        10
      );
      expect(bySymbol.map((t) => t.id).sort()).toEqual(["dvp_fl_open", "dvp_fl_settled"]);

      const byNothing = await repo.listByProject(
        scope,
        { statuses: null, settlementAvailability: null, q: "ZZZZ" },
        10
      );
      expect(byNothing).toEqual([]);
    });

    // A raw `%` in the query is a literal, not a wildcard: unescaped it would
    // match every row and quietly turn the filter off.
    it("treats ILIKE wildcards in the query as literal characters", async () => {
      const percent = await repo.listByProject(
        scope,
        { statuses: null, settlementAvailability: null, q: "%" },
        10
      );
      expect(percent).toEqual([]);

      const underscore = await repo.listByProject(
        scope,
        { statuses: null, settlementAvailability: null, q: "dvp_fl_ope_" },
        10
      );
      expect(underscore).toEqual([]);
    });

    // The list narrows in SQL before its LIMIT; the response derives availability
    // in TypeScript. Every case goes through both, and they must agree.
    it("narrows by settlement availability exactly as the response derives it", async () => {
      const db = getDb(env);
      const cases = [
        { id: "dvp_av_ready", status: "funded", earliest: null, cluster: "1800000000" },
        { id: "dvp_av_edge", status: "funded", earliest: "1800000000", cluster: "1800000000" },
        { id: "dvp_av_early", status: "funded", earliest: "1800000001", cluster: "1800000000" },
        { id: "dvp_av_unobserved", status: "funded", earliest: null, cluster: null },
        { id: "dvp_av_partial", status: "partially_funded", earliest: null, cluster: "1800000000" },
        { id: "dvp_av_expired", status: "expired", earliest: null, cluster: "1800000000" },
      ] as const;
      for (const trade of cases) {
        await repo.create(
          tradeInsert({
            id: trade.id,
            swapDvp: (await generateKeyPairSigner()).address,
            earliestSettlementTimestamp: trade.earliest,
          })
        );
        await db
          .prepare("UPDATE dvp_trades SET status = ?, observed_cluster_timestamp = ? WHERE id = ?")
          .bind(trade.status, trade.cluster, trade.id)
          .run();
      }

      const every = await repo.listByProject(scope, UNFILTERED, 50);
      for (const availability of DVP_SETTLEMENT_AVAILABILITY) {
        const listed = await repo.listByProject(
          scope,
          { statuses: null, settlementAvailability: [availability], q: null },
          50
        );
        const derived = every
          .filter((row) => deriveDvpSettlementAvailability(row) === availability)
          .map((row) => row.id);
        expect(listed.map((row) => row.id).sort()).toEqual(derived.sort());
      }
      const ready = await repo.listByProject(
        scope,
        { statuses: null, settlementAvailability: ["available"], q: null },
        50
      );
      expect(ready.map((row) => row.id).sort()).toEqual(["dvp_av_edge", "dvp_av_ready"]);
    });

    it("composes with the wallet-scope clause: a bound wallet still sees only its party trades, filtered", async () => {
      const listed = await repo.listByProject(
        { ...scope, sdpWalletIds: [CUSTODY_WALLET_ID] },
        { statuses: ["settled"], settlementAvailability: null, q: null },
        10
      );
      expect(listed.map((t) => t.id)).toEqual(["dvp_fl_settled"]);
    });
  });

  describe("listInboundForParty", () => {
    // A third address that neither bound wallet's public key matches.
    const UNRELATED_PUBKEY = "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz";

    const inboundScope = (partyAddresses: Address[]): DvpInboundScope => ({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      partyAddresses,
    });

    // The list only answers for open statuses, so each seeded trade is advanced
    // to `created` the way a real create would leave it.
    it("returns nothing when the caller holds no wallets", async () => {
      await expect(repo.listInboundForParty(inboundScope([]), 10)).resolves.toEqual([]);
    });

    it("excludes the caller's own project, where the trade is already listed", async () => {
      await repo.create(
        tradeInsert({
          id: "dvp_inbound_own_project",
          swapDvp: address("SwapW11111111111111111111111111111111111111"),
          userA: address(WALLET_A_PUBKEY),
          userB: address(UNRELATED_PUBKEY),
        })
      );
      await repo.resolveCreate("dvp_inbound_own_project", "created");

      await expect(
        repo.listInboundForParty(inboundScope([address(WALLET_A_PUBKEY)]), 10)
      ).resolves.toEqual([]);
    });
  });
});
