import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { createPostgresEarnExternalWalletTransactionsRepository } from "@/db/repositories/earn-external-wallet-transactions.repository";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import {
  createPostgresEarnSplitSwapAdvisoriesRepository,
  generateEarnSplitSwapAdvisoryId,
} from "@/db/repositories/earn-split-swap-advisories.repository";
import { runInEnvironmentClusterScope } from "@/runtime/cluster-scope-runs";
import {
  ENVIRONMENT_CLUSTER_CASES,
  epochInfoResult,
  installClusterRpcResponder,
} from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const readOwnerMintBalance = vi.hoisted(() => vi.fn());
const logEvent = vi.hoisted(() => vi.fn());

vi.mock("@/services/earn/owner-token-balance", () => ({ readOwnerMintBalance }));
vi.mock("@/runtime/money-path-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/money-path-events")>()),
  logEvent,
}));

const { detectOrphanedEarnSplitSwaps } = await import("./detect-orphaned-earn-split-swaps");

const ORG = "org_split_swap";
const PROJECT = "prj_split_swap";
const PROJECT_BY_ENVIRONMENT = {
  sandbox: PROJECT,
  production: `${PROJECT}_production`,
} as const satisfies Record<SdpEnvironment, string>;
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
/** The slot of the bank that reports each cluster's confirmed height: the balance read's floor. */
const HEIGHT_SLOT = 777n;

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
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORG,
    createdBy: USER,
    members: [],
    ids: PROJECT_BY_ENVIRONMENT,
  });
});

/** One sweep, as the Worker runs it: inside the environment's cluster scope. */
function detectIn(environment: SdpEnvironment): Promise<void> {
  return runInEnvironmentClusterScope(environment, () => detectOrphanedEarnSplitSwaps(env));
}

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

