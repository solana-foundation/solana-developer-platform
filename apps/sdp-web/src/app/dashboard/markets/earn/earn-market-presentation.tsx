"use client";

import { formatDecimalAmount, isDecimalString, parseDecimalAmount } from "@sdp/solana/amount";
import { type EarnStrategy, type SolanaCluster, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { truncateMiddle } from "../truncate-middle";
import {
  type EarnDepositAvailabilityLabels,
  earnDepositAvailabilityLabel,
  shortenMarketAddress,
} from "./earn-format";
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
    : { mint, symbol: mint.length <= 12 ? mint : truncateMiddle(mint, 4, 4) };
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

/**
 * The one transaction row both vault modals render: the signature shortened,
 * the cluster's explorer one click away. The cluster comes resolved from the
 * caller — a deposit reads it off the strategy, a withdrawal off the
 * environment.
 */
export function TransactionLink({
  signature,
  cluster,
}: {
  signature: string;
  cluster: SolanaCluster;
}) {
  return (
    <a
      className="inline-flex items-center gap-1 text-secondary underline decoration-border-strong underline-offset-4 transition-colors hover:text-primary"
      href={explorerTxUrl(signature, cluster)}
      rel="noreferrer"
      target="_blank"
    >
      {shortenMarketAddress(signature)}
      <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
    </a>
  );
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
  labels: EarnDepositAvailabilityLabels;
  strategy: EarnStrategy;
}) {
  const t = useTranslations();
  return (
    <Badge variant={availability === "available" ? "default" : "outline"}>
      {earnDepositAvailabilityLabel(availability, labels, strategy, t)}
    </Badge>
  );
}
