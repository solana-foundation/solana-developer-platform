"use client";

import { RecordSection } from "@/app/(session)/dashboard/[projectId]/payments/payments-record";
import { useTranslations } from "@/i18n/provider";
import { useCurrentOrganization } from "./organization.data";
import { OrganizationAlertEmailsSwitch } from "./organization-alert-emails-switch";
import {
  SettingsLoadError,
  SettingsRowsSkeleton,
  useReadFailureText,
} from "./settings-section-state";

/**
 * Alert emails to the organization's admins (HOO-2299): one switch for all of them.
 * Per-type controls, when they come, go below the switch in this section.
 */
export function OrganizationAlertEmailsSection() {
  const t = useTranslations();
  const failureText = useReadFailureText();
  const organization = useCurrentOrganization();

  return (
    <RecordSection id="email-alerts" title={t("Shared.organizationAlertEmails.title")}>
      {organization.data ? (
        <OrganizationAlertEmailsSwitch
          initialEnabled={organization.data.alertEmailsEnabled}
          organizationId={organization.data.id}
        />
      ) : organization.error ? (
        <SettingsLoadError
          message={t("Shared.organizationAlertEmails.loadFailed", {
            error: failureText(organization.error),
          })}
          onRetry={() => void organization.mutate()}
        />
      ) : (
        <SettingsRowsSkeleton rows={1} />
      )}
    </RecordSection>
  );
}
