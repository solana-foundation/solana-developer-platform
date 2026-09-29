// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { OverviewAreaChart } from "./overview-area-chart";

const DATES = ["Sep 1", "Sep 2", "Sep 3", "Sep 4", "Sep 5"];
// Low, then high: the second reading sits near the floor, the fourth near the ceiling.
const VALUES = [12, 11, 14, 19, 18];

function renderChart() {
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <OverviewAreaChart
        label="Stablecoin share of activity"
        values={VALUES}
        ticks={[10, 15, 20]}
        formatTick={(value) => `${value}%`}
        formatValue={(value) => `${value.toFixed(1)}%`}
        formatDate={(index) => DATES[index] ?? ""}
        dateLabels={["Sep 1", "Sep 3", "Sep 5"]}
      />
    </I18nProvider>
  );
  const plot = screen.getByRole("slider", { name: "Stablecoin share of activity" });
  // 7px insets either side leave 400px for the five readings, 100px apart.
  plot.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 414, height: 182, right: 414, bottom: 182 }) as DOMRect;
  return plot;
}

const card = () => document.querySelector("[data-chart-reading]");
const cursor = () => document.querySelector("[data-chart-cursor]");

afterEach(cleanup);

describe("OverviewAreaChart hover", () => {
  it("rests on the latest reading with no card", () => {
    const plot = renderChart();
    expect(plot.getAttribute("aria-valuetext")).toBe("18.0% on Sep 5");
    expect(card()).toBeNull();
    expect(cursor()).toBeNull();
  });

  it("names the nearest reading under the pointer, and clears when the pointer leaves", () => {
    const plot = renderChart();
    // 7 + 190 is 1.9 readings in: the nearest is the third.
    fireEvent.pointerMove(plot, { clientX: 197 });

    expect(card()?.textContent).toBe("Sep 314.0%");
    expect(cursor()).not.toBeNull();
    expect(plot.getAttribute("aria-valuenow")).toBe("2");
    expect(plot.getAttribute("aria-valuetext")).toBe("14.0% on Sep 3");

    fireEvent.pointerLeave(plot.parentElement as HTMLElement);
    expect(card()).toBeNull();
    expect(plot.getAttribute("aria-valuetext")).toBe("18.0% on Sep 5");
  });

  it("puts the card at the foot for a high reading and at the top for a low one", () => {
    const plot = renderChart();
    fireEvent.pointerMove(plot, { clientX: 307 });
    expect(card()?.className).toContain("bottom-2");

    fireEvent.pointerMove(plot, { clientX: 107 });
    expect(card()?.className).toContain("top-0");
  });

  it("pins the card to an edge near either end", () => {
    const plot = renderChart();
    fireEvent.pointerMove(plot, { clientX: 0 });
    expect(card()?.className.split(" ")).toContain("-translate-x-1");

    fireEvent.pointerMove(plot, { clientX: 414 });
    expect(card()?.className).toContain("-translate-x-[calc(100%-var(--spacing))]");
  });

  it("steps through the readings from the keyboard", () => {
    const plot = renderChart();
    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    expect(card()?.textContent).toBe("Sep 419.0%");

    fireEvent.keyDown(plot, { key: "Home" });
    expect(plot.getAttribute("aria-valuetext")).toBe("12.0% on Sep 1");
    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    expect(plot.getAttribute("aria-valuenow")).toBe("0");

    fireEvent.keyDown(plot, { key: "Escape" });
    expect(card()).toBeNull();
  });
});
