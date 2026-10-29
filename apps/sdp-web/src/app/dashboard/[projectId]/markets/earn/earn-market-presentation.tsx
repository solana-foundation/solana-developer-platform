"use client";

import { formatDecimalAmount, isDecimalString, parseDecimalAmount } from "@sdp/solana/amount";
import type { EarnStrategy } from "@sdp/types/earn";
import { type SolanaCluster, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
import { ExternalLinkIcon } from "lucide-react";
import { truncateMiddle } from "@/app/dashboard/[projectId]/markets/truncate-middle";
import { explorerTxUrl } from "@/lib/explorer";
import { shortenMarketAddress } from "./earn-format";

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
