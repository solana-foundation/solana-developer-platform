"use client";

import type { Token } from "@sdp/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { AdvancedSettingsEditor } from "../../../create/advanced-settings-editor";
import { ReadOnlyField, TextField } from "../../../create/form-primitives";
import type { DraftState } from "../../../create/issuance-draft-wizard.types";
import type { AssetProfileForm } from "../use-asset-profile-form";

export function DetailsTab({
  token,
  form,
  editing,
  onEdit,
}: {
  token: Token;
  form: AssetProfileForm;
  editing: boolean;
  onEdit: () => void;
}) {
  const t = useTranslations();
  const { dashboardAccess } = useDashboardWorkspace();
  const rows = [
    [t("DashboardIssuance.forms.name"), form.draft.name],
    [t("DashboardIssuance.create.symbol"), form.draft.symbol],
    [
      t("DashboardIssuance.ux.issuanceLimit"),
      form.draft.maxSupply
        ? `${Number(form.draft.maxSupply).toLocaleString()} ${form.draft.symbol}`
        : t("DashboardIssuance.assetDetails.maxSupplyUnlimited"),
    ],
    [t("DashboardIssuance.assetDetails.descriptionLabel"), form.draft.description],
    [t("DashboardIssuance.assetDetails.website"), form.draft.website],
  ].filter(([, value]) => value);
  return (
    <div className="space-y-4">
      {dashboardAccess.capabilities.canManageTokenAdmin && !editing ? (
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" disabled={form.saving} onClick={onEdit}>
            {t("DashboardIssuance.ux.editSettings")}
          </Button>
        </div>
      ) : null}
      {editing ? (
        <EditableDetailsTab token={token} form={form} />
      ) : (
        <>
          <dl className="divide-y divide-border-subtle text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="flex flex-wrap justify-between gap-x-6 gap-y-1 py-3">
                <dt className="text-tertiary">{label}</dt>
                <dd className="max-w-full break-words text-primary sm:max-w-[70%] sm:text-right">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <AdvancedSettingsEditor
            category={form.draft.assetCategory}
            type={form.draft.assetType}
            settings={form.draft.advancedSettings}
            onSettingsChange={() => {}}
            accessControl={form.draft.accessControl}
            onAccessControlChange={() => {}}
            mode="readonly"
          />
        </>
      )}
    </div>
  );
}

