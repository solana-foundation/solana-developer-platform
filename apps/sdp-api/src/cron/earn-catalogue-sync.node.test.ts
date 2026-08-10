import { SdpEarnError } from "@sdp/earn";
import type {
  EarnRuntimeContext,
  EarnVaultProvider,
  ProviderStrategySnapshot,
} from "@sdp/earn/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Observability } from "@/runtime/observability";
import type { Env } from "@/types/env";
import {
  EARN_CATALOGUE_SYNC_CRON,
  EARN_CATALOGUE_SYNC_MONITOR,
  EARN_CATALOGUE_SYNC_SLOT_TTL_SECONDS,
  runEarnCatalogueSyncIfDue,
} from "./earn-catalogue-sync";

// Mutable registry the module reads through the mocked @sdp/earn binding —
// tests install providers per case, proving the sync is registry-driven and
// picks up new providers with no changes to this module or the job.
const mocks = vi.hoisted(() => ({
  providerClients: {} as Record<string, EarnVaultProvider>,
  upsertStrategy: vi.fn(),
  admitSlidingWindow: vi.fn(),
  deleteKey: vi.fn(),
}));

vi.mock("@sdp/earn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sdp/earn")>();
  return {
    ...actual,
    EARN_PROVIDER_CLIENTS: mocks.providerClients,
  };
});

vi.mock("@/db/repositories", () => ({
  createEarnRepository: vi.fn(() => ({ upsertStrategy: mocks.upsertStrategy })),
}));

vi.mock("@/runtime/kv-redis", () => ({
  createKVStoreSet: vi.fn(() => ({
    cache: {
      admitSlidingWindow: mocks.admitSlidingWindow,
      delete: mocks.deleteKey,
    },
  })),
}));

import { createEarnRepository } from "@/db/repositories";

const env = { DATABASE_URL: "postgres://unit", REDIS_URL: "redis://unit" } as Env;

function makeSnapshot(ref: string): ProviderStrategySnapshot {
  return {
    providerReference: ref,
    name: `Strategy ${ref}`,
    sourceKind: "defi",
    depositMints: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    apyType: "variable",
    liquidityTerm: "instant",
  };
}

function makeProvider(
  id: string,
  listStrategies: EarnVaultProvider["listStrategies"]
): EarnVaultProvider {
  return {
    provider: id,
    // Envelope matches makeSnapshot() so isStrategyWithinDeclaredSupport
    // (real implementation) admits the fixtures.
    declaredSupport: { sourceKinds: ["defi", "rwa"], depositTokens: ["USDC"] },
    listStrategies,
  } as unknown as EarnVaultProvider;
}

function makeObservability(): Observability {
  return {
    captureException: vi.fn(),
    withScope: vi.fn(),
    withMonitor: vi.fn((_slug, fn) => fn()),
  };
}

function installProviders(providers: Record<string, EarnVaultProvider>): void {
  for (const key of Object.keys(mocks.providerClients)) {
    delete mocks.providerClients[key];
  }
  Object.assign(mocks.providerClients, providers);
}

