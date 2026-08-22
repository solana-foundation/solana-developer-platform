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
  EARN_CATALOGUE_SYNC_DEADLINE_SECONDS,
  EARN_CATALOGUE_SYNC_MONITOR,
  EARN_CATALOGUE_SYNC_SLOT_TTL_SECONDS,
  runEarnCatalogueSyncIfDue,
} from "./earn-catalogue-sync";

const SLOT_KEY = "cron:earn-catalogue-sync:slot";
const MONITOR_SLOT_KEY = "cron:earn-catalogue-sync:disabled-monitor-slot";

// Mutable registry the module reads through the mocked @sdp/earn binding —
// tests install providers per case, proving the sync is registry-driven and
// picks up new providers with no changes to this module or the job.
const mocks = vi.hoisted(() => ({
  providerClients: {} as Record<string, EarnVaultProvider>,
  upsertStrategy: vi.fn(),
  deleteUnlistedStrategies: vi.fn(),
  get: vi.fn(),
  compareAndSet: vi.fn(),
  compareAndDelete: vi.fn(),
}));

vi.mock("@sdp/earn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sdp/earn")>();
  return {
    ...actual,
    EARN_PROVIDER_CLIENTS: mocks.providerClients,
  };
});

vi.mock("@/db/repositories", () => ({
  createEarnRepository: vi.fn(() => ({
    upsertStrategy: mocks.upsertStrategy,
    deleteUnlistedStrategies: mocks.deleteUnlistedStrategies,
  })),
}));

vi.mock("@/runtime/kv-redis", () => ({
  createKVStoreSet: vi.fn(() => ({
    cache: {
      get: mocks.get,
      compareAndSet: mocks.compareAndSet,
      compareAndDelete: mocks.compareAndDelete,
    },
  })),
}));

import { createEarnRepository } from "@/db/repositories";

const env = { DATABASE_URL: "postgres://unit", REDIS_URL: "redis://unit" } as Env;

// Matches makeSlotToken's `<expiresAtEpochMs>:<uuid>` wire format.
const TOKEN_PATTERN = /^\d+:[0-9a-f-]{36}$/;

