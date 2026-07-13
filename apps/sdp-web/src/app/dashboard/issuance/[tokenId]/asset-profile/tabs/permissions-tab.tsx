"use client";

import { useTranslations } from "@/i18n/provider";
import { TokenSettingsSection } from "../../token-settings-section";
import type { TokenOperations } from "../use-token-operations";

export function PermissionsTab({
  ops,
  canManageTokenAdmin,
}: {
  ops: TokenOperations;
  canManageTokenAdmin: boolean;
}) {
  const t = useTranslations();

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <SectionHeading
          title={t("DashboardIssuance.management.permissions")}
          description={t("DashboardIssuance.management.permissionsDescription")}
        />
        <TokenSettingsSection
          mode="permissions"
          permissionRows={ops.permissionRows}
          extensionRows={ops.extensionRows}
          showTitle={false}
          canEditAuthorities={!ops.canDeployToken && canManageTokenAdmin}
          onCopy={ops.handleCopy}
          onEditAuthority={ops.handleAuthorityModalOpen}
        />
      </div>
      <div className="space-y-3 pt-2">
        <SectionHeading
          title={t("DashboardIssuance.management.extensions")}
          description={t("DashboardIssuance.management.extensionsDescription")}
        />
        <TokenSettingsSection
          mode="extensions"
          permissionRows={ops.permissionRows}
          extensionRows={ops.extensionRows}
          showTitle={false}
          canEditAuthorities={false}
          onCopy={ops.handleCopy}
          onEditAuthority={ops.handleAuthorityModalOpen}
        />
      </div>
    </div>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <p className="text-base font-medium text-primary">{title}</p>
      <p className="mt-0.5 text-sm text-tertiary">{description}</p>
    </div>
  );
}
