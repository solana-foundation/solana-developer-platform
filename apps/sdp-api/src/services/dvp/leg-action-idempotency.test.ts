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

const { runDvpLegActionOnce } = await import("./leg-action-idempotency");

import type { DvpLegActionRequestScope, RecordDvpLegActionAttempt } from "./leg-action-idempotency";

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
