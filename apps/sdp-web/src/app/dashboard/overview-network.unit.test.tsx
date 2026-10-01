// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { NetworkSnapshot } from "./network-stats";
import { NETWORK_STATS_FIXTURE } from "./network-stats.fixture";
import { OverviewNetwork } from "./overview-network";

function renderNetwork(snapshot?: NetworkSnapshot) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <OverviewNetwork snapshot={snapshot} />
    </I18nProvider>
  );
}

const status = () => document.querySelector("[data-network-status]");

afterEach(cleanup);

describe("OverviewNetwork", () => {
  it("labels the fixture as sample data and claims no health", () => {
    renderNetwork();
    expect(status()?.getAttribute("data-network-status")).toBe("sample");
    expect(screen.getByText("Sample data")).toBeTruthy();
    expect(screen.queryByText("Healthy")).toBeNull();
    expect(screen.queryByText("Degraded")).toBeNull();
  });

  it.each([
    ["healthy", "Healthy"],
    ["degraded", "Degraded"],
  ] as const)("shows a live %s status", (health, label) => {
    renderNetwork({ ...NETWORK_STATS_FIXTURE, sample: false, health });
    expect(status()?.getAttribute("data-network-status")).toBe(health);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText("Sample data")).toBeNull();
  });

  it("shows no status when a live snapshot has no health check", () => {
    renderNetwork({ ...NETWORK_STATS_FIXTURE, sample: false, health: null });
    expect(status()).toBeNull();
  });

  it("draws every metric and narrows them to the picked range", () => {
    renderNetwork();
    const figures = document.querySelectorAll("[data-network-metric]");
    expect(figures).toHaveLength(NETWORK_STATS_FIXTURE.metrics.length);
    const plot = screen.getByRole("slider", { name: "Stablecoin supply" });
    expect(plot.getAttribute("aria-valuemax")).toBe("364");
    fireEvent.click(screen.getByRole("radio", { name: "30D" }));
    expect(plot.getAttribute("aria-valuemax")).toBe("29");
    expect(screen.getByRole("link", { name: /solana\.com\/data/ }).getAttribute("href")).toBe(
      "https://solana.com/data"
    );
  });
});
