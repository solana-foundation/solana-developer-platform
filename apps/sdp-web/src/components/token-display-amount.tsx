"use client";

import {
  APPROXIMATE_TOKEN_DISPLAY_RULES,
  type TokenBalanceAmounts,
} from "@sdp/types/token-movements";
import { useSyncExternalStore } from "react";
import { useLocale, useTranslations } from "@/i18n/provider";

/** One caption formatter per locale, built once. */
const captionFormats = new Map<string, Intl.DateTimeFormat>();

function captionTime(locale: string, iso: string): string {
  let format = captionFormats.get(locale);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    captionFormats.set(locale, format);
  }
  return format.format(new Date(iso));
}

/** Nothing to subscribe to: the time only differs between server and browser. */
function subscribeToNothing(): () => void {
  return () => undefined;
}

/**
 * The chain time in the viewer's own time zone, formatted in the browser only:
 * the server renders no caption, so its time zone never reaches the markup.
 */
function useCaptionTime(locale: string, iso: string): string | null {
  return useSyncExternalStore(
    subscribeToNothing,
    () => captionTime(locale, iso),
    () => null
  );
}

/**
 * A holding's display amount, as a wallet shows it (ADR 0012). The caller
 * formats `displayAmount`; this adds "≈" and the chain time for an
 * interest-bearing mint. Never use it for an amount the user sends.
 *
 * The time is a caption, not a tooltip, so it stays readable inside a link row.
 */
export function TokenDisplayAmount({
  balance,
  formatted,
}: {
  balance: Pick<TokenBalanceAmounts, "displayRule" | "displayAsOf">;
  formatted: string;
}) {
  if (!APPROXIMATE_TOKEN_DISPLAY_RULES[balance.displayRule]) {
    return formatted;
  }
  return <ApproximateDisplayAmount displayAsOf={balance.displayAsOf} formatted={formatted} />;
}

/** Only an approximate amount needs copy, so an exact one renders without the catalog. */
function ApproximateDisplayAmount({
  displayAsOf,
  formatted,
}: {
  displayAsOf: string | null;
  formatted: string;
}) {
  const t = useTranslations();
  return (
    <>
      {t("Shared.tokenDisplay.approximate", { amount: formatted })}
      {displayAsOf === null ? null : <DisplayAsOfCaption displayAsOf={displayAsOf} />}
    </>
  );
}

function DisplayAsOfCaption({ displayAsOf }: { displayAsOf: string }) {
  const t = useTranslations();
  const time = useCaptionTime(useLocale(), displayAsOf);
  if (time === null) {
    return null;
  }
  return (
    <span className="ml-1 text-xs text-tertiary">{t("Shared.tokenDisplay.asOf", { time })}</span>
  );
}
