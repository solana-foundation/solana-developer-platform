// @vitest-environment jsdom
import type { EarnPortfolioWalletActivity, EarnPortfolioWalletStatus } from "@sdp/types";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EarnProgramState } from "./earn-program-data";
import {
  EARN_PROGRAM_DEDUPING_MS,
  earnProgramRefreshInterval,
  useEarnWalletActivityToasts,
} from "./earn-program-data";

/**
 * Money-path coverage for what the dashboard ANNOUNCES about an operation the
 * provider is running. The provider is the source of truth, so every case here
 * drives the hook with provider-observed states and asserts we never announce
 * something the provider did not report.
 */

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("@/i18n/provider", () => ({ useTranslations: () => (key: string) => key }));

const KEY = {
  withdrawal: "DashboardEarn.overview.activityWithdrawalComplete",
  rebalance: "DashboardEarn.overview.activityRebalanceComplete",
  generic: "DashboardEarn.overview.activityComplete",
  failed: "DashboardEarn.overview.activityFailed",
};

function programState(
  status: EarnPortfolioWalletStatus,
  activity?: EarnPortfolioWalletActivity
): EarnProgramState {
  return {
    kind: "active",
    program: {
      provider: "ground",
      label: "Treasury earn",
      createdAt: "2026-07-18T09:00:00.000Z",
      yield: { currentApy: "0.058", earnedUsd: "0", positions: [] },
      wallet: {
        providerWalletRef: "wallet-ref-1",
        status,
        activity,
        balance: {
          totalUsd: "19.00",
          withdrawableUsd: "19.00",
          reservedUsd: "0",
          earnedUsd: "0",
        },
        positions: [],
        allocations: {},
      },
    },
  } as EarnProgramState;
}

/** Replays a sequence of provider observations through one mounted hook. */
function observe(...states: Array<EarnProgramState | undefined>) {
  const { rerender } = renderHook((state: EarnProgramState | undefined) =>
    useEarnWalletActivityToasts(state)
  );
  for (const state of states) {
    rerender(state);
  }
}

describe("useEarnWalletActivityToasts", () => {
  beforeEach(() => {
    toasts.success.mockClear();
    toasts.error.mockClear();
  });

  it("announces a withdrawal once the provider reports the wallet settled", () => {
    observe(programState("busy", "withdrawing"), programState("ready"));
    expect(toasts.success).toHaveBeenCalledWith(KEY.withdrawal);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("names a rebalance the provider ran on its own", () => {
    observe(programState("busy", "rebalancing"), programState("ready"));
    expect(toasts.success).toHaveBeenCalledWith(KEY.rebalance);
  });

  it("stays generic when the provider was busy doing something unrecognized", () => {
    observe(programState("busy"), programState("ready"));
    expect(toasts.success).toHaveBeenCalledWith(KEY.generic);
  });

  it("reports a failure as a failure, not a completion", () => {
    observe(programState("busy", "withdrawing"), programState("failed"));
    expect(toasts.error).toHaveBeenCalledWith(KEY.failed);
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("says nothing while the operation is still running", () => {
    observe(programState("busy", "withdrawing"), programState("busy", "withdrawing"));
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("never announces on first observation, even landing on a settled wallet", () => {
    // Opening the page is not an event. A program that is already busy when it
    // loads is a state — announcing it would claim something just happened.
    observe(programState("ready"));
    observe(programState("busy", "withdrawing"));
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("announces once per completion, not on every subsequent read", () => {
    observe(
      programState("busy", "withdrawing"),
      programState("ready"),
      programState("ready"),
      programState("ready")
    );
    expect(toasts.success).toHaveBeenCalledTimes(1);
  });

  it("ignores a program that is absent or unconfigured", () => {
    observe(programState("busy", "withdrawing"), { kind: "none" } as EarnProgramState);
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });
});

/**
 * The completion above can only be OBSERVED if the program keeps re-reading
 * while the provider works. A browser cannot demonstrate that — SWR suspends
 * the interval whenever the tab is hidden — so the rule is asserted here.
 */
describe("earnProgramRefreshInterval", () => {
  it("keeps re-reading only while the provider is mid-operation", () => {
    expect(earnProgramRefreshInterval(programState("busy", "withdrawing"))).toBe(10_000);
    expect(earnProgramRefreshInterval(programState("busy", "rebalancing"))).toBe(10_000);
    // Unrecognized busy still converges; that is the state most at risk of
    // sticking forever if it did not.
    expect(earnProgramRefreshInterval(programState("busy"))).toBe(10_000);
    // A wizard step waits on a deposit address that does not exist yet.
    expect(earnProgramRefreshInterval(programState("creating"))).toBe(4_000);
  });

  it("stops entirely once nothing is in flight", () => {
    expect(earnProgramRefreshInterval(programState("ready"))).toBe(0);
    expect(earnProgramRefreshInterval(programState("failed"))).toBe(0);
    expect(earnProgramRefreshInterval({ kind: "none" } as EarnProgramState)).toBe(0);
    expect(earnProgramRefreshInterval(undefined)).toBe(0);
  });

  it("dedupes for less time than it waits between polls", async () => {
    // The dashboard-wide default (10s) equals the busy cadence, so inheriting
    // it would drop each poll inside its own dedupe window and freeze the
    // status exactly while it moves. This is the regression that would make
    // every assertion above true and the feature still broken in a browser.
    const { DASHBOARD_SWR_CONFIG } = await import("@/lib/dashboard-swr-config");
    const cadences = [
      earnProgramRefreshInterval(programState("busy", "withdrawing")),
      earnProgramRefreshInterval(programState("creating")),
    ];
    for (const cadence of cadences) {
      expect(EARN_PROGRAM_DEDUPING_MS).toBeLessThan(cadence);
    }
    expect(DASHBOARD_SWR_CONFIG.dedupingInterval).toBeGreaterThanOrEqual(Math.min(...cadences));
  });
});
