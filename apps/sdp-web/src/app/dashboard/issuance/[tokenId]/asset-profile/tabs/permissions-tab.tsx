"use client";

import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "@/i18n/provider";
import { toWalletIdentity, WalletIdentityBadge } from "../../../wallet-identity";
import { PERMISSION_ROW_ICONS, TokenSettingsSection } from "../../token-settings-section";
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
          authorityWallets={ops.authorityWallets}
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
          authorityWallets={ops.authorityWallets}
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
  const custodyWallet = ops.authorityWallets[0] ?? null;

  return (
    <div className="rounded-xl border border-warning-border bg-warning-bg px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <TriangleAlert className="h-4.5 w-4.5 shrink-0 text-warning" />
        <p className="text-sm font-medium text-warning">
          {t("DashboardIssuance.permissions.externalWarningTitle")}
        </p>
        {externalRows.map((row) => {
          const Icon = PERMISSION_ROW_ICONS[row.id];
          return (
            <span
              key={row.id}
              className="inline-flex items-center gap-1 rounded-full bg-warning-bg px-2 py-0.5 text-xs font-medium text-warning ring-1 ring-warning-border ring-inset"
            >
              <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
              {row.title}
            </span>
          );
        })}
      </div>
      <p className="mt-1 text-sm text-warning">
        {t("DashboardIssuance.permissions.externalWarningBody")}
      </p>
      <div className="mt-4">
        {custodyWallet ? (
          <>
            <p className="text-xs text-warning">
              {t("DashboardIssuance.permissions.externalRemediationTarget")}
            </p>
            {/* The transfer target is one of our custody wallets, so name it —
                the compact badge, not the card, whose 48px mark and stacked key
                rows would dominate the banner. The flex wrapper keeps the badge
                (itself a block-level flex container) at content width instead of
                letting it stretch across the banner. */}
            <div className="mt-1.5 flex">
              <WalletIdentityBadge
                identity={toWalletIdentity(custodyWallet, null, {
                  unresolvedAs: "custom",
                  unlabeled: t("DashboardIssuance.wallet.unlabeled"),
                })}
                onCopy={(value) => void ops.handleCopy(value)}
              />
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
