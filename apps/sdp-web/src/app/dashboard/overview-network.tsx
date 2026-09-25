"use client";

import { ArrowUpRightIcon, RotateCwIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusText } from "@/components/ui/status-text";
import { useLocale, useTranslations } from "@/i18n/provider";
import {
  formatNetworkChange,
  formatNetworkValue,
  NETWORK_RANGES,
  type NetworkMetric,
  type NetworkMetricId,
  type NetworkRange,
  type NetworkSnapshot,
  networkChange,
  networkChangeTone,
  niceNetworkTicks,
  sliceNetworkRange,
} from "./network-stats";
import { NETWORK_STATS_FIXTURE } from "./network-stats.fixture";
import { OverviewAreaChart } from "./overview-area-chart";

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
} as const satisfies Record<NetworkMetric["unit"], string>;

const RANGE_COPY = {
  "30d": "Shared.homeWorkspace.network.range30d",
  "90d": "Shared.homeWorkspace.network.range90d",
  "1y": "Shared.homeWorkspace.network.range1y",
} as const satisfies Record<NetworkRange, string>;

function formatDay(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function MetricChart({ metric, range }: { metric: NetworkMetric; range: NetworkRange }) {
  const t = useTranslations();
  const locale = useLocale();
  const points = sliceNetworkRange(metric.points, range);
  const values = points.map((point) => point.value);
  const latest = values.at(-1);
  const change = networkChange(points);
  const ticks = niceNetworkTicks(Math.min(...values), Math.max(...values));
  const copy = METRIC_COPY[metric.id];
  const first = points[0];
  const middle = points[Math.floor((points.length - 1) / 2)];
  const last = points.at(-1);
  const label = t(copy.label);
  const headline =
    latest === undefined ? "—" : formatNetworkValue(latest, metric.format, locale, "headline");
  const changeLabel = change === null ? null : formatNetworkChange(change, locale);

  return (
    <figure className="min-w-0" data-network-metric={metric.id}>
      <div className="grid grid-cols-[minmax(0,1fr)_48px] items-center gap-x-2.5">
        <figcaption className="flex min-w-0 items-center gap-1.5 text-body text-secondary">
          <span className="truncate">{label}</span>
          <InfoHint text={t(copy.hint)} />
        </figcaption>
        <span className="text-body text-tertiary">{t(UNIT_COPY[metric.unit])}</span>
      </div>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span className="text-quote font-medium text-primary tabular-nums">{headline}</span>
        {changeLabel && change !== null ? (
          <StatusText
            tone={networkChangeTone(change, metric.higherIsBetter)}
            className="text-nav tabular-nums"
          >
            {changeLabel}
            <span className="sr-only">
              {" "}
              {t("Shared.homeWorkspace.network.changeOver", { range: t(RANGE_COPY[range]) })}
            </span>
          </StatusText>
        ) : null}
      </p>
      {first && middle && last ? (
        <OverviewAreaChart
          className="mt-5"
          label={label}
          values={values}
          ticks={ticks}
          formatTick={(value) => formatNetworkValue(value, metric.format, locale, "axis")}
          formatValue={(value) => formatNetworkValue(value, metric.format, locale, "headline")}
          formatDate={(index) => formatDay(points[index]?.date ?? last.date, locale)}
          dateLabels={[
            formatDay(first.date, locale),
            formatDay(middle.date, locale),
            formatDay(last.date, locale),
          ]}
        />
      ) : null}
    </figure>
  );
}

function formatUpdated(iso: string, locale: string, now = Date.now()): string {
  const hours = Math.max(0, Math.round((now - Date.parse(iso)) / 3_600_000));
  const formatter = new Intl.RelativeTimeFormat(locale, { style: "narrow" });
  return hours < 24
    ? formatter.format(-hours, "hour")
    : formatter.format(-Math.round(hours / 24), "day");
}

/**
 * Solana network context under the organization's own figures: stablecoin supply, transfers,
 * share of activity and cost per transaction over 30 days, 90 days or a year.
 *
 * Reads `NETWORK_STATS_FIXTURE`, the prototype's figures, until a data provider is chosen.
 */
export function OverviewNetwork({
  snapshot = NETWORK_STATS_FIXTURE,
}: {
  snapshot?: NetworkSnapshot;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [range, setRange] = useState<NetworkRange>("1y");
  const healthy = snapshot.health === "healthy";

  return (
    <section
      aria-labelledby="overview-network-title"
      data-overview-section="network"
      className="min-w-0"
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-3">
          <h2 id="overview-network-title" className="text-subheading font-medium text-primary">
            {t("Shared.homeWorkspace.network.title")}
          </h2>
          <span className="flex items-center gap-1.5 text-body text-secondary">
            <span
              aria-hidden="true"
              className={
                healthy ? "size-1.5 rounded-full bg-success" : "size-1.5 rounded-full bg-warning"
              }
            />
            {t(
              healthy
                ? "Shared.homeWorkspace.network.healthy"
                : "Shared.homeWorkspace.network.degraded"
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:ml-auto">
          <span className="flex items-center gap-2 text-body text-tertiary">
            <RotateCwIcon aria-hidden="true" className="size-4" />
            <time
              dateTime={snapshot.updatedAt}
              title={t("Shared.homeWorkspace.network.updated", {
                when: formatUpdated(snapshot.updatedAt, locale),
              })}
            >
              {formatUpdated(snapshot.updatedAt, locale)}
            </time>
          </span>
          <SegmentedControl
            ariaLabel={t("Shared.homeWorkspace.network.rangeLabel")}
            value={range}
            onChange={(value) => setRange(value as NetworkRange)}
            options={NETWORK_RANGES.map((value) => ({ value, label: t(RANGE_COPY[value]) }))}
            className="h-control-sm"
            optionClassName="px-3"
          />
          <Button asChild variant="outline" size="sm">
            <a href={SOLANA_DATA_URL} target="_blank" rel="noopener noreferrer">
              {t("Shared.homeWorkspace.network.source")}
              <ArrowUpRightIcon aria-hidden="true" className="size-4" />
            </a>
          </Button>
        </div>
      </div>
      <div className="mt-5 grid min-w-0 gap-x-12 gap-y-10 md:grid-cols-2">
        {snapshot.metrics.map((metric) => (
          <MetricChart key={metric.id} metric={metric} range={range} />
        ))}
      </div>
    </section>
  );
}
