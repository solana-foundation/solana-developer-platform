import { RecordSection } from "@/app/(session)/dashboard/[projectId]/payments/payments-record";
import { getTranslations } from "@/i18n/server";
import { loadOrganizationIpAllowlist } from "./organization-access-actions";
import { OrganizationIpAllowlist } from "./organization-ip-allowlist";

/** The organization-wide IP allowlist for its API keys. */
export async function OrganizationAccessSection() {
  const [t, allowlist] = await Promise.all([getTranslations(), loadOrganizationIpAllowlist()]);

  if (allowlist.ok) {
    return <OrganizationIpAllowlist initialAllowedIps={allowlist.allowedIps} />;
  }
  return (
    <RecordSection id="api-access" title={t("Shared.organizationAccess.title")}>
      <p className="text-body text-error" role="alert">
        {t("Shared.organizationAccess.loadFailed", { error: allowlist.error })}
      </p>
    </RecordSection>
  );
}
