import { describe, expect, it } from "vitest";
import { balanceAfterDays, EARN_APY, rateWobble, yieldSeries } from "./yield";

describe("balanceAfterDays", () => {
  it("returns the principal before any time passes", () => {
    expect(balanceAfterDays(12_500, EARN_APY, 0)).toBe(12_500);
  });

  it("returns zero for a zero balance", () => {
    expect(balanceAfterDays(0, EARN_APY, 30)).toBe(0);
  });

  it("lands near continuously compounded growth after a year", () => {
    const balance = balanceAfterDays(1_000, EARN_APY, 365);
    const continuouslyCompounded = 1_000 * Math.exp(EARN_APY);
    expect(balance).toBeGreaterThan(continuouslyCompounded - 3);
    expect(balance).toBeLessThan(continuouslyCompounded + 3);
  });

  it("supports fractional days for the animation sweep", () => {
    const half = balanceAfterDays(12_500, EARN_APY, 0.5);
    expect(half).toBeGreaterThan(12_500);
    expect(half).toBeLessThan(balanceAfterDays(12_500, EARN_APY, 1));
  });

  it("accrues a positive amount every single day", () => {
    const series = yieldSeries(12_500, EARN_APY, 30);
    for (let day = 1; day < series.length; day += 1) {
      expect(series[day]).toBeGreaterThan(series[day - 1]);
    }
  });

  it("does not accrue in a straight line", () => {
    const series = yieldSeries(12_500, EARN_APY, 30);
    const deltas = series
      .slice(1)
      .map((balance, index) => balance - series[index]);
    const uniqueDeltas = new Set(deltas.map((delta) => delta.toFixed(6)));
    expect(uniqueDeltas.size).toBeGreaterThan(3);
  });

  it("wobbles the daily rate around the average", () => {
    const wobbles = Array.from({ length: 365 }, (_, day) => rateWobble(day));
    for (const wobble of wobbles) {
      expect(wobble).toBeGreaterThanOrEqual(-0.55);
      expect(wobble).toBeLessThanOrEqual(0.55);
    }
    const average =
      wobbles.reduce((sum, wobble) => sum + wobble, 0) / wobbles.length;
    expect(Math.abs(average)).toBeLessThan(0.15);
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
    const monthly = EARN_APY / 12;
    expect(growth).toBeGreaterThan(monthly * 0.8);
    expect(growth).toBeLessThan(monthly * 1.2);
  });
});
