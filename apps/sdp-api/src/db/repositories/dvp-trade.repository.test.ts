import { type Address, address, signature } from "@solana/kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type {
  DvpInboundScope,
  DvpTradeInsert,
  DvpTradeListFilters,
  DvpTradeRepository,
} from "./dvp-trade.repository";
import { createPostgresDvpTradeRepository } from "./dvp-trade.repository.postgres";

const TEST_PROJECT_ID = "prj_dvp_repo_test";
const OTHER_PROJECT_ID = "prj_dvp_repo_other";
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
const UNFILTERED: DvpTradeListFilters = { statuses: null, q: null };

describe("DvpTradeRepository (postgres)", () => {
  let repo: DvpTradeRepository;

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
    for (const projectId of [TEST_PROJECT_ID, OTHER_PROJECT_ID]) {
      await db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
        )
        .bind(projectId, TEST_ORG.id, projectId, TEST_USER.id)
        .run();
    }
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

  // The row is written before the create transaction is broadcast, so its
  // opening state has to be "outcome unknown" rather than "created". Anything
  // else would claim an on-chain fact nothing has observed yet.
  it("persists a trade and defaults it to creating", async () => {
    const created = await repo.create(tradeInsert());

    expect(created.status).toBe("creating");
    expect(created.swapDvp).toBe("BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po");
    expect(created.counterpartyAccountIdA).toBeNull();
    expect(created.counterpartyAccountIdB).toBeNull();
    expect(created.createdAt).toBeTruthy();
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
    });

    expect(first?.escrowAPeakAmount).toBe("900");
    expect(reclaimed?.escrowAPeakAmount).toBe("900");
    expect(reclaimed?.escrowAAmount).toBe("100");
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

  it("does not leak a trade across projects", async () => {
    const created = await repo.create(tradeInsert());
    const otherScope = { organizationId: TEST_ORG.id, projectId: OTHER_PROJECT_ID };

    await expect(repo.getById(otherScope, created.id)).resolves.toBeNull();
    await expect(repo.getBySwapDvp(otherScope, created.swapDvp)).resolves.toBeNull();
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
        { statuses: ["created", "creating"], q: null },
        10
      );
      expect(open.map((t) => t.id)).toEqual(["dvp_fl_open"]);

      const settled = await repo.listByProject(scope, { statuses: ["settled"], q: null }, 10);
      expect(settled.map((t) => t.id)).toEqual(["dvp_fl_settled"]);
    });

    it("matches q against the trade id, a party address and a mint, case-insensitively", async () => {
      const byId = await repo.listByProject(scope, { statuses: null, q: "dvp_fl_open" }, 10);
      expect(byId.map((t) => t.id)).toEqual(["dvp_fl_open"]);

      // WALLET_A_PUBKEY is user_a on both seeded trades.
      const byParty = await repo.listByProject(
        scope,
        { statuses: null, q: WALLET_A_PUBKEY.toLowerCase() },
        10
      );
      expect(byParty.map((t) => t.id).sort()).toEqual(["dvp_fl_open", "dvp_fl_settled"]);

      // mint_a on both seeded trades.
      const byMint = await repo.listByProject(
        scope,
        { statuses: null, q: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1" },
        10
      );
      expect(byMint.map((t) => t.id).sort()).toEqual(["dvp_fl_open", "dvp_fl_settled"]);
    });

    it("matches q against a leg symbol", async () => {
      // tradeInsert seeds symbolA "ATD", symbolB "USDC".
      const bySymbol = await repo.listByProject(scope, { statuses: null, q: "usdc" }, 10);
      expect(bySymbol.map((t) => t.id).sort()).toEqual(["dvp_fl_open", "dvp_fl_settled"]);

      const byNothing = await repo.listByProject(scope, { statuses: null, q: "ZZZZ" }, 10);
      expect(byNothing).toEqual([]);
    });

    // A raw `%` in the query is a literal, not a wildcard: unescaped it would
    // match every row and quietly turn the filter off.
    it("treats ILIKE wildcards in the query as literal characters", async () => {
      const percent = await repo.listByProject(scope, { statuses: null, q: "%" }, 10);
      expect(percent).toEqual([]);

      const underscore = await repo.listByProject(scope, { statuses: null, q: "dvp_fl_ope_" }, 10);
      expect(underscore).toEqual([]);
    });

    it("composes with the wallet-scope clause: a bound wallet still sees only its party trades, filtered", async () => {
      const listed = await repo.listByProject(
        { ...scope, sdpWalletIds: [CUSTODY_WALLET_ID] },
        { statuses: ["settled"], q: null },
        10
      );
      expect(listed.map((t) => t.id)).toEqual(["dvp_fl_settled"]);
    });

    it("stays tenant-scoped under filters: another project's matching trade is empty", async () => {
      const other = await repo.listByProject(
        { organizationId: TEST_ORG.id, projectId: OTHER_PROJECT_ID },
        { statuses: ["settled"], q: "dvp_fl_settled" },
        10
      );
      expect(other).toEqual([]);
    });
  });

  describe("listInboundForParty", () => {
    // A third address that neither bound wallet's public key matches.
    const UNRELATED_PUBKEY = "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz";
    const UNRELATED_PUBKEY_2 = "DxR4Km2vQp8nRtYwZbCdFgHiJkLmNoPqRsTuVwXyZ12u";

    const inboundScope = (partyAddresses: Address[]): DvpInboundScope => ({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      partyAddresses,
    });

    // The list only answers for open statuses, so each seeded trade is advanced
    // to `created` the way a real create would leave it.
    const createdForeignTrade = (id: string, swapDvp: string, userA: Address, userB: Address) =>
      repo
        .create(
          tradeInsert({
            id,
            projectId: OTHER_PROJECT_ID,
            swapDvp: address(swapDvp),
            userA,
            userB,
          })
        )
        .then((trade) => repo.resolveCreate(trade.id, "created"));

    it("returns nothing when the caller holds no wallets", async () => {
      await expect(repo.listInboundForParty(inboundScope([]), 10)).resolves.toEqual([]);
    });

    it("returns nothing when no caller address is a party to any foreign trade", async () => {
      await createdForeignTrade(
        "dvp_inbound_unrelated",
        "SwapU11111111111111111111111111111111111111",
        address(WALLET_B_PUBKEY),
        address(UNRELATED_PUBKEY)
      );

      // The caller holds WALLET_A only; the foreign trade names WALLET_B.
      await expect(
        repo.listInboundForParty(inboundScope([address(WALLET_A_PUBKEY)]), 10)
      ).resolves.toEqual([]);
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

    it("returns a foreign trade naming the caller's address, and not an unrelated foreign one", async () => {
      await createdForeignTrade(
        "dvp_inbound_mine",
        "SwapM11111111111111111111111111111111111111",
        address(WALLET_A_PUBKEY),
        address(UNRELATED_PUBKEY)
      );
      await createdForeignTrade(
        "dvp_inbound_theirs",
        "SwapT11111111111111111111111111111111111111",
        address(UNRELATED_PUBKEY),
        address(UNRELATED_PUBKEY_2)
      );

      const listed = await repo.listInboundForParty(inboundScope([address(WALLET_A_PUBKEY)]), 10);

      expect(listed.map((trade) => trade.id)).toEqual(["dvp_inbound_mine"]);
    });
  });
});
