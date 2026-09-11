import { getBase58Decoder } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresDvpLegFundingClaimRepository } from "@/db/repositories/dvp-leg-funding-claim.repository";
import { createPostgresDvpTradeRepository } from "@/db/repositories/dvp-trade.repository.postgres";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const getBlockHeight = vi.hoisted(() => vi.fn());
const readDvpTradeObservation = vi.hoisted(() => vi.fn());
const getSignatureStatusesMock = vi.hoisted(() => vi.fn());
const resolveDvpClose = vi.hoisted(() => vi.fn());

vi.mock("@sdp/rpc/solana", () => ({
  createRpc: () => ({ getBlockHeight: () => ({ send: getBlockHeight }) }),
  getSignatureStatuses: getSignatureStatusesMock,
}));
vi.mock("@/services/dvp/read-chain", () => ({ readDvpTradeObservation }));
vi.mock("@/services/dvp/closing-transaction", () => ({ resolveDvpClose }));

const { reconcileDvpTrades } = await import("./reconcile-dvp-trades");

const PROJECT_ID = "prj_dvp_job_test";
const CUSTODY_CONFIG_ID = "cust_dvp_job_test";
const CUSTODY_WALLET_ID = "cwlt_dvp_job_test";

/** A real base58 64-byte signature, so the resolving job's validation accepts it. */
const SIG =
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy";

/** The RPC's answer for a transfer that landed: any confirmation status. */
const LANDED_STATUS = [{ slot: 5n, confirmations: 1n, confirmationStatus: "confirmed", err: null }];

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
    closeResolution: null,
    ...overrides,
  };
}

/**
 * A distinct, structurally valid trade address per test id. The repository
 * mapping brands `swap_dvp` with kit's `address()`, which base58-decodes to
 * exactly 32 bytes — a padded placeholder string no longer passes.
 */
function swapDvpFor(id: string): string {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode(id).subarray(0, 32));
  return getBase58Decoder().decode(bytes);
}

async function seedTrade(
  id: string,
  status: string,
  overrides: {
    expiryTimestamp?: string;
    createLastValidBlockHeight?: string | null;
    createSignature?: string | null;
    createdAt?: string;
    closeResolutionAttempts?: number;
    closeResolutionAfter?: string | null;
  } = {}
) {
  await getDb(env)
    .prepare(
      `INSERT INTO dvp_trades (
         id, organization_id, project_id, swap_dvp,
         settlement_authority, user_a, user_b, mint_a, mint_b, nonce,
         token_program_a, token_program_b,
         amount_a, amount_b, expiry_timestamp,
         user_a_settlement_destination, user_b_settlement_destination,
         escrow_a, escrow_b, status,
         create_signature, create_last_valid_block_height
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
         ?, ?, ?
       )`
    )
    .bind(
      id,
      TEST_ORG.id,
      PROJECT_ID,
      swapDvpFor(id),
      overrides.expiryTimestamp ?? String(Math.floor(Date.now() / 1000) + 3600),
      status,
      Object.hasOwn(overrides, "createSignature") ? overrides.createSignature : SIG,
      Object.hasOwn(overrides, "createLastValidBlockHeight")
        ? overrides.createLastValidBlockHeight
        : "1500"
    )
    .run();
  if (overrides.createdAt !== undefined) {
    await getDb(env)
      .prepare("UPDATE dvp_trades SET created_at = ? WHERE id = ?")
      .bind(overrides.createdAt, id)
      .run();
  }
  if (
    overrides.closeResolutionAttempts !== undefined ||
    overrides.closeResolutionAfter !== undefined
  ) {
    await getDb(env)
      .prepare(
        "UPDATE dvp_trades SET close_resolution_attempts = ?, close_resolution_after = ? WHERE id = ?"
      )
      .bind(
        overrides.closeResolutionAttempts === undefined ? 0 : overrides.closeResolutionAttempts,
        overrides.closeResolutionAfter === undefined ? null : overrides.closeResolutionAfter,
        id
      )
      .run();
  }
}

async function statusOf(id: string): Promise<Record<string, unknown> | null> {
  return getDb(env)
    .prepare(
      "SELECT status, escrow_a_amount, escrow_b_amount, escrow_a_frozen, observed_at, close_signature, close_resolution_attempts, close_resolution_after FROM dvp_trades WHERE id = ?"
    )
    .bind(id)
    .first<Record<string, unknown>>();
}

