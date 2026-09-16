"use client";

import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { FileTextIcon, LockIcon, ShieldCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslations } from "@/i18n/provider";
import { openBvnkCustomerLink } from "@/lib/trusted-ramp-destinations";

/**
 * Renders BVNK's agreement consent content inside the requirements step: one
 * card per required agreement with its external text and
 * privacy-policy links. The provider's description is shown only when it adds
 * to the display name. The wizard's primary action submits consent, which
 * resolves the step to the next collect stage.
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
      <ul className="flex w-full max-w-md flex-col gap-3">
        {agreements.map((agreement) => (
          <li key={agreement.name}>
            <Card className="gap-4 text-center">
              <CardHeader>
                <CardTitle>{agreement.displayName}</CardTitle>
                {agreement.description !== agreement.displayName ? (
                  <CardDescription>{agreement.description}</CardDescription>
                ) : null}
              </CardHeader>
              <CardContent className="flex flex-wrap justify-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  iconLeft={<FileTextIcon />}
                  onClick={() => openBvnkCustomerLink(agreement.url)}
                >
                  {t("DashboardPayments.bvnk.viewAgreement")}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  iconLeft={<LockIcon />}
                  onClick={() => openBvnkCustomerLink(agreement.privacyPolicyUrl)}
                >
                  {t("DashboardPayments.bvnk.viewPrivacyPolicy")}
                </Button>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
