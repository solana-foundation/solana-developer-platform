// @vitest-environment jsdom
import type { EarnPortfolioWalletActivity, EarnPortfolioWalletStatus } from "@sdp/types";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EarnProgramState } from "./earn-program-data";
import {
  EARN_PROGRAM_DEDUPING_MS,
  earnProgramRefreshInterval,
  useEarnWalletActivityToasts,
  useEarnWithdrawalOutcomeToast,
} from "./earn-program-data";

/**
 * Money-path coverage for what the dashboard ANNOUNCES about an operation the
 * provider is running. The provider is the source of truth, so every case here
 * drives the hook with provider-observed states and asserts we never announce
 * something the provider did not report.
 */

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
// The withdrawal watcher reads through the shared dashboard fetcher; stubbing
// that seam keeps these tests off the network while exercising the real hook.
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/dashboard-fetch", () => ({ dashboardFetch: fetchMock }));
vi.mock("@/i18n/provider", () => ({ useTranslations: () => (key: string) => key }));

const KEY = {
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

  it("says nothing about a withdrawal when the wallet merely goes idle", () => {
    // The wallet only reports that the provider STOPPED — a failed, cancelled
    // or partial payout leaves it exactly as idle as a settled one. Claiming
    // settlement from this transition would be wrong when it matters most, so
    // the outcome comes from the withdrawal itself.
    observe(programState("busy", "withdrawing"), programState("ready"));
    expect(toasts.success).not.toHaveBeenCalled();
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

  it("reports a wallet failure as a failure, not a completion", () => {
    observe(programState("busy", "rebalancing"), programState("failed"));
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
      programState("busy", "rebalancing"),
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
 * How a withdrawal ENDED, which the wallet transition above deliberately does
 * not claim. Each case pins that the announcement matches the provider's own
 * withdrawal status — the only thing that knows whether money arrived.
 */
describe("useEarnWithdrawalOutcomeToast", () => {
  const OUTCOME = {
    completed: "DashboardEarn.overview.withdrawalCompleted",
    partial: "DashboardEarn.overview.withdrawalPartiallyCompleted",
    failed: "DashboardEarn.overview.withdrawalFailed",
    cancelled: "DashboardEarn.overview.withdrawalCancelled",
  };

  function withdrawalOf(ref: string, status: string) {
    return {
      ok: true as const,
      data: { data: { withdrawal: { withdrawalRef: ref, status, destinationAddress: "addr" } } },
    };
  }

  beforeEach(() => {
    toasts.success.mockClear();
    toasts.error.mockClear();
    fetchMock.mockReset();
  });

  /**
   * SWR caches globally by key, so each case watches its OWN ref — sharing one
   * would replay the previous status and quietly assert nothing.
   */
  async function watch(status: string) {
    const ref = `wd_${status}`;
    fetchMock.mockResolvedValue(withdrawalOf(ref, status));
    renderHook(() => useEarnWithdrawalOutcomeToast(ref));
    // Let SWR resolve the first read and the effect run.
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("announces settlement only when the provider says completed", async () => {
    await watch("completed");
    expect(toasts.success).toHaveBeenCalledWith(OUTCOME.completed);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("does NOT call a failed withdrawal complete", async () => {
    // The wallet is idle either way; only this status distinguishes them.
    await watch("failed");
    expect(toasts.error).toHaveBeenCalledWith(OUTCOME.failed);
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("does NOT call a cancelled withdrawal complete", async () => {
    await watch("cancelled");
    expect(toasts.error).toHaveBeenCalledWith(OUTCOME.cancelled);
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("treats a partial payout as a problem, never a success", async () => {
    // Some of the money did not arrive; "complete" would be the exact lie
    // this hook exists to prevent.
    await watch("partially_completed");
    expect(toasts.error).toHaveBeenCalledWith(OUTCOME.partial);
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("stays silent while the withdrawal is still in flight", async () => {
    await watch("processing");
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("keeps waiting on an approval rather than calling it an outcome", async () => {
    // Parked on a signature — it still resolves later, so announcing now
    // would close a story that has not ended.
    await watch("pending_approval");
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("issues no request at all when nothing was submitted", async () => {
    renderHook(() => useEarnWithdrawalOutcomeToast(undefined));
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
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
