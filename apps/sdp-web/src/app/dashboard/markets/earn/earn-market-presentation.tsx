"use client";

import { formatDecimalAmount, isDecimalString, parseDecimalAmount } from "@sdp/solana/amount";
import { type EarnStrategy, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { TokenMark } from "@/components/token-mark";

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

/** One strategy identity component shared by Treasury and Earn Program. */
export function EarnStrategyIdentity({ strategy }: { strategy: EarnStrategy }) {
  const asset = earnStrategyAsset(strategy);
  return (
    <div className="flex min-w-0 items-center gap-3">
      {asset ? <TokenMark mint={asset.mint} size="md" symbol={asset.symbol} /> : null}
      <div className="min-w-0">
        <p className="line-clamp-2 break-words text-sm text-primary" title={strategy.name}>
          {strategy.name}
        </p>
        <p className="mt-0.5 truncate text-xs text-tertiary">
          {[asset?.symbol, strategy.provider].filter(Boolean).join(" · ")}
        </p>
      </div>
    </div>
  );
}
