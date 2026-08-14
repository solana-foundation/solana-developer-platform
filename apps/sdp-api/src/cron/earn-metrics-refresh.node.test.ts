import { SdpEarnError } from "@sdp/earn";
import type {
  EarnLiveMetricsProvider,
  EarnVaultProvider,
  ProviderStrategyMetrics,
} from "@sdp/earn/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import {
  EARN_PROVIDER_METRICS_DEADLINE_MS,
  refreshEarnStrategyMetrics,
} from "./earn-metrics-refresh";

// Mutable registry the module reads through the mocked @sdp/earn binding —
// tests install providers per case, proving the refresh is capability-driven
// and picks up a new provider with no change to this module or the job.
const mocks = vi.hoisted(() => ({
  providerClients: {} as Record<string, EarnVaultProvider>,
  updateStrategyMetrics: vi.fn(),
}));

vi.mock("@sdp/earn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sdp/earn")>();
  return { ...actual, EARN_PROVIDER_CLIENTS: mocks.providerClients };
});

vi.mock("@/db/repositories", () => ({
  createEarnRepository: vi.fn(() => ({
    updateStrategyMetrics: mocks.updateStrategyMetrics,
  })),
}));

const env = { DATABASE_URL: "postgres://unit" } as Env;

/** A provider WITHOUT the capability — the base contract and nothing else. */
function catalogueOnlyProvider(id: string): EarnVaultProvider {
  return {
    provider: id as EarnVaultProvider["provider"],
    declaredSupport: { sourceKinds: ["defi"], depositTokens: ["USDC"] },
    listStrategies: vi.fn(async () => []),
  };
}

function liveMetricsProvider(
  id: string,
  listStrategyMetrics: EarnLiveMetricsProvider["listStrategyMetrics"]
): EarnLiveMetricsProvider {
  return { ...catalogueOnlyProvider(id), listStrategyMetrics } as EarnLiveMetricsProvider;
}

const metrics = (providerReference: string, currentApy?: string): ProviderStrategyMetrics => ({
  providerReference,
  ...(currentApy === undefined ? {} : { currentApy }),
  riskMetadata: { tvlUsd: 1_000_000 },
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mocks.providerClients)) {
    delete mocks.providerClients[key];
  }
  mocks.updateStrategyMetrics.mockResolvedValue(true);
});

describe("refreshEarnStrategyMetrics", () => {
  it("refreshes every reported strategy, once per environment", async () => {
    mocks.providerClients.kamino = liveMetricsProvider("kamino", async () => [
      metrics("vault-a", "0.051"),
      metrics("vault-b", "0.062"),
    ]);

    await refreshEarnStrategyMetrics(env);

    expect(mocks.updateStrategyMetrics).toHaveBeenCalledTimes(4);
    for (const environment of ["sandbox", "production"] as const) {
      expect(mocks.updateStrategyMetrics).toHaveBeenCalledWith({
        provider: "kamino",
        providerReference: "vault-a",
        environment,
        currentApy: "0.051",
        riskMetadata: { tvlUsd: 1_000_000 },
      });
    }
  });

  it("skips providers without the live-metrics capability", async () => {
    // Capability, not a provider list. Ground opts out because its rates come
    // from the same paged endpoint the catalogue uses — a five-minute pass
    // would re-pay the whole catalogue cost for the rate alone.
    mocks.providerClients.ground = catalogueOnlyProvider("ground");

    await refreshEarnStrategyMetrics(env);

    expect(mocks.updateStrategyMetrics).not.toHaveBeenCalled();
  });

  it("clears a rate the provider has stopped reporting", async () => {
    // Explicit null, not undefined: a stored figure with no source behind it is
    // worse than no figure.
    mocks.providerClients.kamino = liveMetricsProvider("kamino", async () => [metrics("vault-a")]);

    await refreshEarnStrategyMetrics(env);

    expect(mocks.updateStrategyMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ currentApy: null })
    );
  });

  it("degrades per provider — one provider's outage keeps the others fresh", async () => {
    mocks.providerClients.broken = liveMetricsProvider("broken", async () => {
      throw new Error("upstream exploded");
    });
    mocks.providerClients.kamino = liveMetricsProvider("kamino", async () => [
      metrics("vault-a", "0.051"),
    ]);

    await expect(refreshEarnStrategyMetrics(env)).resolves.toBeUndefined();

    expect(mocks.updateStrategyMetrics).toHaveBeenCalledTimes(2);
    expect(mocks.updateStrategyMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "kamino" })
    );
  });

  /**
   * The job runs this pass FIRST and awaits it, then runs the catalogue sync,
   * inside a 120s Cloud Run task. A provider that never answers therefore does
   * not merely lose its own rates — without a deadline it spends the execution
   * and the catalogue sync never runs, every tick, for as long as it stays
   * slow. Fake timers, so this pins the behaviour without a real 20s wait.
   */
  it("gives up on a provider that outruns the deadline and refreshes the rest", async () => {
    vi.useFakeTimers();
    try {
      mocks.providerClients.hung = liveMetricsProvider(
        "hung",
        () => new Promise(() => {}) // never settles
      );
      mocks.providerClients.kamino = liveMetricsProvider("kamino", async () => [
        metrics("vault-a", "0.051"),
      ]);

      const pass = refreshEarnStrategyMetrics(env);
      // Two environments × the hung provider — each waits out its own deadline.
      await vi.advanceTimersByTimeAsync(EARN_PROVIDER_METRICS_DEADLINE_MS * 2 + 1);

      await expect(pass).resolves.toBeUndefined();
      expect(mocks.updateStrategyMetrics).toHaveBeenCalledTimes(2);
      expect(mocks.updateStrategyMetrics).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "kamino" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats NOT_IMPLEMENTED and PROVIDER_NOT_CONFIGURED as quiet skips", async () => {
    for (const code of ["NOT_IMPLEMENTED", "PROVIDER_NOT_CONFIGURED"] as const) {
      mocks.providerClients.stub = liveMetricsProvider("stub", async () => {
        throw new SdpEarnError(code, "expected steady state");
      });

      await expect(refreshEarnStrategyMetrics(env)).resolves.toBeUndefined();
    }

    expect(mocks.updateStrategyMetrics).not.toHaveBeenCalled();
  });

  it("keeps going when a single row's write fails", async () => {
    mocks.providerClients.kamino = liveMetricsProvider("kamino", async () => [
      metrics("vault-a", "0.051"),
      metrics("vault-b", "0.062"),
    ]);
    mocks.updateStrategyMetrics.mockRejectedValueOnce(new Error("deadlock"));

    await expect(refreshEarnStrategyMetrics(env)).resolves.toBeUndefined();

    // The failed row is retried by the next tick five minutes later; it must
    // not cost the rest of the shelf its refresh.
    expect(mocks.updateStrategyMetrics).toHaveBeenCalledTimes(4);
  });

  it("tolerates references the catalogue does not hold", async () => {
    // Providers hand over their whole shelf; the repository no-ops on anything
    // the catalogue refused. That is what lets the refresh skip re-running the
    // admission gates.
    mocks.providerClients.kamino = liveMetricsProvider("kamino", async () => [
      metrics("catalogued"),
      metrics("refused-by-the-tvl-floor"),
    ]);
    mocks.updateStrategyMetrics.mockImplementation(
      async ({ providerReference }: { providerReference: string }) =>
        providerReference === "catalogued"
    );

    await expect(refreshEarnStrategyMetrics(env)).resolves.toBeUndefined();

    expect(mocks.updateStrategyMetrics).toHaveBeenCalledTimes(4);
  });
});
