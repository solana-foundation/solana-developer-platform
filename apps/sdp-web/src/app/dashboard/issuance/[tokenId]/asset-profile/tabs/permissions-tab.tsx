"use client";

import { Copy, TriangleAlert } from "lucide-react";
import Link from "next/link";
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
      {ops.authoritySummary.hasExternal ? <ExternalAuthorityWarning ops={ops} /> : null}
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

/**
 * Warning + remediation for authorities held outside SDP custody. SDP can't sign
 * for them (or transfer them itself — that requires the current external holder),
 * so we surface which authorities are external, the custody address to transfer
 * to, and note the holder must perform the on-chain transfer themselves.
 */
function ExternalAuthorityWarning({ ops }: { ops: TokenOperations }) {
  const t = useTranslations();
  const externalRows = ops.permissionRows.filter((row) => row.controlStatus === "external");
  const custodyTarget = ops.authorityWallets[0]?.publicKey ?? null;

  return (
    <div className="rounded-xl border border-warning-border bg-warning-bg px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <TriangleAlert className="h-4.5 w-4.5 shrink-0 text-warning" />
        <p className="text-sm font-medium text-warning">
          {t("DashboardIssuance.permissions.externalWarningTitle")}
        </p>
        {externalRows.map((row) => (
          <span
            key={row.id}
            className="inline-flex items-center rounded-full bg-warning-bg px-2 py-0.5 text-xs font-medium text-warning ring-1 ring-warning-border ring-inset"
          >
            {row.title}
          </span>
        ))}
      </div>
      <p className="mt-1 text-sm text-warning">
        {t("DashboardIssuance.permissions.externalWarningBody")}
      </p>
      <div className="mt-4">
        {custodyTarget ? (
          <>
            <p className="text-xs text-warning">
              {t("DashboardIssuance.permissions.externalRemediationTarget")}
            </p>
            <div className="mt-1 flex w-fit max-w-full items-center gap-1.5">
              <span className="min-w-0 truncate text-[13px] font-medium text-primary">
                {custodyTarget}
              </span>
              <button
                type="button"
                onClick={() => void ops.handleCopy(custodyTarget)}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-tertiary transition-colors hover:bg-fill hover:text-primary"
                aria-label={t("DashboardIssuance.header.copyTokenAddress")}
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          </>
        ) : (
          <p className="text-xs text-warning">
            {t("DashboardIssuance.permissions.externalRemediationNoWallet")}{" "}
            <Link href="/dashboard/wallets/setup" className="font-medium underline">
              {t("DashboardIssuance.permissions.createWallet")}
            </Link>
          </p>
        )}
        <p className="mt-2 text-xs text-warning">
          {t("DashboardIssuance.permissions.externalRemediationNote")}
        </p>
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
