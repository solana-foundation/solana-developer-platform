"use client";

import { DEFAULT_SDP_DOCS_URL, type Token } from "@sdp/types";
import { type LucideIcon, ShieldCheck, Snowflake, Terminal } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useLocale, useTranslations } from "@/i18n/provider";
import { AdvancedSettingsEditor } from "../../../create/advanced-settings-editor";
import { buildDeployConfigPreview } from "../../../create/draft-mapping";
import type { AdminAction } from "../../token-management-workspace.types";
import { playgroundHrefForAction } from "../playground-links";
import type { AssetProfileForm } from "../use-asset-profile-form";
import type { TokenOperations } from "../use-token-operations";
import { ActionPills } from "./action-pills";
import { OpsActionForms } from "./ops-action-forms";

// No shared docs-URL helper exists; mirror the create wizard's local env pattern.
const DOCS_BASE =
  process.env.NEXT_PUBLIC_SDP_DOCS_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:3001/docs" : DEFAULT_SDP_DOCS_URL);
const ACCESS_CONTROL_DOCS_HREF = `${DOCS_BASE}/tokens/allowlists`;

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

  const hasControls = availableActions.length > 0;
  // The advanced-settings / policy editor is admin-only. Non-admins reach this
  // tab only for control-list tokens, where they get the allowlist controls but
  // not the policy editor (also enforced server-side on the profile PATCH).
  const showPolicyEditor = canManageTokenAdmin;
  const twoColumn = showPolicyEditor && hasControls;

  return (
    // Editor beside controls on widescreens; single column when only one side is
    // present (admin with no controls, or a non-admin allowlist-only view).
    <div
      className={
        twoColumn
          ? // Custom 1440px breakpoint (xl/1280 cramps the left column). Controls
            // hold a fixed width so their tab row never scrolls; the editor takes
            // minmax(0,1fr) and reflows to absorb the rest.
            "grid grid-cols-1 gap-4 min-[1440px]:grid-cols-[minmax(0,1fr)_600px] min-[1440px]:items-start"
          : undefined
      }
    >
      {showPolicyEditor ? (
        <AdvancedSettingsEditor
          // Collapse the inner grids on the editor's own width, not the viewport —
          // it lives in a narrow half-column here.
          containerResponsive
          category={draft.assetCategory}
          type={draft.assetType}
          settings={draft.advancedSettings}
          onSettingsChange={(advancedSettings) => updateDraft({ advancedSettings })}
          capacities={draft.capacities}
          onCapacitiesChange={(capacities) => updateDraft({ capacities })}
          // Access control lives in the permanent (on-chain) section.
          accessControl={draft.accessControl}
          onAccessControlChange={(accessControl) => updateDraft({ accessControl })}
          accessControlReadOnly={isDeployed}
          accessControlDocsHref={ACCESS_CONTROL_DOCS_HREF}
          // Deploy-payload preview is pre-deploy only; null hides the button.
          deployConfig={isDeployed ? null : buildDeployConfigPreview(draft)}
          // Scenario presets are creation-only.
          showScenarios={false}
          // The compliance tab is the config home; the wizard keeps capacities
          // declaration-only.
          allowCapacityConfig
          showErrors={showErrors}
          // Once deployed, on-chain extensions lock but off-chain capacities stay editable.
          settingsReadOnly={isDeployed}
          disabled={saving}
        />
      ) : null}

      {hasControls ? (
        // One card for the whole controls column; the form renders "bare" so it
        // doesn't draw a second box inside this one.
        <div className="rounded-2xl border border-border-default bg-surface-raised p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-base font-medium text-primary">
                {t("DashboardIssuance.compliance.controls")}
              </p>
              <p className="mt-0.5 text-sm text-tertiary">
                {t("DashboardIssuance.compliance.controlsDescription")}
              </p>
            </div>
            {activeAction ? (
              <Button variant="outline" size="sm" className="shrink-0" asChild>
                <Link href={playgroundHrefForAction(token.id, activeAction)}>
                  <Terminal className="h-4 w-4" />
                  {t("DashboardIssuance.playground.viewApiContext")}
                </Link>
              </Button>
            ) : null}
          </div>
          <div className="mt-4 space-y-3">
            <ActionPills
              actions={availableActions}
              activeAction={activeAction}
              disabledReasons={ops.complianceActionDisabledReasons}
              onSelectAction={setActiveAction}
            />
            <div className="flex flex-wrap gap-3">
              {ops.showControlList ? (
                <CountCard
                  icon={ShieldCheck}
                  label={
                    ops.controlListCopy?.label ?? t("DashboardIssuance.controlLists.controlList")
                  }
                  count={ops.allowlistTotal ?? ops.allowlistEntries.length}
                  unit="entries"
                  error={ops.allowlistError}
                />
              ) : null}
              <CountCard
                icon={Snowflake}
                label={t("DashboardIssuance.controlLists.frozenAccounts")}
                count={ops.frozenAccountsTotal ?? ops.frozenAccounts.length}
                unit="accounts"
                error={ops.frozenAccountsError}
              />
            </div>
          </div>
          {/* [&_p.invisible]:hidden collapses the empty validation lines the shared
              fields reserve (~20px each); scoped here so modal/legacy forms keep
              their no-layout-shift reserve. The DS inputs paint their border on an
              inner span via --input-border-*, so border-* classes are inert — override
              the vars to match the 1px border tokens on the surrounding cards. */}
          <div className="mt-5 border-t border-border-subtle pt-5 [&_p.invisible]:hidden [--input-border-hover:var(--color-border-strong)] [--input-border-idle:var(--color-border-default)] [--input-border-width:1px]">
            <OpsActionForms
              ops={ops}
              token={token}
              activeAction={activeAction}
              submitAlignment="end"
              formVariant="bare"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Summary card for a control-list count; the detail line turns red on a fetch error.
function CountCard({
  icon: Icon,
  label,
  count,
  unit,
  error,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
  unit: "entries" | "accounts";
  error: string | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const detail =
    unit === "entries"
      ? t("DashboardIssuance.controlLists.entriesCount", { count: count.toLocaleString(locale) })
      : t("DashboardIssuance.controlLists.accountsCount", { count: count.toLocaleString(locale) });
  return (
    <div
      title={error ?? undefined}
      className="flex min-w-[12rem] flex-1 items-center gap-3 rounded-xl border border-border-default p-3"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-fill-subtle text-primary">
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-primary">{label}</p>
        <p className={["truncate text-sm", error ? "text-error" : "text-tertiary"].join(" ")}>
          {error ?? detail}
        </p>
      </div>
    </div>
  );
}
