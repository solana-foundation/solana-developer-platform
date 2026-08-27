import * as Sentry from "@sentry/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEarnCatalogueSyncIfDue } from "@/cron/earn-catalogue-sync";
import { runEarnMetricsRefreshTick } from "@/cron/earn-metrics-refresh";
import { closeDatabasePools } from "@/db/client";
import { getProcessEnv } from "@/lib/runtime-env";
import { closeAllRedisClients } from "@/runtime/kv-redis";
import { isSentryEnabled } from "@/runtime/observability";
import { nodeObservability } from "@/runtime/observability-node";
import { collectDueRecurringPayments } from "@/services/jobs/collect-recurring-payments";
import { pollRingsIndexing } from "@/services/jobs/poll-rings-indexing";
import { reconcileEarnVaultMovements } from "@/services/jobs/reconcile-earn-vault-movements";
import { reconcileSponsorshipBudgets } from "@/services/jobs/reconcile-sponsorship-budgets";
import { retireOrphanedActionSecrets } from "@/services/jobs/retire-workflow-secrets";
import { runDueWorkflowExecutions } from "@/services/jobs/run-workflow-executions";
import { trackPendingDeposits } from "@/services/jobs/track-pending-deposits";
import { trackPendingTransfers } from "@/services/jobs/track-pending-transfers";
import { trackPendingWithdrawals } from "@/services/jobs/track-pending-withdrawals";
import { recoverApprovedWalletOperations } from "@/services/policy/approved-operation-replay";
import type { Env } from "@/types/env";
import {
  describeCronFailure,
  getManagedMonitorSlug,
  getManagedReconciliationCron,
  runCronJob,
} from "./job";

vi.mock("@sentry/node", () => ({
  close: vi.fn(async () => true),
}));

vi.mock("@/cron/earn-catalogue-sync", () => ({
  EARN_CATALOGUE_SYNC_MONITOR: "sdp-api-sync-earn-catalogue",
  runEarnCatalogueSyncIfDue: vi.fn(async () => "synced"),
}));

// MUST be mocked, like its sibling above: the real implementation walks
// EARN_PROVIDER_CLIENTS and Kamino's client reaches api.kamino.finance with no
// credential to stop it. Unmocked, the flags-on cases below fetched the live
// mainnet shelf and then attempted an UPDATE per vault against the fake
// `postgres://unit` — a unit test whose runtime depended on a third party's
// uptime, silent because both the job's `.catch` and the refresh's per-row
// catch swallow the failures.
vi.mock("@/cron/earn-metrics-refresh", () => ({
  EARN_METRICS_REFRESH_MONITOR: "sdp-api-refresh-earn-metrics",
  runEarnMetricsRefreshTick: vi.fn(async () => {}),
}));

vi.mock("@/cron/earn-vault-movements", () => ({
  EARN_VAULT_MOVEMENTS_MONITOR: "sdp-api-reconcile-earn-vault-movements",
}));

// Literal constants keep the heavy service graph behind pending-transfers out
// of this test's module graph (same reason runner.node.test.ts mocks it).
vi.mock("@/cron/pending-transfers", () => ({
  PENDING_TRANSFERS_MONITOR: "sdp-api-track-pending-transfers",
}));

vi.mock("@/cron/pending-deposits", () => ({
  PENDING_DEPOSITS_MONITOR: "sdp-api-track-pending-deposits",
}));

vi.mock("@/cron/pending-withdrawals", () => ({
  PENDING_WITHDRAWALS_MONITOR: "sdp-api-track-pending-withdrawals",
}));

vi.mock("@/cron/recurring-payments", () => ({
  RECURRING_PAYMENTS_COLLECTION_MONITOR: "sdp-api-collect-recurring-payments",
}));

vi.mock("@/cron/rings-indexing", () => ({
  RINGS_INDEXING_MONITOR: "sdp-api-poll-rings-indexing",
}));

vi.mock("@/cron/workflow-executions", () => ({
  WORKFLOW_EXECUTIONS_MONITOR: "sdp-api-run-workflow-executions",
}));

vi.mock("@/cron/workflow-secret-retirements", () => ({
  WORKFLOW_SECRET_RETIREMENTS_MONITOR: "sdp-api-retire-workflow-secrets",
}));

