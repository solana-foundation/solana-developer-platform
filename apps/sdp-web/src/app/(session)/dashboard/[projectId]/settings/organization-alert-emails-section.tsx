import { RecordSection } from "@/app/(session)/dashboard/[projectId]/payments/payments-record";
import { getTranslations } from "@/i18n/server";
import {
  loadOrganizationAlertEmails,
  saveOrganizationAlertEmailsAction,
} from "./organization-access-actions";
import { OrganizationAlertEmailsSwitch } from "./organization-alert-emails-switch";

/**
 * Alert emails to the organization's admins (HOO-2299): one switch for all of them.
 * Per-type controls, when they come, go below the switch in this section.
 */
export async function OrganizationAlertEmailsSection() {
  const [t, alertEmails] = await Promise.all([getTranslations(), loadOrganizationAlertEmails()]);

  return (
    <RecordSection id="email-alerts" title={t("Shared.organizationAlertEmails.title")}>
      {alertEmails.ok ? (
        <OrganizationAlertEmailsSwitch
          initialEnabled={alertEmails.enabled}
          save={saveOrganizationAlertEmailsAction}
        />
      ) : (
        <p className="text-body text-error" role="alert">
          {t("Shared.organizationAlertEmails.loadFailed", { error: alertEmails.error })}
        </p>
      )}
    </RecordSection>
  );
}
