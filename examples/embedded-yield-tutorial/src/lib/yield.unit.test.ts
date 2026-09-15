import { describe, expect, it } from "vitest";
import { balanceAfterDays, EARN_APY, yieldSeries } from "./yield";

describe("balanceAfterDays", () => {
  it("returns the principal before any time passes", () => {
    expect(balanceAfterDays(12_500, EARN_APY, 0)).toBe(12_500);
  });

  it("returns zero for a zero balance", () => {
    expect(balanceAfterDays(0, EARN_APY, 30)).toBe(0);
  });

  it("approximates continuously compounded growth after a year", () => {
    const balance = balanceAfterDays(1_000, EARN_APY, 365);
    expect(balance).toBeGreaterThan(1_049);
    expect(balance).toBeLessThan(1_050);
  });

  it("supports fractional days for the animation sweep", () => {
    const half = balanceAfterDays(12_500, EARN_APY, 0.5);
    expect(half).toBeGreaterThan(12_500);
    expect(half).toBeLessThan(balanceAfterDays(12_500, EARN_APY, 1));
  });
});

describe("yieldSeries", () => {
  it("produces one inclusive point per day", () => {
    expect(yieldSeries(12_500, EARN_APY, 30)).toHaveLength(31);
  });

  it("starts at the principal and rises monotonically", () => {
    const series = yieldSeries(12_500, EARN_APY, 30);
    expect(series[0]).toBe(12_500);
    for (let day = 1; day < series.length; day += 1) {
      expect(series[day]).toBeGreaterThan(series[day - 1]);
    }
  });

  it("grows roughly one twelfth of the APY over 30 days", () => {
    const series = yieldSeries(12_500, EARN_APY, 30);
    const growth = (series[30] - series[0]) / series[0];
    expect(growth).toBeGreaterThan(0.0035);
    expect(growth).toBeLessThan(0.0045);
  });
});
