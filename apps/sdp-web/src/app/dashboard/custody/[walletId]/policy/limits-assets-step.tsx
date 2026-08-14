"use client";

import { X } from "lucide-react";
import { useMemo } from "react";
import { shortenAddress } from "@/app/dashboard/payments/payments-overview.utils";
import { TokenMark } from "@/components/token-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/i18n/provider";
import { AssetEditor } from "./asset-editor";
import { AssetSearchCombobox } from "./asset-search-combobox";
import { PolicyAssetBadge } from "./policy-asset-badge";
import {
  isValidDecimal,
  isValidSolanaAddress,
  type PolicyAssetOption,
  type PolicyAuthoringState,
  type PolicyLimitInput,
  type validatePolicyState,
} from "./wallet-policy-authoring";
import { EmptyStepState, FormSection } from "./wallet-policy-flow.shared";

export function LimitsAndAssetsStep({
  state,
  setPolicyState,
  assetOptions,
  errors,
}: {
  state: PolicyAuthoringState;
  setPolicyState: (update: (current: PolicyAuthoringState) => PolicyAuthoringState) => void;
  assetOptions: PolicyAssetOption[];
  errors: ReturnType<typeof validatePolicyState>;
}) {
  const t = useTranslations();
  const showLimits = state.categories.includes("limits");
  const showAssets = state.categories.includes("assets");
  const assetByMint = useMemo(
    () => new Map(assetOptions.map((asset) => [asset.mint, asset])),
    [assetOptions]
  );
  const limitedMints = state.limits.map((limit) => limit.asset);
  const seenLimitAssets = new Set<string>();
  const duplicateLimitAssets = new Set<string>();
  for (const limit of state.limits) {
    const asset = limit.asset.trim();
    if (seenLimitAssets.has(asset)) duplicateLimitAssets.add(asset);
    seenLimitAssets.add(asset);
  }

  if (!showLimits && !showAssets) return <EmptyStepState />;

  return (
    <div className="space-y-6">
      {showLimits ? (
        <FormSection
          title={t("DashboardCustody.policyTransferLimits")}
          description={t("DashboardCustody.policyTransferLimitsHint")}
        >
          <AssetSearchCombobox
            assetOptions={assetOptions}
            selectedMints={limitedMints}
            optionsId="policy-limit-asset-options"
            onToggle={(mint) =>
              setPolicyState((current) => ({
                ...current,
                limits: current.limits.some((limit) => limit.asset === mint)
                  ? current.limits.filter((limit) => limit.asset !== mint)
                  : [...current.limits, { asset: mint, max: "" }],
              }))
            }
            onAddCustomMint={(mint) =>
              setPolicyState((current) => ({
                ...current,
                limits: [...current.limits, { asset: mint, max: "" }],
              }))
            }
          />

          {state.limits.length > 0 ? (
            <div className="mt-5">
              <p className="text-xs font-medium text-muted">
                {t("DashboardCustody.policySelectedAssets")}
              </p>
              <div className="mt-2 divide-y divide-border-default border-t border-border-default">
                {state.limits.map((limit, index) => (
                  <PolicyLimitRow
                    key={limit.asset}
                    limit={limit}
                    option={assetByMint.get(limit.asset)}
                    isDuplicate={duplicateLimitAssets.has(limit.asset.trim())}
                    onMaxChange={(max) =>
                      setPolicyState((current) => ({
                        ...current,
                        limits: current.limits.map((currentLimit, currentIndex) =>
                          currentIndex === index ? { ...currentLimit, max } : currentLimit
                        ),
                      }))
                    }
                    onRemove={() =>
                      setPolicyState((current) => ({
                        ...current,
                        limits: current.limits.filter(
                          (_currentLimit, currentIndex) => currentIndex !== index
                        ),
                      }))
                    }
                  />
                ))}
              </div>
            </div>
          ) : null}
        </FormSection>
      ) : null}

      {showAssets ? (
        <AssetEditor
          assets={state.assets}
          assetOptions={assetOptions}
          error={errors.assets}
          onChange={(assets) => setPolicyState((current) => ({ ...current, assets }))}
        />
      ) : null}
    </div>
  );
}

/**
 * One controlled per-asset limit row.
 *
 * @param props - Limit value, catalogue metadata, duplicate flag, and row callbacks.
 * @returns The asset identity, decimal input, validation detail, and remove action.
 */
function PolicyLimitRow({
  limit,
  option,
  isDuplicate,
  onMaxChange,
  onRemove,
}: {
  limit: PolicyLimitInput;
  option: PolicyAssetOption | undefined;
  isDuplicate: boolean;
  onMaxChange: (max: string) => void;
  onRemove: () => void;
}) {
  const t = useTranslations();
  const label = option ? option.token : t("DashboardCustody.policyCustomMint");
  const secondary = option?.name ? option.name : shortenAddress(limit.asset);
  const invalidAsset = !isValidSolanaAddress(limit.asset);
  const invalidMax = limit.max.trim() !== "" && !isValidDecimal(limit.max);

  return (
    <div className="flex min-h-14 items-center gap-3 py-2.5 last:pb-0">
      <TokenMark
        mint={limit.asset}
        symbol={option ? option.token : undefined}
        logoUrl={option ? option.imageUrl : undefined}
        size="md"
      />
      <span className="min-w-0 flex-1">
        <span className="block text-base font-medium text-primary">{label}</span>
        <span className="block truncate text-sm text-muted" title={limit.asset}>
          {secondary}
        </span>
        {invalidAsset ? (
          <span className="mt-1 block text-xs text-error">
            {t("DashboardCustody.policyInvalidMint")}
          </span>
        ) : isDuplicate ? (
          <span className="mt-1 block text-xs text-error">
            {t("DashboardCustody.policyDuplicateAsset")}
          </span>
        ) : null}
      </span>
      <PolicyAssetBadge mint={limit.asset} option={option} />
      <span className="w-32 shrink-0">
        <Input
          value={limit.max}
          inputMode="decimal"
          placeholder={t("DashboardCustody.policyAmountPlaceholder")}
          className="w-32 text-right"
          aria-label={`${t("DashboardCustody.policyPerTransaction")} ${label}`}
          aria-invalid={invalidMax}
          onChange={(event) => onMaxChange(event.target.value)}
        />
        {invalidMax ? (
          <span className="mt-1 block text-xs text-error">
            {t("DashboardCustody.policyInvalidDecimal")}
          </span>
        ) : null}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("DashboardCustody.policyRemoveAsset", { asset: label })}
        onClick={onRemove}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
