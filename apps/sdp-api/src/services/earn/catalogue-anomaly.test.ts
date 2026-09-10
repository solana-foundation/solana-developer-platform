import { describe, expect, it, vi } from "vitest";

const logEvent = vi.fn();
vi.mock("@/runtime/money-path-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/money-path-events")>()),
  logEvent,
}));

const {
  EARN_FIGURE_BOUNDS,
  detectFigureAnomalies,
  reportFigureAnomalies,
  reportShelfDisappearance,
} = await import("./catalogue-anomaly");

const stored = (
  providerReference: string,
  currentApy: string | null,
  tvlUsd: number | null = null
) => ({ providerReference, hostCluster: "mainnet-beta" as const, currentApy, tvlUsd });

describe("detectFigureAnomalies", () => {
  it("flags a 10x APY jump between passes with the ratio", () => {
    const anomalies = detectFigureAnomalies(
      [stored("vault-a", "0.05")],
      [{ providerReference: "vault-a", currentApy: "0.5" }]
    );

    expect(anomalies).toEqual([
      {
        providerReference: "vault-a",
        hostCluster: "mainnet-beta",
        metric: "apy",
        reason: "jump",
        previous: 0.05,
        current: 0.5,
        ratio: 10,
      },
    ]);
  });

  it("flags a collapse the same way, on the inverse ratio", () => {
    const [anomaly] = detectFigureAnomalies(
      [stored("vault-a", "0.06")],
      [{ providerReference: "vault-a", currentApy: "0.01" }]
    );

    expect(anomaly).toMatchObject({ metric: "apy", reason: "jump" });
    expect(anomaly?.ratio).toBeCloseTo(1 / 6, 12);
  });

  it("ignores ordinary drift and sub-floor noise around zero", () => {
    expect(
      detectFigureAnomalies(
        [stored("vault-a", "0.05"), stored("vault-b", "0.0004")],
        [
          { providerReference: "vault-a", currentApy: "0.07" },
          // 10x, but under the half-point absolute floor.
          { providerReference: "vault-b", currentApy: "0.004" },
        ]
      )
    ).toEqual([]);
  });

  it("uses the absolute floor alone when either side is zero", () => {
    const anomalies = detectFigureAnomalies(
      [stored("vault-a", "0"), stored("vault-b", "0.05")],
      [
        { providerReference: "vault-a", currentApy: "0.05" },
        { providerReference: "vault-b", currentApy: "0" },
      ]
    );

    expect(anomalies.map((a) => [a.providerReference, a.ratio])).toEqual([
      ["vault-a", null],
      ["vault-b", null],
    ]);
  });

  it("exempts new rows from the jump check but not from the ceiling", () => {
    const anomalies = detectFigureAnomalies(
      [],
      [
        { providerReference: "new-sane", currentApy: "0.08", hostCluster: "devnet" },
        { providerReference: "new-absurd", currentApy: "4.2", hostCluster: "devnet" },
      ]
    );

    expect(anomalies).toEqual([
      {
        providerReference: "new-absurd",
        hostCluster: "devnet",
        metric: "apy",
        reason: "ceiling",
        previous: null,
        current: 4.2,
        ratio: null,
      },
    ]);
  });

  it("reports both a ceiling breach and a jump when one figure does both", () => {
    const anomalies = detectFigureAnomalies(
      [stored("vault-a", "0.05")],
      [{ providerReference: "vault-a", currentApy: "2" }]
    );

    expect(anomalies.map((a) => a.reason)).toEqual(["ceiling", "jump"]);
  });

  it("skips a rate that is missing or unparseable on either side", () => {
    expect(
      detectFigureAnomalies(
        [stored("gone", "0.05"), stored("garbage", "n/a"), stored("none", null)],
        [
          { providerReference: "gone", currentApy: null },
          { providerReference: "garbage", currentApy: "0.5" },
          { providerReference: "none", currentApy: "0.5" },
        ]
      )
    ).toEqual([]);
  });

  it("flags a TVL jump only when it clears both the ratio and the dollar floor", () => {
    const anomalies = detectFigureAnomalies(
      [
        stored("big", "0.05", 10_000_000),
        stored("tiny", "0.05", 1_000),
        stored("steady", "0.05", 10_000_000),
      ],
      [
        { providerReference: "big", currentApy: "0.05", tvlUsd: 1_000_000 },
        // 40x, but a $39k move.
        { providerReference: "tiny", currentApy: "0.05", tvlUsd: 40_000 },
        { providerReference: "steady", currentApy: "0.05", tvlUsd: 12_000_000 },
      ]
    );

    expect(anomalies).toEqual([
      {
        providerReference: "big",
        hostCluster: "mainnet-beta",
        metric: "tvl_usd",
        reason: "jump",
        previous: 10_000_000,
        current: 1_000_000,
        ratio: 0.1,
      },
    ]);
  });

  it("never coerces malformed provider values into figures", () => {
    // Number(true) is 1 and Number("") is 0: either would fabricate a collapse.
    expect(
      detectFigureAnomalies(
        [
          stored("bool", "0.05", 10_000_000),
          stored("empty", "0.05", 10_000_000),
          stored("array", "0.05", 10_000_000),
          stored("nan", "0.05", 10_000_000),
        ],
        [
          { providerReference: "bool", currentApy: "0.05", tvlUsd: true },
          { providerReference: "empty", currentApy: "", tvlUsd: "" },
          { providerReference: "array", currentApy: "0.05", tvlUsd: [] },
          { providerReference: "nan", currentApy: "NaN", tvlUsd: Number.NaN },
        ]
      )
    ).toEqual([]);
  });

  it("accepts the numeric string shapes providers actually send", () => {
    const anomalies = detectFigureAnomalies(
      [stored("a", "0.05"), stored("b", "0.05"), stored("c", "0.05")],
      [
        { providerReference: "a", currentApy: " 0.5 " },
        { providerReference: "b", currentApy: "5e-1" },
        { providerReference: "c", currentApy: ".5" },
      ]
    );

    expect(anomalies.map((a) => [a.providerReference, a.current])).toEqual([
      ["a", 0.5],
      ["b", 0.5],
      ["c", 0.5],
    ]);
  });

  it("treats a non-numeric incoming TVL as no figure", () => {
    expect(
      detectFigureAnomalies(
        [stored("vault-a", "0.05", 10_000_000)],
        [{ providerReference: "vault-a", currentApy: "0.05", tvlUsd: "12M" }]
      )
    ).toEqual([]);
  });

  it("ignores references the catalogue does not hold when no cluster is known", () => {
    // A metrics entry for an unadmitted vault: the refresh no-ops on it.
    expect(
      detectFigureAnomalies([], [{ providerReference: "unadmitted", currentApy: "9" }])
    ).toEqual([]);
  });
});

