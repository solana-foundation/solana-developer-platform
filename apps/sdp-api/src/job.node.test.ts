import * as Sentry from "@sentry/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEarnCatalogueSyncIfDue } from "@/cron/earn-catalogue-sync";
import { closeDatabasePools } from "@/db/client";
import { getProcessEnv } from "@/lib/runtime-env";
import { closeAllRedisClients } from "@/runtime/kv-redis";
import { isSentryEnabled } from "@/runtime/observability";
import { nodeObservability } from "@/runtime/observability-node";
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

vi.mock("@/db/client", () => ({
  closeDatabasePools: vi.fn(async () => {}),
}));

vi.mock("@/lib/runtime-env", () => ({
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

  it("runs only the ungated pair when the Earn flags are off", async () => {
    await runCronJob();

    expect(trackPendingTransfers).toHaveBeenCalledTimes(1);
    expect(recoverApprovedWalletOperations).toHaveBeenCalledTimes(1);
    expect(runEarnCatalogueSyncIfDue).not.toHaveBeenCalled();
    expect(closeDatabasePools).toHaveBeenCalledTimes(1);
    expect(closeAllRedisClients).toHaveBeenCalledTimes(1);
    expect(Sentry.close).toHaveBeenCalledTimes(1);
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

    // The job-level monitor wraps only the ungated pair, exactly as before.
    expect(nodeObservability.withMonitor).toHaveBeenCalledExactlyOnceWith(
      "sdp-api-track-pending-transfers",
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

    expect(runEarnCatalogueSyncIfDue).not.toHaveBeenCalled();
    expect(closeDatabasePools).toHaveBeenCalledTimes(1);
  });
});
