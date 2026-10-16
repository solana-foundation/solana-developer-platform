/** The plot's drawing space: the SVG stretches this square onto the plot's box. */
export const CHART_VIEW = 1000;

export interface ChartPaths {
  line: string;
  /** The line closed down to the floor, for the fill under it. */
  area: string;
}

/** Steffen's tangent at a reading between two others, as d3's curveMonotoneX takes it. */
function innerTangent(before: number, after: number): number {
  const sign = (slope: number) => (slope < 0 ? -1 : 1);
  return (
    (sign(before) + sign(after)) *
    Math.min(Math.abs(before), Math.abs(after), 0.25 * Math.abs(before + after))
  );
}

/**
 * The line through a series and its fill, in the CHART_VIEW square: a reading's x is its place
 * in the series and its y its distance below `ceiling`. The line is a monotone cubic through
 * every reading, so it reads smooth at 30 days yet never overshoots between two readings: it
 * draws no peak or dip the data lacks. Its end tangents are one-sided, so the first and last
 * segments bend into their neighbours. Whole-unit coordinates keep the path short; at a plot
 * under 1,000px a unit is under a pixel.
 */
export function chartPaths(values: readonly number[], floor: number, ceiling: number): ChartPaths {
  const count = values.length;
  const ys = values.map((value) => ((ceiling - value) / (ceiling - floor)) * CHART_VIEW);
  const round = (n: number) => Math.round(n);
  if (count === 0) return { line: "", area: "" };
  if (count === 1) return { line: `M${CHART_VIEW} ${round(ys[0])}`, area: "" };

  const step = CHART_VIEW / (count - 1);
  const slopes = ys.slice(1).map((y, index) => (y - ys[index]) / step);
  const tangents = ys.map((_, index) =>
    index === 0 || index === count - 1 ? 0 : innerTangent(slopes[index - 1], slopes[index])
  );
  if (count > 2) {
    tangents[0] = (3 * slopes[0] - tangents[1]) / 2;
    tangents[count - 1] = (3 * slopes[count - 2] - tangents[count - 2]) / 2;
  } else {
    tangents[0] = slopes[0];
    tangents[1] = slopes[0];
  }

  const third = step / 3;
  const segments = [`M0 ${round(ys[0])}`];
  for (let index = 1; index < count; index++) {
    const x0 = (index - 1) * step;
    const x1 = index * step;
    const y0 = ys[index - 1];
    const y1 = ys[index];
    segments.push(
      `C${round(x0 + third)} ${round(y0 + tangents[index - 1] * third)} ${round(x1 - third)} ${round(y1 - tangents[index] * third)} ${round(x1)} ${round(y1)}`
    );
  }
  const line = segments.join("");
  return { line, area: `${line}L${CHART_VIEW} ${CHART_VIEW}L0 ${CHART_VIEW}Z` };
}
