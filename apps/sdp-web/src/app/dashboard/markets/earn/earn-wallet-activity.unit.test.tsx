// @vitest-environment jsdom
import type { EarnPortfolioWalletActivity, EarnPortfolioWalletStatus } from "@sdp/types";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EarnProgramsState } from "./earn-program-data";
import {
  EARN_PROGRAM_DEDUPING_MS,
  earnProgramsRefreshInterval,
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

function program(
  id: string,
  status: EarnPortfolioWalletStatus,
  activity?: EarnPortfolioWalletActivity
) {
  return {
    id,
    provider: "ground",
    label: "Treasury earn",
    createdAt: "2026-07-18T09:00:00.000Z",
    yield: { currentApy: "0.058", earnedUsd: "0", positions: [] },
    wallet: {
      providerWalletRef: `wallet-ref-${id}`,
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
  };
}

/** Single-program state, the shape most cases here drive. */
function programState(
  status: EarnPortfolioWalletStatus,
  activity?: EarnPortfolioWalletActivity
): EarnProgramsState {
  return { kind: "ready", programs: [program("1", status, activity)] } as EarnProgramsState;
}

/** Multi-program state, for the per-program snapshot rules. */
function programsState(
  ...specs: [string, EarnPortfolioWalletStatus, EarnPortfolioWalletActivity?][]
): EarnProgramsState {
  return {
    kind: "ready",
    programs: specs.map(([id, status, activity]) => program(id, status, activity)),
  } as EarnProgramsState;
}

/** Replays a sequence of provider observations through one mounted hook. */
function observe(...states: Array<EarnProgramsState | undefined>) {
  const { rerender } = renderHook((state: EarnProgramsState | undefined) =>
    useEarnWalletActivityToasts(state)
  );
  for (const state of states) {
    rerender(state);
  }
}

describe("useEarnWalletActivityToasts across several programs", () => {
  beforeEach(() => {
    toasts.success.mockClear();
    toasts.error.mockClear();
  });

  /**
   * The regression this exists to prevent: with one remembered snapshot instead
   * of one per program, the hook compares program A's busy wallet against
   * program B's ready wallet, reads a transition that never happened, and
   * announces money that never moved.
   */
  it("does not announce a completion when only the program ORDER changed", () => {
    observe(
      programsState(["a", "busy", "rebalancing"], ["b", "ready"]),
      // Same two programs, same two statuses — only the order differs.
      programsState(["b", "ready"], ["a", "busy", "rebalancing"])
    );
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("announces the program that actually settled, and only once", () => {
    observe(
      programsState(["a", "busy", "rebalancing"], ["b", "busy", "rebalancing"]),
      programsState(["a", "ready"], ["b", "busy", "rebalancing"])
    );
    expect(toasts.success).toHaveBeenCalledTimes(1);
    expect(toasts.success).toHaveBeenCalledWith(KEY.rebalance);
  });

  it("announces each program separately as each settles", () => {
    observe(
      programsState(["a", "busy", "rebalancing"], ["b", "busy", "rebalancing"]),
      programsState(["a", "ready"], ["b", "busy", "rebalancing"]),
      programsState(["a", "ready"], ["b", "ready"])
    );
    expect(toasts.success).toHaveBeenCalledTimes(2);
  });

  // A program that disappears must not leave a snapshot a re-created id could
  // inherit and fire a transition on first sight.
  /**
   * A non-ready interlude (credentials pulled, a failed read) breaks the
   * observation chain: by the time the read recovers, a busy program may have
   * settled minutes ago, and announcing that pairing would claim a completion
   * nobody watched happen. Recovery must behave like a first mount — silent.
   */
  it("does not announce across an unconfigured interlude", () => {
    observe(
      programsState(["a", "busy", "rebalancing"]),
      { kind: "unconfigured" } as EarnProgramsState,
      programsState(["a", "ready"])
    );
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("forgets a program that is no longer listed", () => {
    observe(
      programsState(["a", "busy", "rebalancing"]),
      programsState(["b", "ready"]),
      programsState(["a", "ready"])
    );
    expect(toasts.success).not.toHaveBeenCalled();
  });
});

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
    observe(programState("busy", "withdrawing"), {
      kind: "ready",
      programs: [],
    } as EarnProgramsState);
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
    renderHook(() => useEarnWithdrawalOutcomeToast("prog_1", ref));
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

  /**
   * The retire signal: a settled watcher has nothing left to do, and keeping it
   * mounted accumulates dead SWR subscriptions over a long session — so the
   * caller must hear exactly one "done" to unmount it, and must NOT hear it
   * while the withdrawal is still in flight.
   */
  it("fires onSettled once on a terminal status, and not before", async () => {
    const settled = vi.fn();
    fetchMock.mockResolvedValue(withdrawalOf("wd_settle_cb", "processing"));
    const { rerender } = renderHook(() =>
      useEarnWithdrawalOutcomeToast("prog_1", "wd_settle_cb", settled)
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(settled).not.toHaveBeenCalled();

    // SWR caches by key, so drive the terminal read through a fresh key the
    // way the sibling cases do — same watcher semantics, new withdrawal.
    fetchMock.mockResolvedValue(withdrawalOf("wd_settle_done", "completed"));
    rerender();
    renderHook(() => useEarnWithdrawalOutcomeToast("prog_1", "wd_settle_done", settled));
    await act(async () => {
      await Promise.resolve();
    });
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("issues no request at all when nothing was submitted", async () => {
    renderHook(() => useEarnWithdrawalOutcomeToast(undefined, undefined));
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The key is a conjunction, so each half must gate on its own: a withdrawal
  // ref with no resolved program would otherwise build /programs/undefined/...
  it("issues no request when only one half of the key is known", async () => {
    renderHook(() => useEarnWithdrawalOutcomeToast("prog_1", undefined));
    renderHook(() => useEarnWithdrawalOutcomeToast(undefined, "wd_1"));
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
    expect(earnProgramsRefreshInterval(programState("busy", "withdrawing"))).toBe(10_000);
    expect(earnProgramsRefreshInterval(programState("busy", "rebalancing"))).toBe(10_000);
    // Unrecognized busy still converges; that is the state most at risk of
    // sticking forever if it did not.
    expect(earnProgramsRefreshInterval(programState("busy"))).toBe(10_000);
    // A wizard step waits on a deposit address that does not exist yet.
    expect(earnProgramsRefreshInterval(programState("creating"))).toBe(4_000);
  });

  it("stops entirely once nothing is in flight", () => {
    expect(earnProgramsRefreshInterval(programState("ready"))).toBe(0);
    expect(earnProgramsRefreshInterval(programState("failed"))).toBe(0);
    expect(earnProgramsRefreshInterval({ kind: "ready", programs: [] } as EarnProgramsState)).toBe(
      0
    );
    expect(earnProgramsRefreshInterval(undefined)).toBe(0);
  });

  it("dedupes for less time than it waits between polls", async () => {
    // The dashboard-wide default (10s) equals the busy cadence, so inheriting
    // it would drop each poll inside its own dedupe window and freeze the
    // status exactly while it moves. This is the regression that would make
    // every assertion above true and the feature still broken in a browser.
    const { DASHBOARD_SWR_CONFIG } = await import("@/lib/dashboard-swr-config");
    const cadences = [
      earnProgramsRefreshInterval(programState("busy", "withdrawing")),
      earnProgramsRefreshInterval(programState("creating")),
    ];
    for (const cadence of cadences) {
      expect(EARN_PROGRAM_DEDUPING_MS).toBeLessThan(cadence);
    }
    expect(DASHBOARD_SWR_CONFIG.dedupingInterval).toBeGreaterThanOrEqual(Math.min(...cadences));
  });
});
