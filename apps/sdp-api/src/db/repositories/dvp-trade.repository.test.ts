import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { DvpTradeInsert, DvpTradeRepository } from "./dvp-trade.repository";
import { createPostgresDvpTradeRepository } from "./dvp-trade.repository.postgres";

const TEST_PROJECT_ID = "prj_dvp_repo_test";
const OTHER_PROJECT_ID = "prj_dvp_repo_other";
const CUSTODY_CONFIG_ID = "cust_dvp_repo_test";
const CUSTODY_WALLET_ID = "cwlt_dvp_repo_test";
const OTHER_CUSTODY_WALLET_ID = "cwlt_dvp_repo_other";

// Deliberately above Number.MAX_SAFE_INTEGER (9007199254740991). The nonce is a
// PDA seed, so if anything in the storage path routes it through a JS number it
// rounds here, and the trade's SwapDvp address stops matching the one the
// counterparty was told to fund.
const BIG_NONCE = "18446744073709551610";
const BIG_AMOUNT = "18446744073709551615";

function tradeInsert(overrides: Partial<DvpTradeInsert> = {}): DvpTradeInsert {
  return {
    id: "dvp_trade_test_1",
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    swapDvp: "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
    settlementAuthority: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
    userA: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
    userB: "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg",
    mintA: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
    mintB: "AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE",
    nonce: BIG_NONCE,
    tokenProgramA: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    tokenProgramB: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    amountA: "1000",
    amountB: "2000",
    expiryTimestamp: "1800003600",
    earliestSettlementTimestamp: null,
    userASettlementDestination: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
    userBSettlementDestination: "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg",
    refString: null,
    escrowA: "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU",
    escrowB: "6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y",
    sdpSide: "a",
    sdpWalletId: CUSTODY_WALLET_ID,
    idempotencyKey: null,
    idempotencyFingerprint: null,
    createSignature: null,
    createLastValidBlockHeight: null,
    ...overrides,
  };
}

const scope = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };

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
         VALUES (?, ?, 'w1', '5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn', 'active')`
      )
      .bind(CUSTODY_WALLET_ID, CUSTODY_CONFIG_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, 'w2', '7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg', 'active')`
      )
      .bind(OTHER_CUSTODY_WALLET_ID, CUSTODY_CONFIG_ID)
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
    expect(created.sdpSide).toBe("a");
    expect(created.createdAt).toBeTruthy();
  });

  it("resolves a creating trade to created once the broadcast is accepted", async () => {
    const created = await repo.create(tradeInsert());

    const resolved = await repo.resolveCreate(created.id, "created");

    expect(resolved?.status).toBe("created");
    await expect(repo.getById(scope, created.id)).resolves.toMatchObject({ status: "created" });
  });

  it("resolves a creating trade to create_failed when the broadcast is rejected", async () => {
    const created = await repo.create(tradeInsert());

    const resolved = await repo.resolveCreate(created.id, "create_failed");

    expect(resolved?.status).toBe("create_failed");
    // The seed tuple survives a failed create. It is the only durable copy of
    // what RecoverDvp needs, and a preflight rejection is not proof that a
    // retransmission of the same bytes can never land.
    expect(resolved?.nonce).toBe(BIG_NONCE);
    expect(resolved?.swapDvp).toBe(created.swapDvp);
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
      tradeInsert({ id: "dvp_a", swapDvp: "SwapA11111111111111111111111111111111111111" })
    );
    await repo.create(
      tradeInsert({ id: "dvp_b", swapDvp: "SwapB11111111111111111111111111111111111111" })
    );

    const listed = await repo.listByProject(scope, 10);

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
          swapDvp: "SwapZ11111111111111111111111111111111111111",
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
            swapDvp: "SwapZ11111111111111111111111111111111111111",
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
      tradeInsert({ id: "dvp_n1", swapDvp: "SwapN11111111111111111111111111111111111111" })
    );
    await repo.create(
      tradeInsert({ id: "dvp_n2", swapDvp: "SwapN21111111111111111111111111111111111111" })
    );

    await expect(repo.listByProject(scope, 10)).resolves.toHaveLength(2);
  });

  // The program's nonce tombstone makes a (seeds, nonce) pair single-use forever,
  // so two rows for one on-chain trade should be impossible here too.
  it("refuses a second row for the same on-chain trade", async () => {
    await repo.create(tradeInsert());

    await expect(repo.create(tradeInsert({ id: "dvp_trade_test_2" }))).rejects.toThrow();
  });

  // A trade names the custody wallet holding SDP's leg, so a wallet-scoped API
  // key reading one for a wallet it is not bound to is reading outside its
  // scope. The dangerous case is the empty list, which must deny rather than
  // fall through to "no filter".
  describe("wallet scope", () => {
    const bothTrades = async () => {
      await repo.create(
        tradeInsert({ id: "dvp_mine", swapDvp: "SwapA11111111111111111111111111111111111111" })
      );
      await repo.create(
        tradeInsert({
          id: "dvp_theirs",
          swapDvp: "SwapB11111111111111111111111111111111111111",
          sdpWalletId: OTHER_CUSTODY_WALLET_ID,
        })
      );
    };

    it("returns every trade when the scope is unrestricted", async () => {
      await bothTrades();

      const listed = await repo.listByProject({ ...scope, sdpWalletIds: null }, 10);

      expect(listed.map((t) => t.id).sort()).toEqual(["dvp_mine", "dvp_theirs"]);
    });

    it("returns only the bound wallet's trades", async () => {
      await bothTrades();

      const listed = await repo.listByProject({ ...scope, sdpWalletIds: [CUSTODY_WALLET_ID] }, 10);

      expect(listed.map((t) => t.id)).toEqual(["dvp_mine"]);
    });

    it("denies everything for a key with no usable bindings", async () => {
      await bothTrades();

      await expect(repo.listByProject({ ...scope, sdpWalletIds: [] }, 10)).resolves.toEqual([]);
    });

    it("hides an out-of-scope trade from getById and getBySwapDvp", async () => {
      await bothTrades();
      const bound = { ...scope, sdpWalletIds: [CUSTODY_WALLET_ID] };

      await expect(repo.getById(bound, "dvp_theirs")).resolves.toBeNull();
      await expect(
        repo.getBySwapDvp(bound, "SwapB11111111111111111111111111111111111111")
      ).resolves.toBeNull();
      await expect(repo.getById(bound, "dvp_mine")).resolves.toMatchObject({ id: "dvp_mine" });
    });
  });
});