describe("runEarnCatalogueSyncIfDue", () => {
  beforeEach(() => {
    mocks.upsertStrategy.mockReset().mockResolvedValue(undefined);
    mocks.admitSlidingWindow
      .mockReset()
      .mockResolvedValue({ admitted: true, current: 1, previous: 0 });
    mocks.deleteKey.mockReset().mockResolvedValue(undefined);
    vi.mocked(createEarnRepository)
      .mockReset()
      .mockImplementation(() => ({ upsertStrategy: mocks.upsertStrategy }) as never);
    installProviders({});
  });

  it("claims the hourly slot with a fixed once-per-TTL window and syncs", async () => {
    const listStrategies = vi.fn(async (_ctx: EarnRuntimeContext) => [makeSnapshot("vault-a")]);
    installProviders({ ground: makeProvider("ground", listStrategies) });

    const outcome = await runEarnCatalogueSyncIfDue(env);

    expect(outcome).toBe("synced");
    expect(mocks.admitSlidingWindow).toHaveBeenCalledExactlyOnceWith(
      "cron:earn-catalogue-sync:slot",
      "cron:earn-catalogue-sync:slot-previous",
      {
        maxRequests: 1,
        previousWeight: 0,
        expirationTtl: EARN_CATALOGUE_SYNC_SLOT_TTL_SECONDS,
      }
    );
    // One pass per synced environment, driven by the registry.
    const environments = listStrategies.mock.calls.map(([ctx]) => ctx.environment);
    expect(environments).toEqual(["sandbox", "production"]);
    expect(mocks.upsertStrategy).toHaveBeenCalledTimes(2);
    expect(mocks.deleteKey).not.toHaveBeenCalled();
  });

  it("skips without syncing or checking in when the slot is already claimed", async () => {
    const listStrategies = vi.fn(async () => [makeSnapshot("vault-a")]);
    installProviders({ ground: makeProvider("ground", listStrategies) });
    mocks.admitSlidingWindow.mockResolvedValue({ admitted: false, current: 1, previous: 0 });
    const observability = makeObservability();

    const outcome = await runEarnCatalogueSyncIfDue(env, observability);

    expect(outcome).toBe("skipped");
    expect(listStrategies).not.toHaveBeenCalled();
    // No monitor check-in on a skipped tick — Sentry must see hourly
    // check-ins, not one per five-minute job tick.
    expect(observability.withMonitor).not.toHaveBeenCalled();
    expect(mocks.deleteKey).not.toHaveBeenCalled();
  });

  it("runs under its own monitor with the hourly crontab schedule", async () => {
    installProviders({
      ground: makeProvider(
        "ground",
        vi.fn(async () => [])
      ),
    });
    const observability = makeObservability();

    await runEarnCatalogueSyncIfDue(env, observability);

    expect(observability.withMonitor).toHaveBeenCalledExactlyOnceWith(
      EARN_CATALOGUE_SYNC_MONITOR,
      expect.any(Function),
      { schedule: { type: "crontab", value: EARN_CATALOGUE_SYNC_CRON } }
    );
  });

  it("releases the slot and rethrows when the sync fails at infrastructure level", async () => {
    installProviders({
      ground: makeProvider(
        "ground",
        vi.fn(async () => [])
      ),
    });
    vi.mocked(createEarnRepository).mockImplementation(() => {
      throw new Error("database unreachable");
    });

    await expect(runEarnCatalogueSyncIfDue(env)).rejects.toThrow("database unreachable");

    // Released so the next five-minute tick retries instead of waiting out
    // the hourly TTL.
    expect(mocks.deleteKey).toHaveBeenCalledExactlyOnceWith("cron:earn-catalogue-sync:slot");
  });

  it("never lets a slot-release failure mask the sync error", async () => {
    installProviders({
      ground: makeProvider(
        "ground",
        vi.fn(async () => [])
      ),
    });
    vi.mocked(createEarnRepository).mockImplementation(() => {
      throw new Error("database unreachable");
    });
    mocks.deleteKey.mockRejectedValue(new Error("redis gone too"));

    await expect(runEarnCatalogueSyncIfDue(env)).rejects.toThrow("database unreachable");
  });

  it("degrades per provider: one failing provider never sinks the others' pass", async () => {
    // Two registered providers — the exact shape a future onboarding takes.
    // The failing one is logged and swallowed inside the pass; the healthy
    // one still syncs and the tick still counts as run.
    const failing = vi.fn(async (): Promise<ProviderStrategySnapshot[]> => {
      throw new Error("provider API down");
    });
    const healthy = vi.fn(async () => [makeSnapshot("vault-b")]);
    installProviders({
      veda: makeProvider("veda", failing),
      ground: makeProvider("ground", healthy),
    });

    const outcome = await runEarnCatalogueSyncIfDue(env);

    expect(outcome).toBe("synced");
    expect(failing).toHaveBeenCalledTimes(2);
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(mocks.upsertStrategy).toHaveBeenCalledTimes(2);
    expect(mocks.upsertStrategy.mock.calls.every(([row]) => row.provider === "ground")).toBe(true);
    expect(mocks.deleteKey).not.toHaveBeenCalled();
  });

  it("treats stub and un-credentialed providers as steady states, not failures", async () => {
    const notImplemented = vi.fn(async (): Promise<ProviderStrategySnapshot[]> => {
      throw new SdpEarnError("NOT_IMPLEMENTED");
    });
    const notConfigured = vi.fn(async (): Promise<ProviderStrategySnapshot[]> => {
      throw new SdpEarnError("PROVIDER_NOT_CONFIGURED");
    });
    installProviders({
      upshift: makeProvider("upshift", notImplemented),
      ground: makeProvider("ground", notConfigured),
    });

    const outcome = await runEarnCatalogueSyncIfDue(env);

    expect(outcome).toBe("synced");
    expect(mocks.upsertStrategy).not.toHaveBeenCalled();
    expect(mocks.deleteKey).not.toHaveBeenCalled();
  });
});
