import { type KeyboardEvent, useId, useRef, useState } from "react";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

/** The data sits 7px inside the plot so the end dot never clips on the right edge. */
const INSET_PX = 7;
const VIEW = 1000;

function toPath(values: readonly number[], floor: number, ceiling: number): string {
  const span = ceiling - floor || 1;
  const last = Math.max(values.length - 1, 1);
  return values
    .map((value, index) => {
      const x = (index / last) * VIEW;
      const y = ((ceiling - value) / span) * VIEW;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

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

/**
 * A single-series area chart in the design's grammar: dotted gridlines on the ticks with a solid
 * baseline, a 2px line over a fill that fades to nothing at the floor, a dot on the latest
 * value, tick labels in a 48px column on the right and three dates underneath. The SVG only
 * draws the line and the fill; gridlines, labels and the dot are HTML, so the text and the dot
 * stay crisp at any width.
 *
 * Hovering (or arrowing, once focused) picks the nearest reading: a rule drops through it, the
 * line and fill stay lit up to it and the rest of the line dims, the dot moves onto it and a card
 * names its date and value. The card sits at the foot of the plot when the reading is high and
 * at the top when it is low, and pins to an edge near either end.
 */
export function OverviewAreaChart({
  label,
  values,
  ticks,
  formatTick,
  formatValue,
  formatDate,
  dateLabels,
  className,
}: {
  /** Names the chart for assistive technology, as the metric's caption does on screen. */
  label: string;
  values: readonly number[];
  /** Ascending; the first and last are the plot's floor and ceiling. */
  ticks: readonly number[];
  formatTick: (value: number) => string;
  /** A reading's value, as the hover card shows it. */
  formatValue: (value: number) => string;
  /** A reading's date, by its index in `values`. */
  formatDate: (index: number) => string;
  /** The first, middle and last dates of the range. */
  dateLabels: readonly [string, string, string];
  className?: string;
}) {
  const t = useTranslations();
  const [active, setActive] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  // SVG references go through url(#…), so the id keeps to characters that need no escaping.
  const id = useId().replace(/[^\w-]/g, "");
  const gradientId = `${id}-fill`;
  const clipId = `${id}-upto`;
  const floor = ticks[0] ?? 0;
  const ceiling = ticks.at(-1) ?? 1;
  const span = ceiling - floor || 1;
  const topPercent = (value: number) => ((ceiling - value) / span) * 100;
  const line = toPath(values, floor, ceiling);
  const area = `${line} L${VIEW} ${VIEW} L0 ${VIEW} Z`;
  const last = Math.max(values.length - 1, 0);
  const shown = active ?? last;
  const shownValue = values[shown];
  const fractionOf = (index: number) => (last === 0 ? 1 : index / last);
  const leftOf = (index: number) =>
    `calc(${INSET_PX}px + (100% - ${INSET_PX * 2}px) * ${fractionOf(index)})`;
  const insetBox = { left: INSET_PX, right: INSET_PX } as const;
  const reading =
    shownValue === undefined
      ? undefined
      : t("Shared.homeWorkspace.network.chartReading", {
          value: formatValue(shownValue),
          date: formatDate(shown),
        });

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

  const activeValue = active === null ? undefined : values[active];
  const cardAtFoot = activeValue !== undefined && topPercent(activeValue) < 45;
  const activeFraction = active === null ? 0 : fractionOf(active);

  return (
    // Leaving the whole chart, not just the plot, clears the reading, so the pointer can run
    // into the tick column to reach the last one.
    <div
      className={cn("grid grid-cols-[minmax(0,1fr)_48px] gap-x-2.5", className)}
      onPointerLeave={() => setActive(null)}
    >
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
        onPointerMove={(event) => pickAt(event.clientX)}
        onKeyDown={handleKeyDown}
        onBlur={() => setActive(null)}
        className="relative h-[182px] touch-pan-y outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {ticks.map((tick, index) => (
          <span
            key={tick}
            aria-hidden="true"
            style={{ top: `${topPercent(tick)}%` }}
            className={cn(
              "pointer-events-none absolute inset-x-0 h-px",
              index === 0
                ? "bg-border-default"
                : "bg-[repeating-linear-gradient(to_right,var(--color-border-default)_0_2px,transparent_2px_6px)]"
            )}
          />
        ))}
        {active === null ? null : (
          <span
            aria-hidden="true"
            data-chart-cursor=""
            style={{ left: leftOf(active) }}
            className="pointer-events-none absolute inset-y-0 w-px bg-tertiary/60"
          />
        )}
        <svg
          aria-hidden="true"
          viewBox={`0 0 ${VIEW} ${VIEW}`}
          preserveAspectRatio="none"
          style={insetBox}
          className="pointer-events-none absolute inset-y-0 h-full w-[calc(100%-14px)] overflow-visible text-primary"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.15" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
            <clipPath id={clipId}>
              <rect x={0} y={-VIEW} width={activeFraction * VIEW} height={VIEW * 3} />
            </clipPath>
          </defs>
          <path
            d={area}
            fill={`url(#${gradientId})`}
            clipPath={active === null ? undefined : `url(#${clipId})`}
          />
          <path
            d={line}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            className={cn(
              "transition-opacity motion-reduce:transition-none",
              active === null ? "opacity-100" : "opacity-25"
            )}
          />
          {active === null ? null : (
            <path
              d={line}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              clipPath={`url(#${clipId})`}
            />
          )}
        </svg>
        {shownValue === undefined ? null : (
          <span
            aria-hidden="true"
            style={{ left: leftOf(shown), top: `${topPercent(shownValue)}%` }}
            className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-surface-raised"
          />
        )}
        {active === null || activeValue === undefined ? null : (
          <span
            aria-hidden="true"
            data-chart-reading=""
            style={{ left: leftOf(active) }}
            className={cn(
              "pointer-events-none absolute z-10 flex flex-col gap-0.5 rounded-control bg-primary px-3 py-1.5 text-meta whitespace-nowrap text-surface-raised tabular-nums",
              cardAtFoot ? "bottom-2" : "top-0",
              activeFraction < 1 / 6
                ? "-translate-x-1"
                : activeFraction > 5 / 6
                  ? "-translate-x-[calc(100%-var(--spacing))]"
                  : "-translate-x-1/2"
            )}
          >
            <span className="opacity-60">{formatDate(active)}</span>
            <span className="font-medium">{formatValue(activeValue)}</span>
          </span>
        )}
      </div>
      <div aria-hidden="true" className="relative h-[182px]">
        {ticks.map((tick) => (
          <span
            key={tick}
            style={{ top: `${topPercent(tick)}%` }}
            className="absolute left-0 -translate-y-1/2 text-meta whitespace-nowrap text-tertiary tabular-nums"
          >
            {formatTick(tick)}
          </span>
        ))}
      </div>
      <div
        aria-hidden="true"
        style={{ paddingLeft: INSET_PX, paddingRight: INSET_PX }}
        className="mt-2 flex justify-between gap-2 text-meta whitespace-nowrap text-tertiary tabular-nums"
      >
        {dateLabels.map((dateLabel, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the three positions are fixed.
          <span key={index}>{dateLabel}</span>
        ))}
      </div>
    </div>
  );
}
