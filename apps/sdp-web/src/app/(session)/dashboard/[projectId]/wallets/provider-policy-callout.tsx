"use client";

import type { CustodyProvider, ProviderPolicyCheck } from "@sdp/types/custody";
import { isByokCustodyProvider } from "@sdp/types/custody";
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

/** Every translated body the advisory can show, per status and surface. */
type PolicyBody =
  | (typeof POLICY_PRESENTATION)[keyof typeof POLICY_PRESENTATION]["body"]
  | "providerPolicyMissingWalletBody"
  | "providerPolicyDeniedBody";

/** Which translated body explains this observation on this surface. */
function policyBody(check: ProviderPolicyCheck, scope: "connection" | "wallet"): PolicyBody {
  switch (check.status) {
    case "present":
      return POLICY_PRESENTATION.present.body;
    case "missing":
      return scope === "wallet"
        ? "providerPolicyMissingWalletBody"
        : POLICY_PRESENTATION.missing.body;
    case "unknown":
      return check.reason === "access_denied"
        ? "providerPolicyDeniedBody"
        : POLICY_PRESENTATION.unknown.body;
    default: {
      const exhaustive: never = check.status;
      throw new Error(`Unhandled provider policy status: ${exhaustive}`);
    }
  }
}

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
  if (!check || !provider || !isByokCustodyProvider(provider)) return null;
  const name = formatCustodyProviderName(provider);
  const presentation = POLICY_PRESENTATION[check.status];
  const checkedAt = check.checkedAt ? formatDateTime(locale, timeZone, check.checkedAt) : null;
  return (
    <Callout
      variant={check.status === "present" ? "neutral" : "warning"}
      title={t(`DashboardCustody.${presentation.title}`)}
    >
      <p>{t(`DashboardCustody.${policyBody(check, scope)}`, { provider: name })}</p>
      {checkedAt ? (
        <p className="mt-2 text-caption text-secondary">
          {t("DashboardCustody.providerPolicyCheckedAt", { at: checkedAt })}
        </p>
      ) : null}
    </Callout>
  );
}
