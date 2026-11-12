"use client";

import type { ProviderPolicyCheck } from "@sdp/types/custody";
import { Callout } from "@sdp/ui/callout";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useTimeZone } from "@/i18n/time-zone";

/** The same advisory is visible on the connection and on each wallet, including for viewers. */
export function ProviderPolicyCallout({
  check,
  provider,
}: {
  check: ProviderPolicyCheck | undefined;
  provider: string | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  if (!check || (provider !== "fireblocks" && provider !== "privy")) return null;
  const name = provider === "fireblocks" ? "Fireblocks" : "Privy";
  const presentation = {
    present: { title: "providerPolicyPresent", body: "providerPolicyPresentBody" },
    missing: { title: "providerPolicyMissing", body: "providerPolicyMissingBody" },
    unknown: {
      title: "providerPolicyUnknown",
      body:
        check.reason === "access_denied" ? "providerPolicyDeniedBody" : "providerPolicyUnknownBody",
    },
  } as const;
  const { title, body } = presentation[check.status];
  return (
    <Callout
      variant={check.status === "present" ? "neutral" : "warning"}
      title={t(`DashboardCustody.${title}`)}
    >
      <p>{t(`DashboardCustody.${body}`, { provider: name })}</p>
      {check.checkedAt ? (
        <p className="mt-2 text-caption text-secondary">
          {t("DashboardCustody.providerPolicyCheckedAt", {
            at: new Intl.DateTimeFormat(locale, {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone,
            }).format(new Date(check.checkedAt)),
          })}
        </p>
      ) : null}
    </Callout>
  );
}
