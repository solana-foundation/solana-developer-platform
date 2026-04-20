"use client";

import type { Token } from "@sdp/types";
import { Button } from "@/components/ui/button";
import { TokenDisabledActionTooltip } from "./token-disabled-action-tooltip";
import { formatDate } from "./token-management-workspace.utils";

interface TokenOverviewSectionProps {
  token: Token;
  showTitle?: boolean;
  mintAuthorityValue?: string | null;
  onRefreshSupply?: () => void;
  refreshDisabled?: boolean;
  refreshDisabledReason?: string | null;
}

export function TokenOverviewSection({
  token,
  showTitle = true,
  mintAuthorityValue,
  onRefreshSupply,
  refreshDisabled = false,
  refreshDisabledReason = null,
}: TokenOverviewSectionProps) {
  return (
    <section className="space-y-3">
      {showTitle || onRefreshSupply ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {showTitle ? (
            <h3 className="text-[36px] leading-[40px] font-medium tracking-[-0.3px] text-[#1c1c1d]">
              Token Overview
            </h3>
          ) : (
            <div />
          )}
          {onRefreshSupply ? (
            <TokenDisabledActionTooltip reason={refreshDisabled ? refreshDisabledReason : null}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRefreshSupply}
                disabled={refreshDisabled}
              >
                Refresh supply
              </Button>
            </TokenDisabledActionTooltip>
          ) : null}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white">
        <OverviewRow label="Token Address" value={token.mintAddress ?? "Not deployed"} monospace />
        <OverviewRow label="Mint Authority" value={mintAuthorityValue ?? "None"} monospace />
        <OverviewRow label="Supply" value={token.totalSupply} />
        <OverviewRow label="Created" value={formatDate(token.createdAt)} />
        <OverviewRow label="Template" value={token.template} />
        <OverviewRow label="Decimals" value={String(token.decimals)} />
      </div>
    </section>
  );
}

function OverviewRow({
  label,
  value,
  monospace = false,
}: {
  label: string;
  value: string;
  monospace?: boolean;
}) {
  return (
    <div
      data-testid={`overview-row-${label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")}`}
      className="flex items-center justify-between gap-4 border-b border-[rgba(28,28,29,0.08)] px-4 py-3 last:border-b-0"
    >
      <p className="text-[15px] text-[rgba(28,28,29,0.68)]">{label}</p>
      <p
        className={[
          "text-right text-[15px] text-[#1c1c1d]",
          monospace ? "font-mono text-xs" : "",
        ].join(" ")}
      >
        {value}
      </p>
    </div>
  );
}
