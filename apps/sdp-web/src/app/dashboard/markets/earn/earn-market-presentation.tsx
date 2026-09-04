"use client";

import { formatDecimalAmount, isDecimalString, parseDecimalAmount } from "@sdp/solana/amount";
import { type EarnStrategy, SOLANA_CLUSTER_LABELS, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { TokenMark } from "@/components/token-mark";
import { Badge } from "@/components/ui/badge";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { earnProviderLabel } from "./earn-format";
import type { EarnVaultDepositAvailability } from "./earn-surfacing";

export interface EarnStrategyAsset {
  decimals?: number;
  mint: string;
  symbol: string;
}

/** Resolve one provider mint for display without inventing an asset symbol. */
export function earnMintAsset(mint: string): EarnStrategyAsset {
  const token = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
  return token
    ? { decimals: token.decimals, mint, symbol: token.symbol }
    : { mint, symbol: mint.length <= 12 ? mint : `${mint.slice(0, 4)}…${mint.slice(-4)}` };
}

/** The first provider-declared deposit asset, resolved without assuming a cluster or stablecoin. */
export function earnStrategyAsset(strategy: EarnStrategy): EarnStrategyAsset | undefined {
  for (const mint of strategy.depositMints) {
    const token = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
    if (token) return earnMintAsset(mint);
  }

  const mint = strategy.depositMints[0];
  return mint ? earnMintAsset(mint) : undefined;
}

/** Provider references are only unique within one provider. */
export function earnStrategyReferenceKey(provider: string, providerReference: string): string {
  return JSON.stringify([provider, providerReference]);
}

/** Add provider decimal strings without routing money through a JavaScript float. */
export function sumDecimalStrings(values: readonly string[]): string | undefined {
  if (values.length === 0 || values.some((value) => !isDecimalString(value))) return undefined;
  const scale = values.reduce((largest, value) => {
    const fraction = value.split(".")[1]?.length ?? 0;
    return Math.max(largest, fraction);
  }, 0);
  const total = values.reduce((sum, value) => sum + parseDecimalAmount(value, scale), 0n);
  return formatDecimalAmount(total, scale);
}

export { formatProviderAmount } from "./earn-format";

/** APY is a decimal rate (`0.062` = 6.2%); absent and malformed values stay unavailable. */
export function formatProviderApy(value: string | undefined, locale: string): string {
  if (value === undefined || !isDecimalString(value)) return "—";
  const rate = Number(value);
  if (!Number.isFinite(rate)) return "—";
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  }).format(rate);
}

export function shortenMarketAddress(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 6)}…${value.slice(-6)}`;
}

/**
 * One badge for the deposit-availability verdict, shared by the two catalogue
 * surfaces (the Treasury strategies table and the Earn Program builder) so the
 * mapping from `earnVaultDepositAvailability` to copy exists exactly once per
 * namespace. The label map is EXHAUSTIVE over the union: adding an
 * availability variant breaks both call sites' compiles instead of silently
 * collapsing to a bare "Unavailable". `cluster_unavailable` is the one reason
 * with a subject: the badge names the cluster the instrument lives on
 * (PRO-1742) from the row's own hostCluster, the server's `fundable` verdict,
 * with no cluster comparison re-derived here.
 */
export function EarnDepositAvailabilityBadge({
  availability,
  labels,
  strategy,
}: {
  availability: EarnVaultDepositAvailability;
  labels: Readonly<Record<EarnVaultDepositAvailability, MessageKey>>;
  strategy: EarnStrategy;
}) {
  const t = useTranslations();
  return (
    <Badge variant={availability === "available" ? "default" : "outline"}>
      {availability === "cluster_unavailable"
        ? t(labels.cluster_unavailable, { cluster: SOLANA_CLUSTER_LABELS[strategy.hostCluster] })
        : t(labels[availability])}
    </Badge>
  );
}

/** One strategy identity component shared by Treasury and Earn Program. */
export function EarnStrategyIdentity({
  showAssetMark = true,
  strategy,
}: {
  showAssetMark?: boolean;
  strategy: EarnStrategy;
}) {
  const asset = earnStrategyAsset(strategy);
  return (
    <div className="flex min-w-0 items-center gap-3">
      {showAssetMark && asset ? (
        <TokenMark mint={asset.mint} size="md" symbol={asset.symbol} />
      ) : null}
      <div className="min-w-0">
        <p className="line-clamp-2 break-words text-sm text-primary" title={strategy.name}>
          {strategy.name}
        </p>
        <p className="mt-0.5 truncate text-xs text-tertiary">
          {[asset?.symbol, earnProviderLabel(strategy.provider)].filter(Boolean).join(" · ")}
        </p>
      </div>
    </div>
  );
}
