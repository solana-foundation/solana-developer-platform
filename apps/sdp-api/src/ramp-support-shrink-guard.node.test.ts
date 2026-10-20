import type {
  ProviderDirectionSupportSnapshot,
  ProviderRailSupportSnapshot,
} from "@sdp/payments/ramps/types";
import type { CryptoRailId } from "@sdp/types/payment-rails";
import { describe, expect, it, vi } from "vitest";
import {
  discoverWithShrinkGuard,
  findRailSupportShrink,
  type RailDiscoveryAttempt,
} from "@/scripts/ramp-support-shrink-guard";

const FIATS = ["AUD", "BRL", "CAD", "CHF", "EUR", "GBP", "JPY", "MXN", "SGD", "USD"];

function direction(
  fiats: readonly string[],
  cryptos: readonly CryptoRailId[]
): ProviderDirectionSupportSnapshot {
  return {
    currencies: Object.fromEntries(fiats.map((fiat) => [fiat, { min: "20", max: null }])),
    cryptos: [...cryptos],
  };
}

// MoonPay's shape at a tenth of the size: PYUSD buys only.
const COMMITTED: ProviderRailSupportSnapshot = {
  onramp: direction(FIATS, ["pyusd.solana", "sol.solana", "usdc.solana"]),
  offramp: direction(FIATS, ["sol.solana", "usdc.solana"]),
};

const WITHOUT_PYUSD: ProviderRailSupportSnapshot = {
  onramp: direction(FIATS, ["sol.solana", "usdc.solana"]),
  offramp: COMMITTED.offramp,
};

function distilled(snapshot: ProviderRailSupportSnapshot): RailDiscoveryAttempt {
  return {
    outcome: "distilled",
    distillation: { snapshot, droppedCurrencyCodes: [], droppedCountryCodes: [] },
  };
}

function discoverReturning(...attempts: readonly RailDiscoveryAttempt[]) {
  const discover = vi.fn<() => Promise<RailDiscoveryAttempt>>();
  for (const attempt of attempts) {
    discover.mockResolvedValueOnce(attempt);
  }
  return discover;
}

describe("findRailSupportShrink", () => {
  it("flags a dropped crypto with every corridor it served", () => {
    expect(findRailSupportShrink(COMMITTED, WITHOUT_PYUSD)).toEqual([
      {
        direction: "onramp",
        removedCryptos: ["pyusd.solana"],
        removedCorridors: 10,
        committedCorridors: 30,
      },
    ]);
  });

  it("lets one fiat in ten leave a direction", () => {
    const discovered = {
      onramp: COMMITTED.onramp,
      offramp: direction(FIATS.slice(1), ["sol.solana", "usdc.solana"]),
    };
    expect(findRailSupportShrink(COMMITTED, discovered)).toEqual([]);
  });

  it("flags losing over a tenth of the corridors even when new fiats keep the count level", () => {
    const discovered = {
      onramp: direction(
        [...FIATS.slice(2), "NOK", "SEK"],
        ["pyusd.solana", "sol.solana", "usdc.solana"]
      ),
      offramp: COMMITTED.offramp,
    };
    expect(findRailSupportShrink(COMMITTED, discovered)).toEqual([
      { direction: "onramp", removedCryptos: [], removedCorridors: 6, committedCorridors: 30 },
    ]);
  });

  it("ignores retired codes the generated matrix already drops", () => {
    const committed = {
      onramp: direction(
        [...FIATS, "BGN", "HRK", "SLL"],
        ["pyusd.solana", "sol.solana", "usdc.solana"]
      ),
      offramp: COMMITTED.offramp,
    };
    expect(findRailSupportShrink(committed, COMMITTED)).toEqual([]);
  });

  it("accepts a refresh that only adds support", () => {
    const discovered = {
      onramp: direction(
        [...FIATS, "NOK"],
        ["pyusd.solana", "sol.solana", "usdc.solana", "usdt.solana"]
      ),
      offramp: COMMITTED.offramp,
    };
    expect(findRailSupportShrink(COMMITTED, discovered)).toEqual([]);
  });
});

describe("discoverWithShrinkGuard", () => {
  it("writes an unchanged read without retrying", async () => {
    const discover = discoverReturning(distilled(COMMITTED));
    const beforeRetry = vi.fn(() => Promise.resolve());

    const result = await discoverWithShrinkGuard({
      committed: COMMITTED,
      allowShrink: false,
      offline: false,
      discover,
      beforeRetry,
    });

    expect(result).toEqual(distilled(COMMITTED));
    expect(discover).toHaveBeenCalledTimes(1);
    expect(beforeRetry).not.toHaveBeenCalled();
  });

  it("writes the retry when it restores a dropped crypto", async () => {
    const discover = discoverReturning(distilled(WITHOUT_PYUSD), distilled(COMMITTED));
    const beforeRetry = vi.fn(() => Promise.resolve());

    const result = await discoverWithShrinkGuard({
      committed: COMMITTED,
      allowShrink: false,
      offline: false,
      discover,
      beforeRetry,
    });

    expect(result).toEqual(distilled(COMMITTED));
    expect(discover).toHaveBeenCalledTimes(2);
    expect(beforeRetry).toHaveBeenCalledWith(findRailSupportShrink(COMMITTED, WITHOUT_PYUSD));
  });

  it("refuses when the retry drops it again", async () => {
    const discover = discoverReturning(distilled(WITHOUT_PYUSD), distilled(WITHOUT_PYUSD));

    const result = await discoverWithShrinkGuard({
      committed: COMMITTED,
      allowShrink: false,
      offline: false,
      discover,
      beforeRetry: () => Promise.resolve(),
    });

    expect(result).toEqual({
      outcome: "shrunk",
      shrinks: findRailSupportShrink(COMMITTED, WITHOUT_PYUSD),
    });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("refuses offline without retrying the same dumps", async () => {
    const discover = discoverReturning(distilled(WITHOUT_PYUSD));
    const beforeRetry = vi.fn(() => Promise.resolve());

    const result = await discoverWithShrinkGuard({
      committed: COMMITTED,
      allowShrink: false,
      offline: true,
      discover,
      beforeRetry,
    });

    expect(result.outcome).toBe("shrunk");
    expect(discover).toHaveBeenCalledTimes(1);
    expect(beforeRetry).not.toHaveBeenCalled();
  });

  it("reports failed requests on the retry instead of refusing", async () => {
    const discover = discoverReturning(distilled(WITHOUT_PYUSD), { outcome: "requests-failed" });

    const result = await discoverWithShrinkGuard({
      committed: COMMITTED,
      allowShrink: false,
      offline: false,
      discover,
      beforeRetry: () => Promise.resolve(),
    });

    expect(result).toEqual({ outcome: "requests-failed" });
  });

  it("writes a drop under allowShrink without retrying", async () => {
    const discover = discoverReturning(distilled(WITHOUT_PYUSD));

    const result = await discoverWithShrinkGuard({
      committed: COMMITTED,
      allowShrink: true,
      offline: false,
      discover,
      beforeRetry: () => Promise.resolve(),
    });

    expect(result).toEqual(distilled(WITHOUT_PYUSD));
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("writes a new provider's first snapshot with nothing to compare", async () => {
    const discover = discoverReturning(distilled(WITHOUT_PYUSD));

    const result = await discoverWithShrinkGuard({
      committed: undefined,
      allowShrink: false,
      offline: false,
      discover,
      beforeRetry: () => Promise.resolve(),
    });

    expect(result).toEqual(distilled(WITHOUT_PYUSD));
    expect(discover).toHaveBeenCalledTimes(1);
  });
});
