import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresIssuanceTransactionsRepository } from "@/db/repositories";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const getSignatureStatusesMock = vi.hoisted(() => vi.fn());
vi.mock("@sdp/rpc/solana", () => ({
  createRpc: () => ({}),
  getSignatureStatuses: getSignatureStatusesMock,
}));

const { finalizeConfirmedIssuanceTransactions } = await import(
  "./finalize-confirmed-issuance-transactions"
);

const PROJECT_ID = "prj_issuance_finality_job";
const TOKEN_ID = "tok_issuance_finality_job";
/** A real base58 64-byte signature, so the job's validation accepts it. */
const SIG =
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy";

/** Distinct valid signatures per row: issuance signatures carry a UNIQUE constraint. */
const NEXT_SIG_CHAR = ["5", "6", "7", "8", "9", "A", "B", "C", "D", "E"].values();
function signatureFor(_id: string): string {
  const first = NEXT_SIG_CHAR.next().value ?? "F";
  return `${first}${SIG.slice(1)}`;
}

type StatusInfo = { slot: bigint; confirmations: bigint; confirmationStatus: string; err: unknown };

function statusOf(confirmationStatus: string, err: unknown = null): StatusInfo {
  return { slot: 500n, confirmations: 1n, confirmationStatus, err };
}

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

async function seedConfirmedTransaction(params: {
  id: string;
  confirmedMinutesAgo: number;
}): Promise<void> {
  const confirmedAt = minutesAgo(params.confirmedMinutesAgo);
  await getDb(env)
    .prepare(
      `INSERT INTO issued_tokens
         (id, project_id, organization_id, mint_address, name, symbol, decimals, created_by)
       VALUES (?, ?, ?, 'FinalityJobMint1111111111111111111111111111111',
               'Finality job', 'FNJ', 6, ?)
       ON CONFLICT (id) DO NOTHING`
    )
    .bind(TOKEN_ID, PROJECT_ID, TEST_ORG.id, TEST_USER.id)
    .run();
  await getDb(env)
    .prepare(
      `INSERT INTO issuance_transactions
         (id, token_id, organization_id, type, status, signature, slot,
          operation_params, created_at, updated_at)
       VALUES (?, ?, ?, 'mint', 'confirmed', ?, 123, '{}', ?, ?)`
    )
    .bind(params.id, TOKEN_ID, TEST_ORG.id, signatureFor(params.id), confirmedAt, confirmedAt)
    .run();
  await getDb(env)
    .prepare(
      `INSERT INTO issuance_transaction_statuses (id, transaction_id, status, changed_at)
       VALUES (?, ?, 'confirmed', ?)`
    )
    .bind(`its_${params.id}`, params.id, confirmedAt)
    .run();
}

async function getTransaction(id: string) {
  return getDb(env)
    .prepare(
      `SELECT id, status, slot, finalization_last_polled_at, finalization_poll_attempts,
              finalization_next_poll_at
       FROM issuance_transactions WHERE id = ?`
    )
    .bind(id)
    .first<{
      id: string;
      status: string;
      slot: number | null;
      finalization_last_polled_at: string | null;
      finalization_poll_attempts: number;
      finalization_next_poll_at: string | null;
    }>();
}

