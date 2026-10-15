// @vitest-environment jsdom

import type { NetworkHealth, NetworkHealthReading } from "@sdp/types/network-metrics";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { buildNetworkStatsFixture } from "./network-stats.fixture";
import { OverviewNetwork, type OverviewNetworkProps } from "./overview-network";

const AS_OF = "2026-10-12";
const FIXTURE = buildNetworkStatsFixture(AS_OF);
/** 21 hours after the fixture's day closed. */
const NOW = Date.parse("2026-10-13T21:00:00Z");

function renderNetwork(props: OverviewNetworkProps) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <OverviewNetwork {...props} />
    </I18nProvider>
  );
}

const status = () => document.querySelector("[data-network-status]");

/** A health reading the status page gave `ageMs` before NOW. */
function checked(state: NetworkHealth, ageMs = 60_000): NetworkHealthReading {
  return { state, checkedAt: new Date(NOW - ageMs).toISOString() };
}
const freshness = () => document.querySelector("[data-network-freshness]");

// The section counts the figures' age on the browser's clock, pinned here 21 hours past the close.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("OverviewNetwork status", () => {
  it.each([
    ["operational", "Healthy"],
    ["degraded", "Degraded"],
    ["outage", "Outage"],
    ["maintenance", "Maintenance"],
  ] as const)("shows the cluster's %s state", (state, label) => {
    renderNetwork({ status: "ready", snapshot: { ...FIXTURE, health: checked(state) } });
    expect(status()?.getAttribute("data-network-status")).toBe(state);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it("drops a health reading too old to stand for now, as on a page left open", () => {
    const health = checked("operational", 11 * 60_000);
    renderNetwork({ status: "ready", snapshot: { ...FIXTURE, health } });
    expect(status()).toBeNull();
    expect(screen.queryByText("Healthy")).toBeNull();
  });

  it("shows no status when the health check did not answer", () => {
    renderNetwork({ status: "ready", snapshot: { ...FIXTURE, health: null } });
    expect(status()).toBeNull();
  });
});

describe("OverviewNetwork freshness", () => {
  it("counts from the close of the latest day and names that day", () => {
    renderNetwork({ status: "ready", snapshot: FIXTURE });
    expect(freshness()?.getAttribute("data-network-freshness")).toBe("recent");
    expect(screen.getByText("21h ago").getAttribute("datetime")).toBe(AS_OF);
    expect(screen.getByText("Daily figures through Oct 12, 2026 (UTC)")).toBeTruthy();
  });

  it("keeps counting on the browser's clock while the page stays open", () => {
    renderNetwork({ status: "ready", snapshot: FIXTURE });
    expect(screen.getByText("21h ago")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(60 * 60_000);
    });
    expect(screen.getByText("22h ago")).toBeTruthy();
  });

  it("names the date once the figures are days old, never an age that passes as today", () => {
    vi.setSystemTime(NOW + 4 * 86_400_000);
    renderNetwork({ status: "ready", snapshot: FIXTURE });
    expect(freshness()?.getAttribute("data-network-freshness")).toBe("dated");
    expect(screen.getByText("As of Oct 12, 2026")).toBeTruthy();
    expect(screen.queryByText(/ago$/)).toBeNull();
  });
});

describe("OverviewNetwork figures", () => {
  it("draws every metric and narrows them to the picked range", () => {
    renderNetwork({ status: "ready", snapshot: FIXTURE });
    expect(document.querySelectorAll("[data-network-metric]")).toHaveLength(4);
    const plot = screen.getByRole("slider", { name: "Stablecoin supply" });
    expect(plot.getAttribute("aria-valuemax")).toBe("364");
    expect(plot.getAttribute("aria-valuetext")).toBe("$16.27B on Oct 12, 2026");
    fireEvent.click(screen.getByRole("radio", { name: "30D" }));
    expect(plot.getAttribute("aria-valuemax")).toBe("29");
    expect(screen.getByRole("link", { name: /^solana\.com\/data$/ }).getAttribute("href")).toBe(
      "https://solana.com/data"
    );
  });

  it("charts transfers as a weekly 7-day average on 1Y and a daily one on 30D", () => {
    renderNetwork({ status: "ready", snapshot: FIXTURE });
    const transfers = screen.getByRole("slider", { name: "Stablecoin transfers, 7-day average" });
    expect(transfers.getAttribute("aria-valuemax")).toBe("51");
    fireEvent.click(screen.getByRole("radio", { name: "30D" }));
    expect(transfers.getAttribute("aria-valuemax")).toBe("29");
  });

  it("marks the averaged figures 7d avg and leaves supply daily", () => {
    renderNetwork({ status: "ready", snapshot: FIXTURE });
    const tagged = [...document.querySelectorAll("[data-network-metric]")].map((figure) => [
      figure.getAttribute("data-network-metric"),
      figure.querySelector("figcaption")?.textContent?.includes("7d avg"),
    ]);
    expect(tagged).toEqual([
      ["stablecoinSupply", false],
      ["stablecoinTransfers", true],
      ["stablecoinShare", true],
      ["costPerTransaction", true],
    ]);
  });

  it("draws the design's 12px hint icon, not InfoHint's 16px default", () => {
    renderNetwork({ status: "ready", snapshot: FIXTURE });
    const hint = document.querySelector("figcaption button");
    expect(hint?.className.split(" ")).toContain("[&_svg]:size-3");
  });

  it("states the headline's change over the range for assistive technology", () => {
    renderNetwork({ status: "ready", snapshot: FIXTURE });
    const supply = document.querySelector('[data-network-metric="stablecoinSupply"]');
    expect(supply?.textContent).toContain("$16.27B+29.7% over 1Y");
  });

  it("marks a metric with no complete day as unavailable and keeps the rest", () => {
    const metrics = { ...FIXTURE.metrics, costPerTransaction: [] };
    renderNetwork({ status: "ready", snapshot: { ...FIXTURE, metrics } });
    const cost = document.querySelector('[data-network-metric="costPerTransaction"]');
    expect(cost?.getAttribute("data-network-metric-state")).toBe("empty");
    expect(cost?.textContent).toContain("Unavailable");
    // The chart's footprint stays, so the figure is as tall as the three beside it.
    expect(cost?.querySelector("[data-chart-empty]")).not.toBeNull();
    expect(screen.queryByRole("slider", { name: "Cost per transaction" })).toBeNull();
    expect(screen.getAllByRole("slider")).toHaveLength(3);
  });
});

describe("OverviewNetwork without figures", () => {
  it("holds the layout with placeholders while loading", () => {
    renderNetwork({ status: "loading" });
    const section = document.querySelector('[data-overview-section="network"]');
    expect(section?.getAttribute("aria-busy")).toBe("true");
    expect(document.querySelectorAll("[data-network-metric]")).toHaveLength(0);
    expect(status()).toBeNull();
    expect(freshness()).toBeNull();
    expect(screen.getByRole("radio", { name: "1Y" }).closest("fieldset")?.disabled).toBe(true);
  });

  it("keeps the four figures in place, each unavailable, rather than showing old ones", () => {
    renderNetwork({ status: "unavailable" });
    const figures = [...document.querySelectorAll("[data-network-metric]")];
    expect(figures.map((figure) => figure.getAttribute("data-network-metric-state"))).toEqual([
      "empty",
      "empty",
      "empty",
      "empty",
    ]);
    expect(figures.every((figure) => figure.querySelector("[data-chart-empty]"))).toBe(true);
    expect(screen.getAllByText("Unavailable")).toHaveLength(4);
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
    expect(status()).toBeNull();
    expect(freshness()).toBeNull();
  });
});
