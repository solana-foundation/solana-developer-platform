"use client";

import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { toWalletIdentity, WalletIdentityBadge } from "../../../wallet-identity";
import { PERMISSION_ROW_ICONS, TokenSettingsSection } from "../../token-settings-section";
import type { TokenOperations } from "../use-token-operations";
import type { AssetProfileForm } from "../use-asset-profile-form";
import { getSignerWalletOptionLabel } from "../../token-management-workspace.utils";

export function PermissionsTab({
  ops,
  form,
  canManageTokenAdmin,
}: {
  ops: TokenOperations;
  form: AssetProfileForm;
  canManageTokenAdmin: boolean;
}) {
  const t = useTranslations();
  const copy = {
    "mint-authority": [
      t("DashboardIssuance.simplified.mintPermission"),
      t("DashboardIssuance.simplified.mintPermissionHint"),
    ],
    "freeze-authority": [
      t("DashboardIssuance.simplified.freezePermission"),
      t("DashboardIssuance.simplified.freezePermissionHint"),
    ],
    "metadata-authority": [
      t("DashboardIssuance.simplified.metadataPermission"),
      t("DashboardIssuance.simplified.metadataPermissionHint"),
    ],
    "permanent-delegate": [
      t("DashboardIssuance.simplified.recoveryPermission"),
      t("DashboardIssuance.simplified.recoveryPermissionHint"),
    ],
  };
  return (
    <div className="w-full space-y-5">
      {ops.authoritySummary.hasExternal ? <ExternalAuthorityWarning ops={ops} /> : null}
      {ops.authorityWalletsLoading ? (
        <div aria-busy="true" className="divide-y divide-border-subtle">
          {ops.permissionRows.map((row) => (
            <div key={row.id} className="flex flex-wrap items-center justify-between gap-4 py-6">
              <SkeletonBlock className="h-5 w-52" />
              <SkeletonBlock className="h-10 w-48 rounded-lg" />
            </div>
          ))}
        </div>
      ) : ops.canDeployToken ? (
        <div className="w-full space-y-4">
          {ops.permissionRows.map((row) => (
            <div key={row.id} className="space-y-2 border-b border-border-subtle py-3 last:border-0">
              <p className="text-sm font-medium text-primary">{copy[row.id][0]}</p>
              <Select
            ariaLabel={copy[row.id][0]}
            placeholder={t("DashboardIssuance.signer.select")}
            value={form.draft.authorityWalletIds?.[row.id] || form.draft.signingWalletId || ops.authorityWallets[0]?.walletId || ""}
            disabled={!canManageTokenAdmin || form.saving || !ops.authorityWallets.length}
            onValueChange={(value) => {
              if (value) form.updateDraft({ authorityWalletIds: { ...form.draft.authorityWalletIds, [row.id]: value } });
            }}
          >
            {ops.authorityWallets.map((wallet) => (
              <SelectItem key={wallet.walletId} value={wallet.walletId}>
                {getSignerWalletOptionLabel(wallet, t)}
              </SelectItem>
            ))}
          </Select>
            </div>
          ))}
        </div>
      ) : (
        <TokenSettingsSection
          variant="flat"
          mode="permissions"
          permissionRows={ops.permissionRows.map((row) => ({
            ...row,
            title: copy[row.id][0],
            helper: copy[row.id][1],
          }))}
          extensionRows={ops.extensionRows}
          authorityWallets={ops.authorityWallets}
          showTitle={false}
          showEditActions={canManageTokenAdmin && !ops.canDeployToken}
          canEditAuthorities={!ops.canDeployToken && canManageTokenAdmin}
          onCopy={ops.handleCopy}
          onEditAuthority={ops.handleAuthorityModalOpen}
        />
      )}
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
