"use client";

import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { ShieldCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { openExternalRampUrl } from "@/lib/trusted-ramp-destinations";

/**
 * Renders BVNK's agreement consent content inside the requirements step: one
 * row per required agreement with its external text link. The wizard's primary
 * action submits consent, which resolves the step to the next collect stage.
 *
 * @param props - The pending agreements.
 * @returns The consent content.
 */
export function BvnkAgreementConsent({
  agreements,
}: {
  agreements: Extract<
    CounterpartyRequirements,
    { status: "customer_agreement_required" }
  >["agreements"];
}) {
  const t = useTranslations();
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
      <ShieldCheckIcon className="size-10 text-primary" />
      <p className="text-lg font-medium text-primary">
        {t("DashboardPayments.bvnk.agreementRequiredTitle")}
      </p>
      <p className="max-w-md text-sm leading-relaxed text-tertiary">
        {t("DashboardPayments.bvnk.agreementRequiredDescription")}
      </p>
      <ul className="flex w-full max-w-md flex-col gap-4">
        {agreements.map((agreement) => (
          <li key={agreement.id} className="flex flex-col gap-2">
            <p className="font-medium">{agreement.name}</p>
            <p className="text-sm leading-relaxed text-tertiary">{agreement.description}</p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => openExternalRampUrl(agreement.downloadUrl)}
            >
              {t("DashboardPayments.bvnk.viewAgreement")}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
