import { getBase58Decoder, signature } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresDvpLegFundingClaimRepository } from "@/db/repositories/dvp-leg-funding-claim.repository";
import { createPostgresDvpLegTransferRepository } from "@/db/repositories/dvp-leg-transfer.repository";
import { createPostgresDvpTradeRepository } from "@/db/repositories/dvp-trade.repository.postgres";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
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
const syncDvpLegTransfers = vi.hoisted(() => vi.fn());
vi.mock("@/services/dvp/leg-transfers", () => ({
  syncDvpLegTransfers,
  createDvpEscrowHistoryReader: () => ({}),
}));

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
    clusterUnixTimestamp: BigInt(Math.floor(Date.now() / 1000)),
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
      "SELECT status, escrow_a_amount, escrow_b_amount, escrow_a_frozen, observed_at, observed_cluster_timestamp, close_signature, close_resolution_attempts, close_resolution_after FROM dvp_trades WHERE id = ?"
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
    syncDvpLegTransfers.mockResolvedValue(0);
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
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
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
    // Pinned, not read from the wall clock again after the sweep: a second can tick between the two.
    const clusterUnixTimestamp = BigInt(Math.floor(Date.now() / 1000));
    readDvpTradeObservation.mockResolvedValue(
      observation({ legA: leg(1000n), legB: leg(2000n), clusterUnixTimestamp })
    );

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
    expect(row?.observed_cluster_timestamp).toBe(clusterUnixTimestamp.toString());
  });

  /**
   * PRO-1941. Each leg's escrow history is read into the transfer ledger when
   * the leg may have moved: never read, the trade changed, or its last complete
   * read is five minutes old. The read itself is `syncDvpLegTransfers`.
   */
  describe("escrow transfer ledger", () => {
    async function scanned(tradeId: string, scannedAt: string | null) {
      const transfers = createPostgresDvpLegTransferRepository(getDb(env));
      for (const side of ["a", "b"] as const) {
        await transfers.saveScan(tradeId, { side, cursor: null, scannedAt });
      }
    }

    async function quiet(tradeId: string) {
      await seedTrade(tradeId, "created");
      await getDb(env)
        .prepare("UPDATE dvp_trades SET escrow_a_amount = '0', escrow_b_amount = '0' WHERE id = ?")
        .bind(tradeId)
        .run();
    }

    it("reads both legs of a trade whose history was never read", async () => {
      await seedTrade("dvp_ledger_new", "created");

      await reconcileDvpTrades(env);

      expect(
        syncDvpLegTransfers.mock.calls.map(([, , leg, scan]) => [leg.tradeId, leg.side, scan])
      ).toEqual([
        ["dvp_ledger_new", "a", null],
        ["dvp_ledger_new", "b", null],
      ]);
      // History is read back no further than the trade's own creation.
      const row = await getDb(env)
        .prepare("SELECT created_at FROM dvp_trades WHERE id = ?")
        .bind("dvp_ledger_new")
        .first<{ created_at: string }>();
      expect(syncDvpLegTransfers.mock.calls[0]?.[2]).toMatchObject({
        createdAt: row?.created_at,
      });
    });

    it("leaves legs read a moment ago alone while nothing about the trade changed", async () => {
      await quiet("dvp_ledger_quiet");
      await scanned("dvp_ledger_quiet", new Date().toISOString());

      await reconcileDvpTrades(env);

      expect(syncDvpLegTransfers).not.toHaveBeenCalled();
    });

    it("reads again once the escrow balance moved, however recent the last read", async () => {
      await quiet("dvp_ledger_moved");
      await scanned("dvp_ledger_moved", new Date().toISOString());
      readDvpTradeObservation.mockResolvedValue(observation({ legA: leg(500n) }));

      await reconcileDvpTrades(env);

      expect(syncDvpLegTransfers).toHaveBeenCalledTimes(2);
    });

    // A deposit and a reclaim between two sweeps leave the balance unchanged.
    it("reads again when the last complete read is stale or never finished", async () => {
      await quiet("dvp_ledger_stale");
      await scanned("dvp_ledger_stale", new Date(Date.now() - 6 * 60_000).toISOString());
      await quiet("dvp_ledger_unfinished");
      await scanned("dvp_ledger_unfinished", null);

      await reconcileDvpTrades(env);

      expect(syncDvpLegTransfers).toHaveBeenCalledTimes(4);
    });

    it("still records the observation when the transfer read fails", async () => {
      await seedTrade("dvp_ledger_down", "created");
      syncDvpLegTransfers.mockRejectedValue(new Error("429 Too Many Requests"));
      readDvpTradeObservation.mockResolvedValue(
        observation({ legA: leg(1000n), legB: leg(2000n) })
      );

      await reconcileDvpTrades(env);

      await expect(statusOf("dvp_ledger_down")).resolves.toMatchObject({ status: "funded" });
    });
  });

  // The program judges expiry by its own Clock. A cluster clock already past
  // expiry expires the trade even while the host's is an hour short of it.
  it("expires a trade by the cluster clock read with the observation", async () => {
    await seedTrade("dvp_cluster_expired", "funded");
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    readDvpTradeObservation.mockResolvedValue(
      observation({ legA: leg(1000n), legB: leg(2000n), clusterUnixTimestamp: BigInt(expiry + 1) })
    );

    await reconcileDvpTrades(env);

    await expect(statusOf("dvp_cluster_expired")).resolves.toMatchObject({ status: "expired" });
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

  // PRO-1974. A trade whose account is gone and whose close is not in the
  // history the RPC returns yet used to rescan that history on every tick.
  it("backs off a close lookup that found nothing, as it does a capped one", async () => {
    await seedTrade("dvp_absent", "closed_unknown", { closeResolutionAttempts: 0 });
    await getDb(env)
      .prepare("UPDATE dvp_trades SET closed_at = sdp_iso_now() WHERE id = ?")
      .bind("dvp_absent")
      .run();
    readDvpTradeObservation.mockResolvedValue(observation({ tradeAccountExists: false }));
    resolveDvpClose.mockResolvedValue({ kind: "absent" });
    const before = Date.now();

    await reconcileDvpTrades(env);
    await reconcileDvpTrades(env);

    const row = await statusOf("dvp_absent");
    expect(row?.close_resolution_attempts).toBe(1);
    expect(Date.parse(String(row?.close_resolution_after))).toBeGreaterThanOrEqual(before + 60_000);
    expect(resolveDvpClose).toHaveBeenCalledTimes(1);
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
      observedClusterTimestamp: "1800000000",
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
  // PRO-1973. A settle or cancel that died holding its lock, or whose send was
  // ambiguous and never landed, must not keep the trade from closing or its
  // legs from moving. One that can still land keeps its lock.
  it("releases close locks past their last valid height and keeps live ones", async () => {
    await seedTrade("dvp_close_dead", "funded");
    await seedTrade("dvp_close_live", "funded");
    const trades = createPostgresDvpTradeRepository(getDb(env));
    const signatureOf = (byte: number) =>
      signature(getBase58Decoder().decode(new Uint8Array(64).fill(byte)));
    await trades.claimClose("dvp_close_dead", {
      action: "settle",
      signature: signatureOf(7),
      expiryHeight: "999",
    });
    await trades.claimClose("dvp_close_live", {
      action: "cancel",
      signature: signatureOf(8),
      expiryHeight: "1000",
    });

    await reconcileDvpTrades(env);

    const read = async (id: string) =>
      (await trades.getByIdAsParty(id))?.closeClaim?.signature ?? null;
    expect(await read("dvp_close_dead")).toBeNull();
    expect(await read("dvp_close_live")).toBe(signatureOf(8));
  });

  // PRO-1974. Expired receipts are asked about in chunks of 256, not one call
  // each. A chunk whose read fails deletes nothing and does not stop the next.
  it("reads expired receipts in chunks of 256, and a failed chunk deletes nothing", async () => {
    const db = getDb(env);
    const claims = createPostgresDvpLegFundingClaimRepository(db);
    const receiptSignature = (index: number) => {
      const bytes = new Uint8Array(64);
      new DataView(bytes.buffer).setUint32(0, index + 1);
      bytes[63] = 1;
      return getBase58Decoder().decode(bytes);
    };
    const receipts = 257;
    for (let index = 0; index < receipts; index += 2) {
      const tradeId = `dvp_receipts_${index}`;
      await seedTrade(tradeId, "created");
      for (const [offset, side] of [
        [0, "a"],
        [1, "b"],
      ] as const) {
        if (index + offset >= receipts) {
          continue;
        }
        const receipt = receiptSignature(index + offset);
        await claims.claim({
          tradeId,
          side,
          organizationId: TEST_ORG.id,
          projectId: PROJECT_ID,
          custodyWalletId: CUSTODY_WALLET_ID,
          signature: receipt,
          expiryHeight: "900",
        });
        await claims.recordFundingTx(tradeId, side, receipt);
      }
    }
    getSignatureStatusesMock
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockImplementation(async (_rpc: unknown, signatures: string[]) =>
        signatures.map(() => null)
      );

    await reconcileDvpTrades(env);

    expect(getSignatureStatusesMock.mock.calls.map(([, signatures]) => signatures.length)).toEqual([
      256, 1,
    ]);
    const remaining = await db
      .prepare("SELECT COUNT(*)::int AS count FROM dvp_leg_funding_claims")
      .first<{ count: number }>();
    expect(remaining?.count).toBe(256);
  });

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

  // A processed failure can be re-executed on the surviving fork, so it is not
  // yet an answer; only a confirmed one is.
  it("keeps an expired broadcast claim whose failure is only processed", async () => {
    await seedTrade("dvp_processed_failure", "created");
    const db = getDb(env);
    const claims = createPostgresDvpLegFundingClaimRepository(db);
    await claims.claim({
      tradeId: "dvp_processed_failure",
      side: "a",
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      custodyWalletId: CUSTODY_WALLET_ID,
      signature: SIG,
      expiryHeight: "900",
    });
    await db
      .prepare("UPDATE dvp_leg_funding_claims SET funding_tx = ? WHERE trade_id = ? AND side = 'a'")
      .bind(SIG, "dvp_processed_failure")
      .run();
    getSignatureStatusesMock.mockResolvedValue([
      {
        slot: 5n,
        confirmations: 0n,
        confirmationStatus: "processed",
        err: { InstructionError: [0, "Custom"] },
      },
    ]);

    await reconcileDvpTrades(env);

    expect(await claims.listForTrade("dvp_processed_failure")).toHaveLength(1);
  });

  // An expired trade's escrows still exist; a receipt that never landed on one
  // is cleared like any other, not left linking a dropped transaction.
  it("releases a never-landed receipt on an expired trade", async () => {
    await seedTrade("dvp_expired_receipt", "expired");
    const db = getDb(env);
    const claims = createPostgresDvpLegFundingClaimRepository(db);
    await claims.claim({
      tradeId: "dvp_expired_receipt",
      side: "a",
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      custodyWalletId: CUSTODY_WALLET_ID,
      signature: SIG,
      expiryHeight: "900",
    });
    await db
      .prepare("UPDATE dvp_leg_funding_claims SET funding_tx = ? WHERE trade_id = ? AND side = 'a'")
      .bind(SIG, "dvp_expired_receipt")
      .run();
    getSignatureStatusesMock.mockResolvedValue([null]);

    await reconcileDvpTrades(env);

    expect(await claims.listForTrade("dvp_expired_receipt")).toHaveLength(0);
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
