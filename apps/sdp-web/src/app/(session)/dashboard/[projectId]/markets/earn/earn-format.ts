import { isDecimalString } from "@sdp/solana/amount";
import type { EarnStrategy } from "@sdp/types/earn";
import type { OperationIntent, OperationStatus } from "@sdp/types/operations";
import type { EarnProviderId } from "@sdp/types/provider-access";
import { SOLANA_CLUSTER_LABELS, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
import type { StatusTone } from "@sdp/ui/status-text";
import { truncateMiddle } from "@/app/(session)/dashboard/[projectId]/markets/truncate-middle";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";
import { compareUnsignedDecimals } from "./earn-decimal";
import {
  type EarnVaultDepositAvailability,
  earnVaultDepositOnlyEnvironment,
} from "./earn-surfacing";

/**
 * Pure display formatters shared by every Earn surface.
 *
 * All money on the live wire is a decimal STRING and never passes through a
 * JavaScript `number`. `Intl.NumberFormat.prototype.format` accepts one
 * directly (ES2023) and formats it exactly, so a balance past 2^53 still
 * renders every digit it was given — which is why there is no `Number()` cast
 * and no hand-rolled digit grouping here.
 *
 * `roundingMode: "trunc"` is deliberate: these figures are balances and
 * ceilings, so rounding the last visible digit UP would display an amount the
 * provider will then refuse.
 *
 * Every formatter takes the caller's `locale`, matching `formatProviderApy` —
 * digit grouping and the decimal separator are locale facts, not en-US
 * constants.
 */
/**
 * `isDecimalString` restated as a type predicate: an unsigned decimal string is
 * exactly what `Intl`'s string overload takes, so this reaches the exact
 * formatter without an `as` cast.
 */
export function isIntlDecimalLiteral(value: string): value is Intl.StringNumericLiteral {
  return isDecimalString(value);
}

function formatDecimalString(
  value: string,
  locale: string,
  maximumFractionDigits: number,
  minimumFractionDigits: number
): string | undefined {
  if (!isIntlDecimalLiteral(value)) return undefined;
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits,
    minimumFractionDigits,
    roundingMode: "trunc",
  }).format(value);
}

/** Display a provider amount without losing precision or inventing zero. */
export function formatProviderAmount(
  value: string | undefined,
  locale: string,
  symbol?: string,
  maximumFractionDigits = 6,
  minimumFractionDigits = 0
): string {
  if (value === undefined) return "—";
  const amount = formatDecimalString(value, locale, maximumFractionDigits, minimumFractionDigits);
  if (amount === undefined) return "—";
  return symbol ? `${amount} ${symbol}` : amount;
}

/**
 * A dollar figure, to the cent, everywhere in Earn: provider USD fields (TVL,
 * fees, ceilings), dollar totals summed across USD-stable tokens and, through
 * `formatTokenValue`, every USD-stable deposit-token amount. Truncates like the
 * rest of this module so a balance never rounds UP; a value above zero but
 * under a cent renders "<$0.01" instead of the "$0.00" truncation would print,
 * so a real fee or balance never reads as nothing.
 */
export function formatUsd(value: string | undefined, locale: string): string {
  if (value === undefined || !isIntlDecimalLiteral(value)) return "—";
  if (isBelowOneCent(value)) return `<$${formatDecimalString("0.01", locale, 2, 2) ?? "0.01"}`;
  const amount = formatDecimalString(value, locale, 2, 2);
  return amount === undefined ? "—" : `$${amount}`;
}

/**
 * A provider-reported dollar total in compact notation ("$32M", "$1.23B"), where cents and whole
 * dollars are noise. It truncates like every Earn figure, so it never overstates.
 *
 * @param value - The total as a decimal string, or undefined when the provider reports none.
 * @param locale - The viewer's locale.
 * @returns The compact figure, or "—" when the total is unknown.
 */
export function formatCompactUsd(value: string | undefined, locale: string): string {
  if (value === undefined || !isIntlDecimalLiteral(value)) return "—";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumSignificantDigits: 3,
    roundingMode: "trunc",
  }).format(value);
}

/** Above zero but under one cent: exactly what a two-decimal truncation prints as zero. */
function isBelowOneCent(value: string): boolean {
  const [whole = "", fraction = ""] = value.split(".");
  if (/[1-9]/.test(whole) || /[1-9]/.test(fraction.slice(0, 2))) return false;
  return /[1-9]/.test(fraction.slice(2));
}

/** The parts of a table row's detail line, joined by the design's middle dot. */
/**
 * How each operation status reads, in the design system's status tones. A prepared operation
 * still waits on the user's decision, so it reads as plain text.
 */
