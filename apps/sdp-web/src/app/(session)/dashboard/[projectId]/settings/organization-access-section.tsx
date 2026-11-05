"use client";

import { RecordSection } from "@/app/(session)/dashboard/[projectId]/payments/payments-record";
import { useTranslations } from "@/i18n/provider";
import { useCurrentOrganization } from "./organization.data";
import { OrganizationIpAllowlist } from "./organization-ip-allowlist";
import {
  SettingsLoadError,
  SettingsRowsSkeleton,
  useReadFailureText,
} from "./settings-section-state";

/** The organization-wide IP allowlist for its API keys. */
export function OrganizationAccessSection() {
  const t = useTranslations();
  const failureText = useReadFailureText();
  const organization = useCurrentOrganization();

  if (organization.data) {
    return (
      <OrganizationIpAllowlist
        organizationId={organization.data.id}
        initialAllowedIps={organization.data.allowedIps}
      />
    );
  }
  return (
    <RecordSection id="api-access" title={t("Shared.organizationAccess.title")}>
      {organization.error ? (
        <SettingsLoadError
          message={t("Shared.organizationAccess.loadFailed", {
            error: failureText(organization.error),
          })}
          onRetry={() => void organization.mutate()}
        />
      ) : (
        <SettingsRowsSkeleton rows={2} />
      )}
    </RecordSection>
  );
}
