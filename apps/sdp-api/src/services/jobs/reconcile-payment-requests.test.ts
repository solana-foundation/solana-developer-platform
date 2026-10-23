import { runInClusterScope } from "@sdp/rpc/scope";
import * as solanaRpc from "@sdp/rpc/solana";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import {
  createPaymentRequestsRepository,
  createSystemPaymentRequestsRepository,
} from "@/db/repositories/repository-factory";
import { badRequest } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import * as moneyPathEvents from "@/runtime/money-path-events";
import * as paymentAmounts from "@/services/payments/token-amount";
import { TEST_CUSTODY_PUBLIC_KEY } from "@/test/fixtures/custody";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  expirePaymentRequests,
  reconcileHotPaymentRequests,
  reconcilePaymentRequests,
} from "./reconcile-payment-requests";

const TEST_PROJECT_ID = "prj_preq_job_test";
const TEST_CONFIG_ID = "cust_cfg_preq_job_test";
const TEST_CUSTODY_WALLET_ID = "cwlt_preq_job_test";
const TEST_WALLET_ID = "wal_preq_job_test";
const PAST = "2020-01-01T00:00:00.000Z";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

async function updateRow(id: string, fields: Record<string, string | null>) {
  const columns = Object.keys(fields);
  await getDb(env)
    .prepare(
      `UPDATE payment_requests SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`
    )
    .bind(...Object.values(fields), id)
    .run();
}

async function createRequest(params: { token: string; expiresAt: string | null }) {
  return createPaymentRequestsRepository(
    env,
    createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID })
  ).createPaymentRequest({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    custodyWalletId: TEST_CUSTODY_WALLET_ID,
    walletId: TEST_WALLET_ID,
    destinationAddress: TEST_CUSTODY_PUBLIC_KEY,
    token: params.token,
    amount: "1.5",
    expiresAt: params.expiresAt,
    createdBy: TEST_USER.id,
  });
}

async function getRow(requestId: string) {
  const row = await createSystemPaymentRequestsRepository(env).getPaymentRequestById({
    requestId,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
  });
  if (row === null) {
    throw new Error(`Payment request ${requestId} not found`);
  }
  return row;
}

function onSandbox(fn: () => Promise<void>) {
  return runInClusterScope({ projectId: TEST_PROJECT_ID, environment: "sandbox" }, fn);
}

