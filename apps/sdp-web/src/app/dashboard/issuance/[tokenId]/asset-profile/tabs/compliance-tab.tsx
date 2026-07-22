"use client";

import type { Token } from "@sdp/types";
import { ShieldCheck, Terminal } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { AdvancedSettingsEditor } from "../../../create/advanced-settings-editor";
import { ACCESS_CONTROL_OPTIONS, accessControlLabel } from "../../../create/asset-details-config";
import { FormCard, ReadOnlyField } from "../../../create/form-primitives";
import type { DraftState } from "../../../create/issuance-draft-wizard.types";
import { TokenControlListsSection } from "../../token-control-lists-section";
import type { AdminAction } from "../../token-management-workspace.types";
import { playgroundHrefForAction } from "../playground-links";
import type { AssetProfileForm } from "../use-asset-profile-form";
import type { TokenOperations } from "../use-token-operations";
import { ActionPills } from "./action-pills";
import { OpsActionForms } from "./ops-action-forms";

export function ComplianceTab({
  token,
  form,
  ops,
  canManageTokenAdmin,
}: {
  token: Token;
  form: AssetProfileForm;
  ops: TokenOperations;
  canManageTokenAdmin: boolean;
}) {
  const t = useTranslations();
  const { draft, updateDraft, saving, showErrors } = form;
  const isDeployed = Boolean(token.mintAddress);

  const availableActions: Array<{ id: AdminAction; label: string }> = [
    ...(ops.controlListCopy
      ? [{ id: "allowlist" as const, label: ops.controlListCopy.label }]
      : []),
    ...(canManageTokenAdmin
      ? [
          { id: "seize" as const, label: t("DashboardIssuance.compliance.forceTransfer") },
          { id: "force-burn" as const, label: t("DashboardIssuance.compliance.forceBurn") },
          { id: "freeze" as const, label: t("DashboardIssuance.compliance.freeze") },
          { id: "pause" as const, label: t("DashboardIssuance.compliance.pause") },
        ]
      : []),
  ];
  const [activeAction, setActiveAction] = useState<AdminAction | null>(
    availableActions[0]?.id ?? null
  );

  return (
    <div className="space-y-5">
      <FormCard
        title={t("DashboardIssuance.compliance.accessPolicy")}
        description={t("DashboardIssuance.compliance.accessPolicyDescription")}
        icon={ShieldCheck}
      >
        <div className="grid items-start gap-4 sm:grid-cols-2">
          {isDeployed ? (
            <ReadOnlyField
              label={t("DashboardIssuance.compliance.accessControl")}
              value={
                accessControlLabel(draft.accessControl, t) ??
                t("DashboardIssuance.compliance.notSet")
              }
              lockReason={t("DashboardIssuance.compliance.lockReason")}
            />
          ) : (
            <div className="max-w-xs">
              <Label>{t("DashboardIssuance.compliance.accessControl")}</Label>
              <div className="mt-1.5">
                <Select
                  disabled={saving}
                  value={draft.accessControl || null}
                  onValueChange={(value) =>
                    updateDraft({
                      accessControl: (value ?? "") as DraftState["accessControl"],
                    })
                  }
                  placeholder={t("DashboardIssuance.compliance.selectAccessControl")}
                >
                  {ACCESS_CONTROL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </Select>
              </div>
              <p className="mt-1.5 text-xs text-tertiary">
                {t("DashboardIssuance.compliance.appliedOnDeploy")}
              </p>
            </div>
          )}
        </div>
      </FormCard>

      <AdvancedSettingsEditor
        category={draft.assetCategory}
        type={draft.assetType}
        settings={draft.advancedSettings}
        onSettingsChange={(advancedSettings) => updateDraft({ advancedSettings })}
        capacities={draft.capacities}
        onCapacitiesChange={(capacities) => updateDraft({ capacities })}
        showErrors={showErrors}
        // On-chain extensions are immutable once deployed — lock them, but keep
        // the off-chain capacities editable. An undeployed draft stays fully
        // editable (the editor itself flags what becomes permanent at deploy).
        settingsReadOnly={isDeployed}
        disabled={saving}
      />

      {availableActions.length > 0 ? (
        <div className="space-y-4 pt-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-base font-medium text-primary">
                {t("DashboardIssuance.compliance.controls")}
              </p>
              <p className="mt-0.5 text-sm text-tertiary">
                {t("DashboardIssuance.compliance.controlsDescription")}
              </p>
            </div>
            {activeAction ? (
              <Button variant="outline" size="sm" asChild>
                <Link href={playgroundHrefForAction(token.id, activeAction)}>
                  <Terminal className="h-4 w-4" />
                  {t("DashboardIssuance.playground.openInPlayground")}
                </Link>
              </Button>
            ) : null}
          </div>
          <ActionPills
            actions={availableActions}
            activeAction={activeAction}
            disabledReasons={ops.complianceActionDisabledReasons}
            onSelectAction={setActiveAction}
          />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div>
              <OpsActionForms ops={ops} token={token} activeAction={activeAction} />
            </div>
            <TokenControlListsSection
              showControlList={ops.showControlList}
              controlListLabel={ops.controlListCopy?.label ?? null}
              allowlistEntriesCount={ops.allowlistEntries.length}
              allowlistError={ops.allowlistError}
              allowlistTotal={ops.allowlistTotal}
              allowlistHasMore={ops.allowlistHasMore}
              frozenAccountsCount={ops.frozenAccounts.length}
              frozenAccountsError={ops.frozenAccountsError}
              frozenAccountsTotal={ops.frozenAccountsTotal}
              frozenAccountsHasMore={ops.frozenAccountsHasMore}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
