import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresEarnExternalWalletTransactionsRepository } from "@/db/repositories/earn-external-wallet-transactions.repository";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import {
  createPostgresEarnSplitSwapAdvisoriesRepository,
  generateEarnSplitSwapAdvisoryId,
} from "@/db/repositories/earn-split-swap-advisories.repository";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const getBlockHeight = vi.hoisted(() => vi.fn());
const readOwnerMintBalance = vi.hoisted(() => vi.fn());
const logEvent = vi.hoisted(() => vi.fn());

vi.mock("@sdp/rpc/solana", () => ({
  createRpc: () => ({ getBlockHeight: () => ({ send: getBlockHeight }) }),
}));
vi.mock("@/services/earn/execution-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/earn/execution-registry")>()),
  assertClusterEndpoint: vi.fn(async () => {}),
  resolveClusterRpcUrl: () => "https://rpc.example.invalid",
}));
vi.mock("@/services/earn/owner-token-balance", () => ({ readOwnerMintBalance }));
vi.mock("@/runtime/money-path-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/money-path-events")>()),
  logEvent,
}));

const { detectOrphanedEarnSplitSwaps } = await import("./detect-orphaned-earn-split-swaps");

const ORG = "org_split_swap";
const PROJECT = "prj_split_swap";
const USER = "usr_split_swap";
const OWNER = "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const VAULT = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";

/** Swap floor: 24.8 USDC. Baseline: the owner already held 0.5 USDC. */
const FLOOR = 24_800_000n;
const BASELINE = 500_000n;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

beforeEach(async () => {
  await seedTestDatabase(env);
  vi.clearAllMocks();
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG, "Split Swap Org", "split-swap", "enterprise", "active"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER, "split-swap@example.com"),
    db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Split Swap', 'split-swap', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT, ORG, USER),
  ]);
  // The swap's blockhash is long expired by default; judgement is on.
  getBlockHeight.mockResolvedValue(10_000n);
});

function advisories() {
  return createPostgresEarnSplitSwapAdvisoriesRepository(getDb(env));
}

/** An advisory created `ageMs` ago, with the swap expiring at height 100. */
async function seedAdvisory(ageMs: number, overrides: Record<string, unknown> = {}) {
  const row = await advisories().create({
    id: generateEarnSplitSwapAdvisoryId(),
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox",
    provider: "kamino",
    strategyId: "strategy_split_test",
    vaultAddress: VAULT,
    ownerAddress: OWNER,
    sourceTokenMint: USDT,
    depositTokenMint: USDC,
    depositTokenDecimals: 6,
    swapSourceAmount: "25",
    swapMinOutAmount: "24.8",
    swapMinOutAtoms: FLOOR.toString(),
    swapLastValidBlockHeight: "100",
    baselineDepositTokenAtoms: BASELINE.toString(),
    createdBy: USER,
    ...overrides,
  });
  await getDb(env)
    .prepare("UPDATE earn_split_swap_advisories SET created_at = ? WHERE id = ?")
    .bind(new Date(Date.now() - ageMs).toISOString(), row.id)
    .run();
  return row.id;
}

