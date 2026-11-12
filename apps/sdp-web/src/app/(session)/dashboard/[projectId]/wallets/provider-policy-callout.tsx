"use client";

import type { CustodyProvider, ProviderPolicyCheck } from "@sdp/types/custody";
import { Callout } from "@sdp/ui/callout";
import { useMemo } from "react";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useTimeZone } from "@/i18n/time-zone";

type PolicyPresentation = { title: string; body: string };

const POLICY_PRESENTATION = {
  present: { title: "providerPolicyPresent", body: "providerPolicyPresentBody" },
  missing: { title: "providerPolicyMissing", body: "providerPolicyMissingBody" },
  unknown: { title: "providerPolicyUnknown", body: "providerPolicyUnknownBody" },
} as const satisfies Record<ProviderPolicyCheck["status"], PolicyPresentation>;

/** The same advisory is visible on the connection and on each wallet, including for viewers. */
export function ProviderPolicyCallout({
  check,
  provider,
}: {
  check: ProviderPolicyCheck | undefined;
  provider: CustodyProvider | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const formatCheckedAt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone,
      }),
    [locale, timeZone]
  );
  if (!check || (provider !== "fireblocks" && provider !== "privy")) return null;
  const name = provider === "fireblocks" ? "Fireblocks" : "Privy";
  const presentation = POLICY_PRESENTATION[check.status];
  const body =
    check.status === "unknown" && check.reason === "access_denied"
      ? "providerPolicyDeniedBody"
      : presentation.body;
  return (
    <Callout
      variant={check.status === "present" ? "neutral" : "warning"}
      title={t(`DashboardCustody.${presentation.title}`)}
    >
      <p>{t(`DashboardCustody.${body}`, { provider: name })}</p>
      {check.checkedAt ? (
        <p className="mt-2 text-caption text-secondary">
          {t("DashboardCustody.providerPolicyCheckedAt", {
            at: formatCheckedAt.format(new Date(check.checkedAt)),
          })}
        </p>
      ) : null}
    </Callout>
  );
}
