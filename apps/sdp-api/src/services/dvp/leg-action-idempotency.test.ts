/**
 * Idempotency-Key handling for funding or reclaiming one leg, against the real
 * table and its unique index.
 *
 * The case that matters is the retry that arrives after the first request's
 * transaction confirmed: every chain check passes again by then, so only the
 * key can stop it moving the leg a second time.
 */

import { signature } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readDvpFundingReceipt = vi.hoisted(() => vi.fn());
vi.mock("./funding-receipt", () => ({ readDvpFundingReceipt }));
vi.mock("@sdp/rpc/solana", () => ({ createRpc: () => ({}) }));

import { getDb } from "@/db";
import { runWithTenantDatabaseIdentity } from "@/db/identity";
import { conflict } from "@/lib/errors";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const { runDvpCloseOnce, runDvpLegActionOnce } = await import("./leg-action-idempotency");

import type {
  DvpCloseRequestScope,
  DvpLegActionRequestScope,
  RecordDvpLegActionAttempt,
} from "./leg-action-idempotency";

const ORG = "org_leg_action";
const PROJECT = `prj_${ORG}`;
const TRADE_ID = "dvp_leg_action_trade";
const SIG = signature(
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"
);

const SCOPE: DvpLegActionRequestScope = {
  action: "reclaim",
  tradeId: TRADE_ID,
  side: "a",
  organizationId: ORG,
  projectId: PROJECT,
  custodyWalletId: "cwlt_leg_action",
};

