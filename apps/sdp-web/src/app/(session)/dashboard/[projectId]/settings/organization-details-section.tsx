"use client";

import { useOrganization } from "@clerk/nextjs";
import { Card, CardContent, CardHeader, CardTitle } from "@sdp/ui/card";
import { DetailList, DetailRow } from "@sdp/ui/detail-list";
import { WalletMetadataCopyButton } from "@/app/(session)/dashboard/[projectId]/custody/wallet-address-copy-button";
import { useTranslations } from "@/i18n/provider";

export function OrganizationDetailsSection() {
  const t = useTranslations();
  const { organization } = useOrganization();

  if (!organization) {
    return null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Shared.organizationSettings.detailsTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        <DetailList>
          <DetailRow label={t("Shared.organizationSettings.name")}>{organization.name}</DetailRow>
          <DetailRow label={t("Shared.SharedComponents.organizationId")}>
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span className="truncate font-mono text-meta">{organization.id}</span>
              <WalletMetadataCopyButton
                value={organization.id}
                label={t("Shared.SharedComponents.organizationId")}
              />
            </span>
          </DetailRow>
        </DetailList>
      </CardContent>
    </Card>
  );
}
