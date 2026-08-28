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

function makeSnapshot(
  ref: string,
  hostCluster: ProviderStrategySnapshot["hostCluster"] = "devnet"
): ProviderStrategySnapshot {
  return {
    providerReference: ref,
    name: `Strategy ${ref}`,
    sourceKind: "defi",
    depositMints: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    apyType: "variable",
    liquidityTerm: "instant",
    hostCluster,
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
    // One fetch per data source, driven by the registry — production first,
    // because its accepted snapshots double as the mirror source (PRO-1742).
    const environments = listStrategies.mock.calls.map(([ctx]) => ctx.environment);
    expect(environments).toEqual(["production", "sandbox"]);
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
    // A steady state is still a reliable ANSWER: with no production catalogue,
    // the mirror sub-shelf converges to empty (an authorized empty keep set),
    // while the own lanes write and delete nothing.
    expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledTimes(2);
    for (const provider of ["upshift", "ground"]) {
      expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledWith({
        provider,
        environment: "sandbox",
        hostCluster: "mainnet-beta",
        listedProviderReferences: [],
        allowEmptyKeepSet: true,
      });
    }
    expect(mocks.compareAndDelete).not.toHaveBeenCalled();
  });

  it("deletes rows the provider no longer lists, per provider, environment and lane", async () => {
    // The keep set is what the provider still lists; the repository decides
    // what that leaves behind. This is what makes a tightened catalogue gate
    // reach rows ALREADY stored. Production's delist is environment-wide (its
    // own fetch is the total truth there); a non-production own lane is scoped
    // to the environment's cluster so it can never reach the mirrored shelf.
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
    // Three lanes: production environment-wide, sandbox's own devnet sub-shelf,
    // and the sandbox mirror converging to empty (production listed no mainnet
    // rows this pass: a reliable answer, so the empty keep set is authorized).
    expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledTimes(3);
    expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledWith({
      provider: "ground",
      environment: "production",
      hostCluster: undefined,
      listedProviderReferences: ["kamino-allez-usdc", "kamino-steakhouse-usdc"],
    });
    expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledWith({
      provider: "ground",
      environment: "sandbox",
      hostCluster: "devnet",
      listedProviderReferences: ["kamino-allez-usdc", "kamino-steakhouse-usdc"],
    });
    expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledWith({
      provider: "ground",
      environment: "sandbox",
      hostCluster: "mainnet-beta",
      listedProviderReferences: [],
      allowEmptyKeepSet: true,
    });
  });

  it("never deletes an OWN shelf off an empty catalogue or a partial write pass", async () => {
    // Both are cases where the pass cannot prove what the provider lists, so a
    // fundable shelf must never be torn down on the strength of them. Only the
    // browse-only mirror sub-shelf converges on an authorized empty keep set.
    const isMirrorConvergence = (call: unknown[]) =>
      (call[0] as { hostCluster?: string; allowEmptyKeepSet?: true }).hostCluster ===
        "mainnet-beta" && (call[0] as { allowEmptyKeepSet?: true }).allowEmptyKeepSet === true;

    installProviders({
      ground: makeProvider(
        "ground",
        vi.fn(async () => [])
      ),
    });
    expect(await runEarnCatalogueSyncIfDue(env)).toBe("synced");
    expect(mocks.deleteUnlistedStrategies.mock.calls.every(isMirrorConvergence)).toBe(true);

    mocks.deleteUnlistedStrategies.mockClear();
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
    expect(mocks.deleteUnlistedStrategies.mock.calls.every(isMirrorConvergence)).toBe(true);
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

  describe("the mainnet mirror (PRO-1742)", () => {
    it("mirrors production's accepted mainnet shelf into sandbox beside sandbox's own rows", async () => {
      const listStrategies = vi.fn(async (ctx: EarnRuntimeContext) =>
        ctx.environment === "production"
          ? [makeSnapshot("mainnet-vault", "mainnet-beta")]
          : [makeSnapshot("devnet-vault", "devnet")]
      );
      installProviders({ kamino: makeProvider("kamino", listStrategies) });

      expect(await runEarnCatalogueSyncIfDue(env)).toBe("synced");

      // The mirror is a second WRITE, never a second read: one fetch per data
      // source, production first because it doubles as the mirror source.
      expect(listStrategies.mock.calls.map(([ctx]) => ctx.environment)).toEqual([
        "production",
        "sandbox",
      ]);

      // Three writes: production's own row, sandbox's own row, and the
      // mirrored mainnet row — cluster taken from the snapshot, never the
      // target environment.
      expect(mocks.upsertStrategy).toHaveBeenCalledTimes(3);
      expect(mocks.upsertStrategy).toHaveBeenCalledWith(
        expect.objectContaining({
          providerReference: "mainnet-vault",
          environment: "production",
          hostCluster: "mainnet-beta",
        })
      );
      expect(mocks.upsertStrategy).toHaveBeenCalledWith(
        expect.objectContaining({
          providerReference: "devnet-vault",
          environment: "sandbox",
          hostCluster: "devnet",
        })
      );
      expect(mocks.upsertStrategy).toHaveBeenCalledWith(
        expect.objectContaining({
          providerReference: "mainnet-vault",
          environment: "sandbox",
          hostCluster: "mainnet-beta",
        })
      );

      // Each lane delists only the sub-shelf it is the truth for, so the next
      // pass over unchanged catalogues deletes nothing: the devnet keep set
      // cannot reach the mirrored mainnet rows and vice versa.
      expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledTimes(3);
      expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledWith({
        provider: "kamino",
        environment: "production",
        hostCluster: undefined,
        listedProviderReferences: ["mainnet-vault"],
      });
      expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledWith({
        provider: "kamino",
        environment: "sandbox",
        hostCluster: "devnet",
        listedProviderReferences: ["devnet-vault"],
      });
      expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledWith({
        provider: "kamino",
        environment: "sandbox",
        hostCluster: "mainnet-beta",
        listedProviderReferences: ["mainnet-vault"],
        allowEmptyKeepSet: true,
      });
    });

    it("skips only the mirror lane when the production fetch fails; the devnet shelf keeps converging", async () => {
      const listStrategies = vi.fn(async (ctx: EarnRuntimeContext) => {
        if (ctx.environment === "production") {
          throw new Error("mainnet API down");
        }
        return [makeSnapshot("devnet-vault", "devnet")];
      });
      installProviders({ kamino: makeProvider("kamino", listStrategies) });

      expect(await runEarnCatalogueSyncIfDue(env)).toBe("synced");

      // Sandbox's own lane is untouched by the mirror-source failure…
      expect(mocks.upsertStrategy).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ providerReference: "devnet-vault", environment: "sandbox" })
      );
      expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledExactlyOnceWith({
        provider: "kamino",
        environment: "sandbox",
        hostCluster: "devnet",
        listedProviderReferences: ["devnet-vault"],
      });
      // …and the mirrored mainnet shelf goes stale rather than getting torn
      // down by a keep set nobody could prove this pass.
    });

    it("converges the mirror to empty when production reliably has no catalogue", async () => {
      // The orphaned-mirror shape: production credentials absent (or revoked
      // after rows were mirrored) is a steady-state ANSWER, not an outage, so
      // previously mirrored mainnet rows get a delist path instead of being
      // served forever as a catalogue production no longer vouches for.
      const listStrategies = vi.fn(async (ctx: EarnRuntimeContext) => {
        if (ctx.environment === "production") {
          throw new SdpEarnError("PROVIDER_NOT_CONFIGURED");
        }
        return [makeSnapshot("devnet-vault", "devnet")];
      });
      installProviders({ ground: makeProvider("ground", listStrategies) });

      expect(await runEarnCatalogueSyncIfDue(env)).toBe("synced");
      expect(mocks.upsertStrategy).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ providerReference: "devnet-vault", environment: "sandbox" })
      );
      expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledTimes(2);
      expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledWith({
        provider: "ground",
        environment: "sandbox",
        hostCluster: "mainnet-beta",
        listedProviderReferences: [],
        allowEmptyKeepSet: true,
      });
    });

    it("converges the mirror to empty on a reliably EMPTY production mainnet shelf", async () => {
      // Production answered, and its accepted mainnet shelf is simply empty:
      // a real all-gone delisting the mirror must follow, not an unreliable
      // pass to warn about every hour while stale rows stay active forever.
      const listStrategies = vi.fn(async (ctx: EarnRuntimeContext) =>
        ctx.environment === "production" ? [] : [makeSnapshot("devnet-vault", "devnet")]
      );
      installProviders({ kamino: makeProvider("kamino", listStrategies) });

      expect(await runEarnCatalogueSyncIfDue(env)).toBe("synced");
      expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledWith({
        provider: "kamino",
        environment: "sandbox",
        hostCluster: "mainnet-beta",
        listedProviderReferences: [],
        allowEmptyKeepSet: true,
      });
    });

    it("mirrors a mainnet-only provider whose own-environment source is a steady-state skip", async () => {
      // The provider class the mirror exists for: nothing to catalogue in
      // sandbox (PROVIDER_NOT_CONFIGURED there is a reliable "no own shelf",
      // not an outage), so the mirror proceeds with an empty own reference set
      // instead of never materializing.
      const listStrategies = vi.fn(async (ctx: EarnRuntimeContext) => {
        if (ctx.environment === "production") {
          return [makeSnapshot("mainnet-vault", "mainnet-beta")];
        }
        throw new SdpEarnError("PROVIDER_NOT_CONFIGURED");
      });
      installProviders({ veda: makeProvider("veda", listStrategies) });

      expect(await runEarnCatalogueSyncIfDue(env)).toBe("synced");
      expect(mocks.upsertStrategy).toHaveBeenCalledWith(
        expect.objectContaining({
          providerReference: "mainnet-vault",
          environment: "sandbox",
          hostCluster: "mainnet-beta",
        })
      );
      expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledWith({
        provider: "veda",
        environment: "sandbox",
        hostCluster: "mainnet-beta",
        listedProviderReferences: ["mainnet-vault"],
        allowEmptyKeepSet: true,
      });
      // The own lane wrote and delisted nothing: there is no own shelf.
      expect(mocks.upsertStrategy).not.toHaveBeenCalledWith(
        expect.objectContaining({ environment: "sandbox", hostCluster: "devnet" })
      );
      expect(mocks.deleteUnlistedStrategies).not.toHaveBeenCalledWith(
        expect.objectContaining({ hostCluster: "devnet" })
      );
    });

    it("keeps both sandbox lanes skipped on a TRANSIENT own-fetch failure", async () => {
      // An outage is not an answer: the mirror needs the fresh own reference
      // set (collision rule), so it goes stale alongside the own shelf rather
      // than risking a wrong write or delete.
      const listStrategies = vi.fn(async (ctx: EarnRuntimeContext) => {
        if (ctx.environment === "production") {
          return [makeSnapshot("mainnet-vault", "mainnet-beta")];
        }
        throw new Error("devnet RPC down");
      });
      installProviders({ kamino: makeProvider("kamino", listStrategies) });

      expect(await runEarnCatalogueSyncIfDue(env)).toBe("synced");
      // Production's own lane still converges…
      expect(mocks.upsertStrategy).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ providerReference: "mainnet-vault", environment: "production" })
      );
      // …and nothing touches sandbox at all this pass.
      expect(mocks.deleteUnlistedStrategies).not.toHaveBeenCalledWith(
        expect.objectContaining({ environment: "sandbox" })
      );
    });

    it("never writes a mirror row whose reference collides with the environment's own shelf, but keeps it delisted-proof", async () => {
      // The upsert key is (provider, reference, environment) with no cluster:
      // a shared reference would flip one row between clusters every pass, so
      // the environment's own (fundable) row wins the WRITE. The reference
      // still rides in the mirror's keep set — production lists it, so the
      // mirror delist must not treat it as delisted.
      const listStrategies = vi.fn(async (ctx: EarnRuntimeContext) =>
        ctx.environment === "production"
          ? [
              makeSnapshot("shared-ref", "mainnet-beta"),
              makeSnapshot("mainnet-only", "mainnet-beta"),
            ]
          : [makeSnapshot("shared-ref", "devnet")]
      );
      installProviders({ ground: makeProvider("ground", listStrategies) });

      expect(await runEarnCatalogueSyncIfDue(env)).toBe("synced");

      expect(mocks.upsertStrategy).not.toHaveBeenCalledWith(
        expect.objectContaining({
          environment: "sandbox",
          providerReference: "shared-ref",
          hostCluster: "mainnet-beta",
        })
      );
      expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledWith({
        provider: "ground",
        environment: "sandbox",
        hostCluster: "mainnet-beta",
        listedProviderReferences: ["shared-ref", "mainnet-only"],
        allowEmptyKeepSet: true,
      });
    });

    it("cannot turn a failed own-lane write into a mirror delisting of a collided reference", async () => {
      // The review-flagged corner: a previously mirrored mainnet row whose
      // reference newly appears on the own shelf, in the same pass where that
      // own upsert transiently FAILS. The stored row is then still
      // mainnet-beta, so the mirror delist would delete it off a keep set that
      // dropped the reference as a collision — absent from both shelves until
      // a later pass. The collided reference riding in the mirror keep set is
      // what closes that.
      const listStrategies = vi.fn(async (ctx: EarnRuntimeContext) =>
        ctx.environment === "production"
          ? [makeSnapshot("shared-ref", "mainnet-beta")]
          : [makeSnapshot("shared-ref", "devnet")]
      );
      installProviders({ ground: makeProvider("ground", listStrategies) });
      mocks.upsertStrategy.mockImplementation(async (input: { hostCluster: string }) => {
        if (input.hostCluster === "devnet") {
          throw new Error("write conflict");
        }
        return undefined;
      });

      expect(await runEarnCatalogueSyncIfDue(env)).toBe("synced");

      // The own lane skipped its delist (upsertFailed) as ever, and the mirror
      // delist ran with the collided reference protected in its keep set.
      expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledTimes(2);
      expect(mocks.deleteUnlistedStrategies).toHaveBeenCalledWith({
        provider: "ground",
        environment: "sandbox",
        hostCluster: "mainnet-beta",
        listedProviderReferences: ["shared-ref"],
        allowEmptyKeepSet: true,
      });
      expect(mocks.deleteUnlistedStrategies).not.toHaveBeenCalledWith(
        expect.objectContaining({ hostCluster: "devnet" })
      );
    });

    it("drops an own-fetch snapshot on a foreign cluster — the mirror lane owns mainnet rows here", async () => {
      // Successor of the old refusal guard: a provider whose non-production
      // source starts reporting mainnet instruments is drift, not a shelf.
      const listStrategies = vi.fn(async (ctx: EarnRuntimeContext) =>
        ctx.environment === "production"
          ? []
          : [makeSnapshot("rogue-mainnet", "mainnet-beta"), makeSnapshot("devnet-vault", "devnet")]
      );
      installProviders({ ground: makeProvider("ground", listStrategies) });

      expect(await runEarnCatalogueSyncIfDue(env)).toBe("synced");

      expect(mocks.upsertStrategy).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ providerReference: "devnet-vault", environment: "sandbox" })
      );
      expect(mocks.upsertStrategy).not.toHaveBeenCalledWith(
        expect.objectContaining({ providerReference: "rogue-mainnet" })
      );
    });
  });
});
