import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@sdp/ui/card";
import { getTranslations } from "@/i18n/server";
import { loadOrganizationIpAllowlist } from "./organization-access-actions";
import { OrganizationIpAllowlistForm } from "./organization-ip-allowlist-form";

/** The organization-wide IP allowlist for its API keys. */
export async function OrganizationAccessSection() {
  const [t, allowlist] = await Promise.all([getTranslations(), loadOrganizationIpAllowlist()]);

  return (
    <Card id="api-access" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>{t("Shared.organizationAccess.title")}</CardTitle>
        <CardDescription>{t("Shared.organizationAccess.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {allowlist.ok ? (
          <OrganizationIpAllowlistForm initialAllowedIps={allowlist.allowedIps} />
        ) : (
          <p className="text-sm text-destructive" role="alert">
            {t("Shared.organizationAccess.loadFailed", { error: allowlist.error })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