function EditableDetailsTab({ token, form }: { token: Token; form: AssetProfileForm }) {
  const t = useTranslations();
  const { dashboardAccess } = useDashboardWorkspace();
  const canManageTokenAdmin = dashboardAccess.capabilities.canManageTokenAdmin;
  const { draft, updateDraft, saving, errors, showErrors, supplyLocked } = form;

  // Same reveal semantics as the creation wizard: live feedback once a field
  // has content, everything after a failed save attempt.
  const fieldError = (key: keyof DraftState): string | undefined => {
    const message = errors[key];
    if (!message) {
      return undefined;
    }
    const hasContent = String(draft[key] ?? "").trim().length > 0;
    return hasContent || showErrors ? message : undefined;
  };
  const nameError = fieldError("name");
  const descriptionError = fieldError("description");
  const symbolError = fieldError("symbol");
  const decimalsError = fieldError("decimals");

  // Symbol and decimals are baked into the mint at deploy, so they lock once
  // the token is on-chain and stay editable only while it's a draft.
  const isDeployed = Boolean(token.mintAddress);

  return (
    <div className="w-full space-y-8">
      <section className="space-y-5">
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <TextField
              label={t("DashboardIssuance.forms.name")}
              required
              disabled={saving}
              value={draft.name}
              onChange={(value) => updateDraft({ name: value })}
              placeholder={t("DashboardIssuance.assetDetails.namePlaceholder")}
              error={nameError}
            />
          </div>
          {isDeployed ? (
            <>
              <ReadOnlyField label={t("DashboardIssuance.create.symbol")} value={token.symbol} />
              <ReadOnlyField
                label={t("DashboardIssuance.create.decimals")}
                value={String(token.decimals)}
              />
            </>
          ) : (
            <>
              <TextField
                label={t("DashboardIssuance.create.symbol")}
                required
                disabled={saving}
                value={draft.symbol}
                onChange={(value) => updateDraft({ symbol: value })}
                placeholder={t("DashboardIssuance.assetDetails.symbolPlaceholder")}
                error={symbolError}
              />
              <TextField
                label={t("DashboardIssuance.create.decimals")}
                required
                type="number"
                disabled={saving}
                value={draft.decimals}
                onChange={(value) => updateDraft({ decimals: value })}
                placeholder={t("DashboardIssuance.create.decimalsPlaceholder")}
                error={decimalsError}
              />
            </>
          )}
          {/* The cap lives on the token row, not in issuance_metadata, and SDP
              enforces it at mint time — so it stays editable for as long as SDP
              can enforce it, i.e. until lock-supply revokes the mint authority.
              The hint states both halves of that (who enforces it, and that it
              can be made permanent); "blank = unlimited" is left to the
              placeholder so the copy stays as short as its neighbours'. */}
          {supplyLocked ? (
            <ReadOnlyField
              label={t("DashboardIssuance.assetDetails.maxSupply")}
              value={token.maxSupply ?? t("DashboardIssuance.assetDetails.maxSupplyUnlimited")}
              lockReason={t("DashboardIssuance.assetDetails.maxSupplyLockedReason")}
            />
          ) : (
            <TextField
              label={t("DashboardIssuance.assetDetails.maxSupply")}
              disabled={saving}
              type="number"
              value={draft.maxSupply}
              onChange={(value) => updateDraft({ maxSupply: value })}
              placeholder={t("DashboardIssuance.assetDetails.maxSupplyPlaceholder")}
              help={t("DashboardIssuance.assetDetails.maxSupplyEnforcementHint")}
              error={fieldError("maxSupply")}
            />
          )}
        </div>
        <div className="mt-4 grid gap-1.5">
          <Label htmlFor="asset-description">
            {t("DashboardIssuance.assetDetails.descriptionLabel")}
          </Label>
          <textarea
            id="asset-description"
            disabled={saving}
            value={draft.description}
            onChange={(event) => updateDraft({ description: event.currentTarget.value })}
            rows={3}
            aria-invalid={descriptionError ? true : undefined}
            className={cn(
              "w-full rounded-[14px] border bg-surface-raised px-4 py-3 text-sm text-primary outline-none transition-[box-shadow,border-color] placeholder:text-muted",
              descriptionError
                ? "border-destructive focus:border-destructive focus:ring-2 focus:ring-destructive-border"
                : "border-border-default focus:border-border-strong focus:ring-2 focus:ring-border-default"
            )}
          />
          {descriptionError ? (
            <p className="text-xs text-destructive" role="alert">
              {descriptionError}
            </p>
          ) : null}
        </div>
        <div className="mt-4 grid items-start gap-4 sm:grid-cols-2">
          <TextField
            label={t("DashboardIssuance.assetDetails.website")}
            disabled={saving}
            value={draft.website}
            onChange={(value) => updateDraft({ website: value })}
            placeholder={t("DashboardIssuance.assetDetails.websitePlaceholder")}
            error={fieldError("website")}
          />
          <TextField
            label={t("DashboardIssuance.assetDetails.logoImageUrl")}
            disabled={saving}
            value={draft.imageUrl}
            onChange={(value) => updateDraft({ imageUrl: value })}
            placeholder={t("DashboardIssuance.assetDetails.logoPlaceholder")}
            error={fieldError("imageUrl")}
          />
        </div>
      </section>
      <section className="border-t border-border-subtle pt-6">
        <h3 className="mb-4 text-sm font-medium text-primary">
          {t("DashboardIssuance.simplified.controls")}
        </h3>
        <AdvancedSettingsEditor
          category={draft.assetCategory}
          type={draft.assetType}
          settings={draft.advancedSettings}
          onSettingsChange={(advancedSettings) => updateDraft({ advancedSettings })}
          accessControl={draft.accessControl}
          onAccessControlChange={(accessControl) => updateDraft({ accessControl })}
          mode={isDeployed ? "readonly" : saving || !canManageTokenAdmin ? "disabled" : "editable"}
          showErrors={showErrors}
        />
      </section>
    </div>
  );
}
