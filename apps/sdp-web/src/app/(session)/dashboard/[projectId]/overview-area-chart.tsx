import { cn } from "@sdp/ui/cn";
import { type KeyboardEvent, memo, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "@/i18n/provider";
import { CHART_VIEW, type ChartPaths, chartPaths } from "./overview-chart-path";

/** The data sits 7px inside the plot so the end dot never clips on the right edge. */
const INSET_PX = 7;

/** The plot beside a 3rem column of tick labels; a caption row above can share the columns. */
export const CHART_COLUMNS = "grid grid-cols-[minmax(0,1fr)_3rem] gap-x-2";
/** The plot's height, shared by every stand-in for the chart so none of them moves the page. */
export const CHART_PLOT_HEIGHT = "h-[11.375rem]";
/**
 * The plot and the tick column place what is inside them with transforms against their own size
 * (`cqw` and `cqh`), never with left or top. A transform moves no layout, so a hover, a range
 * switch or a refreshed figure shifts nothing on the page, and each move skips layout entirely.
 */
const SIZE_CONTAINER = "[container-type:size]";

/** The reading a key moves to, or null for a key the chart leaves alone. */
function readingForKey(key: string, from: number, last: number): number | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return Math.max(0, from - 1);
    case "ArrowRight":
    case "ArrowUp":
      return Math.min(last, from + 1);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

interface VerticalScale {
  floor: number;
  ceiling: number;
  /** A value's distance from the top, in percent of the plot. */
  topPercent: (value: number) => number;
  /** The same distance as a length inside a size container. */
  yOf: (value: number) => string;
}

/** The scale over ticks that bracket the data: at least two, the first below the last. */
function verticalScale(ticks: readonly number[]): VerticalScale {
  const floor = ticks[0];
  const ceiling = ticks[ticks.length - 1];
  const topPercent = (value: number) => ((ceiling - value) / (ceiling - floor)) * 100;
  return { floor, ceiling, topPercent, yOf: (value) => `${topPercent(value)}cqh` };
}

/** A reading's horizontal position, inside the plot's inset. */
function horizontalScale(last: number) {
  const fractionOf = (index: number) => (last === 0 ? 1 : index / last);
  return {
    fractionOf,
    xOf: (index: number) =>
      `calc(${INSET_PX}px + (100cqw - ${INSET_PX * 2}px) * ${fractionOf(index)})`,
  };
}

/** The reading the pointer or the keyboard picked, or null while the chart is at rest. */
function useChartReading(values: readonly number[]) {
  const last = values.length - 1;
  // A pick belongs to the series it was made on. When a refresh or a new range swaps the series
  // it lapses, rather than pointing past the end of a shorter one.
  const [pick, setPick] = useState<{ values: readonly number[]; index: number } | null>(null);
  const active = pick !== null && pick.values === values ? pick.index : null;
  const plotRef = useRef<HTMLDivElement>(null);
  const shown = active ?? last;

  /** Picks a reading, or none. An unchanged pick keeps its state, so moving within one reading
   * re-renders nothing. */
  function setActive(index: number | null) {
    setPick((previous) => {
      if (index === null) return null;
      if (previous !== null && previous.values === values && previous.index === index) {
        return previous;
      }
      return { values, index };
    });
  }

  /** Picks the reading nearest `clientX`, measuring the plot on every move: it can shift or
   * resize under a resting pointer. */
  function pickAt(clientX: number) {
    const plot = plotRef.current;
    if (!plot || last === 0) {
      return;
    }
    const box = plot.getBoundingClientRect();
    const width = box.width - INSET_PX * 2;
    if (width <= 0) {
      return;
    }
    const ratio = (clientX - box.left - INSET_PX) / width;
    setActive(Math.max(0, Math.min(last, Math.round(ratio * last))));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      setActive(null);
      return;
    }
    const next = readingForKey(event.key, shown, last);
    if (next === null) {
      return;
    }
    event.preventDefault();
    setActive(next);
  }

  function clear() {
    setActive(null);
  }

  return { active, shown, last, plotRef, pickAt, handleKeyDown, clear };
}

/** Dotted gridlines on the ticks over a solid baseline. */
const ChartGridlines = memo(function ChartGridlines({
  ticks,
  scale,
}: {
  ticks: readonly number[];
  scale: VerticalScale;
}) {
  return ticks.map((tick, index) => (
    <span
      key={tick}
      aria-hidden="true"
      style={{ transform: `translateY(${scale.yOf(tick)})` }}
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 h-px",
        index === 0
          ? "bg-border-default"
          : "bg-[repeating-linear-gradient(to_right,var(--border-l)_0_2px,transparent_2px_6px)]"
      )}
    />
  ));
});

const LINE_STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinejoin: "round",
  strokeLinecap: "round",
  vectorEffect: "non-scaling-stroke",
} as const;