export const EARN_OPERATION_STATUS_TONE: Record<OperationStatus, StatusTone | null> = {
  prepared: null,
  queued: "progress",
  awaiting_signature: "progress",
  submitted: "progress",
  settling: "progress",
  completed: "positive",
  failed: "critical",
  cancelled: "neutral",
};

export function earnDetailLine(parts: readonly string[]): string {
  return parts.join(" · ");
}

export function tokenSymbol(mint: string): string {
  return WELL_KNOWN_TOKEN_BY_MINT.get(mint)?.symbol ?? truncateMiddle(mint, 4, 4);
}

export function shortenMarketAddress(value: string): string {
  return value.length <= 16 ? value : truncateMiddle(value, 6, 6);
}

/**
 * A vault position's display name: the label the provider gave it, or the
 * shortened provider reference when it arrives unnamed. One rule for every
 * surface that names a position.
 */
export function positionDisplayName(position: {
  label: string;
  providerReference: string;
}): string {
  return position.label || shortenMarketAddress(position.providerReference);
}

export function formatTokenQuantity(
  value: string | undefined,
  locale: string,
  symbol: string
): string {
  return formatProviderAmount(value, locale, symbol, 6);
}

/**
 * A deposit-token amount for display: a position's `tokenValue`, a wallet's
 * balance in the deposit token, a withdrawal ceiling or quote. Every Earn
 * deposit token is a USD stablecoin (`EARN_DEPOSIT_TOKEN_SYMBOLS`), so a
 * USD-stable mint renders as dollars at par, to the cent. The `isUsdStable`
 * guard is what keeps that honest: any other mint renders as a token quantity
 * with its symbol rather than a wrong `$`, and an unresolved mint renders the
 * bare amount rather than guessing a unit. Par, not a price feed: a depeg is
 * not reflected, the same approximation the treasury deployed total and the
 * API's exposure caps make.
 */
export function formatTokenValue(
  value: string | undefined,
  tokenMint: string | undefined,
  locale: string
): string {
  if (tokenMint === undefined) return formatProviderAmount(value, locale);
  return WELL_KNOWN_TOKEN_BY_MINT.get(tokenMint)?.isUsdStable
    ? formatUsd(value, locale)
    : formatTokenQuantity(value, locale, tokenSymbol(tokenMint));
}

/**
 * A share count with its unit, singular for exactly one. A strategy's share token carries no
 * symbol of its own, so shares read as shares rather than a shortened mint.
 *
 * @param value - The decimal share count.
 * @param locale - The viewer's locale.
 * @param t - The translator.
 * @returns The count with its unit.
 */
export function formatShareAmount(
  value: string,
  locale: string,
  t: (key: MessageKey, values?: TranslationValues) => string
): string {
  const unit =
    compareUnsignedDecimals(value, "1") === 0
      ? "DashboardEarn.core.shareUnitOne"
      : "DashboardEarn.core.shareUnit";
  return formatTokenQuantity(value, locale, t(unit));
}

/**
 * The amount an operation's intent asks to move: the deposit, or the withdrawal as requested.
 *
 * @param intent - The operation's intent.
 * @param locale - The viewer's locale.
 * @param t - The translator.
 * @returns The requested amount as Earn surfaces name it.
 */
export function formatIntentAmount(
  intent: OperationIntent,
  locale: string,
  t: (key: MessageKey, values?: TranslationValues) => string
): string {
  if (intent.kind === "earn.deposit") {
    return formatTokenValue(intent.amount.value, intent.amount.mint, locale);
  }
  const { amount } = intent;
  switch (amount.kind) {
    case "all":
      return t("DashboardEarn.core.allHoldings");
    case "shares":
      return formatShareAmount(amount.value, locale, t);
    case "token":
    case "intermediate":
      return formatTokenValue(amount.value, amount.mint, locale);
    default: {
      const unknownAmount: never = amount;
      throw new Error(`Unknown withdrawal amount: ${JSON.stringify(unknownAmount)}`);
    }
  }
}

/** Turn a provider duration into one short, human unit for product copy. */
export function formatDurationSeconds(seconds: number, locale: string): string | undefined {
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;

  const units =
    seconds < 60
      ? ({ divisor: 1, unit: "second" } as const)
      : seconds < 3_600
        ? ({ divisor: 60, unit: "minute" } as const)
        : seconds < 86_400
          ? ({ divisor: 3_600, unit: "hour" } as const)
          : ({ divisor: 86_400, unit: "day" } as const);

  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "unit",
    unit: units.unit,
    unitDisplay: "long",
  }).format(seconds / units.divisor);
}