vi.mock("@/db/client", () => ({
  closeDatabasePools: vi.fn(async () => {}),
}));

// `isAssetProfilesEnabled` (real, via feature-flags) needs the real
// `isSelfHostedDeployment`; only the env lookup itself is stubbed.
vi.mock("@/lib/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runtime-env")>()),
  getProcessEnv: vi.fn(),
}));

vi.mock("@/runtime/kv-redis", () => ({
  closeAllRedisClients: vi.fn(async () => {}),
}));

vi.mock("@/runtime/observability", () => ({
  getSentryOptions: vi.fn(() => ({})),
  isSentryEnabled: vi.fn(() => false),
}));

vi.mock("@/runtime/observability-node", () => ({
  initNodeSentry: vi.fn(),
  nodeObservability: {
    captureException: vi.fn(),
    captureCheckIn: vi.fn((checkIn: { monitorSlug: string; status: string }) =>
      checkIn.status === "in_progress" ? `check-in:${checkIn.monitorSlug}` : checkIn.monitorSlug
    ),
    withScope: vi.fn(),
    withMonitor: vi.fn((_slug: string, fn: () => Promise<unknown>) => fn()),
  },
}));

vi.mock("@/services/jobs/retire-workflow-secrets", () => ({
  retireOrphanedActionSecrets: vi.fn(async () => ({ retired: 0, failed: 0 })),
}));

vi.mock("@/services/jobs/run-workflow-executions", () => ({
  runDueWorkflowExecutions: vi.fn(async () => {}),
}));

vi.mock("@/services/jobs/collect-recurring-payments", () => ({
  collectDueRecurringPayments: vi.fn(async () => {}),
}));

vi.mock("@/services/jobs/poll-rings-indexing", () => ({
  pollRingsIndexing: vi.fn(async () => {}),
}));

vi.mock("@/services/jobs/track-pending-deposits", () => ({
  trackPendingDeposits: vi.fn(async () => {}),
}));

vi.mock("@/services/jobs/track-pending-transfers", () => ({
  trackPendingTransfers: vi.fn(async () => {}),
}));

vi.mock("@/services/jobs/track-pending-withdrawals", () => ({
  trackPendingWithdrawals: vi.fn(async () => {}),
}));

vi.mock("@/services/jobs/reconcile-sponsorship-budgets", () => ({
  reconcileSponsorshipBudgets: vi.fn(async () => {}),
}));

vi.mock("@/services/jobs/reconcile-earn-vault-movements", () => ({
  reconcileEarnVaultMovements: vi.fn(async () => {}),
}));

vi.mock("@/services/policy/approved-operation-replay", () => ({
  recoverApprovedWalletOperations: vi.fn(async () => {}),
}));

function makeEnv(overrides: Partial<Record<keyof Env, string>> = {}): Env {
  return {
    DATABASE_URL: "postgres://unit",
    REDIS_URL: "redis://unit",
    SIGNING_PROVIDER: "coinbase_cdp",
    CUSTODY_KMS_KEY_NAME: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
    SDP_MANAGED_RECONCILIATION_CRON: "*/3 * * * *",
    SDP_MANAGED_RECONCILIATION_TIMEOUT_SECONDS: "120",
    ...overrides,
  } as Env;
}