describe("reportFigureAnomalies", () => {
  it("emits one warn event per anomaly with the pass's context and returns the count", () => {
    logEvent.mockClear();

    const count = reportFigureAnomalies({
      source: "metrics_refresh",
      provider: "kamino",
      environment: "production",
      stored: [stored("vault-a", "0.05", 5_000_000)],
      incoming: [{ providerReference: "vault-a", currentApy: "0.5", tvlUsd: 50_000_000 }],
    });

    expect(count).toBe(2);
    expect(logEvent).toHaveBeenCalledTimes(2);
    expect(logEvent).toHaveBeenCalledWith("warn", {
      event: "sdp_api_earn_catalogue_figure_anomaly",
      source: "metrics_refresh",
      provider: "kamino",
      environment: "production",
      provider_reference: "vault-a",
      host_cluster: "mainnet-beta",
      metric: "apy",
      reason: "jump",
      previous: 0.05,
      current: 0.5,
      ratio: 10,
    });
    expect(logEvent).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({ metric: "tvl_usd", ratio: 10 })
    );
  });

  it("stays quiet on an unchanged shelf", () => {
    logEvent.mockClear();

    expect(
      reportFigureAnomalies({
        source: "catalogue_sync",
        provider: "kamino",
        environment: "sandbox",
        stored: [stored("vault-a", "0.05")],
        incoming: [{ providerReference: "vault-a", currentApy: "0.052" }],
      })
    ).toBe(0);
    expect(logEvent).not.toHaveBeenCalled();
  });
});

describe("reportShelfDisappearance", () => {
  it("emits an error event carrying the scope and whether the lane will delist", () => {
    logEvent.mockClear();

    reportShelfDisappearance({
      provider: "kamino",
      environment: "sandbox",
      delistScope: "devnet",
      previousCount: 21,
      willDelist: false,
    });

    expect(logEvent).toHaveBeenCalledWith("error", {
      event: "sdp_api_earn_catalogue_shelf_disappeared",
      source: "catalogue_sync",
      provider: "kamino",
      environment: "sandbox",
      delist_scope: "devnet",
      previous_count: 21,
      will_delist: false,
    });
  });
});

describe("EARN_FIGURE_BOUNDS", () => {
  it("pins the starting bounds so a change is a deliberate diff", () => {
    expect(EARN_FIGURE_BOUNDS).toEqual({
      apyJumpRatio: 3,
      apyMinAbsoluteDelta: 0.005,
      apyCeiling: 1,
      tvlJumpRatio: 3,
      tvlMinAbsoluteDeltaUsd: 50_000,
    });
  });
});