/** A follow-up deposit MOVEMENT for the owner, advanced to `status`. Defaults to the intended follow-up shape: this vault, exactly the floor. */
async function seedFollowUpMovement(
  status: string,
  shape: { vaultAddress?: string; amount?: string } = {}
): Promise<string> {
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
    vaultAddress: shape.vaultAddress ?? built.vault_address,
    ownerAddress: built.owner_address,
    shareMint: built.share_mint,
    tokenMint: built.token_mint,
    label: built.label,
    requestedAmount: shape.amount ?? built.amount_requested,
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
  const clusterRpc = installClusterRpcResponder();

  beforeEach(() => {
    // The swap's blockhash is long expired by default; judgement is on.
    clusterRpc.answer(
      "getEpochInfo",
      epochInfoResult({ absoluteSlot: Number(HEIGHT_SLOT), blockHeight: 10_000 })
    );
  });

  it("flags an owner whose balance rose by the swap floor with no follow-up deposit", async () => {
    const id = await seedAdvisory(2 * HOUR);
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });
    const before = await movementCount();

    await detectIn("sandbox");

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
    // The balance read must come from a node at least as current as the height read.
    expect(readOwnerMintBalance).toHaveBeenCalledWith(OWNER, USDC, {
      minContextSlot: HEIGHT_SLOT,
    });
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

    await detectIn("sandbox");

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

    await detectIn("sandbox");

    expect(eventsNamed("sdp_api_earn_split_swap_orphaned")).toHaveLength(0);
    expect(tick().payload).toMatchObject({ indeterminate: 1, open_backlog: 1 });
    expect((await advisoryRow(id))?.resolved_at).toBeNull();
  });

  it("resolves deposit_observed on a confirmed follow-up deposit once the funds have left the wallet", async () => {
    const id = await seedAdvisory(2 * HOUR);
    await seedFollowUpMovement("failed");
    const observed = await seedFollowUpMovement("confirmed");
    // The swapped tokens went into the vault: the balance is back at baseline.
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE, decimals: 6 });

    await detectIn("sandbox");

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

    await detectIn("sandbox");

    // The failed deposit moved nothing, so the balance judgement runs and flags it.
    expect(tick().payload).toMatchObject({ orphaned: 1, deposit_observed: 0 });
    expect((await advisoryRow(id))?.resolved_at).toBeNull();
  });

  it("lets one deposit discharge at most one advisory for a reused owner wallet", async () => {
    const first = await seedAdvisory(3 * HOUR);
    const second = await seedAdvisory(2 * HOUR);
    await seedFollowUpMovement("finalized");
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE, decimals: 6 });

    await detectIn("sandbox");

    const rows = [await advisoryRow(first), await advisoryRow(second)];
    expect(rows.filter((r) => r?.resolution === "deposit_observed")).toHaveLength(1);
    // The other cannot borrow the same movement; with no rise left it is unfunded.
    expect(tick().payload).toMatchObject({ deposit_observed: 1, unfunded: 1, orphaned: 0 });
  });

  it("resolves on the intended follow-up even when an unrelated credit keeps the balance high", async () => {
    // Same vault, exactly the floor, chain-committed: that IS the follow-up, and
    // whatever else sits in the wallet is not this swap's output. Paging here
    // would be a persistent false alert on any wallet with other inflows.
    const id = await seedAdvisory(2 * HOUR);
    const followUp = await seedFollowUpMovement("confirmed");
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });

    await detectIn("sandbox");

    expect(readOwnerMintBalance).not.toHaveBeenCalled();
    expect(eventsNamed("sdp_api_earn_split_swap_orphaned")).toHaveLength(0);
    expect(tick().payload).toMatchObject({ deposit_observed: 1, orphaned: 0 });
    expect(await advisoryRow(id)).toMatchObject({
      resolution: "deposit_observed",
      resolving_movement_id: followUp,
    });
  });

  it("holds a sibling-vault deposit plus a persisting rise as ambiguous during the escalation grace", async () => {
    // A covering deposit into a DIFFERENT vault while the swapped tokens are
    // still in the wallet: either a sibling deposit plus an unrelated credit,
    // or an abandoned follow-up plus an unrelated deposit. Inside the grace it
    // stays open under its own event, neither resolved nor paged.
    const id = await seedAdvisory(45 * MINUTE);
    await seedFollowUpMovement("confirmed", {
      vaultAddress: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    });
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });

    await detectIn("sandbox");

    expect(tick().payload).toMatchObject({ ambiguous: 1, orphaned: 0, deposit_observed: 0 });
    expect(eventsNamed("sdp_api_earn_split_swap_orphaned")).toHaveLength(0);
    const [ambiguous] = eventsNamed("sdp_api_earn_split_swap_ambiguous");
    expect(ambiguous?.[1]).toMatchObject({ escalated: false });
    expect((await advisoryRow(id))?.resolved_at).toBeNull();
  });

  it("escalates a stale ambiguous advisory under its own event, never as an orphan", async () => {
    // Undecidable by machine: a sibling deposit of the swapped funds plus an
    // unrelated credit looks identical to an abandoned follow-up plus an
    // unrelated deposit. Paging it as an orphan would page every legitimate
    // wallet with other inflows; going silent would hide a real orphan behind
    // one sibling deposit. So it escalates visibly for a human to judge.
    const id = await seedAdvisory(2 * HOUR);
    const sibling = await seedFollowUpMovement("confirmed", {
      vaultAddress: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    });
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });

    await detectIn("sandbox");

    expect(tick().payload).toMatchObject({ ambiguous: 1, orphaned: 0, deposit_observed: 0 });
    expect(eventsNamed("sdp_api_earn_split_swap_orphaned")).toHaveLength(0);
    const [ambiguous] = eventsNamed("sdp_api_earn_split_swap_ambiguous");
    expect(ambiguous?.[1]).toMatchObject({
      advisory_id: id,
      escalated: true,
      covering_deposit_ids: [sibling],
    });
    const row = await advisoryRow(id);
    expect(row?.resolved_at).toBeNull();
    // Escalation stamps first_flagged_at so the operator can see how long it has stood.
    expect(row?.first_flagged_at).not.toBeNull();
  });

  it("still flags an orphan when the only same-mint deposit is too small to be the follow-up", async () => {
    const id = await seedAdvisory(2 * HOUR);
    await seedFollowUpMovement("confirmed", { amount: "1" });
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });

    await detectIn("sandbox");

    expect(tick().payload).toMatchObject({ orphaned: 1, ambiguous: 0 });
    expect((await advisoryRow(id))?.resolved_at).toBeNull();
  });

  it("treats an in-flight follow-up deposit as pending, not orphaned", async () => {
    await seedAdvisory(2 * HOUR);
    await seedFollowUpMovement("requested");
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });

    await detectIn("sandbox");

    expect(readOwnerMintBalance).not.toHaveBeenCalled();
    expect(tick().payload).toMatchObject({ follow_up_pending: 1, orphaned: 0 });
  });

  it("treats a recent follow-up BUILD as the partner still working", async () => {
    // The movement only exists at submit; a human second signature can take
    // minutes, and paging in that window would be a false positive.
    const id = await seedAdvisory(2 * HOUR);
    await seedFollowUpBuild(5 * MINUTE);
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });

    await detectIn("sandbox");

    expect(readOwnerMintBalance).not.toHaveBeenCalled();
    expect(tick().payload).toMatchObject({ follow_up_pending: 1 });
    expect((await advisoryRow(id))?.last_follow_up_build_at).not.toBeNull();
  });

  it("stops crediting a follow-up build once it is older than the window", async () => {
    await seedAdvisory(3 * HOUR);
    await seedFollowUpBuild(2 * HOUR);
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });

    await detectIn("sandbox");

    expect(tick().payload).toMatchObject({ orphaned: 1, follow_up_pending: 0 });
  });

  it("waits while the swap can still land or the grace period has not run", async () => {
    // Blockhash still live: the swap may yet land.
    await seedAdvisory(2 * HOUR, { swapLastValidBlockHeight: "20000" });
    // Young advisory: past the blockhash but inside the grace window.
    await seedAdvisory(5 * MINUTE);
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });

    await detectIn("sandbox");

    expect(readOwnerMintBalance).not.toHaveBeenCalled();
    expect(tick().payload).toMatchObject({ pending: 2, orphaned: 0 });
  });

  it.each([
    ["is unavailable", "rpc unavailable"],
    // A node behind the height read's slot could predate a landed swap.
    [
      "comes from a node behind the height's slot",
      "Mint-filtered token-account RPC answered at slot 776, below its floor 777",
    ],
  ])(
    "fails the tick loudly and judges nothing when the balance read %s",
    async (_label, message) => {
      const id = await seedAdvisory(2 * HOUR);
      readOwnerMintBalance.mockRejectedValue(new Error(message));

      await expect(detectIn("sandbox")).rejects.toThrow(/1 balance failures/);

      expect(tick().level).toBe("error");
      expect(tick().payload).toMatchObject({ balance_read_failures: 1 });
      expect(logEvent).toHaveBeenCalledWith(
        "error",
        expect.objectContaining({
          event: "sdp_api_earn_split_swap_balance_read_failed",
          advisory_id: id,
          error_message: message,
        })
      );
      expect((await advisoryRow(id))?.resolved_at).toBeNull();
    }
  );

  it("refuses to judge atoms of a different scale", async () => {
    await seedAdvisory(2 * HOUR);
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 9 });

    await expect(detectIn("sandbox")).rejects.toThrow(/balance failures/);

    expect(eventsNamed("sdp_api_earn_split_swap_orphaned")).toHaveLength(0);
    expect(logEvent).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ error_name: "DecimalsMismatch" })
    );
  });

  it("fails the tick when the block height cannot be read, leaving every advisory open", async () => {
    const id = await seedAdvisory(2 * HOUR);
    clusterRpc.respond("getEpochInfo", () => ({
      error: { code: -32000, message: "rpc unavailable" },
    }));

    await expect(detectIn("sandbox")).rejects.toThrow(/1 block-height/);

    expect(readOwnerMintBalance).not.toHaveBeenCalled();
    expect(tick().level).toBe("error");
    expect((await advisoryRow(id))?.resolved_at).toBeNull();
  });

  it("emits an idle tick with a zero backlog and touches nothing", async () => {
    await detectIn("sandbox");

    expect(tick().level).toBe("info");
    expect(tick().payload).toMatchObject({ environment: "sandbox", checked: 0, open_backlog: 0 });
    expect(clusterRpc.calls).toEqual([]);
  });

  it("rotates the scan so a standing orphan cannot pin the head of the queue", async () => {
    const older = await seedAdvisory(3 * HOUR);
    const newer = await seedAdvisory(2 * HOUR);
    readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });

    await detectIn("sandbox");

    const olderRow = await advisoryRow(older);
    const newerRow = await advisoryRow(newer);
    expect(olderRow?.last_checked_at).not.toBeNull();
    expect(newerRow?.last_checked_at).not.toBeNull();
    // Both were visited in one tick; the cursor now orders by the visit, not
    // by creation, so the next tick cannot re-serve the oldest one first alone.
    const next = await advisories().claimOpenForDetection({ environment: "sandbox", limit: 1 });
    expect(next.map((r) => r.id)).toHaveLength(1);
  });

  it.each(ENVIRONMENT_CLUSTER_CASES)(
    "judges only $environment advisories, against $cluster's block height",
    async ({ environment, cluster }) => {
      const ids = new Map<SdpEnvironment, string>();
      for (const seeded of SDP_ENVIRONMENTS) {
        ids.set(
          seeded,
          await seedAdvisory(2 * HOUR, {
            environment: seeded,
            projectId: PROJECT_BY_ENVIRONMENT[seeded],
          })
        );
      }
      readOwnerMintBalance.mockResolvedValue({ atoms: BASELINE + FLOOR, decimals: 6 });

      await detectIn(environment);

      for (const [seeded, id] of ids) {
        const row = await advisoryRow(id);
        if (row === null) throw new Error(`advisory ${id} is missing`);
        if (seeded === environment) {
          expect(row.first_flagged_at).not.toBeNull();
        } else {
          expect(row).toMatchObject({ last_checked_at: null, first_flagged_at: null });
        }
      }
      expect(tick().payload).toMatchObject({ environment, checked: 1, orphaned: 1 });
      expect(
        clusterRpc.requests
          .filter((request) => request.method === "getEpochInfo")
          .map((request) => request.cluster)
      ).toEqual([cluster]);
    }
  );
});

describe("advisory repository environment scope", () => {
  // Each environment's detector registration (a `cluster` Cron Definition)
  // claims and counts only its own advisories; the other environment's rows
  // are neither returned, counted, nor touched.
  it.each(SDP_ENVIRONMENTS)("claims and counts only %s open advisories", async (environment) => {
    const other = environment === "sandbox" ? "production" : "sandbox";
    const own = await seedAdvisory(2 * HOUR, {
      environment,
      projectId: PROJECT_BY_ENVIRONMENT[environment],
    });
    const others = [
      await seedAdvisory(2 * HOUR, {
        environment: other,
        projectId: PROJECT_BY_ENVIRONMENT[other],
      }),
      await seedAdvisory(2 * HOUR, {
        environment: other,
        projectId: PROJECT_BY_ENVIRONMENT[other],
      }),
    ];

    const claimed = await advisories().claimOpenForDetection({ environment, limit: 128 });

    expect(claimed.map((row) => row.id)).toEqual([own]);
    for (const id of others) {
      const row = await advisoryRow(id);
      if (row === null) throw new Error(`advisory ${id} is missing`);
      expect(row.last_checked_at).toBeNull();
    }
    await expect(advisories().countOpen({ environment })).resolves.toBe(1);
  });
});