describe("runCronJob", () => {
  beforeEach(() => {
    vi.mocked(getProcessEnv).mockReset().mockReturnValue(makeEnv());
    vi.mocked(isSentryEnabled).mockReset().mockReturnValue(false);
    vi.mocked(trackPendingTransfers)
      .mockReset()
      .mockResolvedValue(undefined as never);
    vi.mocked(recoverApprovedWalletOperations)
      .mockReset()
      .mockResolvedValue(undefined as never);
    vi.mocked(reconcileSponsorshipBudgets)
      .mockReset()
      .mockResolvedValue(undefined as never);
    vi.mocked(collectDueRecurringPayments)
      .mockReset()
      .mockResolvedValue({ recovered: 0, collected: 0, failed: 0, skipped: 0 });
    vi.mocked(pollRingsIndexing).mockReset().mockResolvedValue(undefined);
    vi.mocked(trackPendingDeposits).mockReset().mockResolvedValue(undefined);
    vi.mocked(trackPendingWithdrawals).mockReset().mockResolvedValue(undefined);
    vi.mocked(reconcileEarnVaultMovements).mockReset().mockResolvedValue(undefined);
    vi.mocked(runEarnCatalogueSyncIfDue).mockReset().mockResolvedValue("synced");
    vi.mocked(runEarnMetricsRefreshTick).mockReset().mockResolvedValue(undefined);
    vi.mocked(runDueWorkflowExecutions)
      .mockReset()
      .mockResolvedValue(undefined as never);
    vi.mocked(retireOrphanedActionSecrets).mockReset().mockResolvedValue({ retired: 0, failed: 0 });
    vi.mocked(nodeObservability.withMonitor)
      .mockReset()
      .mockImplementation((_slug, fn) => fn());
    vi.mocked(nodeObservability.captureCheckIn)
      .mockReset()
      .mockImplementation((checkIn) =>
        checkIn.status === "in_progress" ? `check-in:${checkIn.monitorSlug}` : checkIn.monitorSlug
      );
    vi.mocked(closeDatabasePools).mockClear();
    vi.mocked(closeAllRedisClients).mockClear();
    vi.mocked(Sentry.close).mockClear();
  });

  it("refuses to run when a managed deployment has no custody KMS key", async () => {
    vi.mocked(getProcessEnv).mockReturnValue({
      DATABASE_URL: "postgres://unit",
      REDIS_URL: "redis://unit",
      SIGNING_PROVIDER: "coinbase_cdp",
    } as Env);
    await expect(runCronJob()).rejects.toThrow(/CUSTODY_KMS_KEY_NAME is required/);
  });

  it("refuses to run when a managed deployment would sign with a platform-held key", async () => {
    vi.mocked(getProcessEnv).mockReturnValue(makeEnv({ SIGNING_PROVIDER: "local" }));
    await expect(runCronJob()).rejects.toThrow(/Local signing/);
  });

  it("runs a self-hosted deployment without a custody KMS key", async () => {
    vi.mocked(getProcessEnv).mockReturnValue(
      makeEnv({
        CUSTODY_KMS_KEY_NAME: "",
        SDP_DEPLOYMENT_MODE: "self_hosted",
      })
    );
    await expect(runCronJob()).resolves.toBeUndefined();
  });

  it("fails fast when DATABASE_URL or REDIS_URL is missing", async () => {
    vi.mocked(getProcessEnv).mockReturnValue({ REDIS_URL: "redis://unit" } as Env);
    await expect(runCronJob()).rejects.toThrow(/DATABASE_URL is required/);

    vi.mocked(getProcessEnv).mockReturnValue({ DATABASE_URL: "postgres://unit" } as Env);
    await expect(runCronJob()).rejects.toThrow(/REDIS_URL is required/);

    expect(trackPendingTransfers).not.toHaveBeenCalled();
    expect(reconcileSponsorshipBudgets).not.toHaveBeenCalled();
  });

  it("fails fast when the Managed Reconciliation Cadence is missing, invalid, or cannot run the hourly task", async () => {
    vi.mocked(getProcessEnv).mockReturnValue(makeEnv({ SDP_MANAGED_RECONCILIATION_CRON: "" }));
    await expect(runCronJob()).rejects.toThrow(/SDP_MANAGED_RECONCILIATION_CRON is required/);

    for (const invalid of ["not a crontab", "0 */3 * * * *", "0 */3 * * *", "7,19,43 * * * *"]) {
      vi.mocked(getProcessEnv).mockReturnValue(
        makeEnv({ SDP_MANAGED_RECONCILIATION_CRON: invalid })
      );
      await expect(runCronJob()).rejects.toThrow(
        /SDP_MANAGED_RECONCILIATION_CRON must (?:be a valid crontab|run at least once every 5 minutes)/
      );
    }

    expect(trackPendingTransfers).not.toHaveBeenCalled();
    expect(reconcileSponsorshipBudgets).not.toHaveBeenCalled();
  });

  it("accepts a managed cadence at the exact five-minute gap boundary", () => {
    expect(getManagedReconciliationCron({ SDP_MANAGED_RECONCILIATION_CRON: "*/5 * * * *" })).toBe(
      "*/5 * * * *"
    );
  });

  it.each([
    ["hour", "*/5 0 * * *"],
    ["day of month", "*/5 * 1 * *"],
    ["month", "*/5 * * 1 *"],
    ["day of week", "*/5 * * * 1"],
  ])("rejects a managed cadence restricted by %s", (_field, cron) => {
    expect(() => getManagedReconciliationCron({ SDP_MANAGED_RECONCILIATION_CRON: cron })).toThrow(
      /must run at least once every 5 minutes of every hour/
    );
  });

  it("creates a managed slug for a monitor without the API prefix", () => {
    expect(getManagedMonitorSlug("custom-reconciler")).toBe("sdp-api-managed-custom-reconciler");
  });

  it("fails fast when the managed job timeout is missing or invalid", async () => {
    for (const invalid of ["", "zero", "0", "-1", "Infinity"]) {
      vi.mocked(getProcessEnv).mockReturnValue(
        makeEnv({ SDP_MANAGED_RECONCILIATION_TIMEOUT_SECONDS: invalid })
      );
      await expect(runCronJob()).rejects.toThrow(
        /SDP_MANAGED_RECONCILIATION_TIMEOUT_SECONDS must be a positive number/
      );
    }

    expect(trackPendingTransfers).not.toHaveBeenCalled();
  });

  it("runs the ungated ticks — recurring collection included — when every flag is off", async () => {
    const env = makeEnv();
    vi.mocked(getProcessEnv).mockReturnValue(env);

    await runCronJob();

    expect(trackPendingTransfers).toHaveBeenCalledTimes(1);
    expect(recoverApprovedWalletOperations).toHaveBeenCalledTimes(1);
    expect(reconcileSponsorshipBudgets).toHaveBeenCalledTimes(1);
    // Recurring payments are an always-on product surface: the collection tick
    // is deliberately behind no flag.
    expect(collectDueRecurringPayments).toHaveBeenCalledExactlyOnceWith(env);
    // The rings poll gates itself on the flag plus the http adapter, so the job
    // hands it every tick — this is its only tick on a managed deployment.
    expect(pollRingsIndexing).toHaveBeenCalledExactlyOnceWith(env);
    expect(reconcileEarnVaultMovements).toHaveBeenCalledTimes(1);
    // Managed deployments always have asset profiles on, so the workflow tick runs.
    expect(runDueWorkflowExecutions).toHaveBeenCalledTimes(1);
    expect(runEarnCatalogueSyncIfDue).not.toHaveBeenCalled();
    expect(trackPendingDeposits).not.toHaveBeenCalled();
    expect(trackPendingWithdrawals).not.toHaveBeenCalled();
    expect(closeDatabasePools).toHaveBeenCalledTimes(1);
    expect(closeAllRedisClients).toHaveBeenCalledTimes(1);
    expect(Sentry.close).toHaveBeenCalledTimes(1);
  });

  it("fails the job on a recurring-collection error but still releases pools", async () => {
    vi.mocked(collectDueRecurringPayments).mockRejectedValue(new Error("collection down"));

    await expect(runCronJob()).rejects.toThrow("collection down");

    expect(closeDatabasePools).toHaveBeenCalledTimes(1);
    expect(closeAllRedisClients).toHaveBeenCalledTimes(1);
  });

  it("fails the job on a rings-poll error but still runs the ticks after it", async () => {
    vi.mocked(pollRingsIndexing).mockRejectedValue(new Error("photon down"));

    await expect(runCronJob()).rejects.toThrow("photon down");

    expect(reconcileEarnVaultMovements).toHaveBeenCalledTimes(1);
    expect(runDueWorkflowExecutions).toHaveBeenCalledTimes(1);
    expect(closeDatabasePools).toHaveBeenCalledTimes(1);
  });

  it("runs both private-channel reconcilers behind the flag", async () => {
    const env = makeEnv({ PRIVATE_CHANNELS_ENABLED: "true" });
    vi.mocked(getProcessEnv).mockReturnValue(env);

    await runCronJob();

    expect(trackPendingDeposits).toHaveBeenCalledExactlyOnceWith(env);
    expect(trackPendingWithdrawals).toHaveBeenCalledExactlyOnceWith(env);
  });

  // The reconcilers are siblings: a failing deposits leg must never skip the
  // withdrawals leg (or vice versa), only fail the job after both settle.
  it("still reconciles withdrawals when deposit tracking fails", async () => {
    vi.mocked(getProcessEnv).mockReturnValue(makeEnv({ PRIVATE_CHANNELS_ENABLED: "true" }));
    vi.mocked(trackPendingDeposits).mockRejectedValue(new Error("deposits down"));

    await expect(runCronJob()).rejects.toThrow("deposits down");

    expect(trackPendingWithdrawals).toHaveBeenCalledTimes(1);
    expect(closeDatabasePools).toHaveBeenCalledTimes(1);
  });

  it("registers every managed tick before work with deployment cadence and timeout", async () => {
    vi.mocked(getProcessEnv).mockReturnValue(makeEnv({ PRIVATE_CHANNELS_ENABLED: "true" }));
    vi.mocked(isSentryEnabled).mockReturnValue(true);

    await runCronJob();

    const starts = vi
      .mocked(nodeObservability.captureCheckIn)
      .mock.calls.filter(([checkIn]) => checkIn.status === "in_progress");
    expect(starts.map(([checkIn]) => checkIn.monitorSlug)).toEqual([
      "sdp-api-managed-track-pending-transfers",
      "sdp-api-managed-collect-recurring-payments",
      "sdp-api-managed-track-pending-deposits",
      "sdp-api-managed-track-pending-withdrawals",
      "sdp-api-managed-poll-rings-indexing",
      "sdp-api-managed-reconcile-earn-vault-movements",
      "sdp-api-managed-run-workflow-executions",
      "sdp-api-managed-retire-workflow-secrets",
      "sdp-api-managed-refresh-earn-metrics",
    ]);
    for (const [, config] of starts) {
      expect(config).toEqual({
        schedule: { type: "crontab", value: "*/3 * * * *" },
        checkinMargin: 4,
        maxRuntime: 2,
      });
    }

    const lastStartOrder = Math.max(
      ...vi
        .mocked(nodeObservability.captureCheckIn)
        .mock.invocationCallOrder.slice(0, starts.length)
    );
    expect(lastStartOrder).toBeLessThan(
      vi.mocked(trackPendingTransfers).mock.invocationCallOrder[0]
    );
  });

  it("completes feature-disabled monitors as successful no-ops", async () => {
    vi.mocked(getProcessEnv).mockReturnValue(
      makeEnv({
        SDP_DEPLOYMENT_MODE: "self_hosted",
        PRIVATE_CHANNELS_ENABLED: "false",
        MARKETS_ENABLED: "false",
        EARN_ENABLED: "false",
      })
    );
    vi.mocked(isSentryEnabled).mockReturnValue(true);

    await runCronJob();

    for (const monitorSlug of [
      "sdp-api-managed-track-pending-deposits",
      "sdp-api-managed-track-pending-withdrawals",
      "sdp-api-managed-run-workflow-executions",
      "sdp-api-managed-refresh-earn-metrics",
    ]) {
      expect(nodeObservability.captureCheckIn).toHaveBeenCalledWith({
        monitorSlug,
        status: "ok",
        checkInId: `check-in:${monitorSlug}`,
      });
    }
    expect(trackPendingDeposits).not.toHaveBeenCalled();
    expect(trackPendingWithdrawals).not.toHaveBeenCalled();
    expect(runDueWorkflowExecutions).not.toHaveBeenCalled();
    expect(runEarnMetricsRefreshTick).not.toHaveBeenCalled();
    expect(runEarnCatalogueSyncIfDue).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), {
      workEnabled: false,
    });
  });

  it("completes managed check-ins by ID with each tick's outcome", async () => {
    vi.mocked(getProcessEnv).mockReturnValue(makeEnv());
    vi.mocked(isSentryEnabled).mockReturnValue(true);
    vi.mocked(collectDueRecurringPayments).mockRejectedValue(new Error("collection down"));

    await expect(runCronJob()).rejects.toThrow("collection down");

    expect(nodeObservability.captureCheckIn).toHaveBeenCalledWith({
      monitorSlug: "sdp-api-managed-collect-recurring-payments",
      status: "error",
      checkInId: "check-in:sdp-api-managed-collect-recurring-payments",
    });
    expect(nodeObservability.captureCheckIn).toHaveBeenCalledWith({
      monitorSlug: "sdp-api-managed-poll-rings-indexing",
      status: "ok",
      checkInId: "check-in:sdp-api-managed-poll-rings-indexing",
    });
    expect(pollRingsIndexing).toHaveBeenCalledTimes(1);
  });

  it("skips the workflow tick on a self-hosted deployment without the asset-profiles flag", async () => {
    vi.mocked(getProcessEnv).mockReturnValue(makeEnv({ SDP_DEPLOYMENT_MODE: "self_hosted" }));

    await runCronJob();

    expect(runDueWorkflowExecutions).not.toHaveBeenCalled();
    expect(trackPendingTransfers).toHaveBeenCalledTimes(1);
  });

  // This job is the ONLY tick a Cloud Run deployment gets — the in-process scheduler
  // returns null under K_SERVICE — and Cloud Run is also where GCP Secret Manager is the
  // default backend, so it is exactly where retirements are queued. Omitting the sweep
  // here left every queued version orphaned in managed production, readable forever.
  it("sweeps secret retirements, and does so behind no flag", async () => {
    const env = makeEnv();
    vi.mocked(getProcessEnv).mockReturnValue(env);

    await runCronJob();

    expect(retireOrphanedActionSecrets).toHaveBeenCalledExactlyOnceWith(env);

    // …and still when the feature that fills the queue is off: the rows outlive it.
    const selfHosted = makeEnv({ SDP_DEPLOYMENT_MODE: "self_hosted" });
    vi.mocked(getProcessEnv).mockReturnValue(selfHosted);
    vi.mocked(retireOrphanedActionSecrets).mockClear();
    // Cleared too, or the managed run above would still count against the assertion that
    // the gated tick stays off.
    vi.mocked(runDueWorkflowExecutions).mockClear();

    await runCronJob();

    expect(runDueWorkflowExecutions).not.toHaveBeenCalled();
    expect(retireOrphanedActionSecrets).toHaveBeenCalledExactlyOnceWith(selfHosted);
  });

  // The sweep is cleanup, not the reconciliation this job exists for. A queued row is
  // never abandoned, so the next run retries it — failing the whole job instead would
  // strand the transfer reconciliation that already succeeded.
  it("does not fail the job when the retirement sweep throws", async () => {
    vi.mocked(retireOrphanedActionSecrets).mockRejectedValue(new Error("secret store down"));

    await expect(runCronJob()).resolves.toBeUndefined();

    expect(trackPendingTransfers).toHaveBeenCalledTimes(1);
    expect(closeDatabasePools).toHaveBeenCalledTimes(1);
  });

  it("requires both flags — the parent flag alone never runs the earn tick", async () => {
    vi.mocked(getProcessEnv).mockReturnValue(makeEnv({ MARKETS_ENABLED: "true" }));
    await runCronJob();
    expect(runEarnCatalogueSyncIfDue).not.toHaveBeenCalled();
    expect(runEarnMetricsRefreshTick).not.toHaveBeenCalled();

    vi.mocked(getProcessEnv).mockReturnValue(makeEnv({ EARN_ENABLED: "true" }));
    await runCronJob();
    expect(runEarnCatalogueSyncIfDue).not.toHaveBeenCalled();
    expect(runEarnMetricsRefreshTick).not.toHaveBeenCalled();
  });

  it("runs the earn tick after the ungated pair when both flags are on", async () => {
    const env = makeEnv({ MARKETS_ENABLED: "true", EARN_ENABLED: "true" });
    vi.mocked(getProcessEnv).mockReturnValue(env);

    await runCronJob();

    // Sentry disabled: no observability handed to the earn tick.
    expect(runEarnCatalogueSyncIfDue).toHaveBeenCalledExactlyOnceWith(env, undefined);
    const pairOrder = vi.mocked(reconcileSponsorshipBudgets).mock.invocationCallOrder[0];
    const earnOrder = vi.mocked(runEarnCatalogueSyncIfDue).mock.invocationCallOrder[0];
    expect(earnOrder).toBeGreaterThan(pairOrder);
  });

  it("refreshes metrics on every tick, before the slot-gated catalogue sync", async () => {
    // The refresh is deliberately unslotted — the Managed Reconciliation
    // Cadence IS its cadence — and ordered first so an unusually slow catalogue pass
    // cannot eat the tick and leave rates stale. Both halves of that are
    // asserted here because neither is visible from the sync's own test.
    const env = makeEnv({ MARKETS_ENABLED: "true", EARN_ENABLED: "true" });
    vi.mocked(getProcessEnv).mockReturnValue(env);

    await runCronJob();

    // Sentry disabled here, so no observability — same shape as the sync.
    expect(runEarnMetricsRefreshTick).toHaveBeenCalledExactlyOnceWith(env, undefined);
    const refreshOrder = vi.mocked(runEarnMetricsRefreshTick).mock.invocationCallOrder[0];
    const syncOrder = vi.mocked(runEarnCatalogueSyncIfDue).mock.invocationCallOrder[0];
    expect(refreshOrder).toBeLessThan(syncOrder);
  });

  it("keeps running the catalogue sync when the metrics refresh throws", async () => {
    // Rates going one tick stale must never stop the catalogue sync, which
    // owns admission and the delist pass.
    const env = makeEnv({ MARKETS_ENABLED: "true", EARN_ENABLED: "true" });
    vi.mocked(getProcessEnv).mockReturnValue(env);
    vi.mocked(runEarnMetricsRefreshTick).mockRejectedValue(new Error("kamino unreachable"));

    await expect(runCronJob()).resolves.toBeUndefined();

    expect(runEarnCatalogueSyncIfDue).toHaveBeenCalledExactlyOnceWith(env, undefined);
  });

  it("uses the managed cadence for metrics and a managed identity for the hourly catalogue", async () => {
    const env = makeEnv({
      MARKETS_ENABLED: "true",
      EARN_ENABLED: "true",
      SDP_MANAGED_RECONCILIATION_CRON: "2-57/5 * * * *",
    });
    vi.mocked(getProcessEnv).mockReturnValue(env);
    vi.mocked(isSentryEnabled).mockReturnValue(true);

    await runCronJob();

    const startedCalls = vi
      .mocked(nodeObservability.captureCheckIn)
      .mock.calls.filter(([checkIn]) => checkIn.status === "in_progress");
    const startedSlugs = startedCalls.map(([checkIn]) => checkIn.monitorSlug);
    expect(startedSlugs).toContain("sdp-api-managed-refresh-earn-metrics");
    for (const [, monitorConfig] of startedCalls) {
      expect(monitorConfig).toMatchObject({ checkinMargin: 4 });
    }
    expect(runEarnMetricsRefreshTick).toHaveBeenCalledExactlyOnceWith(env, undefined);

    const catalogueObservability = vi.mocked(runEarnCatalogueSyncIfDue).mock.calls[0][1];
    expect(catalogueObservability).toBeDefined();
    expect(catalogueObservability).not.toBe(nodeObservability);

    await catalogueObservability?.withMonitor(
      "sdp-api-sync-earn-catalogue",
      async () => undefined,
      { schedule: { type: "crontab", value: "0 * * * *" } }
    );
    expect(nodeObservability.withMonitor).toHaveBeenCalledExactlyOnceWith(
      "sdp-api-managed-sync-earn-catalogue",
      expect.any(Function),
      {
        schedule: { type: "interval", value: 1, unit: "hour" },
        checkinMargin: 10,
        maxRuntime: 2,
      }
    );
  });

  it("fails the job on an earn error but still releases pools and clients", async () => {
    vi.mocked(getProcessEnv).mockReturnValue(
      makeEnv({ MARKETS_ENABLED: "true", EARN_ENABLED: "true" })
    );
    vi.mocked(runEarnCatalogueSyncIfDue).mockRejectedValue(new Error("sync exploded"));

    await expect(runCronJob()).rejects.toThrow("sync exploded");

    expect(trackPendingTransfers).toHaveBeenCalledTimes(1);
    expect(reconcileSponsorshipBudgets).toHaveBeenCalledTimes(1);
    expect(closeDatabasePools).toHaveBeenCalledTimes(1);
    expect(closeAllRedisClients).toHaveBeenCalledTimes(1);
    expect(Sentry.close).toHaveBeenCalledTimes(1);
  });

  // One persistently broken reconciler must never starve the rest: a failing
  // tick is collected, every later tick still runs, and the job fails at the end.
  it("still runs every later tick when reconciliation itself fails", async () => {
    vi.mocked(getProcessEnv).mockReturnValue(
      makeEnv({ MARKETS_ENABLED: "true", EARN_ENABLED: "true" })
    );
    vi.mocked(reconcileSponsorshipBudgets).mockRejectedValue(new Error("sponsorship down"));

    await expect(runCronJob()).rejects.toThrow("sponsorship down");

    expect(reconcileEarnVaultMovements).toHaveBeenCalledTimes(1);
    expect(runDueWorkflowExecutions).toHaveBeenCalledTimes(1);
    expect(retireOrphanedActionSecrets).toHaveBeenCalledTimes(1);
    expect(runEarnCatalogueSyncIfDue).toHaveBeenCalledTimes(1);
    expect(closeDatabasePools).toHaveBeenCalledTimes(1);
  });

  it("aggregates failures from more than one tick without dropping either", async () => {
    vi.mocked(getProcessEnv).mockReturnValue(makeEnv({ PRIVATE_CHANNELS_ENABLED: "true" }));
    vi.mocked(reconcileSponsorshipBudgets).mockRejectedValue(new Error("sponsorship down"));
    vi.mocked(trackPendingDeposits).mockRejectedValue(new Error("deposits down"));

    await expect(runCronJob()).rejects.toMatchObject({
      message: "reconciliation job had multiple tick failures",
      errors: [
        expect.objectContaining({ message: "sponsorship down" }),
        expect.objectContaining({ message: "deposits down" }),
      ],
    });

    expect(trackPendingWithdrawals).toHaveBeenCalledTimes(1);
    expect(reconcileEarnVaultMovements).toHaveBeenCalledTimes(1);
  });

  it("reconciles sponsorship budgets even when pending-transfer tracking fails", async () => {
    vi.mocked(trackPendingTransfers).mockRejectedValue(new Error("transfers down"));

    await expect(runCronJob()).rejects.toThrow("transfers down");

    expect(reconcileSponsorshipBudgets).toHaveBeenCalledTimes(1);
  });

  it("reports every underlying cause when a tick fails on more than one task", () => {
    const failure = new AggregateError(
      [new Error("transfers down"), new Error("sponsorship down")],
      "pending-transfers tick had multiple failures"
    );

    expect(describeCronFailure(failure)).toEqual({
      error: failure,
      causes: [
        { message: "transfers down", stack: expect.any(String) },
        { message: "sponsorship down", stack: expect.any(String) },
      ],
    });
  });

  it("keeps a single failure unchanged", () => {
    const failure = new Error("transfers down");
    expect(describeCronFailure(failure)).toEqual({ error: failure });
  });

  it("describes a rejected non-error value", () => {
    expect(describeCronFailure(new AggregateError(["boom"], "tick"))).toEqual({
      error: expect.any(AggregateError),
      causes: [{ message: "boom" }],
    });
  });

  it("expands nested aggregate failures down to their leaf causes", () => {
    const pendingTransfersTick = new AggregateError(
      [new Error("transfers down"), new Error("sponsorship down")],
      "pending-transfers tick had multiple failures"
    );
    const jobWide = new AggregateError(
      [pendingTransfersTick, new Error("earn vault movements down")],
      "reconciliation job had multiple tick failures"
    );

    expect(describeCronFailure(jobWide)).toEqual({
      error: jobWide,
      causes: [
        {
          message: "pending-transfers tick had multiple failures",
          causes: [
            { message: "transfers down", stack: expect.any(String) },
            { message: "sponsorship down", stack: expect.any(String) },
          ],
        },
        { message: "earn vault movements down", stack: expect.any(String) },
      ],
    });
  });
});