describe("reconcileDvpTrades", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    env.MARKETS_ENABLED = "true";
    getBlockHeight.mockResolvedValue(1_000n);
    // Default: broadcast claims check out on chain as landed, so existing
    // receipt rows survive. Tests that exercise a dead broadcast override.
    getSignatureStatusesMock.mockResolvedValue(LANDED_STATUS);
    resolveDvpClose.mockResolvedValue({ kind: "absent" });
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

  it("does nothing when Markets is off", async () => {
    env.MARKETS_ENABLED = undefined;
    await seedTrade("markets_off", "created");

    await reconcileDvpTrades(env);

    expect(readDvpTradeObservation).not.toHaveBeenCalled();
    await expect(statusOf("markets_off")).resolves.toMatchObject({ observed_at: null });
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

  it("leaves an unsigned claim creating while it is younger than the grace period", async () => {
    await seedTrade("dvp_young_claim", "creating", {
      createSignature: null,
      createLastValidBlockHeight: null,
      createdAt: new Date(Date.now() - 14 * 60 * 1_000).toISOString(),
    });
    readDvpTradeObservation.mockResolvedValue(observation({ tradeAccountExists: false }));

    await reconcileDvpTrades(env);

    await expect(statusOf("dvp_young_claim")).resolves.toMatchObject({ status: "creating" });
  });

  it("fails an unsigned claim once it is older than the grace period", async () => {
    await seedTrade("dvp_orphaned_claim", "creating", {
      createSignature: null,
      createLastValidBlockHeight: null,
      createdAt: new Date(Date.now() - 16 * 60 * 1_000).toISOString(),
    });
    readDvpTradeObservation.mockResolvedValue(observation({ tradeAccountExists: false }));

    await reconcileDvpTrades(env);

    await expect(statusOf("dvp_orphaned_claim")).resolves.toMatchObject({
      status: "create_failed",
    });
  });

  it("uses block height rather than claim age after a signature is attached", async () => {
    await seedTrade("dvp_signed_old_claim", "creating", {
      createSignature: SIG,
      createLastValidBlockHeight: "2000",
      createdAt: new Date(Date.now() - 16 * 60 * 1_000).toISOString(),
    });
    readDvpTradeObservation.mockResolvedValue(observation({ tradeAccountExists: false }));

    await reconcileDvpTrades(env);

    await expect(statusOf("dvp_signed_old_claim")).resolves.toMatchObject({ status: "creating" });
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

  it("records a decoded close and its signature", async () => {
    await seedTrade("dvp_external_settle", "funded");
    readDvpTradeObservation.mockResolvedValue(observation({ tradeAccountExists: false }));
    resolveDvpClose.mockResolvedValue({ kind: "resolved", status: "settled", signature: SIG });

    await reconcileDvpTrades(env);

    await expect(statusOf("dvp_external_settle")).resolves.toMatchObject({
      status: "settled",
      close_signature: SIG,
    });
  });

  it("defers another close lookup after the page cap", async () => {
    await seedTrade("dvp_capped", "closed_unknown", {
      closeResolutionAttempts: 2,
      closeResolutionAfter: null,
    });
    await getDb(env)
      .prepare("UPDATE dvp_trades SET closed_at = sdp_iso_now() WHERE id = ?")
      .bind("dvp_capped")
      .run();
    readDvpTradeObservation.mockResolvedValue(observation({ tradeAccountExists: false }));
    resolveDvpClose.mockResolvedValue({ kind: "capped" });
    const before = Date.now();

    await reconcileDvpTrades(env);

    const row = await statusOf("dvp_capped");
    expect(row?.close_resolution_attempts).toBe(3);
    expect(Date.parse(String(row?.close_resolution_after))).toBeGreaterThanOrEqual(
      before + 4 * 60_000
    );
  });

  it("does not resolve a close before its deferred instant", async () => {
    await seedTrade("dvp_deferred", "closed_unknown", {
      closeResolutionAttempts: 1,
      closeResolutionAfter: new Date(Date.now() + 60_000).toISOString(),
    });
    await getDb(env)
      .prepare("UPDATE dvp_trades SET closed_at = sdp_iso_now() WHERE id = ?")
      .bind("dvp_deferred")
      .run();
    readDvpTradeObservation.mockResolvedValue(observation({ tradeAccountExists: false }));

    await reconcileDvpTrades(env);

    expect(resolveDvpClose).not.toHaveBeenCalled();
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

  it("revisits recently closed trades for late deposits", async () => {
    await seedTrade("dvp_settled", "settled");
    await getDb(env)
      .prepare("UPDATE dvp_trades SET closed_at = sdp_iso_now() WHERE id = 'dvp_settled'")
      .run();

    await reconcileDvpTrades(env);

    expect(readDvpTradeObservation).toHaveBeenCalledTimes(1);
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
      closeSignature: null,
      observedAt: new Date().toISOString(),
    });

    expect(lost).toBeNull();
    await expect(statusOf("dvp_raced")).resolves.toMatchObject({ status: "created" });
  });

  // The claims sweep now runs through `dvp_leg_funding_claims` alone — the
  // trade-level claim columns are gone. A claim whose signed transaction can
  // no longer land must be released; one still inside its window must not be;
  // and a claim with a receipt (`funding_tx` set) is a receipt, not a lock,
  // so it must survive the sweep that clears the live ones.
  it("releases expired funding claims and keeps live and broadcast ones", async () => {
    await seedTrade("dvp_claim_sweep", "created");
    await seedTrade("dvp_claim_sweep_b", "created");
    const db = getDb(env);
    const claims = createPostgresDvpLegFundingClaimRepository(db);
    await claims.claim({
      tradeId: "dvp_claim_sweep",
      side: "a",
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      custodyWalletId: CUSTODY_WALLET_ID,
      signature: "sig_expired",
      expiryHeight: "900",
    });
    await claims.claim({
      tradeId: "dvp_claim_sweep",
      side: "b",
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      custodyWalletId: CUSTODY_WALLET_ID,
      signature: "sig_live",
      expiryHeight: "2000",
    });
    // A funded leg: the claim CAS lost to nobody, but the transfer landed and
    // the row now carries its receipt. Expired AND broadcast, so the resolving
    // pass checks it on chain — the default answer is landed, so it survives.
    await claims.claim({
      tradeId: "dvp_claim_sweep_b",
      side: "b",
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      custodyWalletId: CUSTODY_WALLET_ID,
      signature: SIG,
      expiryHeight: "900",
    });
    await db
      .prepare("UPDATE dvp_leg_funding_claims SET funding_tx = ? WHERE trade_id = ? AND side = 'b'")
      .bind(SIG, "dvp_claim_sweep_b")
      .run();

    await reconcileDvpTrades(env);

    const remaining = await claims.listForTrade("dvp_claim_sweep");
    const receipt = await claims.listForTrade("dvp_claim_sweep_b");
    expect(remaining.map((claim) => claim.signature)).toEqual(["sig_live"]);
    expect(receipt.map((claim) => claim.fundingTx)).toEqual([SIG]);
  });

  // The bug this resolves: an RPC-accepted transfer that DROPS — blockhash
  // expires, transfer never lands — leaves a claim that is neither a live lock
  // nor a real receipt. `releaseExpired` never touches it (broadcast) and
  // `claim()`'s ON CONFLICT refuses every retry, so the leg 409s forever.
  // Past last-valid height the chain's answer is final: no status found means
  // it can never land, and the row must go.
  it("releases an expired broadcast claim whose transfer never landed", async () => {
    await seedTrade("dvp_dead_broadcast", "created");
    const db = getDb(env);
    const claims = createPostgresDvpLegFundingClaimRepository(db);
    await claims.claim({
      tradeId: "dvp_dead_broadcast",
      side: "a",
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      custodyWalletId: CUSTODY_WALLET_ID,
      signature: SIG,
      expiryHeight: "900",
    });
    await db
      .prepare("UPDATE dvp_leg_funding_claims SET funding_tx = ? WHERE trade_id = ? AND side = 'a'")
      .bind(SIG, "dvp_dead_broadcast")
      .run();
    getSignatureStatusesMock.mockResolvedValue([null]);

    await reconcileDvpTrades(env);

    const after = await claims.listForTrade("dvp_dead_broadcast");
    expect(after).toHaveLength(0);
    // The leg is claimable again — the whole point of the fix.
    const retried = await claims.claim({
      tradeId: "dvp_dead_broadcast",
      side: "a",
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      custodyWalletId: CUSTODY_WALLET_ID,
      signature: SIG,
      expiryHeight: "800",
    });
    expect(retried).toBe(true);
  });

  // A transfer can land AND fail: on chain, fees consumed, zero tokens moved.
  // Neither lock nor receipt — released like one that never landed.
  it("releases an expired broadcast claim whose transfer landed and failed", async () => {
    await seedTrade("dvp_failed_broadcast", "created");
    const db = getDb(env);
    const claims = createPostgresDvpLegFundingClaimRepository(db);
    await claims.claim({
      tradeId: "dvp_failed_broadcast",
      side: "a",
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      custodyWalletId: CUSTODY_WALLET_ID,
      signature: SIG,
      expiryHeight: "900",
    });
    await db
      .prepare("UPDATE dvp_leg_funding_claims SET funding_tx = ? WHERE trade_id = ? AND side = 'a'")
      .bind(SIG, "dvp_failed_broadcast")
      .run();
    getSignatureStatusesMock.mockResolvedValue([
      {
        slot: 5n,
        confirmations: 1n,
        confirmationStatus: "confirmed",
        err: { InstructionError: [0, "Custom"] },
      },
    ]);

    await reconcileDvpTrades(env);

    const after = await claims.listForTrade("dvp_failed_broadcast");
    expect(after).toHaveLength(0);
  });

  // The other branch of the same check: the transfer DID land, which is a
  // genuine receipt, so the row must survive the resolving pass.
  it("keeps an expired broadcast claim whose transfer landed", async () => {
    await seedTrade("dvp_landed_broadcast", "created");
    const db = getDb(env);
    const claims = createPostgresDvpLegFundingClaimRepository(db);
    await claims.claim({
      tradeId: "dvp_landed_broadcast",
      side: "b",
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      custodyWalletId: CUSTODY_WALLET_ID,
      signature: SIG,
      expiryHeight: "900",
    });
    await db
      .prepare("UPDATE dvp_leg_funding_claims SET funding_tx = ? WHERE trade_id = ? AND side = 'b'")
      .bind(SIG, "dvp_landed_broadcast")
      .run();

    await reconcileDvpTrades(env);

    const after = await claims.listForTrade("dvp_landed_broadcast");
    expect(after).toHaveLength(1);
    expect(after[0]?.fundingTx).toBe(SIG);
  });
});
