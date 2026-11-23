"use client";

import type { CustodyProvider, ProviderPolicyCheck } from "@sdp/types/custody";
import { Callout } from "@sdp/ui/callout";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useTimeZone } from "@/i18n/time-zone";
import { formatDateTime } from "@/lib/date-format";
import { formatCustodyProviderName } from "./provider-catalog";

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
  scope,
}: {
  check: ProviderPolicyCheck | undefined;
  provider: CustodyProvider | null;
  /** The surface showing the advisory: one wallet, or the wallets of a connection. */
  scope: "connection" | "wallet";
}) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  if (!check || (provider !== "fireblocks" && provider !== "privy")) return null;
  const name = formatCustodyProviderName(provider);
  const presentation = POLICY_PRESENTATION[check.status];
  const checkedAt = check.checkedAt ? formatDateTime(locale, timeZone, check.checkedAt) : null;
  const body =
    check.status === "unknown" && check.reason === "access_denied"
      ? "providerPolicyDeniedBody"
      : check.status === "missing" && scope === "wallet"
        ? "providerPolicyMissingWalletBody"
        : presentation.body;
  return (
    <Callout
      variant={check.status === "present" ? "neutral" : "warning"}
      title={t(`DashboardCustody.${presentation.title}`)}
    >
      <p>{t(`DashboardCustody.${body}`, { provider: name })}</p>
      {checkedAt ? (
        <p className="mt-2 text-caption text-secondary">
          {t("DashboardCustody.providerPolicyCheckedAt", { at: checkedAt })}
        </p>
      ) : null}
    </Callout>
  );
}
