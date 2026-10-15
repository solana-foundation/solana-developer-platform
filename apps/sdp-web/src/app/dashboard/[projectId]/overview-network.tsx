"use client";

import {
  NETWORK_METRIC_IDS,
  type NetworkHealth,
  type NetworkHealthReading,
  type NetworkMetricId,
  type NetworkPoint,
  type NetworkSnapshot,
} from "@sdp/types/network-metrics";
import { ArrowUpRightIcon, RotateCwIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { StatusText } from "@/components/ui/status-text";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useClientNow } from "@/lib/use-client-now";
import { cn } from "@/lib/utils";
import {
  formatNetworkAge,
  formatNetworkChange,
  formatNetworkDay,
  formatNetworkTicks,
  formatNetworkValue,
  isNetworkRange,
  NETWORK_METRIC_DISPLAY,
  NETWORK_RANGES,
  type NetworkMetricDisplay,
  type NetworkRange,
  networkAxisTicks,
  networkChange,
  networkChangeTone,
  networkFreshness,
  networkRangePoints,
} from "./network-stats";
import {
  CHART_COLUMNS,
  CHART_PLOT_HEIGHT,
  EmptyAreaChart,
  OverviewAreaChart,
} from "./overview-area-chart";

const SOLANA_DATA_URL = "https://solana.com/data";

const METRIC_COPY = {
  stablecoinSupply: {
    label: "Shared.homeWorkspace.network.stablecoinSupply",
    hint: "Shared.homeWorkspace.network.stablecoinSupplyHint",
  },
  stablecoinTransfers: {
    label: "Shared.homeWorkspace.network.stablecoinTransfers",
    hint: "Shared.homeWorkspace.network.stablecoinTransfersHint",
  },
  stablecoinShare: {
    label: "Shared.homeWorkspace.network.stablecoinShare",
    hint: "Shared.homeWorkspace.network.stablecoinShareHint",
  },
  costPerTransaction: {
    label: "Shared.homeWorkspace.network.costPerTransaction",
    hint: "Shared.homeWorkspace.network.costPerTransactionHint",
  },
} as const satisfies Record<NetworkMetricId, { label: string; hint: string }>;

const UNIT_COPY = {
  usd: "Shared.homeWorkspace.network.unitUsd",
  count: "Shared.homeWorkspace.network.unitCount",
  percent: "Shared.homeWorkspace.network.unitPercent",
} as const satisfies Record<NetworkMetricDisplay["unit"], string>;

const RANGE_COPY = {
  "30d": "Shared.homeWorkspace.network.range30d",
  "90d": "Shared.homeWorkspace.network.range90d",
  "1y": "Shared.homeWorkspace.network.range1y",
} as const satisfies Record<NetworkRange, string>;

const HEALTH_BADGE = {
  operational: { label: "Shared.homeWorkspace.network.healthy", dot: "bg-success" },
  degraded: { label: "Shared.homeWorkspace.network.degraded", dot: "bg-warning" },
  outage: { label: "Shared.homeWorkspace.network.outage", dot: "bg-error" },
  maintenance: { label: "Shared.homeWorkspace.network.maintenance", dot: "bg-info" },
} as const satisfies Record<NetworkHealth, { label: string; dot: string }>;

/**
 * Four figures, two to a row once the section fits two 328px charts (the narrowest that keeps
 * all three dates) beside the 3rem gap, whatever the sidebar takes.
 */
const FIGURE_GRID = "mt-5 grid min-w-0 gap-x-12 gap-y-12.5 @[44rem]:grid-cols-2";
const FIGURE_SLOTS = ["figure-1", "figure-2", "figure-3", "figure-4"] as const;
/** The headline's one 30px line: a figure with no reading keeps it, so no state moves the page. */
const HEADLINE_ROW = "mt-1 flex h-7.5 min-w-0 gap-x-2 whitespace-nowrap";
/** The age reads in hours; a minute's tick keeps it current on a page left open. */
const FRESHNESS_REFRESH_MS = 60_000;

/**
 * The header in one row once the section is 40rem wide: title and status, then the age, the
 * range and the source link at the right edge. Narrower, two rows: title beside the link, the
 * age beside the range, so no control wraps onto a line of its own. The title runs on over the
 * range's column, so the status fits beside it on a 320px phone instead of wrapping the title.
 */
const HEADER_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-3 [grid-template-areas:'title_title_link'_'fresh_range_range'] @[40rem]:grid-cols-[minmax(0,1fr)_auto_auto_auto] @[40rem]:gap-y-0 @[40rem]:[grid-template-areas:'title_fresh_range_link']";

export type OverviewNetworkProps =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; snapshot: NetworkSnapshot };

/**
 * The caption row: the metric's name and hint, and its unit over the tick column, with "7d avg"
 * beside the unit when the figure is a 7-day average.
 */