/** The line over its fading fill; with a reading picked, lit up to it and dimmed past it. */
function ChartLines({
  paths,
  activeFraction,
}: {
  paths: ChartPaths;
  /** How far along the picked reading sits, or null while the chart is at rest. */
  activeFraction: number | null;
}) {
  // SVG references go through url(#…), so the id keeps to characters that need no escaping.
  const id = useId().replace(/[^\w-]/g, "");
  const gradientId = `${id}-fill`;
  const clipId = `${id}-upto`;
  const picked = activeFraction !== null;

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${CHART_VIEW} ${CHART_VIEW}`}
      preserveAspectRatio="none"
      style={{ left: INSET_PX, right: INSET_PX }}
      className="pointer-events-none absolute inset-y-0 h-full w-[calc(100%-14px)] overflow-visible text-primary"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.15" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
        {activeFraction === null ? null : (
          <clipPath id={clipId}>
            <rect
              x={0}
              y={-CHART_VIEW}
              width={activeFraction * CHART_VIEW}
              height={CHART_VIEW * 3}
            />
          </clipPath>
        )}
      </defs>
      <path
        d={paths.area}
        fill={`url(#${gradientId})`}
        clipPath={picked ? `url(#${clipId})` : undefined}
      />
      <path
        d={paths.line}
        {...LINE_STROKE}
        className={cn(
          "transition-opacity motion-reduce:transition-none",
          picked ? "opacity-25" : "opacity-100"
        )}
      />
      {picked ? <path d={paths.line} {...LINE_STROKE} clipPath={`url(#${clipId})`} /> : null}
    </svg>
  );
}

type ReadingCardPin = "start" | "middle" | "end";

/** How the card hangs off its reading: pinned to an edge near either end, centred between. */
const READING_CARD_SHIFT = {
  start: "calc(var(--spacing) * -1)",
  middle: "-50%",
  end: "calc(var(--spacing) - 100%)",
} as const satisfies Record<ReadingCardPin, string>;

function readingCardPin(fraction: number): ReadingCardPin {
  if (fraction < 1 / 6) return "start";
  if (fraction > 5 / 6) return "end";
  return "middle";
}

/** The card naming the picked reading's date and value, at the plot's foot or its top. */
function ChartReadingCard({
  x,
  atFoot,
  fraction,
  date,
  value,
}: {
  x: string;
  atFoot: boolean;
  fraction: number;
  date: string;
  value: string;
}) {
  const pin = readingCardPin(fraction);
  const y = atFoot ? "calc(100cqh - 100% - var(--spacing) * 2)" : "0px";
  return (
    <span
      aria-hidden="true"
      data-chart-reading=""
      data-chart-reading-at={atFoot ? "foot" : "top"}
      data-chart-reading-pin={pin}
      style={{ transform: `translate(calc(${x} + ${READING_CARD_SHIFT[pin]}), ${y})` }}
      className="pointer-events-none absolute top-0 left-0 z-10 flex flex-col gap-0.5 rounded-control bg-primary px-3 py-1.5 text-meta whitespace-nowrap text-surface-raised tabular-nums"
    >
      <span className="opacity-60">{date}</span>
      <span className="font-medium">{value}</span>
    </span>
  );
}

/** Tick labels in the 3rem column right of the plot. */
const ChartTickColumn = memo(function ChartTickColumn({
  ticks,
  tickLabels,
  scale,
}: {
  ticks: readonly number[];
  tickLabels: readonly string[];
  scale: VerticalScale;
}) {
  return (
    <div aria-hidden="true" className={cn("relative", SIZE_CONTAINER, CHART_PLOT_HEIGHT)}>
      {ticks.map((tick, index) => (
        <span
          key={tick}
          style={{ transform: `translateY(calc(${scale.yOf(tick)} - 50%))` }}
          className="absolute top-0 left-0 text-meta whitespace-nowrap text-tertiary tabular-nums"
        >
          {tickLabels[index]}
        </span>
      ))}
    </div>
  );
});

/**
 * The range's first, middle and last dates under the plot. Three nowrap dates need a 270px plot,
 * a 328px chart, so on a narrower one the middle date steps out rather than push the page wide.
 */
const ChartDateRow = memo(function ChartDateRow({
  dateLabels,
}: {
  dateLabels: readonly [string, string, string];
}) {
  return (
    <div
      aria-hidden="true"
      style={{ paddingLeft: INSET_PX, paddingRight: INSET_PX }}
      className="mt-2 flex h-4 justify-between gap-2 text-meta whitespace-nowrap text-tertiary tabular-nums"
    >
      {dateLabels.map((dateLabel, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the three positions are fixed.
        <span key={index} className={index === 1 ? "@max-[20.5rem]:hidden" : undefined}>
          {dateLabel}
        </span>
      ))}
    </div>
  );
});

