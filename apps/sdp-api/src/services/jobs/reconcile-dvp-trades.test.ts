import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresDvpTradeRepository } from "@/db/repositories/dvp-trade.repository.postgres";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const getBlockHeight = vi.hoisted(() => vi.fn());
const readDvpTradeObservation = vi.hoisted(() => vi.fn());

vi.mock("@sdp/rpc/solana", () => ({
  createRpc: () => ({ getBlockHeight: () => ({ send: getBlockHeight }) }),
}));
vi.mock("@/services/dvp/read-chain", () => ({ readDvpTradeObservation }));

const { reconcileDvpTrades } = await import("./reconcile-dvp-trades");

const PROJECT_ID = "prj_dvp_job_test";
const CUSTODY_CONFIG_ID = "cust_dvp_job_test";
const CUSTODY_WALLET_ID = "cwlt_dvp_job_test";

function leg(amount: bigint, frozen = false) {
  return { exists: true, amount, frozen };
}

/** The default: trade on chain, both escrows empty. */
function observation(overrides: Record<string, unknown> = {}) {
  return {
    tradeAccountExists: true,
    legA: leg(0n),
    legB: leg(0n),
    blockHeight: 1_000n,
    ...overrides,
  };
}

async function seedTrade(id: string, status: string, overrides: Record<string, string> = {}) {
  await getDb(env)
    .prepare(
      `INSERT INTO dvp_trades (
         id, organization_id, project_id, swap_dvp,
         settlement_authority, user_a, user_b, mint_a, mint_b, nonce,
         token_program_a, token_program_b,
         amount_a, amount_b, expiry_timestamp,
         user_a_settlement_destination, user_b_settlement_destination,
         escrow_a, escrow_b, sdp_side, sdp_wallet_id, status,
         create_last_valid_block_height
       ) VALUES (
         ?, ?, ?, ?,
         '9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY',
         '5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn',
         '7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg',
         'ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1',
         'AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE',
         '42',
         'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
         'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
         '1000', '2000', ?,
         '5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn',
         '7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg',
         'FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU',
         '6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y',
         'a', ?, ?, ?
       )`
    )
    .bind(
      id,
      TEST_ORG.id,
      PROJECT_ID,
      `Swap_${id}`.padEnd(43, "1"),
      overrides.expiryTimestamp ?? String(Math.floor(Date.now() / 1000) + 3600),
      CUSTODY_WALLET_ID,
      status,
      overrides.createLastValidBlockHeight ?? "1500"
    )
    .run();
}

async function statusOf(id: string): Promise<Record<string, unknown> | null> {
  return getDb(env)
    .prepare(
      "SELECT status, escrow_a_amount, escrow_b_amount, escrow_a_frozen, observed_at FROM dvp_trades WHERE id = ?"
    )
    .bind(id)
    .first<Record<string, unknown>>();
}