describe("finalizeConfirmedIssuanceTransactions", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await seedDefaultProjects(getDb(env), {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
    });
    getSignatureStatusesMock.mockReset();
    getSignatureStatusesMock.mockImplementation(async (_rpc: unknown, signatures: string[]) =>
      signatures.map(() => statusOf("confirmed"))
    );
  });

  it("advances a confirmed transaction to finalized once the cluster reports finality", async () => {
    await seedConfirmedTransaction({ id: "itx_fin_ok", confirmedMinutesAgo: 5 });
    getSignatureStatusesMock.mockImplementation(async (_rpc: unknown, signatures: string[]) =>
      signatures.map(() => statusOf("finalized"))
    );

    await expect(finalizeConfirmedIssuanceTransactions(env)).resolves.toEqual({
      polled: 1,
      finalized: 1,
    });

    const row = await getTransaction("itx_fin_ok");
    expect(row).toMatchObject({
      status: "finalized",
      // The transaction's slot never changes between the confirmed and
      // finalized observations, so the recorded value is preserved.
      slot: 123,
      finalization_last_polled_at: expect.any(String),
    });
    const history = await getDb(env).queryMany<{ status: string }>(
      `SELECT status FROM issuance_transaction_statuses WHERE transaction_id = ? ORDER BY changed_at`,
      ["itx_fin_ok"]
    );
    expect(history.map((entry) => entry.status)).toEqual(["confirmed", "finalized"]);

    // With the fixed projection, finality is what makes the unified ledger
    // read the row as succeeded.
    const unified = await getDb(env).queryOne<{ status: string }>(
      `SELECT status FROM unified_transactions WHERE module = 'issuance' AND module_id = ?`,
      ["itx_fin_ok"]
    );
    expect(unified?.status).toBe("succeeded");
  });

  it("keeps a confirmed transaction confirmed while finality is unobserved", async () => {
    await seedConfirmedTransaction({ id: "itx_fin_pending", confirmedMinutesAgo: 5 });

    await expect(finalizeConfirmedIssuanceTransactions(env)).resolves.toEqual({
      polled: 1,
      finalized: 0,
    });

    const row = await getTransaction("itx_fin_pending");
    expect(row).toMatchObject({
      status: "confirmed",
      slot: 123,
      finalization_last_polled_at: expect.any(String),
    });
    const unified = await getDb(env).queryOne<{ status: string }>(
      `SELECT status FROM unified_transactions WHERE module = 'issuance' AND module_id = ?`,
      ["itx_fin_pending"]
    );
    expect(unified?.status).toBe("pending");
    // A provisional poll only rotates the poll stamp: it must never write a
    // terminal `finalized` history entry for a row that did not advance.
    const history = await getDb(env).queryMany<{ status: string }>(
      `SELECT status FROM issuance_transaction_statuses WHERE transaction_id = ? ORDER BY changed_at`,
      ["itx_fin_pending"]
    );
    expect(history.map((entry) => entry.status)).toEqual(["confirmed"]);
  });

  it("never introduces a failure status for a confirmed transaction the chain reports as errored", async () => {
    await seedConfirmedTransaction({ id: "itx_fin_err", confirmedMinutesAgo: 5 });
    getSignatureStatusesMock.mockImplementation(async (_rpc: unknown, signatures: string[]) =>
      signatures.map(() => statusOf("confirmed", { InstructionError: [0, "Custom"] }))
    );

    await expect(finalizeConfirmedIssuanceTransactions(env)).resolves.toEqual({
      polled: 1,
      finalized: 0,
    });

    await expect(getTransaction("itx_fin_err")).resolves.toMatchObject({ status: "confirmed" });
  });

  it("polls rows confirmed long before the tick — the finality-verified recovery path", async () => {
    // No age cutoff: rows confirmed before this reconciler deployed, or
    // stranded by an outage, stay in the least-recently-polled queue until
    // the cluster verifies their finality — the unified ledger reads them as
    // provisional until then.
    await seedConfirmedTransaction({ id: "itx_fin_old", confirmedMinutesAgo: 25 * 60 });
    await seedConfirmedTransaction({ id: "itx_fin_fresh", confirmedMinutesAgo: 5 });
    getSignatureStatusesMock.mockImplementation(async (_rpc: unknown, signatures: string[]) =>
      signatures.map(() => statusOf("finalized"))
    );

    await expect(finalizeConfirmedIssuanceTransactions(env)).resolves.toEqual({
      polled: 2,
      finalized: 2,
    });

    await expect(getTransaction("itx_fin_old")).resolves.toMatchObject({
      status: "finalized",
      finalization_last_polled_at: expect.any(String),
    });
    await expect(getTransaction("itx_fin_fresh")).resolves.toMatchObject({
      status: "finalized",
    });
  });

  it("reports a failed RPC read as a failed tick while still rotating the page", async () => {
    await seedConfirmedTransaction({ id: "itx_fin_rpc", confirmedMinutesAgo: 5 });
    getSignatureStatusesMock.mockImplementation(async () => {
      throw new Error("rpc unreachable");
    });

    await expect(finalizeConfirmedIssuanceTransactions(env)).rejects.toThrow("rpc unreachable");

    // The page still rotated — the failed rows are re-due at this poll's
    // timestamp, so the next tick checks the rows behind them instead of
    // pinning the same page while the backlog waits — but the tick itself
    // failed, so monitoring sees the reconciliation stall instead of a
    // healthy pass. The failed read learned nothing about finality, so the
    // row's non-finalization backoff is untouched: no deferral it never
    // earned stands between it and a re-check once RPC recovers.
    const failed = await getTransaction("itx_fin_rpc");
    expect(failed).toMatchObject({
      status: "confirmed",
      finalization_last_polled_at: expect.any(String),
      finalization_poll_attempts: 0,
    });
    const stampedAt = new Date(failed?.finalization_next_poll_at ?? "");
    expect(Math.abs(stampedAt.getTime() - Date.now())).toBeLessThan(30 * 1000);
  });

  it("backs off repeated non-finalizing polls without dropping the recovery path", async () => {
    await seedConfirmedTransaction({ id: "itx_fin_backoff", confirmedMinutesAgo: 5 });

    // First tick: the row is provisional, so it is deferred instead of being
    // re-polled on the next pass.
    await expect(finalizeConfirmedIssuanceTransactions(env)).resolves.toEqual({
      polled: 1,
      finalized: 0,
    });
    const first = await getTransaction("itx_fin_backoff");
    expect(first?.finalization_poll_attempts).toBe(1);
    expect(first?.finalization_next_poll_at).not.toBeNull();

    // The deferral keeps it out of the queue: a tick that runs before the
    // backoff elapses must not spend an RPC history lookup on it again.
    await expect(finalizeConfirmedIssuanceTransactions(env)).resolves.toEqual({
      polled: 0,
      finalized: 0,
    });

    // Once the deferral elapses the row returns to the queue — the
    // finality-verified recovery path — and this time the cluster reports
    // finality, which clears the deferral entirely.
    await getDb(env)
      .prepare(
        `UPDATE issuance_transactions
            SET finalization_next_poll_at = ?
          WHERE id = 'itx_fin_backoff'`
      )
      .bind(minutesAgo(1))
      .run();
    getSignatureStatusesMock.mockImplementation(async (_rpc: unknown, signatures: string[]) =>
      signatures.map(() => statusOf("finalized"))
    );
    await expect(finalizeConfirmedIssuanceTransactions(env)).resolves.toEqual({
      polled: 1,
      finalized: 1,
    });
    await expect(getTransaction("itx_fin_backoff")).resolves.toMatchObject({
      status: "finalized",
      finalization_poll_attempts: 0,
      finalization_next_poll_at: null,
    });
  });

  it("caps the non-finalizing deferral at 24 hours", async () => {
    await seedConfirmedTransaction({ id: "itx_fin_cap", confirmedMinutesAgo: 5 });
    // A row already deferred the maximum number of consecutive times.
    await getDb(env)
      .prepare(
        `UPDATE issuance_transactions
            SET finalization_poll_attempts = 17, finalization_next_poll_at = ?
          WHERE id = 'itx_fin_cap'`
      )
      .bind(minutesAgo(1))
      .run();

    await expect(finalizeConfirmedIssuanceTransactions(env)).resolves.toEqual({
      polled: 1,
      finalized: 0,
    });

    const row = await getTransaction("itx_fin_cap");
    expect(row?.finalization_poll_attempts).toBe(18);
    const nextPollAt = new Date(row?.finalization_next_poll_at ?? "");
    const hoursAhead = (nextPollAt.getTime() - Date.now()) / (60 * 1000);
    // 24h minus test-clocks skew on either side.
    expect(hoursAhead).toBeGreaterThan(60 * 23);
    expect(hoursAhead).toBeLessThan(60 * 25);
  });

  it("does not double the backoff when an overlapping tick already polled the row", async () => {
    await seedConfirmedTransaction({ id: "itx_fin_overlap", confirmedMinutesAgo: 5 });
    const repo = createPostgresIssuanceTransactionsRepository(getDb(env));
    const [row] = await repo.listConfirmedTransactionsToPoll({ limit: 10 });

    // Two overlapping self-hosted ticks select the same due row (both see the
    // same poll stamp) before either writes.
    await repo.advanceConfirmedTransactions({
      polled: [
        {
          id: row.id,
          organizationId: row.organizationId,
          finalized: false,
          slot: null,
          readFailed: false,
          observedLastPolledAt: row.lastPolledAt,
        },
      ],
      updatedAt: new Date().toISOString(),
    });
    const afterFirst = await getTransaction("itx_fin_overlap");
    expect(afterFirst?.finalization_poll_attempts).toBe(1);

    // The second tick's page was read before the first one stamped the row,
    // so its provisional verdict must not grow the deferral again.
    await repo.advanceConfirmedTransactions({
      polled: [
        {
          id: row.id,
          organizationId: row.organizationId,
          finalized: false,
          slot: null,
          readFailed: false,
          observedLastPolledAt: row.lastPolledAt,
        },
      ],
      updatedAt: new Date().toISOString(),
    });
    const afterSecond = await getTransaction("itx_fin_overlap");
    expect(afterSecond?.finalization_poll_attempts).toBe(1);
    expect(afterSecond?.finalization_next_poll_at).toBe(afterFirst?.finalization_next_poll_at);

    // A verdict whose page observed the new stamp does grow the backoff.
    await getDb(env)
      .prepare(
        `UPDATE issuance_transactions SET finalization_next_poll_at = ? WHERE id = 'itx_fin_overlap'`
      )
      .bind(minutesAgo(1))
      .run();
    const [reread] = await repo.listConfirmedTransactionsToPoll({ limit: 10 });
    await repo.advanceConfirmedTransactions({
      polled: [
        {
          id: reread.id,
          organizationId: reread.organizationId,
          finalized: false,
          slot: null,
          readFailed: false,
          observedLastPolledAt: reread.lastPolledAt,
        },
      ],
      updatedAt: new Date().toISOString(),
    });
    await expect(getTransaction("itx_fin_overlap")).resolves.toMatchObject({
      finalization_poll_attempts: 2,
    });
  });
});
