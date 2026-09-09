// @vitest-environment jsdom

/**
 * Watching an open trade.
 *
 * The behaviour under test is the one nothing else covers: a change nobody on
 * this page caused. A funded escrow is the counterparty's doing and no event
 * announces it, so the page has to look — and it has to stop looking once the
 * trade is over or the tab is not being watched.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DvpTrade } from "./dvp-trade";
import { useDvpTradeWatch } from "./use-dvp-trade-watch";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

function trade(status: string): DvpTrade {
  return { id: "dvp_1", status } as unknown as DvpTrade;
}

function Probe({ value }: { value: DvpTrade }) {
  useDvpTradeWatch(value);
  return null;
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useDvpTradeWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockClear();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("re-reads an open trade while it is being watched", () => {
    render(<Probe value={trade("partially_funded")} />);

    vi.advanceTimersByTime(18_000);

    expect(refresh).toHaveBeenCalled();
  });

  // Settled and cancelled are terminal. Polling one asks the same question
  // forever and can never get a different answer.
  it.each(["settled", "cancelled"])("stops once the trade is %s", (status) => {
    render(<Probe value={trade(status)} />);

    vi.advanceTimersByTime(30_000);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not poll a tab nobody is looking at", () => {
    render(<Probe value={trade("funded")} />);
    refresh.mockClear();

    setVisibility("hidden");
    vi.advanceTimersByTime(30_000);

    expect(refresh).not.toHaveBeenCalled();
  });

  // Returning to the tab is when the page is most likely to be out of date, so
  // it re-reads then rather than waiting out another interval first.
  it("re-reads immediately when the tab comes back", () => {
    render(<Probe value={trade("funded")} />);
    setVisibility("hidden");
    refresh.mockClear();

    setVisibility("visible");

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops polling once unmounted", () => {
    const view = render(<Probe value={trade("created")} />);
    view.unmount();
    refresh.mockClear();

    vi.advanceTimersByTime(30_000);

    expect(refresh).not.toHaveBeenCalled();
  });
});
