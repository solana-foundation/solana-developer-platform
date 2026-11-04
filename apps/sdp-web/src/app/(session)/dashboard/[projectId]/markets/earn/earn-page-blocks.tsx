import { InfoHint } from "@sdp/ui/info-hint";
import { Fragment, type ReactNode } from "react";
import { TokenMark } from "@/components/token-mark";

/** One figure in a summary's stat line: the value, what it is, and what it means behind an (i). */
export interface EarnSummaryStat {
  id: string;
  label: string;
  value: ReactNode;
  hint?: string;
}

/**
 * An Earn page's summary, as Payments sets a balance: a 13px label (an (i) after it when the
 * figure is withheld), the 40px hero figure 6px under it, then a rule and the 24px stat line.
 * Treasury and Embedded Yield both open with it, and `EarnSummarySkeleton` draws its footprint.
 */
export function EarnSummary({
  figure,
  hint,
  label,
  stats,
}: {
  figure: ReactNode;
  hint?: string;
  label: string;
  stats: readonly EarnSummaryStat[];
}) {
  return (
    <section className="min-w-0" data-earn-summary="">
      <h2 className="flex h-4 items-center gap-1.5 text-meta text-secondary">
        {label}
        {hint ? <InfoHint text={hint} /> : null}
      </h2>
      <div className="mt-1.5 flex h-11 items-center text-amount font-medium text-primary tabular-nums">
        {figure}
      </div>
      <div className="mt-10 flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-default pt-6 text-meta text-secondary">
        {stats.map((stat, index) => (
          <Fragment key={stat.id}>
            {index > 0 ? (
              <span aria-hidden="true" className="text-tertiary">
                ·
              </span>
            ) : null}
            {/* The figure reads at 16px over its 13px words, on one baseline, as Payments sets
                its counts. */}
            <div className="flex h-6 items-baseline gap-1">
              <div className="text-field font-medium text-primary tabular-nums">{stat.value}</div>
              <span>{stat.label}</span>
              {stat.hint ? <InfoHint className="self-center" text={stat.hint} /> : null}
            </div>
          </Fragment>
        ))}
      </div>
    </section>
  );
}

/**
 * A table row's subject over its 13px detail line, both truncating with the whole text kept in a
 * title, as every Earn table sets its first cell.
 */
export function EarnRowIdentity({
  asset,
  detail,
  name,
}: {
  asset?: { mint: string; symbol: string };
  detail: ReactNode;
  name: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      {asset ? <TokenMark mint={asset.mint} size="sm" symbol={asset.symbol} /> : null}
      <span className="min-w-0">
        <span className="block truncate font-medium text-primary" title={name}>
          {name}
        </span>
        <span
          className="block truncate text-tertiary"
          title={typeof detail === "string" ? detail : undefined}
        >
          {detail}
        </span>
      </span>
    </span>
  );
}