/**
 * A single-series area chart in the design's grammar: dotted gridlines on the ticks with a solid
 * baseline, a 2px line over a fill that fades to nothing at the floor, a dot on the latest
 * value, tick labels in a 3rem column on the right and three dates underneath. The SVG only
 * draws the line and the fill; gridlines, labels and the dot are HTML, so the text and the dot
 * stay crisp at any width.
 *
 * Hovering (or arrowing, once focused) picks the nearest reading: a rule drops through it, the
 * line and fill stay lit up to it and the rest of the line dims, the dot moves onto it and a card
 * names its date and value. The card sits at the foot of the plot when the reading is high and
 * at the top when it is low, and pins to an edge near either end. A touch picks on contact and
 * dragging scrubs the series. Leaving the whole chart, not just the plot, clears the pick, so the
 * pointer can run into the tick column to reach the last reading. The paths, gridlines, ticks and
 * dates are built once per series, so a hover redraws only the cursor, the dot and the card.
 */
export function OverviewAreaChart({
  label,
  values,
  ticks,
  tickLabels,
  formatValue,
  formatDate,
  dateLabels,
  className,
}: {
  /** Names the chart for assistive technology, as the metric's caption does on screen. */
  label: string;
  /** At least one reading, oldest first. */
  values: readonly number[];
  /** Ascending; the first and last are the plot's floor and ceiling. */
  ticks: readonly number[];
  /** One label per tick, in the same order. */
  tickLabels: readonly string[];
  /** A reading's value, as the hover card shows it. */
  formatValue: (value: number) => string;
  /** A reading's date, by its index in `values`. */
  formatDate: (index: number) => string;
  /** The first, middle and last dates of the range. */
  dateLabels: readonly [string, string, string];
  className?: string;
}) {
  const t = useTranslations();
  const { active, shown, last, plotRef, pickAt, handleKeyDown, clear } = useChartReading(values);
  const scale = useMemo(() => verticalScale(ticks), [ticks]);
  const paths = useMemo(
    () => chartPaths(values, scale.floor, scale.ceiling),
    [values, scale.floor, scale.ceiling]
  );
  const { fractionOf, xOf } = horizontalScale(last);
  const shownValue = values[shown];
  const reading = t("Shared.homeWorkspace.network.chartReading", {
    value: formatValue(shownValue),
    date: formatDate(shown),
  });

  return (
    <div className={cn(CHART_COLUMNS, "@container", className)} onPointerLeave={clear}>
      <div
        ref={plotRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={shown}
        aria-valuetext={reading}
        data-chart-plot=""
        onPointerDown={(event) => pickAt(event.clientX)}
        onPointerMove={(event) => pickAt(event.clientX)}
        onKeyDown={handleKeyDown}
        onBlur={clear}
        className={cn(
          "relative touch-pan-y outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          SIZE_CONTAINER,
          CHART_PLOT_HEIGHT
        )}
      >
        <ChartGridlines ticks={ticks} scale={scale} />
        {active === null ? null : (
          <span
            aria-hidden="true"
            data-chart-cursor=""
            style={{ transform: `translateX(${xOf(active)})` }}
            className="pointer-events-none absolute inset-y-0 left-0 w-px bg-tertiary/60"
          />
        )}
        <ChartLines paths={paths} activeFraction={active === null ? null : fractionOf(active)} />
        <span
          aria-hidden="true"
          data-chart-dot=""
          style={{
            transform: `translate(calc(${xOf(shown)} - 50%), calc(${scale.yOf(shownValue)} - 50%))`,
          }}
          className="pointer-events-none absolute top-0 left-0 size-2 rounded-full bg-primary ring-2 ring-surface-raised"
        />
        {active === null ? null : (
          <ChartReadingCard
            x={xOf(active)}
            atFoot={scale.topPercent(values[active]) < 45}
            fraction={fractionOf(active)}
            date={formatDate(active)}
            value={formatValue(values[active])}
          />
        )}
      </div>
      <ChartTickColumn ticks={ticks} tickLabels={tickLabels} scale={scale} />
      <ChartDateRow dateLabels={dateLabels} />
    </div>
  );
}

/**
 * The chart's footprint with nothing to draw: the baseline over an empty date row, so a figure
 * without readings stands as tall as one with them and the page never moves when they arrive.
 */
export function EmptyAreaChart({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" data-chart-empty="" className={cn(CHART_COLUMNS, className)}>
      <div className={cn("relative", CHART_PLOT_HEIGHT)}>
        <span className="absolute inset-x-0 top-full h-px bg-border-default" />
      </div>
      <div />
      <div className="mt-2 h-4" />
    </div>
  );
}
