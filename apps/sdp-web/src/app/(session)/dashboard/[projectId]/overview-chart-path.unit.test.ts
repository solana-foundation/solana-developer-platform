import { describe, expect, it } from "vitest";
import { CHART_VIEW, chartPaths } from "./overview-chart-path";

/** Every point a path visits, control points included, as [x, y] pairs. */
function coordinates(path: string): Array<[number, number]> {
  const numbers = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const pairs: Array<[number, number]> = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    pairs.push([numbers[index] ?? 0, numbers[index + 1] ?? 0]);
  }
  return pairs;
}

/** The on-curve points: the move, then each cubic's end point. */
function anchors(path: string): Array<[number, number]> {
  const pairs = coordinates(path);
  return pairs.filter((_, index) => index === 0 || index % 3 === 0);
}

describe("chartPaths", () => {
  it("passes through every reading, floor at the bottom and ceiling at the top", () => {
    const { line } = chartPaths([10, 20, 15, 30], 10, 30);
    expect(anchors(line)).toEqual([
      [0, 1000],
      [333, 500],
      [667, 750],
      [1000, 0],
    ]);
  });

  it("never bends past a reading's neighbours, so it draws no peak the data lacks", () => {
    const values = [5, 5, 9, 9, 2, 8, 8, 8, 3];
    const { line } = chartPaths(values, 0, 10);
    const ys = coordinates(line).map(([, y]) => y);
    const yOf = (value: number) => ((10 - value) / 10) * CHART_VIEW;
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(Math.round(yOf(9)));
    expect(Math.max(...ys)).toBeLessThanOrEqual(Math.round(yOf(2)));
    // A flat stretch stays flat: its control points sit on the readings.
    const [, second, third] = line.split("C");
    expect(coordinates(second ?? "").every(([, y]) => y === Math.round(yOf(5)))).toBe(true);
    expect(coordinates(third ?? "").at(-1)?.[1]).toBe(Math.round(yOf(9)));
  });

  it("closes the fill down to the floor across the plot", () => {
    const { line, area } = chartPaths([1, 2], 0, 2);
    expect(area).toBe(`${line}L${CHART_VIEW} ${CHART_VIEW}L0 ${CHART_VIEW}Z`);
  });

  it("draws nothing without readings and a lone point at the latest edge", () => {
    expect(chartPaths([], 0, 1)).toEqual({ line: "", area: "" });
    expect(chartPaths([5], 0, 10)).toEqual({ line: `M${CHART_VIEW} 500`, area: "" });
  });

  it("keeps whole-unit coordinates so a year of readings stays a short path", () => {
    const year = Array.from({ length: 365 }, (_, day) => 100 + Math.sin(day / 9) * 10);
    const { line } = chartPaths(year, 80, 120);
    expect(line).not.toMatch(/\./);
    expect(line.length).toBeLessThan(365 * 32);
  });
});