function FigureCaption({ id }: { id: NetworkMetricId }) {
  const t = useTranslations();
  const copy = METRIC_COPY[id];
  const display = NETWORK_METRIC_DISPLAY[id];
  return (
    <div className={cn(CHART_COLUMNS, "items-center")}>
      <figcaption className="flex min-w-0 items-center gap-1.5 text-body text-secondary">
        <span className="truncate">{t(copy.label)}</span>
        <InfoHint text={t(copy.hint)} className="[&_svg]:size-3" />
        {display.averaged ? (
          <span className="ml-auto shrink-0 text-meta whitespace-nowrap text-tertiary">
            {t("Shared.homeWorkspace.network.sevenDayAverage")}
          </span>
        ) : null}
      </figcaption>
      <span className="text-meta text-tertiary">{t(UNIT_COPY[display.unit])}</span>
    </div>
  );
}

/** A metric with nothing to chart, in a ready figure's footprint so its arrival moves nothing. */
function EmptyFigure({ id }: { id: NetworkMetricId }) {
  const t = useTranslations();
  return (
    <figure className="min-w-0" data-network-metric={id} data-network-metric-state="empty">
      <FigureCaption id={id} />
      <p className={cn(HEADLINE_ROW, "items-center text-body text-tertiary")}>
        {t("Shared.homeWorkspace.network.metricUnavailable")}
      </p>
      <EmptyAreaChart className="mt-5" />
    </figure>
  );
}

/**
 * One metric: its latest figure, the change over the range, and the chart, or an empty figure
 * when the range holds no complete day.
 */
const MetricFigure = memo(function MetricFigure({
  id,
  points: series,
  range,
}: {
  id: NetworkMetricId;
  points: readonly NetworkPoint[];
  range: NetworkRange;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const display = NETWORK_METRIC_DISPLAY[id];
  const view = useMemo(() => {
    const points = networkRangePoints(series, range, display.averaged);
    if (points.length === 0) return null;
    const first = points[0];
    const middle = points[Math.floor((points.length - 1) / 2)];
    const last = points[points.length - 1];
    const values = points.map((point) => point.value);
    const ticks = networkAxisTicks(values);
    return {
      values,
      ticks,
      tickLabels: formatNetworkTicks(ticks, display.format, locale),
      latest: last.value,
      change: networkChange(points),
      dateLabels: [
        formatNetworkDay(first.date, locale),
        formatNetworkDay(middle.date, locale),
        formatNetworkDay(last.date, locale),
      ] as const,
      dayAt: (index: number) => formatNetworkDay(points[index].date, locale),
    };
  }, [series, range, locale, display.format, display.averaged]);

  if (view === null) return <EmptyFigure id={id} />;

  const formatValue = (value: number) =>
    formatNetworkValue(value, display.format, locale, "headline");

  return (
    <figure className="min-w-0" data-network-metric={id}>
      <FigureCaption id={id} />
      <p className={cn(HEADLINE_ROW, "items-baseline")}>
        <span className="text-quote font-medium tracking-normal text-primary">
          {formatValue(view.latest)}
        </span>
        {view.change === null ? null : (
          <StatusText
            tone={networkChangeTone(view.change, display.higherIsBetter)}
            className="min-w-0 truncate text-body tabular-nums"
          >
            {formatNetworkChange(view.change, locale)}
            <span className="sr-only">
              {" "}
              {t("Shared.homeWorkspace.network.changeOver", { range: t(RANGE_COPY[range]) })}
            </span>
          </StatusText>
        )}
      </p>
      <OverviewAreaChart
        className="mt-5"
        label={
          display.averaged
            ? t("Shared.homeWorkspace.network.sevenDayAverageOf", {
                metric: t(METRIC_COPY[id].label),
              })
            : t(METRIC_COPY[id].label)
        }
        values={view.values}
        ticks={view.ticks}
        tickLabels={view.tickLabels}
        formatValue={formatValue}
        formatDate={view.dayAt}
        dateLabels={view.dateLabels}
      />
    </figure>
  );
});

/** Past this, a health reading no longer stands for now. The API serves one at most 3 minutes
 * old and the page refetches every 5, so a reading only gets this old once refreshes stop. */
const HEALTH_MAX_AGE_MS = 10 * 60_000;

/**
 * The badge beside the title: the mainnet cluster's state from status.solana.com, and nothing
 * when no check answered or the last one is too old, so a stale or failed check never reads
 * as a live status, even on a page left open while refreshes fail.
 */
function NetworkStatus({
  health,
  now,
}: {
  health: NetworkHealthReading | null;
  now: number | null;
}) {
  const t = useTranslations();
  if (health === null || now === null) return null;
  if (now - Date.parse(health.checkedAt) > HEALTH_MAX_AGE_MS) return null;
  const badge = HEALTH_BADGE[health.state];
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-body whitespace-nowrap text-secondary"
      data-network-status={health.state}
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", badge.dot)} />
      {t(badge.label)}
    </span>
  );
}

/**
 * How old the figures are, from the close of the latest day they cover: "14h ago" while
 * recent, the date in amber once it is days old, so an old figure never passes as today's.
 */