function makeSnapshot(ref: string): ProviderStrategySnapshot {
  return {
    providerReference: ref,
    name: `Strategy ${ref}`,
    sourceKind: "defi",
    depositMints: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    apyType: "variable",
    liquidityTerm: "instant",
    hostCluster: "devnet",
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
    mocks.deleteUnlistedStrategies.mockReset().mockResolvedValue([]);
    // Default slot state: empty and claimable.
    mocks.get.mockReset().mockResolvedValue(null);
    mocks.compareAndSet.mockReset().mockResolvedValue(true);
    mocks.compareAndDelete.mockReset().mockResolvedValue(true);
    vi.mocked(createEarnRepository)
      .mockReset()
      .mockImplementation(
        () =>
          ({
            upsertStrategy: mocks.upsertStrategy,
            deleteUnlistedStrategies: mocks.deleteUnlistedStrategies,
          }) as never
      );
    installProviders({});
  });

  it("claims an empty slot with a single null-to-token transition and syncs", async () => {
    const listStrategies = vi.fn(async (_ctx: EarnRuntimeContext) => [makeSnapshot("vault-a")]);
    installProviders({ ground: makeProvider("ground", listStrategies) });

    const outcome = await runEarnCatalogueSyncIfDue(env);

    expect(outcome).toBe("synced");
    expect(mocks.compareAndSet).toHaveBeenCalledExactlyOnceWith(
      SLOT_KEY,
      null,
      expect.stringMatching(TOKEN_PATTERN)
    );
    // The token embeds its own expiry, roughly TTL from now.
    const token = mocks.compareAndSet.mock.calls[0][2] as string;
    const expiresAt = Number(token.slice(0, token.indexOf(":")));
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + EARN_CATALOGUE_SYNC_SLOT_TTL_SECONDS * 1000);
    // One pass per synced environment, driven by the registry.
    const environments = listStrategies.mock.calls.map(([ctx]) => ctx.environment);
    expect(environments).toEqual(["sandbox", "production"]);
    expect(mocks.upsertStrategy).toHaveBeenCalledTimes(2);
    expect(mocks.compareAndDelete).not.toHaveBeenCalled();
  });

  it("skips without syncing or checking in while a live claim holds the slot", async () => {
    const listStrategies = vi.fn(async () => [makeSnapshot("vault-a")]);
    installProviders({ ground: makeProvider("ground", listStrategies) });
    mocks.get.mockResolvedValue(`${Date.now() + 60_000}:11111111-2222-3333-4444-555555555555`);
    const observability = makeObservability();

    const outcome = await runEarnCatalogueSyncIfDue(env, observability);

    expect(outcome).toBe("skipped");
    expect(listStrategies).not.toHaveBeenCalled();
    // A held slot is respected without a write attempt, and skipped ticks
    // make no monitor check-in — Sentry must see hourly check-ins, not one
    // per five-minute job tick.
    expect(mocks.compareAndSet).not.toHaveBeenCalled();
    expect(observability.withMonitor).not.toHaveBeenCalled();
    expect(mocks.compareAndDelete).not.toHaveBeenCalled();
  });

  it("takes over an expired claim atomically on its exact stale value", async () => {
    const stale = `${Date.now() - 1_000}:11111111-2222-3333-4444-555555555555`;
    mocks.get.mockResolvedValue(stale);
    installProviders({
      ground: makeProvider(
        "ground",
        vi.fn(async () => [])
      ),
    });

    const outcome = await runEarnCatalogueSyncIfDue(env);

    expect(outcome).toBe("synced");
    expect(mocks.compareAndSet).toHaveBeenCalledExactlyOnceWith(
      SLOT_KEY,
      stale,
      expect.stringMatching(TOKEN_PATTERN)
    );
  });

  it("treats a pre-token legacy value as expired and takes it over", async () => {
    // Older builds claimed via INCR, leaving "1" behind; it must never wedge
    // the slot.
    mocks.get.mockResolvedValue("1");
    installProviders({
      ground: makeProvider(
        "ground",
        vi.fn(async () => [])
      ),
    });

    const outcome = await runEarnCatalogueSyncIfDue(env);

    expect(outcome).toBe("synced");
    expect(mocks.compareAndSet).toHaveBeenCalledExactlyOnceWith(
      SLOT_KEY,
      "1",
      expect.stringMatching(TOKEN_PATTERN)
    );
  });

  it("skips when a racing tick wins the same claim transition", async () => {
    const listStrategies = vi.fn(async () => [makeSnapshot("vault-a")]);
    installProviders({ ground: makeProvider("ground", listStrategies) });
    mocks.compareAndSet.mockResolvedValue(false);

    const outcome = await runEarnCatalogueSyncIfDue(env);

    expect(outcome).toBe("skipped");
    expect(listStrategies).not.toHaveBeenCalled();
    expect(mocks.compareAndDelete).not.toHaveBeenCalled();
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

  it("keeps the hourly monitor healthy without running providers while Earn is disabled", async () => {
    const listStrategies = vi.fn(async () => [makeSnapshot("vault-a")]);
    installProviders({ ground: makeProvider("ground", listStrategies) });
    const observability = makeObservability();

    const outcome = await runEarnCatalogueSyncIfDue(env, observability, {
      workEnabled: false,
    });

    expect(outcome).toBe("disabled");
    expect(listStrategies).not.toHaveBeenCalled();
    expect(createEarnRepository).not.toHaveBeenCalled();
    expect(mocks.compareAndSet).toHaveBeenCalledExactlyOnceWith(
      MONITOR_SLOT_KEY,
      null,
      expect.stringMatching(TOKEN_PATTERN)
    );
    expect(observability.withMonitor).toHaveBeenCalledExactlyOnceWith(
      EARN_CATALOGUE_SYNC_MONITOR,
      expect.any(Function),
      { schedule: { type: "crontab", value: EARN_CATALOGUE_SYNC_CRON } }
    );
  });

  it("releases only its own claim token when the sync fails, and rethrows", async () => {
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

    // compareAndDelete carries this execution's exact token, so the release
    // is an atomic owner check server-side — a newer tick's takeover cannot
    // be cancelled from here, and a still-owned slot is freed for the next
    // five-minute tick to retry.
    const token = mocks.compareAndSet.mock.calls[0][2] as string;
    expect(mocks.compareAndDelete).toHaveBeenCalledExactlyOnceWith(SLOT_KEY, token);
  });

  it("fails a sync that exceeds its deadline and releases the still-owned claim", async () => {
    vi.useFakeTimers();
    try {
      // A provider call that never settles — the deadline, not the provider,
      // must end the tick, keeping every execution bounded far below the
      // claim expiry (the lease-validity invariant).
      const never = new Promise<ProviderStrategySnapshot[]>(() => {});
      installProviders({
        ground: makeProvider(
          "ground",
          vi.fn(() => never)
        ),
      });

      const tick = runEarnCatalogueSyncIfDue(env);
      const assertion = expect(tick).rejects.toThrow(
        `exceeded its ${EARN_CATALOGUE_SYNC_DEADLINE_SECONDS}s deadline`
      );
      await vi.advanceTimersByTimeAsync(EARN_CATALOGUE_SYNC_DEADLINE_SECONDS * 1000);
      await assertion;

      // Deadline ≪ claim expiry, so the claim is provably still this
      // execution's and the release frees the next tick to retry.
      const token = mocks.compareAndSet.mock.calls[0][2] as string;
      expect(mocks.compareAndDelete).toHaveBeenCalledExactlyOnceWith(SLOT_KEY, token);
    } finally {
      vi.useRealTimers();
    }
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
    mocks.compareAndDelete.mockRejectedValue(new Error("redis gone too"));

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
    expect(mocks.compareAndDelete).not.toHaveBeenCalled();
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
    expect(mocks.compareAndDelete).not.toHaveBeenCalled();
  });

  it("deletes rows the provider no longer lists, per provider and environment", async () => {
    // The keep set is what the provider still lists; the repository decides
    // what that leaves behind. This is what makes a tightened catalogue gate
    // reach rows ALREADY stored.
    installProviders({
      ground: makeProvider(
        "ground",
        vi.fn(async () => [
          makeSnapshot("kamino-allez-usdc"),
          makeSnapshot("kamino-steakhouse-usdc"),
        ])
      ),
    });
    mocks.deleteUnlistedStrategies.mockResolvedValue(["morpho-gauntlet-usdc", "aave-v3-usdc"]);

    const outcome = await runEarnCatalogueSyncIfDue(env);

    expect(outcome).toBe("synced");
    expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledTimes(2);
    expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledWith({
      provider: "ground",
      environment: "sandbox",
      listedProviderReferences: ["kamino-allez-usdc", "kamino-steakhouse-usdc"],
    });
    expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledWith({
      provider: "ground",
      environment: "production",
      listedProviderReferences: ["kamino-allez-usdc", "kamino-steakhouse-usdc"],
    });
  });

  it("never deletes off an empty catalogue or a partial write pass", async () => {
    // Both are cases where the pass cannot prove what the provider lists, so a
    // whole shelf must never be torn down on the strength of them.
    installProviders({
      ground: makeProvider(
        "ground",
        vi.fn(async () => [])
      ),
    });
    expect(await runEarnCatalogueSyncIfDue(env)).toBe("synced");
    expect(mocks.deleteUnlistedStrategies).not.toHaveBeenCalled();

    mocks.get.mockResolvedValue(null);
    mocks.compareAndSet.mockResolvedValue(true);
    mocks.upsertStrategy.mockRejectedValue(new Error("write conflict"));
    installProviders({
      ground: makeProvider(
        "ground",
        vi.fn(async () => [makeSnapshot("kamino-allez-usdc")])
      ),
    });

    expect(await runEarnCatalogueSyncIfDue(env)).toBe("synced");
    expect(mocks.deleteUnlistedStrategies).not.toHaveBeenCalled();
  });

  it("keeps a delete failure inside the provider's pass", async () => {
    // Same degradation contract as upsert: the catalogue stays stale for an
    // hour, the tick still counts as run, and the slot is not released.
    installProviders({
      ground: makeProvider(
        "ground",
        vi.fn(async () => [makeSnapshot("kamino-allez-usdc")])
      ),
    });
    mocks.deleteUnlistedStrategies.mockRejectedValue(new Error("deadlock detected"));

    expect(await runEarnCatalogueSyncIfDue(env)).toBe("synced");
    expect(mocks.upsertStrategy).toHaveBeenCalledTimes(2);
    expect(mocks.compareAndDelete).not.toHaveBeenCalled();
  });
});