function installJobHooks() {
  const clusterRpc = installClusterRpcStub();

  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    clusterRpc.answer("getBlockHeight", 1_000);

    const db = getDb(env);
    await db.prepare("DELETE FROM payment_requests").run();
    await db.prepare("DELETE FROM payment_transfers").run();
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
      ids: { sandbox: TEST_PROJECT_ID, production: `${TEST_PROJECT_ID}_production` },
    });
    await db
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted,
            encryption_version, status)
         VALUES (?, ?, ?, 'local', 'test-config', 'sdp-custody-encryption-v1', 'active')`
      )
      .bind(TEST_CONFIG_ID, TEST_ORG.id, TEST_PROJECT_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(TEST_CUSTODY_WALLET_ID, TEST_CONFIG_ID, TEST_WALLET_ID, TEST_CUSTODY_PUBLIC_KEY)
      .run();
  });
}

describe("reconcilePaymentRequests", () => {
  installJobHooks();

  it("stamps last_checked_at and last_verified_at on every row it read, paid or not", async () => {
    vi.spyOn(solanaRpc, "getSignaturesForAddress").mockResolvedValue([]);
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });

    await onSandbox(() => reconcilePaymentRequests(env));

    const row = await getRow(request.id);
    expect(row.status).toBe("awaiting_payment");
    expect(row.last_checked_at).not.toBeNull();
    expect(row.last_verified_at).not.toBeNull();
  });

  it("keeps going after one row throws, and still stamps it", async () => {
    const log = vi.spyOn(moneyPathEvents, "logEvent");
    const first = await createRequest({ token: SOL_MINT, expiresAt: null });
    const second = await createRequest({ token: SOL_MINT, expiresAt: null });
    const findReference = vi
      .spyOn(solanaRpc, "getSignaturesForAddress")
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockResolvedValueOnce([]);

    await onSandbox(() => reconcilePaymentRequests(env));

    expect(findReference).toHaveBeenCalledTimes(2);
    const rows = [await getRow(first.id), await getRow(second.id)];
    expect(rows.map((row) => row.last_checked_at)).not.toContain(null);
    expect(rows.filter((row) => row.last_verified_at === null)).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ event: "payment_requests.check_failed", lane: "sweep" })
    );
  });

  it("summarises each run with a warning when any check failed", async () => {
    const log = vi.spyOn(moneyPathEvents, "logEvent");
    await createRequest({ token: SOL_MINT, expiresAt: null });
    await createRequest({ token: SOL_MINT, expiresAt: null });
    vi.spyOn(solanaRpc, "getSignaturesForAddress")
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockResolvedValueOnce([]);

    await onSandbox(() => reconcilePaymentRequests(env));

    expect(log).toHaveBeenCalledWith("warn", {
      event: "payment_requests.lane_run",
      environment: "sandbox",
      lane: "sweep",
      checked: 2,
      failed: 1,
      settled: 0,
      blocked: 0,
    });
  });

  it("fails the run when every check failed, after stamping and summarising", async () => {
    const log = vi.spyOn(moneyPathEvents, "logEvent");
    const first = await createRequest({ token: SOL_MINT, expiresAt: null });
    const second = await createRequest({ token: SOL_MINT, expiresAt: null });
    vi.spyOn(solanaRpc, "getSignaturesForAddress").mockRejectedValue(new Error("rpc down"));

    await expect(onSandbox(() => reconcilePaymentRequests(env))).rejects.toThrow(
      /sweep lane: all 2 checks failed/
    );

    expect((await getRow(first.id)).last_checked_at).not.toBeNull();
    expect((await getRow(second.id)).last_checked_at).not.toBeNull();
    expect((await getRow(first.id)).last_verified_at).toBeNull();
    expect((await getRow(second.id)).last_verified_at).toBeNull();
    expect(log).toHaveBeenCalledWith("warn", {
      event: "payment_requests.lane_run",
      environment: "sandbox",
      lane: "sweep",
      checked: 2,
      failed: 2,
      settled: 0,
      blocked: 0,
    });
  });

  it("does not fail a run that checked no rows", async () => {
    await expect(onSandbox(() => reconcilePaymentRequests(env))).resolves.toBeUndefined();
  });

  it("summarises a clean run at info level", async () => {
    const log = vi.spyOn(moneyPathEvents, "logEvent");
    vi.spyOn(solanaRpc, "getSignaturesForAddress").mockResolvedValue([]);
    await createRequest({ token: SOL_MINT, expiresAt: null });

    await onSandbox(() => reconcilePaymentRequests(env));

    expect(log).toHaveBeenCalledWith("info", {
      event: "payment_requests.lane_run",
      environment: "sandbox",
      lane: "sweep",
      checked: 1,
      failed: 0,
      settled: 0,
      blocked: 0,
    });
  });

  it("checks rows in parallel with bounded concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(solanaRpc, "getSignaturesForAddress").mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return [];
    });
    const requests = await Promise.all(
      Array.from({ length: 12 }, () => createRequest({ token: SOL_MINT, expiresAt: null }))
    );

    await onSandbox(() => reconcilePaymentRequests(env));

    expect(peak).toBe(8);
    for (const request of requests) {
      expect((await getRow(request.id)).last_checked_at).not.toBeNull();
    }
  });

  it("logs the stale backlog when awaiting rows go unchecked", async () => {
    const log = vi.spyOn(moneyPathEvents, "logEvent");
    vi.spyOn(solanaRpc, "getSignaturesForAddress").mockResolvedValue([]);
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    await createRequest({ token: SOL_MINT, expiresAt: PAST });
    await updateRow(request.id, { created_at: PAST, last_checked_at: PAST });

    await onSandbox(() => reconcilePaymentRequests(env));

    expect(log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({ event: "payment_requests.reconcile_backlog", stale: 1 })
    );
    expect((await getRow(request.id)).last_checked_at).not.toBe(PAST);
  });

  it("does not mark a request verified when its check never read the chain", async () => {
    const signatures = vi.spyOn(solanaRpc, "getSignaturesForAddress").mockResolvedValue([]);
    vi.spyOn(paymentAmounts, "loadPaymentMint").mockRejectedValue(
      badRequest("Token mint account does not exist")
    );
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });

    await onSandbox(() => reconcilePaymentRequests(env));

    const row = await getRow(request.id);
    expect(signatures).not.toHaveBeenCalled();
    expect(row.last_checked_at).not.toBeNull();
    expect(row.last_verified_at).toBeNull();
    expect(row.settlement_blocked_reason).toBe("mint_not_admitted");
  });

  it("keeps a request blocked by its mint out of the backlog", async () => {
    const log = vi.spyOn(moneyPathEvents, "logEvent");
    vi.spyOn(solanaRpc, "getSignaturesForAddress").mockResolvedValue([]);
    vi.spyOn(paymentAmounts, "loadPaymentMint").mockRejectedValue(
      badRequest("Token mint account does not exist")
    );
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    await updateRow(request.id, { created_at: PAST, last_checked_at: PAST });

    await onSandbox(() => reconcilePaymentRequests(env));
    log.mockClear();
    await updateRow(request.id, { last_checked_at: PAST });
    await onSandbox(() => reconcilePaymentRequests(env));

    expect(log).not.toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({ event: "payment_requests.reconcile_backlog" })
    );
    expect(log).toHaveBeenCalledWith(
      "info",
      expect.objectContaining({ event: "payment_requests.lane_run", lane: "sweep", blocked: 1 })
    );
  });

  it("reports a once-blocked request as backlog when its checks start failing", async () => {
    const log = vi.spyOn(moneyPathEvents, "logEvent");
    vi.spyOn(solanaRpc, "getSignaturesForAddress").mockRejectedValue(new Error("rpc down"));
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    await updateRow(request.id, {
      created_at: PAST,
      last_checked_at: PAST,
      settlement_blocked_reason: "mint_not_admitted",
    });

    await expect(onSandbox(() => reconcilePaymentRequests(env))).rejects.toThrow(/checks failed/);
    log.mockClear();
    await updateRow(request.id, { last_checked_at: PAST });
    await expect(onSandbox(() => reconcilePaymentRequests(env))).rejects.toThrow(/checks failed/);

    expect((await getRow(request.id)).settlement_blocked_reason).toBeNull();
    expect(log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({ event: "payment_requests.reconcile_backlog", stale: 1 })
    );
  });

  it("clears the block once the chain can be read again", async () => {
    vi.spyOn(solanaRpc, "getSignaturesForAddress").mockResolvedValue([]);
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    await updateRow(request.id, { settlement_blocked_reason: "mint_not_admitted" });

    await onSandbox(() => reconcilePaymentRequests(env));

    const row = await getRow(request.id);
    expect(row.settlement_blocked_reason).toBeNull();
    expect(row.last_verified_at).not.toBeNull();
  });

  it("reports a row whose checks keep failing as backlog", async () => {
    const log = vi.spyOn(moneyPathEvents, "logEvent");
    vi.spyOn(solanaRpc, "getSignaturesForAddress").mockRejectedValue(new Error("rpc down"));
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    await updateRow(request.id, { created_at: PAST, last_checked_at: PAST });

    await expect(onSandbox(() => reconcilePaymentRequests(env))).rejects.toThrow(/checks failed/);
    log.mockClear();
    await onSandbox(() => reconcilePaymentRequests(env));

    expect((await getRow(request.id)).last_checked_at).not.toBe(PAST);
    expect(log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({ event: "payment_requests.reconcile_backlog", stale: 1 })
    );
  });

  it("does not report a backlog for aged rows on their slower recheck cadence", async () => {
    const log = vi.spyOn(moneyPathEvents, "logEvent");
    vi.spyOn(solanaRpc, "getSignaturesForAddress").mockResolvedValue([]);
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    await updateRow(request.id, {
      created_at: ago(2 * DAY),
      last_checked_at: ago(11 * MINUTE),
      last_verified_at: ago(11 * MINUTE),
    });

    await onSandbox(() => reconcilePaymentRequests(env));

    expect(log).not.toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({ event: "payment_requests.reconcile_backlog" })
    );
  });

  it("rechecks requests older than a day at most every ten minutes", async () => {
    const findReference = vi.spyOn(solanaRpc, "getSignaturesForAddress").mockResolvedValue([]);
    const young = await createRequest({ token: SOL_MINT, expiresAt: null });
    const aged = await createRequest({ token: SOL_MINT, expiresAt: null });
    const lastChecked = ago(MINUTE);
    await updateRow(young.id, { last_checked_at: lastChecked });
    await updateRow(aged.id, { created_at: ago(2 * DAY), last_checked_at: lastChecked });

    await onSandbox(() => reconcilePaymentRequests(env));

    expect(findReference).toHaveBeenCalledTimes(1);
    expect((await getRow(young.id)).last_checked_at).not.toBe(lastChecked);
    expect((await getRow(aged.id)).last_checked_at).toBe(lastChecked);
  });
});

describe("reconcileHotPaymentRequests", () => {
  installJobHooks();

  it("checks only rows whose sponsored transaction can still land", async () => {
    const findReference = vi.spyOn(solanaRpc, "getSignaturesForAddress").mockResolvedValue([]);
    const hot = await createRequest({ token: SOL_MINT, expiresAt: null });
    await createRequest({ token: SOL_MINT, expiresAt: null });
    await getDb(env)
      .prepare(
        `UPDATE payment_requests SET sponsored_tx_account = 'acct', sponsored_tx_unsigned = 'tx',
           sponsored_tx_last_valid_block_height = ? WHERE id = ?`
      )
      .bind("999999999", hot.id)
      .run();

    await onSandbox(() => reconcileHotPaymentRequests(env));

    expect(findReference).toHaveBeenCalledTimes(1);
    expect((await getRow(hot.id)).last_checked_at).not.toBeNull();
  });

  it("fails the run when every hot check failed", async () => {
    vi.spyOn(solanaRpc, "getSignaturesForAddress").mockRejectedValue(new Error("rpc down"));
    const hot = await createRequest({ token: SOL_MINT, expiresAt: null });
    await getDb(env)
      .prepare(
        `UPDATE payment_requests SET sponsored_tx_account = 'acct', sponsored_tx_unsigned = 'tx',
           sponsored_tx_last_valid_block_height = ? WHERE id = ?`
      )
      .bind("999999999", hot.id)
      .run();

    await expect(onSandbox(() => reconcileHotPaymentRequests(env))).rejects.toThrow(
      /hot lane: all 1 checks failed/
    );
    expect((await getRow(hot.id)).last_checked_at).not.toBeNull();
  });
});

describe("expirePaymentRequests", () => {
  installJobHooks();

  it("stores expired for a lapsed request with no payment", async () => {
    vi.spyOn(solanaRpc, "getSignaturesForAddress").mockResolvedValue([]);
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const log = vi.spyOn(moneyPathEvents, "logEvent");

    await onSandbox(() => expirePaymentRequests(env));

    expect((await getRow(request.id)).status).toBe("expired");
    expect(log).toHaveBeenCalledWith("info", {
      event: "payment_requests.lane_run",
      environment: "sandbox",
      lane: "expiry",
      checked: 1,
      failed: 0,
      settled: 1,
      blocked: 0,
    });
  });

  it("leaves a lapsed request open while its sponsored transaction can still land", async () => {
    vi.spyOn(solanaRpc, "getSignaturesForAddress").mockResolvedValue([]);
    const live = await createRequest({ token: SOL_MINT, expiresAt: PAST });
    const passed = await createRequest({ token: SOL_MINT, expiresAt: PAST });
    await updateRow(live.id, {
      sponsored_tx_account: "acct",
      sponsored_tx_unsigned: "tx",
      sponsored_tx_last_valid_block_height: "900",
    });
    await updateRow(passed.id, {
      sponsored_tx_account: "acct",
      sponsored_tx_unsigned: "tx",
      sponsored_tx_last_valid_block_height: "849",
    });

    await onSandbox(() => expirePaymentRequests(env));

    expect((await getRow(live.id)).status).toBe("awaiting_payment");
    expect((await getRow(passed.id)).status).toBe("expired");
  });

  it("still runs the late watch, then fails the run, when every expiry check failed", async () => {
    const log = vi.spyOn(moneyPathEvents, "logEvent");
    const lapsed = await createRequest({ token: SOL_MINT, expiresAt: PAST });
    const watched = await createRequest({ token: SOL_MINT, expiresAt: null });
    await updateRow(watched.id, {
      status: "expired",
      expires_at: ago(DAY),
      last_checked_at: PAST,
    });
    vi.spyOn(solanaRpc, "getSignaturesForAddress")
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockResolvedValueOnce([]);

    await expect(onSandbox(() => expirePaymentRequests(env))).rejects.toThrow(
      /expiry lane: all 1 checks failed/
    );

    expect((await getRow(lapsed.id)).last_checked_at).not.toBeNull();
    expect((await getRow(watched.id)).last_checked_at).not.toBe(PAST);
    expect(log).toHaveBeenCalledWith("info", {
      event: "payment_requests.lane_run",
      environment: "sandbox",
      lane: "late_watch",
      checked: 1,
      failed: 0,
      settled: 0,
      blocked: 0,
    });
  });

  it("fails the run when every late-watch check failed", async () => {
    const watched = await createRequest({ token: SOL_MINT, expiresAt: null });
    await updateRow(watched.id, {
      status: "expired",
      expires_at: ago(DAY),
      last_checked_at: PAST,
    });
    vi.spyOn(solanaRpc, "getSignaturesForAddress").mockRejectedValue(new Error("rpc down"));

    await expect(onSandbox(() => expirePaymentRequests(env))).rejects.toThrow(
      /late_watch lane: all 1 checks failed/
    );
  });

  it("stops watching an expired request after the late-payment window", async () => {
    const findReference = vi.spyOn(solanaRpc, "getSignaturesForAddress").mockResolvedValue([]);
    const outside = await createRequest({ token: SOL_MINT, expiresAt: null });
    const inside = await createRequest({ token: SOL_MINT, expiresAt: null });
    await updateRow(outside.id, {
      status: "expired",
      expires_at: ago(8 * DAY),
      last_checked_at: PAST,
    });
    await updateRow(inside.id, {
      status: "expired",
      expires_at: ago(6 * DAY),
      last_checked_at: PAST,
    });

    await onSandbox(() => expirePaymentRequests(env));

    expect(findReference).toHaveBeenCalledTimes(1);
    expect((await getRow(inside.id)).last_checked_at).not.toBe(PAST);
    expect((await getRow(outside.id)).last_checked_at).toBe(PAST);
  });

  it("logs the expiry backlog when lapsed rows go unchecked", async () => {
    const log = vi.spyOn(moneyPathEvents, "logEvent");
    vi.spyOn(solanaRpc, "getSignaturesForAddress").mockResolvedValue([]);
    const stale = await createRequest({ token: SOL_MINT, expiresAt: PAST });
    await createRequest({ token: SOL_MINT, expiresAt: ago(MINUTE) });
    await updateRow(stale.id, { last_checked_at: ago(DAY) });

    await onSandbox(() => expirePaymentRequests(env));

    expect(log).toHaveBeenCalledWith("warn", {
      event: "payment_requests.expiry_backlog",
      environment: "sandbox",
      stale: 1,
    });
  });

  it("does not report an expiry backlog for lapses checked recently", async () => {
    const log = vi.spyOn(moneyPathEvents, "logEvent");
    vi.spyOn(solanaRpc, "getSignaturesForAddress").mockResolvedValue([]);
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });
    await updateRow(request.id, { last_checked_at: ago(MINUTE), last_verified_at: ago(MINUTE) });

    await onSandbox(() => expirePaymentRequests(env));

    expect(log).not.toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({ event: "payment_requests.expiry_backlog" })
    );
  });

  it("logs the late-watch backlog when expired rows go unchecked", async () => {
    const log = vi.spyOn(moneyPathEvents, "logEvent");
    vi.spyOn(solanaRpc, "getSignaturesForAddress").mockResolvedValue([]);
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    await updateRow(request.id, {
      status: "expired",
      expires_at: ago(DAY),
      last_checked_at: PAST,
      last_verified_at: PAST,
    });

    await onSandbox(() => expirePaymentRequests(env));

    expect(log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({ event: "payment_requests.late_watch_backlog", stale: 1 })
    );
  });
});