/** Format Unix epoch seconds only when JavaScript can represent the resulting date. */
export function formatEpochSeconds(
  value: string | null | undefined,
  locale: string
): string | undefined {
  if (value === undefined || value === null || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return undefined;
  const date = new Date(seconds * 1_000);
  if (!Number.isFinite(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** The formatted epoch timestamp, or the caller's placeholder when unrenderable. */
export function formatEpochSecondsOr(
  value: string | null | undefined,
  locale: string,
  unavailable: string
): string {
  return formatEpochSeconds(value, locale) ?? unavailable;
}

/**
 * Compact human range from two ISO-8601 durations (providers report processing
 * estimates as e.g. "PT21M" / "P2D"). Unparseable inputs render verbatim so a
 * provider format change degrades to raw text instead of hiding the estimate.
 */
export function formatDurationRange(minimum: string, maximum: string): string {
  const min = formatIsoDuration(minimum);
  const max = formatIsoDuration(maximum);
  return min === max ? min : `${min}–${max}`;
}

/** Whole-day count from an ISO-8601 duration ("P2D" → 2), else undefined. */
export function isoDurationDays(duration: string): number | undefined {
  const match = /^P(\d+)D$/.exec(duration.trim());
  return match ? Number(match[1]) : undefined;
}

function formatIsoDuration(duration: string): string {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration.trim());
  if (!match) return duration;
  const [, days, hours, minutes, seconds] = match.map((part) => (part ? Number(part) : 0));
  const totalSeconds = days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
  if (totalSeconds === 0) return duration;
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3_600) return `${Math.round(totalSeconds / 60)}m`;
  if (totalSeconds < 86_400) return `${Math.round(totalSeconds / 3_600)}h`;
  return `${Math.round(totalSeconds / 86_400)}d`;
}

/**
 * Display labels for vault-infra provider ids. Exhaustive over the registry so
 * a newly registered provider must state its label, but `strategy.provider` is
 * an open read-model string, so an unknown id renders as-is rather than being
 * hidden or renamed.
 */
const EARN_PROVIDER_LABELS = {
  kamino: "Kamino",
  hastra: "Hastra / Figure",
  jupiter_lend: "Jupiter Lend",
  ondo: "Ondo",
  perena: "Perena",
  upshift: "Upshift",
  veda: "Veda",
  wisdomtree: "WisdomTree",
  plume: "Plume",
} as const satisfies Record<EarnProviderId, string>;

export function earnProviderLabel(provider: string): string {
  return Object.hasOwn(EARN_PROVIDER_LABELS, provider)
    ? EARN_PROVIDER_LABELS[provider as EarnProviderId]
    : provider;
}

/**
 * Liquidity term for a catalogue row. `liquidityTerm` is typed closed but the
 * read model is open wire data, so a value outside the vocabulary returns
 * undefined and the caller renders its placeholder: a term is never invented.
 * A delayed row without a usable day count still says "Delayed"; the day count
 * renders only when it is a positive integer.
 */
export function earnStrategyLiquidityLabel(
  strategy: EarnStrategy,
  t: (key: MessageKey, values?: TranslationValues) => string
): string | undefined {
  if (strategy.liquidityTerm === "instant") return t("DashboardMarkets.liquidity.instant");
  if (strategy.liquidityTerm !== "delayed") return undefined;
  const days = strategy.redemptionDelayDays;
  if (days === undefined || !Number.isInteger(days) || days <= 0) {
    return t("DashboardMarkets.liquidity.delayed");
  }
  return days === 1
    ? t("DashboardMarkets.liquidity.delayedDay")
    : t("DashboardMarkets.liquidity.delayedDays", { days });
}

/**
 * Label keys per availability verdict, plus `production_only`: the
 * `environment_unavailable` verdict is about the CURRENT project, so the label
 * names the other side. Providers that deposit only in production (Jupiter
 * Lend, Ondo) read "Production only"; the sandbox-era providers keep
 * "Sandbox only".
 */
export type EarnDepositAvailabilityLabels = Readonly<
  Record<EarnVaultDepositAvailability | "production_only", MessageKey>
>;

export function earnDepositAvailabilityLabel(
  availability: EarnVaultDepositAvailability,
  labels: EarnDepositAvailabilityLabels,
  strategy: Pick<EarnStrategy, "hostCluster" | "provider">,
  t: (key: MessageKey, values?: TranslationValues) => string
): string {
  if (availability === "cluster_unavailable") {
    return t(labels.cluster_unavailable, { cluster: SOLANA_CLUSTER_LABELS[strategy.hostCluster] });
  }
  if (
    availability === "environment_unavailable" &&
    earnVaultDepositOnlyEnvironment(strategy.provider) === "production"
  ) {
    return t(labels.production_only);
  }
  return t(labels[availability]);
}
