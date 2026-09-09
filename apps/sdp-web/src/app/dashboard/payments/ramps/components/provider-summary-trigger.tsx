"use client";

import type { RampProviderId } from "@sdp/types/provider-access";
import { InfoIcon } from "lucide-react";
import Image from "next/image";
import { useTranslations } from "@/i18n/provider";
import { RAMP_PROVIDER_LOGOS, RAMP_PROVIDER_OPTIONS } from "@/lib/ramps";

/**
 * Provider-branded content for the wizard's summary button: "Powered by
 * [logo] Provider".
 *
 * @param provider - Selected ramp provider.
 * @returns The branded trigger content.
 */
export function ProviderSummaryTrigger({ provider }: { provider: RampProviderId }) {
  const t = useTranslations();
  const option = RAMP_PROVIDER_OPTIONS.find((candidate) => candidate.id === provider);
  if (option === undefined) {
    throw new Error(`Ramp provider ${provider} has no display option.`);
  }
  return (
    <>
      <InfoIcon className="size-4 shrink-0 text-muted" />
      <span className="text-tertiary">{t("DashboardPayments.ramps.checkoutPoweredBy")}</span>
      <Image
        src={RAMP_PROVIDER_LOGOS[provider]}
        alt=""
        width={16}
        height={16}
        className="size-4 shrink-0 rounded object-contain"
      />
      <span className="text-primary">{option.title}</span>
    </>
  );
}
