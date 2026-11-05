"use client";

import { useOrganization } from "@clerk/nextjs";
import {
  RecordList,
  RecordRow,
  RecordSection,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-record";
import { useTranslations } from "@/i18n/provider";

export function OrganizationDetailsSection() {
  const t = useTranslations();
  const { organization } = useOrganization();

  if (!organization) {
    return null;
  }
  return (
    <RecordSection title={t("Shared.organizationSettings.detailsTitle")}>
      <RecordList>
        <RecordRow label={t("Shared.organizationSettings.name")}>{organization.name}</RecordRow>
        <RecordRow label={t("Shared.SharedComponents.organizationId")} copy={organization.id}>
          <span className="tabular-nums">{organization.id}</span>
        </RecordRow>
      </RecordList>
    </RecordSection>
  );
}