async function advisoryRow(id: string) {
  return getDb(env)
    .prepare("SELECT * FROM earn_split_swap_advisories WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}

/** A follow-up deposit BUILD for the owner (what the partner requests after the swap). */
async function seedFollowUpBuild(ageMs = 0): Promise<string> {
  const id = `earn_external_wallet_transaction_${crypto.randomUUID()}`;
  await createPostgresEarnExternalWalletTransactionsRepository(getDb(env)).create({
    id,
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox",
    provider: "kamino",
    direction: "deposit",
    ownerAddress: OWNER,
    vaultAddress: VAULT,
    tokenMint: USDC,
    shareMint: SHARE_MINT,
    label: "USDC Vault",
    denomination: USDC,
    amountRequested: "24.8",
    createsShareAccount: false,
    unsignedTransaction: Buffer.from([7, 8, 9]).toString("base64"),
    lastValidBlockHeight: "100",
  });
  if (ageMs > 0) {
    await getDb(env)
      .prepare("UPDATE earn_external_wallet_transactions SET created_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - ageMs).toISOString(), id)
      .run();
  }
  return id;
}

/** A follow-up deposit MOVEMENT for the owner, advanced to `status`. */
async function seedFollowUpMovement(status: string): Promise<string> {
  const buildId = await seedFollowUpBuild();
  const built = await createPostgresEarnExternalWalletTransactionsRepository(getDb(env)).getById({
    organizationId: ORG,
    transactionId: buildId,
  });
  if (!built) throw new Error("build row did not persist");
  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  const seeded = await ledger.createSignedExternalWalletDepositIntent({
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox",
    provider: "kamino",
    vaultAddress: built.vault_address,
    ownerAddress: built.owner_address,
    shareMint: built.share_mint,
    tokenMint: built.token_mint,
    label: built.label,
    requestedAmount: built.amount_requested,
    signature: `sig_${crypto.randomUUID()}`,
    signedTransaction: Buffer.from([7, 8, 9]).toString("base64"),
    lastValidBlockHeight: "100",
    requestId: crypto.randomUUID(),
    idempotencyFingerprint: crypto.randomUUID(),
    externalWalletTransactionId: built.id,
  });
  if (status !== "requested") {
    const observedAt = new Date().toISOString();
    await ledger.advanceVaultMovement({
      movementId: seeded.movement.id,
      organizationId: ORG,
      toStatus: status,
      ...(status === "failed" ? { failureReason: "test setup" } : {}),
      ...(status === "confirmed" || status === "finalized" ? { confirmedAt: observedAt } : {}),
      ...(status === "finalized" ? { settledAt: observedAt } : {}),
    });
  }
  return seeded.movement.id;
}

function eventsNamed(name: string) {
  return logEvent.mock.calls.filter(([, payload]) => payload?.event === name);
}

function tick() {
  const call = eventsNamed("sdp_api_earn_split_swap_detection_tick")[0];
  return { level: call?.[0], payload: call?.[1] as Record<string, unknown> | undefined };
}

async function movementCount(): Promise<number> {
  const row = await getDb(env)
    .prepare("SELECT COUNT(*)::int AS n FROM earn_movements")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("detectOrphanedEarnSplitSwaps", () => {
  it("flags an owner whose balance rose by the swap floor with no follow-up deposit", async () => {
    const id = await seedAdvisory(2 * HOUR);
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });
    const before = await movementCount();

    await detectOrphanedEarnSplitSwaps(env);

    const [orphan] = eventsNamed("sdp_api_earn_split_swap_orphaned");
    expect(orphan?.[0]).toBe("warn");
    expect(orphan?.[1]).toMatchObject({
      advisory_id: id,
      owner_address: OWNER,
      strategy_id: "strategy_split_test",
      deposit_token_mint: USDC,
      swap_min_out_atoms: FLOOR.toString(),
      observed_atoms: (BASELINE + FLOOR).toString(),
      delta_atoms: FLOOR.toString(),
      escalated: true,
    });
    expect(tick().level).toBe("info");
    expect(tick().payload).toMatchObject({ checked: 1, orphaned: 1, open_backlog: 1 });
    // Stays open, stamped, and reported again on the next visit.
    const row = await advisoryRow(id);
    expect(row?.resolved_at).toBeNull();
    expect(row?.first_flagged_at).not.toBeNull();
    expect(row?.last_checked_at).not.toBeNull();
    // Detection never creates a movement.
    expect(await movementCount()).toBe(before);
  });

  it("does not mistake a pre-existing balance for the swap (unfunded)", async () => {
    // The owner still holds exactly the baseline: the swap never broadcast, or
    // the owner moved the tokens. Nothing sits swapped-but-undeposited.
    const id = await seedAdvisory(2 * HOUR);
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE, decimals: 6 });

    await detectOrphanedEarnSplitSwaps(env);

    expect(eventsNamed("sdp_api_earn_split_swap_orphaned")).toHaveLength(0);
    expect(tick().payload).toMatchObject({ unfunded: 1, orphaned: 0, open_backlog: 0 });
    expect(await advisoryRow(id)).toMatchObject({
      resolution: "unfunded",
      resolved_by: "system",
      last_observed_atoms: BASELINE.toString(),
    });
  });

  it("keeps a partial rise open as indeterminate rather than judging it", async () => {
    const id = await seedAdvisory(2 * HOUR);
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR / 2n, decimals: 6 });

    await detectOrphanedEarnSplitSwaps(env);

    expect(eventsNamed("sdp_api_earn_split_swap_orphaned")).toHaveLength(0);
    expect(tick().payload).toMatchObject({ indeterminate: 1, open_backlog: 1 });
    expect((await advisoryRow(id))?.resolved_at).toBeNull();
  });

  it("resolves deposit_observed on a confirmed follow-up deposit, and never on a failed one", async () => {
    const id = await seedAdvisory(2 * HOUR);
    await seedFollowUpMovement("failed");
    const observed = await seedFollowUpMovement("confirmed");
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });

    await detectOrphanedEarnSplitSwaps(env);

    expect(readOwnerMintBalance).not.toHaveBeenCalled();
    expect(tick().payload).toMatchObject({ deposit_observed: 1, orphaned: 0 });
    expect(await advisoryRow(id)).toMatchObject({
      resolution: "deposit_observed",
      resolving_movement_id: observed,
    });
  });

  it("does not let a failed follow-up alone discharge the advisory", async () => {
    const id = await seedAdvisory(2 * HOUR);
    await seedFollowUpMovement("failed");
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });

    await detectOrphanedEarnSplitSwaps(env);

    // The failed deposit moved nothing, so the balance judgement runs and flags it.
    expect(tick().payload).toMatchObject({ orphaned: 1, deposit_observed: 0 });
    expect((await advisoryRow(id))?.resolved_at).toBeNull();
  });

  it("lets one deposit discharge at most one advisory for a reused owner wallet", async () => {
    const first = await seedAdvisory(3 * HOUR);
    const second = await seedAdvisory(2 * HOUR);
    await seedFollowUpMovement("finalized");
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });

    await detectOrphanedEarnSplitSwaps(env);

    const rows = [await advisoryRow(first), await advisoryRow(second)];
    expect(rows.filter((r) => r?.resolution === "deposit_observed")).toHaveLength(1);
    // The other one still has to be judged on its own merits.
    expect(tick().payload).toMatchObject({ deposit_observed: 1, orphaned: 1 });
  });

  it("treats an in-flight follow-up deposit as pending, not orphaned", async () => {
    await seedAdvisory(2 * HOUR);
    await seedFollowUpMovement("requested");
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });

    await detectOrphanedEarnSplitSwaps(env);

    expect(readOwnerMintBalance).not.toHaveBeenCalled();
    expect(tick().payload).toMatchObject({ follow_up_pending: 1, orphaned: 0 });
  });

  it("treats a recent follow-up BUILD as the partner still working", async () => {
    // The movement only exists at submit; a human second signature can take
    // minutes, and paging in that window would be a false positive.
    const id = await seedAdvisory(2 * HOUR);
    await seedFollowUpBuild(5 * MINUTE);
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });

    await detectOrphanedEarnSplitSwaps(env);

    expect(readOwnerMintBalance).not.toHaveBeenCalled();
    expect(tick().payload).toMatchObject({ follow_up_pending: 1 });
    expect((await advisoryRow(id))?.last_follow_up_build_at).not.toBeNull();
  });

  it("stops crediting a follow-up build once it is older than the window", async () => {
    await seedAdvisory(3 * HOUR);
    await seedFollowUpBuild(2 * HOUR);
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });

    await detectOrphanedEarnSplitSwaps(env);

    expect(tick().payload).toMatchObject({ orphaned: 1, follow_up_pending: 0 });
  });

  it("waits while the swap can still land or the grace period has not run", async () => {
    // Blockhash still live: the swap may yet land.
    await seedAdvisory(2 * HOUR, { swapLastValidBlockHeight: "20000" });
    // Young advisory: past the blockhash but inside the grace window.
    await seedAdvisory(5 * MINUTE);
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });

    await detectOrphanedEarnSplitSwaps(env);

    expect(readOwnerMintBalance).not.toHaveBeenCalled();
    expect(tick().payload).toMatchObject({ pending: 2, orphaned: 0 });
  });

  it("fails the tick loudly when the balance read is unavailable", async () => {
    const id = await seedAdvisory(2 * HOUR);
    readOwnerMintBalance.mockRejectedValue(new Error("rpc unavailable"));

    await expect(detectOrphanedEarnSplitSwaps(env)).rejects.toThrow(/1 balance failures/);

    expect(tick().level).toBe("error");
    expect(tick().payload).toMatchObject({ balance_read_failures: 1 });
    expect(logEvent).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        event: "sdp_api_earn_split_swap_balance_read_failed",
        advisory_id: id,
        error_message: "rpc unavailable",
      })
    );
    expect((await advisoryRow(id))?.resolved_at).toBeNull();
  });

  it("refuses to judge atoms of a different scale", async () => {
    await seedAdvisory(2 * HOUR);
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 9 });

    await expect(detectOrphanedEarnSplitSwaps(env)).rejects.toThrow(/balance failures/);

    expect(eventsNamed("sdp_api_earn_split_swap_orphaned")).toHaveLength(0);
    expect(logEvent).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ error_name: "DecimalsMismatch" })
    );
  });

  it("fails the tick when the block height cannot be read, leaving every advisory open", async () => {
    const id = await seedAdvisory(2 * HOUR);
    getBlockHeight.mockRejectedValue(new Error("rpc unavailable"));

    await expect(detectOrphanedEarnSplitSwaps(env)).rejects.toThrow(/1 block-height/);

    expect(readOwnerMintBalance).not.toHaveBeenCalled();
    expect(tick().level).toBe("error");
    expect((await advisoryRow(id))?.resolved_at).toBeNull();
  });

  it("emits an idle tick with a zero backlog and touches nothing", async () => {
    await detectOrphanedEarnSplitSwaps(env);

    expect(tick().level).toBe("info");
    expect(tick().payload).toMatchObject({ checked: 0, open_backlog: 0 });
    expect(getBlockHeight).not.toHaveBeenCalled();
  });

  it("rotates the scan so a standing orphan cannot pin the head of the queue", async () => {
    const older = await seedAdvisory(3 * HOUR);
    const newer = await seedAdvisory(2 * HOUR);
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });

    await detectOrphanedEarnSplitSwaps(env);

    const olderRow = await advisoryRow(older);
    const newerRow = await advisoryRow(newer);
    expect(olderRow?.last_checked_at).not.toBeNull();
    expect(newerRow?.last_checked_at).not.toBeNull();
    // Both were visited in one tick; the cursor now orders by the visit, not
    // by creation, so the next tick cannot re-serve the oldest one first alone.
    const next = await advisories().claimOpenForDetection(1);
    expect(next.map((r) => r.id)).toHaveLength(1);
  });
});
