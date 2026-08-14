// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

// The panels each fetch; this suite is about the tab STRIP, so they are stubbed
// down to markers. Their own behaviour is covered in earn-workspace.unit.test.
vi.mock("./earn-program-data", () => ({
  useEarnPrograms: () => ({ state: { kind: "ready", programs: [] } }),
  useEarnStrategies: () => ({ strategies: [], error: undefined, isLoading: false }),
  useEarnWalletActivityToasts: () => {},
  useEarnWithdrawalOutcomeToast: () => {},
  hasPrograms: () => false,
  findProgram: () => undefined,
  EARN_PROGRAM_CREATION_ENABLED: false,
  EARN_PROGRAM_CREATE_PROVIDER: undefined,
  SURFACED_CUSTODIAL_EARN_PROVIDERS: [],
}));

vi.mock("./earn-playground", () => ({
  EarnPlayground: () => <div data-testid="playground-panel" />,
}));

import { EarnWorkspace } from "./earn-workspace";

afterEach(cleanup);

/**
 * ARIA tabs are a TWO-part contract and shipping only half of it is worse than
 * shipping neither: `tabIndex={-1}` takes the inactive tabs out of the Tab
 * order, so without key handling they become unreachable rather than merely
 * skipped — a keyboard-only reader could not open Positions or the playground
 * at all. Caught in review on #1340.
 */
describe("Earn tab strip keyboard navigation", () => {
  // No jest-dom matchers in this project, so assertions read the DOM directly —
  // the same style as strategy-step.unit.test.tsx.
  function tab(name: string) {
    // The Positions label carries its program count, so match on prefix.
    return screen.getByRole("tab", { name: new RegExp(`^${name}`) });
  }
  const selected = (name: string) => tab(name).getAttribute("aria-selected");

  it("moves and selects with arrow keys, wrapping at both ends", async () => {
    const user = userEvent.setup();
    render(<EarnWorkspace />);

    const opportunities = tab("DashboardEarn.tabs.opportunities");
    expect(opportunities.getAttribute("aria-selected")).toBe("true");

    opportunities.focus();
    await user.keyboard("{ArrowRight}");
    expect(selected("DashboardEarn.tabs.positions")).toBe("true");

    await user.keyboard("{ArrowRight}");
    expect(selected("DashboardEarn.tabs.playground")).toBe("true");

    // Wraps forward off the end...
    await user.keyboard("{ArrowRight}");
    expect(selected("DashboardEarn.tabs.opportunities")).toBe("true");

    // ...and backward off the start.
    await user.keyboard("{ArrowLeft}");
    expect(selected("DashboardEarn.tabs.playground")).toBe("true");
  });

  it("jumps to the ends with Home and End", async () => {
    const user = userEvent.setup();
    render(<EarnWorkspace />);

    tab("DashboardEarn.tabs.opportunities").focus();
    await user.keyboard("{End}");
    expect(selected("DashboardEarn.tabs.playground")).toBe("true");

    await user.keyboard("{Home}");
    expect(selected("DashboardEarn.tabs.opportunities")).toBe("true");
  });

  /**
   * Focus has to FOLLOW selection, not just precede it: the newly active tab is
   * the only one left in the Tab order, so focus left behind on the old tab
   * strands the reader — their next Tab press lands somewhere unrelated.
   */
  it("carries focus onto the newly selected tab", async () => {
    const user = userEvent.setup();
    render(<EarnWorkspace />);

    tab("DashboardEarn.tabs.opportunities").focus();
    await user.keyboard("{ArrowRight}");

    const positions = tab("DashboardEarn.tabs.positions");
    expect(document.activeElement).toBe(positions);
    expect(positions.getAttribute("tabindex")).toBe("0");
    expect(tab("DashboardEarn.tabs.opportunities").getAttribute("tabindex")).toBe("-1");
  });

  it("switches the rendered panel, not just the tab state", async () => {
    const user = userEvent.setup();
    render(<EarnWorkspace />);

    expect(screen.getByRole("tabpanel").getAttribute("id")).toBe("earn-panel-opportunities");

    tab("DashboardEarn.tabs.opportunities").focus();
    await user.keyboard("{End}");
    expect(screen.queryByTestId("playground-panel")).not.toBeNull();
  });
});
