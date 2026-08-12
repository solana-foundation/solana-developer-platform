import * as Sentry from "@sentry/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEarnCatalogueSyncIfDue } from "@/cron/earn-catalogue-sync";
import { closeDatabasePools } from "@/db/client";
import { getProcessEnv } from "@/lib/runtime-env";
import { closeAllRedisClients } from "@/runtime/kv-redis";
import { isSentryEnabled } from "@/runtime/observability";
import { nodeObservability } from "@/runtime/observability-node";
import { retireOrphanedActionSecrets } from "@/services/jobs/retire-workflow-secrets";
import { runDueWorkflowExecutions } from "@/services/jobs/run-workflow-executions";
import { trackPendingTransfers } from "@/services/jobs/track-pending-transfers";
import { recoverApprovedWalletOperations } from "@/services/policy/approved-operation-replay";
import type { Env } from "@/types/env";
import { runCronJob } from "./job";

vi.mock("@sentry/node", () => ({
  close: vi.fn(async () => true),
}));

vi.mock("@/cron/earn-catalogue-sync", () => ({
  runEarnCatalogueSyncIfDue: vi.fn(async () => "synced"),
}));

// Literal constants keep the heavy service graph behind pending-transfers out
// of this test's module graph (same reason runner.node.test.ts mocks it).
vi.mock("@/cron/pending-transfers", () => ({
  PENDING_TRANSFERS_CRON: "* * * * *",
  PENDING_TRANSFERS_MONITOR: "sdp-api-track-pending-transfers",
}));

vi.mock("@/cron/workflow-executions", () => ({
  WORKFLOW_EXECUTIONS_CRON: "* * * * *",
  WORKFLOW_EXECUTIONS_MONITOR: "sdp-api-run-workflow-executions",
}));