describe("reconcileDvpTrades", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    env.MARKETS_ENABLED = "true";
    env.DVP_ENABLED = "true";
    getBlockHeight.mockResolvedValue(1_000n);
    readDvpTradeObservation.mockResolvedValue(observation());

    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
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
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, TEST_ORG.id, PROJECT_ID, TEST_USER.id)
      .run();
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
  });

  it("does nothing when the DvP flag is off", async () => {
    env.DVP_ENABLED = undefined;
    await seedTrade("dvp_flagged_off", "created");

    await reconcileDvpTrades(env);

    expect(readDvpTradeObservation).not.toHaveBeenCalled();
    await expect(statusOf("dvp_flagged_off")).resolves.toMatchObject({ observed_at: null });
    env.DVP_ENABLED = "true";
  });

  it("records the observed balances and advances the status", async () => {
    await seedTrade("dvp_funding", "created");
    readDvpTradeObservation.mockResolvedValue(observation({ legA: leg(1000n), legB: leg(2000n) }));

    await reconcileDvpTrades(env);

    const row = await statusOf("dvp_funding");
    expect(row).toMatchObject({
      status: "funded",
      escrow_a_amount: "1000",
      escrow_b_amount: "2000",
    });
    // The observation timestamp is part of the answer: a status with no
    // recorded reading time is a claim with no provenance.
    expect(row?.observed_at).toBeTruthy();
  });

  it("resolves a creating trade once its create blockhash has expired", async () => {
    await seedTrade("dvp_dead_create", "creating", { createLastValidBlockHeight: "900" });
    readDvpTradeObservation.mockResolvedValue(observation({ tradeAccountExists: false }));
    getBlockHeight.mockResolvedValue(901n);

    await reconcileDvpTrades(env);

    await expect(statusOf("dvp_dead_create")).resolves.toMatchObject({ status: "create_failed" });
  });

  it("leaves a creating trade alone while its blockhash can still land", async () => {
    await seedTrade("dvp_live_create", "creating", { createLastValidBlockHeight: "2000" });
    readDvpTradeObservation.mockResolvedValue(observation({ tradeAccountExists: false }));
    getBlockHeight.mockResolvedValue(1_000n);

    await reconcileDvpTrades(env);

    await expect(statusOf("dvp_live_create")).resolves.toMatchObject({ status: "creating" });
  });

  it("records a frozen escrow, which balance alone cannot distinguish from unpaid", async () => {
    await seedTrade("dvp_frozen", "created");
    readDvpTradeObservation.mockResolvedValue(observation({ legA: leg(0n, true) }));

    await reconcileDvpTrades(env);

    await expect(statusOf("dvp_frozen")).resolves.toMatchObject({
      status: "created",
      escrow_a_frozen: true,
    });
  });

  it("does not claim a vanished trade settled", async () => {
    await seedTrade("dvp_gone", "funded");
    readDvpTradeObservation.mockResolvedValue(observation({ tradeAccountExists: false }));

    await reconcileDvpTrades(env);

    await expect(statusOf("dvp_gone")).resolves.toMatchObject({ status: "closed_unknown" });
  });

  // The most destructive failure this job could cause. `create_failed` and
  // `closed_unknown` are both terminal and both excluded from later sweeps, so
  // treating a rate-limited RPC as "the account is gone" would permanently
  // misclassify a live trade with nothing left to correct it.
  it("never writes a terminal status when the chain could not be read", async () => {
    await seedTrade("dvp_rpc_down", "funded");
    readDvpTradeObservation.mockRejectedValue(new Error("429 Too Many Requests"));

    await reconcileDvpTrades(env);

    const row = await statusOf("dvp_rpc_down");
    expect(row).toMatchObject({ status: "funded" });
    // Still unobserved, so the next sweep picks it up first.
    expect(row?.observed_at).toBeNull();
  });

  it("leaves a creating trade alone when the chain could not be read", async () => {
    await seedTrade("dvp_creating_rpc_down", "creating", {
      createLastValidBlockHeight: "1",
    });
    readDvpTradeObservation.mockRejectedValue(new Error("socket hang up"));
    getBlockHeight.mockResolvedValue(999_999n);

    await reconcileDvpTrades(env);

    await expect(statusOf("dvp_creating_rpc_down")).resolves.toMatchObject({
      status: "creating",
    });
  });

  // One unreadable trade must not end the sweep, or a single bad row would
  // permanently starve every trade behind it.
  it("keeps sweeping after a trade fails to read", async () => {
    await seedTrade("dvp_broken", "created");
    await seedTrade("dvp_healthy", "created");
    readDvpTradeObservation
      .mockRejectedValueOnce(new Error("rpc exploded"))
      .mockResolvedValue(observation({ legA: leg(1000n), legB: leg(2000n) }));

    await reconcileDvpTrades(env);

    await expect(statusOf("dvp_broken")).resolves.toMatchObject({ status: "created" });
    await expect(statusOf("dvp_healthy")).resolves.toMatchObject({ status: "funded" });
  });

  it("does not sweep trades that already reached a terminal state", async () => {
    await seedTrade("dvp_settled", "settled");

    await reconcileDvpTrades(env);

    expect(readDvpTradeObservation).not.toHaveBeenCalled();
  });

  // A row something better-informed already advanced must win over a sweep
  // working from a read taken before that.
  it("does not overwrite a row that moved under it", async () => {
    await seedTrade("dvp_raced", "created");
    const repository = createPostgresDvpTradeRepository(getDb(env));

    const lost = await repository.recordObservation({
      id: "dvp_raced",
      expectedStatus: "creating",
      status: "create_failed",
      escrowAAmount: null,
      escrowBAmount: null,
      escrowAFrozen: null,
      escrowBFrozen: null,
      observedAt: new Date().toISOString(),
    });

    expect(lost).toBeNull();
    await expect(statusOf("dvp_raced")).resolves.toMatchObject({ status: "created" });
  });
});
