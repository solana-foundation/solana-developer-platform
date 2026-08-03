"use client";

import { Input } from "@/components/ui/input";
import { useTranslations } from "@/i18n/provider";
import { AssetEditor } from "./asset-editor";
import type {
  PolicyAssetOption,
  PolicyAuthoringState,
  validatePolicyState,
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

  if (!showLimits && !showAssets) return <EmptyStepState />;

  return (
    <div className="space-y-6">
      {showLimits ? (
        <FormSection
          title={t("DashboardCustody.policyTransferLimits")}
          description={t("DashboardCustody.policyTransferLimitsHint")}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <AmountField
              id="policy-per-transaction"
              label={t("DashboardCustody.policyPerTransaction")}
              value={state.maxTransferAmount}
              error={errors.maxTransferAmount}
              onChange={(value) =>
                setPolicyState((current) => ({ ...current, maxTransferAmount: value }))
              }
            />
            <AmountField
              id="policy-daily-total"
              label={t("DashboardCustody.policyDailyTotal")}
              value={state.maxDailyAmount}
              error={errors.maxDailyAmount}
              onChange={(value) =>
                setPolicyState((current) => ({ ...current, maxDailyAmount: value }))
              }
            />
          </div>
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

function AmountField({
  id,
  label,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error?: "invalid_decimal" | "daily_below_transaction";
  onChange: (value: string) => void;
}) {
  const t = useTranslations();
  return (
    <label htmlFor={id} className="block">
      <span className="mb-2 block text-sm font-medium text-primary">{label}</span>
      <Input
        id={id}
        value={value}
        inputMode="decimal"
        placeholder="0.00"
        size="xl"
        aria-invalid={Boolean(error)}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <span className="mt-2 block text-sm text-error">
          {error === "daily_below_transaction"
            ? t("DashboardCustody.policyDailyBelowTransaction")
            : t("DashboardCustody.policyInvalidDecimal")}
        </span>
      ) : null}
    </label>
  );
}