vi.mock("@/cron/workflow-secret-retirements", () => ({
  WORKFLOW_SECRET_RETIREMENTS_CRON: "*/5 * * * *",
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

vi.mock("@/services/jobs/track-pending-transfers", () => ({
  trackPendingTransfers: vi.fn(async () => {}),
}));

vi.mock("@/services/policy/approved-operation-replay", () => ({
  recoverApprovedWalletOperations: vi.fn(async () => {}),
}));

function makeEnv(overrides: Partial<Record<keyof Env, string>> = {}): Env {
  return {
    DATABASE_URL: "postgres://unit",
    REDIS_URL: "redis://unit",
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
    vi.mocked(runEarnCatalogueSyncIfDue).mockReset().mockResolvedValue("synced");
    vi.mocked(runDueWorkflowExecutions)
      .mockReset()
      .mockResolvedValue(undefined as never);
    vi.mocked(retireOrphanedActionSecrets).mockReset().mockResolvedValue({ retired: 0, failed: 0 });
    vi.mocked(nodeObservability.withMonitor)
      .mockReset()
      .mockImplementation((_slug, fn) => fn());
    vi.mocked(closeDatabasePools).mockClear();
    vi.mocked(closeAllRedisClients).mockClear();
    vi.mocked(Sentry.close).mockClear();
  });

  it("fails fast when DATABASE_URL or REDIS_URL is missing", async () => {
    vi.mocked(getProcessEnv).mockReturnValue({ REDIS_URL: "redis://unit" } as Env);
    await expect(runCronJob()).rejects.toThrow(/DATABASE_URL is required/);

    vi.mocked(getProcessEnv).mockReturnValue({ DATABASE_URL: "postgres://unit" } as Env);
    await expect(runCronJob()).rejects.toThrow(/REDIS_URL is required/);

    expect(trackPendingTransfers).not.toHaveBeenCalled();
  });

  it("runs the ungated pair and the workflow tick when the Earn flags are off", async () => {
    await runCronJob();

    expect(trackPendingTransfers).toHaveBeenCalledTimes(1);
    expect(recoverApprovedWalletOperations).toHaveBeenCalledTimes(1);
    // Managed deployments always have asset profiles on, so the workflow tick runs.
    expect(runDueWorkflowExecutions).toHaveBeenCalledTimes(1);
    expect(runEarnCatalogueSyncIfDue).not.toHaveBeenCalled();
    expect(closeDatabasePools).toHaveBeenCalledTimes(1);
    expect(closeAllRedisClients).toHaveBeenCalledTimes(1);
    expect(Sentry.close).toHaveBeenCalledTimes(1);
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

    vi.mocked(getProcessEnv).mockReturnValue(makeEnv({ EARN_ENABLED: "true" }));
    await runCronJob();
    expect(runEarnCatalogueSyncIfDue).not.toHaveBeenCalled();
  });

  it("runs the earn tick after the ungated pair when both flags are on", async () => {
    const env = makeEnv({ MARKETS_ENABLED: "true", EARN_ENABLED: "true" });
    vi.mocked(getProcessEnv).mockReturnValue(env);

    await runCronJob();

    // Sentry disabled: no observability handed to the earn tick.
    expect(runEarnCatalogueSyncIfDue).toHaveBeenCalledExactlyOnceWith(env, undefined);
    const pairOrder = vi.mocked(recoverApprovedWalletOperations).mock.invocationCallOrder[0];
    const earnOrder = vi.mocked(runEarnCatalogueSyncIfDue).mock.invocationCallOrder[0];
    expect(earnOrder).toBeGreaterThan(pairOrder);
  });

  it("hands the earn tick its own observability while the pair keeps the transfers monitor", async () => {
    const env = makeEnv({ MARKETS_ENABLED: "true", EARN_ENABLED: "true" });
    vi.mocked(getProcessEnv).mockReturnValue(env);
    vi.mocked(isSentryEnabled).mockReturnValue(true);

    await runCronJob();

    // The pair keeps the transfers monitor; the workflow tick and the retirement sweep
    // each report to their own, so neither masquerades as a reconciliation failure.
    expect(nodeObservability.withMonitor).toHaveBeenCalledTimes(3);
    expect(nodeObservability.withMonitor).toHaveBeenCalledWith(
      "sdp-api-retire-workflow-secrets",
      expect.any(Function),
      { schedule: { type: "crontab", value: "*/5 * * * *" } }
    );
    expect(nodeObservability.withMonitor).toHaveBeenCalledWith(
      "sdp-api-track-pending-transfers",
      expect.any(Function),
      { schedule: { type: "crontab", value: "* * * * *" } }
    );
    expect(nodeObservability.withMonitor).toHaveBeenCalledWith(
      "sdp-api-run-workflow-executions",
      expect.any(Function),
      { schedule: { type: "crontab", value: "* * * * *" } }
    );
    // The earn tick monitors itself (EARN_CATALOGUE_SYNC_MONITOR) inside
    // runEarnCatalogueSyncIfDue — the job just passes observability through.
    expect(runEarnCatalogueSyncIfDue).toHaveBeenCalledExactlyOnceWith(env, nodeObservability);
  });

  it("fails the job on an earn error but still releases pools and clients", async () => {
    vi.mocked(getProcessEnv).mockReturnValue(
      makeEnv({ MARKETS_ENABLED: "true", EARN_ENABLED: "true" })
    );
    vi.mocked(runEarnCatalogueSyncIfDue).mockRejectedValue(new Error("sync exploded"));

    await expect(runCronJob()).rejects.toThrow("sync exploded");

    expect(trackPendingTransfers).toHaveBeenCalledTimes(1);
    expect(closeDatabasePools).toHaveBeenCalledTimes(1);
    expect(closeAllRedisClients).toHaveBeenCalledTimes(1);
    expect(Sentry.close).toHaveBeenCalledTimes(1);
  });

  it("skips the earn tick when reconciliation itself fails", async () => {
    vi.mocked(getProcessEnv).mockReturnValue(
      makeEnv({ MARKETS_ENABLED: "true", EARN_ENABLED: "true" })
    );
    vi.mocked(trackPendingTransfers).mockRejectedValue(new Error("reconciliation down"));

    await expect(runCronJob()).rejects.toThrow("reconciliation down");

    expect(runDueWorkflowExecutions).not.toHaveBeenCalled();
    expect(runEarnCatalogueSyncIfDue).not.toHaveBeenCalled();
    expect(closeDatabasePools).toHaveBeenCalledTimes(1);
  });
});
