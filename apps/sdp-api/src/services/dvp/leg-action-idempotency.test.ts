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
import { getDb } from "@/db";
import { runWithTenantDatabaseIdentity } from "@/db/identity";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { type DvpLegActionRequestScope, runDvpLegActionOnce } from "./leg-action-idempotency";

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
  run: () => Promise<{ signature: typeof SIG; leg: "a" | "b"; amount: string }>,
  scope: DvpLegActionRequestScope = SCOPE
) {
  return runWithTenantDatabaseIdentity({ organizationId: ORG }, () =>
    runDvpLegActionOnce(env, key, scope, run)
  );
}

describe("runDvpLegActionOnce", () => {
  beforeEach(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    await seed();
  });

  it("runs every request that carries no key", async () => {
    const run = vi.fn(async () => ({ signature: SIG, leg: "a" as const, amount: "1000" }));

    await once(null, run);
    await once(null, run);

    expect(run).toHaveBeenCalledTimes(2);
  });

  // The retry after a confirmed reclaim would pass every chain check again.
  it("answers a retry with the same key from the first result, without running again", async () => {
    const run = vi.fn(async () => ({ signature: SIG, leg: "a" as const, amount: "1000" }));

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
    const run = vi.fn(async () => ({ signature: SIG, leg: "a" as const, amount: "1000" }));
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

  // A refusal sent nothing, so the same key may try again; the leg lock and the
  // live chain reads still stand between the retry and a second send.
  it("frees the key when the request throws", async () => {
    const refused = vi.fn(async () => {
      throw new Error("leg is already being moved");
    });
    await expect(once("key-4", refused)).rejects.toThrow("leg is already being moved");

    const run = vi.fn(async () => ({ signature: SIG, leg: "a" as const, amount: "1000" }));
    await expect(once("key-4", run)).resolves.toMatchObject({ replayed: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  // A request that died before recording its answer must not hold the key forever.
  it("hands a key abandoned mid-request to the next request", async () => {
    const run = vi.fn(async () => ({ signature: SIG, leg: "a" as const, amount: "1000" }));
    await getDb(env)
      .prepare(
        `INSERT INTO dvp_leg_action_requests
           (id, organization_id, project_id, idempotency_key, fingerprint, action, trade_id, side, status, updated_at)
         SELECT 'dvpla_abandoned', ?, ?, 'key-5', fingerprint, 'reclaim', ?, 'a', 'pending', '2026-01-01T00:00:00.000Z'
           FROM (SELECT encode(sha256(?::bytea), 'hex') AS fingerprint) AS f`
      )
      .bind(ORG, PROJECT, TRADE_ID, JSON.stringify(["reclaim", TRADE_ID, "a", "cwlt_leg_action"]))
      .run();

    await expect(once("key-5", run)).resolves.toMatchObject({ replayed: false });
    expect(run).toHaveBeenCalledTimes(1);
    await expect(once("key-5", run)).resolves.toMatchObject({ replayed: true });
  });
});
