import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@sdp/ui/card";
import { getTranslations } from "@/i18n/server";
import { loadOrganizationAlertEmails } from "./organization-access-actions";
import { OrganizationAlertEmailsSwitch } from "./organization-alert-emails-switch";

/**
 * Alert emails to the organization's admins (HOO-2299): one switch for all of them.
 * Per-type controls, when they come, go below the switch in this card's content.
 */
export async function OrganizationAlertEmailsSection() {
  const [t, alertEmails] = await Promise.all([getTranslations(), loadOrganizationAlertEmails()]);

  return (
    <Card id="email-alerts" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>{t("Shared.organizationAlertEmails.title")}</CardTitle>
        <CardDescription>{t("Shared.organizationAlertEmails.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {alertEmails.ok ? (
          <OrganizationAlertEmailsSwitch initialEnabled={alertEmails.enabled} />
        ) : (
          <p className="text-sm text-destructive" role="alert">
            {t("Shared.organizationAlertEmails.loadFailed", { error: alertEmails.error })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
