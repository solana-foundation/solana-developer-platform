import { RecordSection } from "@/app/dashboard/[projectId]/payments/payments-record";
import { getTranslations } from "@/i18n/server";
import { OrganizationIpAllowlist } from "./organization-ip-allowlist";
import { loadOrganizationIpAllowlist } from "./organization-settings-load";

/** The organization-wide IP allowlist for its API keys. */
export async function OrganizationAccessSection() {
  const [t, allowlist] = await Promise.all([getTranslations(), loadOrganizationIpAllowlist()]);

  if (allowlist.ok) {
    return (
      <OrganizationIpAllowlist
        organizationId={allowlist.organizationId}
        initialAllowedIps={allowlist.allowedIps}
      />
    );
  }
  return (
    <RecordSection id="api-access" title={t("Shared.organizationAccess.title")}>
      <p className="text-body text-error" role="alert">
        {t("Shared.organizationAccess.loadFailed", { error: allowlist.error })}
      </p>
    </RecordSection>
  );
}