function NetworkFreshnessLabel({ asOf, now }: { asOf: string; now: number }) {
  const t = useTranslations();
  const locale = useLocale();
  const freshness = networkFreshness(asOf, now);
  const day = formatNetworkDay(asOf, locale);
  const through = t("Shared.homeWorkspace.network.dataThrough", { date: day });
  const dated = freshness.kind === "dated";
  return (
    <span
      title={through}
      data-network-freshness={freshness.kind}
      className={cn(
        "flex items-center gap-2 text-body whitespace-nowrap",
        dated ? "text-warning" : "text-secondary"
      )}
    >
      <RotateCwIcon aria-hidden="true" className="size-3.5" />
      <time dateTime={asOf} className="tabular-nums">
        {dated
          ? t("Shared.homeWorkspace.network.asOf", { date: day })
          : formatNetworkAge(freshness.elapsedMs, locale)}
      </time>
      <span className="sr-only">{through}</span>
    </span>
  );
}

/** The four figures' placeholders, in the grid they settle into. */
function NetworkFigureSkeletons() {
  return (
    <div className={FIGURE_GRID}>
      {FIGURE_SLOTS.map((slot) => (
        <div key={slot} className="min-w-0">
          <SkeletonBlock className="h-5 w-36 rounded-sm" />
          <SkeletonBlock className="mt-1 h-7.5 w-32 rounded-sm" />
          <SkeletonBlock className={cn("mt-5", CHART_PLOT_HEIGHT, "w-full rounded-control")} />
          <SkeletonBlock className="mt-2 h-4 w-full rounded-sm" />
        </div>
      ))}
    </div>
  );
}

/** The whole section while its page loads, in the header's grid so the page lands where it sits. */
export function OverviewNetworkSkeleton() {
  return (
    <div className="@container min-w-0" data-loading-home-network>
      <div className={HEADER_GRID}>
        <SkeletonBlock className="h-6 w-44 max-w-full rounded-sm [grid-area:title]" />
        <SkeletonBlock className="h-control-sm w-32 justify-self-end rounded-control [grid-area:range]" />
        <SkeletonBlock className="h-control-sm w-control-sm justify-self-end rounded-control [grid-area:link] @[40rem]:w-36" />
      </div>
      <NetworkFigureSkeletons />
    </div>
  );
}

/**
 * Solana network context under the organization's own figures: stablecoin supply, transfers,
 * share of activity and cost per transaction over 30 days, 90 days or a year. The figures' age and
 * the badge's limit count on the browser's clock, so no server-rendered time can disagree with
 * them on hydration.
 */
export function OverviewNetwork(props: OverviewNetworkProps) {
  const t = useTranslations();
  const [range, setRange] = useState<NetworkRange>("1y");
  const ready = props.status === "ready" ? props : null;
  const now = useClientNow(FRESHNESS_REFRESH_MS);

  return (
    <section
      aria-labelledby="overview-network-title"
      aria-busy={props.status === "loading" || undefined}
      data-overview-section="network"
      data-network-state={props.status}
      className="@container min-w-0"
    >
      <div className={HEADER_GRID}>
        <div className="flex min-w-0 items-center gap-3 [grid-area:title]">
          <h2
            id="overview-network-title"
            className="min-w-0 truncate text-subheading font-medium text-primary"
          >
            {t("Shared.homeWorkspace.network.title")}
          </h2>
          {ready ? <NetworkStatus health={ready.snapshot.health} now={now} /> : null}
        </div>
        {ready && now !== null ? (
          <div className="[grid-area:fresh]">
            <NetworkFreshnessLabel asOf={ready.snapshot.asOf} now={now} />
          </div>
        ) : null}
        <SegmentedControl
          ariaLabel={t("Shared.homeWorkspace.network.rangeLabel")}
          value={range}
          onChange={(value) => {
            if (isNetworkRange(value)) setRange(value);
          }}
          options={NETWORK_RANGES.map((value) => ({ value, label: t(RANGE_COPY[value]) }))}
          disabled={ready === null}
          className="h-control-sm justify-self-end [grid-area:range]"
          optionClassName="px-2.5"
        />
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="h-control-sm justify-self-end [grid-area:link] @max-[40rem]:px-2"
        >
          <a href={SOLANA_DATA_URL} target="_blank" rel="noopener noreferrer">
            <span className="text-primary @max-[40rem]:sr-only">
              {t("Shared.homeWorkspace.network.source")}
            </span>
            <ArrowUpRightIcon aria-hidden="true" className="size-3.5 text-tertiary" />
          </a>
        </Button>
      </div>
      {props.status === "loading" ? <NetworkFigureSkeletons /> : null}
      {props.status === "unavailable" ? (
        <div className={FIGURE_GRID}>
          {NETWORK_METRIC_IDS.map((id) => (
            <EmptyFigure key={id} id={id} />
          ))}
        </div>
      ) : null}
      {ready ? (
        <div className={FIGURE_GRID}>
          {NETWORK_METRIC_IDS.map((id) => (
            <MetricFigure key={id} id={id} points={ready.snapshot.metrics[id]} range={range} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