async function seed(): Promise<void> {
  const db = getDb(env);
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, status)
       VALUES ('usr_leg_action', 'leg-action@example.com', 1, 'active') ON CONFLICT (id) DO NOTHING`
    )
    .run();
  await db
    .prepare(
      `INSERT INTO organizations (id, name, slug, tier, status)
       VALUES (?, ?, ?, 'individual', 'active') ON CONFLICT (id) DO NOTHING`
    )
    .bind(ORG, ORG, ORG)
    .run();
  await seedDefaultProjects(db, {
    organizationId: ORG,
    createdBy: "usr_leg_action",
    members: [],
    ids: { sandbox: PROJECT, production: `${PROJECT}_production` },
  });
  await db
    .prepare(
      `INSERT INTO dvp_trades (
         id, organization_id, project_id, swap_dvp, settlement_authority,
         user_a, user_b, mint_a, mint_b, nonce, token_program_a, token_program_b,
         decimals_a, decimals_b, amount_a, amount_b, expiry_timestamp,
         user_a_settlement_destination, user_b_settlement_destination,
         escrow_a, escrow_b, status
       ) VALUES (?, ?, ?, 'BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po',
         '9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY',
         'AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC', 'C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk',
         'ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1', 'AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE',
         '42', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
         6, 6, '1000', '2000', '1900000000',
         'AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC', 'C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk',
         'FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU', '6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y',
         'funded')
       ON CONFLICT (id) DO NOTHING`
    )
    .bind(TRADE_ID, ORG, PROJECT)
    .run();
}

/** Runs one keyed request as the caller's tenant, the way the handler does. */
function once(
  key: string | null,
  run: (
    recordAttempt: RecordDvpLegActionAttempt
  ) => Promise<{ signature: typeof SIG; leg: "a" | "b"; amount: string }>,
  scope: DvpLegActionRequestScope = SCOPE
) {
  return runWithTenantDatabaseIdentity({ organizationId: ORG }, () =>
    runDvpLegActionOnce(env, key, scope, run)
  );
}

/** What fund and reclaim do: record the signed transaction, then send it. */
async function sends(recordAttempt: RecordDvpLegActionAttempt) {
  await recordAttempt({ signature: SIG, amount: "1000", expiryHeight: "500" });
  return { signature: SIG, leg: "a" as const, amount: "1000" };
}

describe("runDvpLegActionOnce", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    await seed();
  });

  it("runs every request that carries no key", async () => {
    const run = vi.fn(sends);

    await once(null, run);
    await once(null, run);

    expect(run).toHaveBeenCalledTimes(2);
  });

  // The retry after a confirmed reclaim would pass every chain check again.
  it("answers a retry with the same key from the first result, without running again", async () => {
    const run = vi.fn(sends);

    const first = await once("key-1", run);
    const retry = await once("key-1", run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(first).toEqual({
      result: { signature: SIG, leg: "a", amount: "1000" },
      replayed: false,
    });
    expect(retry).toEqual({ result: { signature: SIG, leg: "a", amount: "1000" }, replayed: true });
  });

  it("refuses a key reused for a different request", async () => {
    const run = vi.fn(sends);
    await once("key-2", run);

    await expect(once("key-2", run, { ...SCOPE, action: "fund" })).rejects.toThrow(
      /different request payload/
    );
    await expect(once("key-2", run, { ...SCOPE, side: "b" })).rejects.toThrow(
      /different request payload/
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  // Two overlapping requests with one key: only one may send.
  it("refuses a second request while the first still holds the key", async () => {
    let finish: (() => void) | undefined;
    const slow = vi.fn(
      () =>
        new Promise<{ signature: typeof SIG; leg: "a"; amount: string }>((resolve) => {
          finish = () => resolve({ signature: SIG, leg: "a", amount: "1000" });
        })
    );
    const first = once("key-3", slow);
    await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(1));

    await expect(once("key-3", slow)).rejects.toThrow(/still being processed/);

    finish?.();
    await first;
    expect(slow).toHaveBeenCalledTimes(1);
  });

  // A refusal sent nothing, so the same key may try again.
  it("frees the key when the request is refused before sending", async () => {
    const refused = vi.fn(async () => {
      throw conflict("this leg is already being moved; nothing was sent");
    });
    await expect(once("key-4", refused)).rejects.toThrow("already being moved");

    const run = vi.fn(sends);
    await expect(once("key-4", run)).resolves.toMatchObject({ replayed: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  /** Signs, records the attempt the way fund and reclaim do, then fails ambiguously. */
  const sentThenLost = vi.fn(async (recordAttempt: RecordDvpLegActionAttempt) => {
    await recordAttempt({ signature: SIG, amount: "1000", expiryHeight: "500" });
    throw new Error("socket hang up");
  });

  // The send may have landed. Until the chain says, a retry must not run again.
  it("refuses a retry while the recorded transaction can still land", async () => {
    await expect(once("key-5", sentThenLost)).rejects.toThrow("socket hang up");
    readDvpFundingReceipt.mockResolvedValue("pending");

    const run = vi.fn(sends);
    await expect(once("key-5", run)).rejects.toThrow(/still being processed/);
    expect(readDvpFundingReceipt).toHaveBeenCalledWith(expect.anything(), {
      fundingTx: SIG,
      expiryHeight: "500",
    });
    expect(run).not.toHaveBeenCalled();
  });

  // The lost-response case the key exists for: the send landed and only the
  // answer went missing, so the retry gets that answer and moves nothing.
  it("replays a recorded transaction that landed, without running again", async () => {
    await expect(once("key-6", sentThenLost)).rejects.toThrow("socket hang up");
    readDvpFundingReceipt.mockResolvedValue("landed");

    const run = vi.fn(sends);
    await expect(once("key-6", run)).resolves.toEqual({
      result: { signature: SIG, leg: "a", amount: "1000" },
      replayed: true,
    });
    expect(run).not.toHaveBeenCalled();
    // Now recorded as sent: the next retry replays without asking the chain.
    readDvpFundingReceipt.mockClear();
    await expect(once("key-6", run)).resolves.toMatchObject({ replayed: true });
    expect(readDvpFundingReceipt).not.toHaveBeenCalled();
  });

  it("runs again when the recorded transaction provably moved nothing", async () => {
    await expect(once("key-7", sentThenLost)).rejects.toThrow("socket hang up");
    readDvpFundingReceipt.mockResolvedValue("moved_nothing");

    const run = vi.fn(sends);
    await expect(once("key-7", run)).resolves.toMatchObject({ replayed: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  // No attempt recorded means nothing was signed, so nothing was sent; once it
  // is too old to be a live request, the key is handed on.
  it("hands on a key whose request died before signing, once it is stale", async () => {
    const run = vi.fn(sends);
    await getDb(env)
      .prepare(
        `INSERT INTO dvp_leg_action_requests
           (id, organization_id, project_id, idempotency_key, fingerprint, action, trade_id, side, status, updated_at)
         SELECT 'dvpla_abandoned', ?, ?, 'key-8', fingerprint, 'reclaim', ?, 'a', 'pending', '2026-01-01T00:00:00.000Z'
           FROM (SELECT encode(sha256(?::bytea), 'hex') AS fingerprint) AS f`
      )
      .bind(ORG, PROJECT, TRADE_ID, JSON.stringify(["reclaim", TRADE_ID, "a", "cwlt_leg_action"]))
      .run();

    await expect(once("key-8", run)).resolves.toMatchObject({ replayed: false });
    expect(run).toHaveBeenCalledTimes(1);
    expect(readDvpFundingReceipt).not.toHaveBeenCalled();
  });
});

const CLOSE_SCOPE: DvpCloseRequestScope = {
  action: "settle",
  tradeId: TRADE_ID,
  organizationId: ORG,
  projectId: PROJECT,
  custodyWalletId: "cwlt_settlement",
};

/** Runs one keyed close as the caller's tenant, the way the handler does. */
function closeOnce(
  key: string | null,
  run: (
    recordAttempt: RecordDvpLegActionAttempt
  ) => Promise<{ signature: typeof SIG; landed: boolean }>,
  scope: DvpCloseRequestScope = CLOSE_SCOPE
) {
  return runWithTenantDatabaseIdentity({ organizationId: ORG }, () =>
    runDvpCloseOnce(env, key, scope, run)
  );
}

/** What a close does: record the sponsored transaction, then send it. */
async function closes(recordAttempt: RecordDvpLegActionAttempt) {
  await recordAttempt({ signature: SIG, amount: null, expiryHeight: "500" });
  return { signature: SIG, landed: true };
}

describe("runDvpCloseOnce", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    await seed();
  });

  // Without a key this was the whole exposure: the close lock refuses a retry
  // while it is live and tells the caller nothing about the settle that landed.
  it("answers a retry with the signature the first close sent, without closing again", async () => {
    const run = vi.fn(closes);

    const first = await closeOnce("close-1", run);
    const retry = await closeOnce("close-1", run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ result: { signature: SIG, landed: true }, replayed: false });
    expect(retry).toEqual({ result: { signature: SIG, landed: true }, replayed: true });
  });

  // A settle and a cancel are different requests, and answering one with the
  // other's signature would report the wrong outcome for the trade.
  it("refuses a key reused for the other close action", async () => {
    await closeOnce("close-2", closes);

    await expect(
      closeOnce("close-2", closes, { ...CLOSE_SCOPE, action: "cancel" })
    ).rejects.toThrow(/different request payload/);
  });

  it("refuses a key reused for another trade", async () => {
    await closeOnce("close-3", closes);

    await expect(
      closeOnce("close-3", closes, { ...CLOSE_SCOPE, tradeId: "dvp_other_trade" })
    ).rejects.toThrow(/different request payload/);
  });

  it("replays a recorded close that landed, without signing a second one", async () => {
    const lostAfterSending = async (recordAttempt: RecordDvpLegActionAttempt) => {
      await recordAttempt({ signature: SIG, amount: null, expiryHeight: "500" });
      throw new Error("socket hang up");
    };
    await expect(closeOnce("close-4", lostAfterSending)).rejects.toThrow("socket hang up");
    readDvpFundingReceipt.mockResolvedValue("landed");

    const run = vi.fn(closes);
    await expect(closeOnce("close-4", run)).resolves.toEqual({
      result: { signature: SIG, landed: true },
      replayed: true,
    });
    expect(run).not.toHaveBeenCalled();
  });

  // The close that failed on chain: the escrow is untouched, so a fresh close
  // is legitimate, and the chain is what says so.
  it("closes again when the recorded close provably moved nothing", async () => {
    const failedOnChain = async (recordAttempt: RecordDvpLegActionAttempt) => {
      await recordAttempt({ signature: SIG, amount: null, expiryHeight: "500" });
      throw conflict("the settle was refused on chain; nothing moved");
    };
    await expect(closeOnce("close-5", failedOnChain)).rejects.toThrow(/refused on chain/);
    readDvpFundingReceipt.mockResolvedValue("moved_nothing");

    const run = vi.fn(closes);
    await expect(closeOnce("close-5", run)).resolves.toMatchObject({ replayed: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  // The difference from a leg action. A close throws 400
  // `dvp_close_failed_on_chain` AFTER broadcasting, so freeing the key on a 4xx
  // would let the retry sign a second close with no evidence about the first.
  // The key is kept, and a transaction that can still land holds the retry off.
  it("keeps the key when a recorded close fails with a 4xx, and refuses the retry while it can land", async () => {
    const recordedThen4xx = async (recordAttempt: RecordDvpLegActionAttempt) => {
      await recordAttempt({ signature: SIG, amount: null, expiryHeight: "500" });
      throw conflict("the close was refused on chain; nothing moved");
    };
    await expect(closeOnce("close-6", recordedThen4xx)).rejects.toThrow(/refused on chain/);
    readDvpFundingReceipt.mockResolvedValue("pending");

    const run = vi.fn(closes);
    await expect(closeOnce("close-6", run)).rejects.toThrow(/still being processed/);
    expect(run).not.toHaveBeenCalled();
  });

  // Nothing recorded means nothing was signed and nothing was sent, which is
  // the one case where the same key may be tried again immediately.
  it("frees the key when the close is refused before it signs anything", async () => {
    const refusedEarly = async () => {
      throw conflict("another settle or cancel is already in flight");
    };
    await expect(closeOnce("close-7", refusedEarly)).rejects.toThrow(/already in flight/);

    const run = vi.fn(closes);
    await expect(closeOnce("close-7", run)).resolves.toMatchObject({ replayed: false });
    expect(run).toHaveBeenCalledTimes(1);
    expect(readDvpFundingReceipt).not.toHaveBeenCalled();
  });
});

// Migration 0112 makes the two absences exact rather than optional, so a row
// that would make a close look like a leg action cannot be stored at all.
describe("dvp_leg_action_requests constraints (0112)", () => {
  beforeEach(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    await seed();
  });

  let rowCount = 0;

  function insert(row: {
    action: string;
    side: string | null;
    amount: string | null;
    signed: boolean;
  }) {
    rowCount += 1;
    return runWithTenantDatabaseIdentity({ organizationId: ORG }, () =>
      getDb(env)
        .prepare(
          `INSERT INTO dvp_leg_action_requests
             (id, organization_id, project_id, idempotency_key, fingerprint, action, trade_id, side, status, signature, amount, expiry_height)
           VALUES (?, ?, ?, ?, 'fp', ?, ?, ?, 'pending', ?, ?, ?)`
        )
        .bind(
          `dvpla_constraint_${rowCount}`,
          ORG,
          PROJECT,
          `constraint-key-${rowCount}`,
          row.action,
          TRADE_ID,
          row.side,
          row.signed ? SIG : null,
          row.amount,
          row.signed ? "500" : null
        )
        .run()
    );
  }

  it("stores a close with no side and no amount", async () => {
    await expect(
      insert({ action: "settle", side: null, amount: null, signed: true })
    ).resolves.toBeDefined();
  });

  // Each refusal names the constraint that produced it: a bare `rejects` would
  // pass just as well on a typo in the insert and prove nothing.
  it("refuses a close that names a side", async () => {
    await expect(
      insert({ action: "cancel", side: "a", amount: null, signed: true })
    ).rejects.toThrow(/dvp_leg_action_requests_side_presence_check/);
  });

  it("refuses a leg action with no side", async () => {
    await expect(
      insert({ action: "fund", side: null, amount: "1000", signed: true })
    ).rejects.toThrow(/dvp_leg_action_requests_side_presence_check/);
  });

  it("refuses a close that records an amount", async () => {
    await expect(
      insert({ action: "settle", side: null, amount: "1000", signed: true })
    ).rejects.toThrow(/dvp_leg_action_requests_attempt_complete_check/);
  });

  // The pairing 0101 relied on, kept for leg actions alone: a recorded fund
  // without its amount would replay a signature and no answer.
  it("refuses a signed leg action with no amount", async () => {
    await expect(insert({ action: "fund", side: "a", amount: null, signed: true })).rejects.toThrow(
      /dvp_leg_action_requests_attempt_complete_check/
    );
  });
});
