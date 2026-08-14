"use client";

import { X } from "lucide-react";
import { useMemo } from "react";
import { shortenAddress } from "@/app/dashboard/payments/payments-overview.utils";
import { TokenMark } from "@/components/token-mark";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { AssetSearchCombobox } from "./asset-search-combobox";
import { PolicyAssetBadge } from "./policy-asset-badge";
import type { PolicyAssetOption } from "./wallet-policy-authoring";
import { FormSection } from "./wallet-policy-flow.shared";

export function AssetEditor({
  assets,
  assetOptions,
  error,
  onChange,
}: {
  assets: string[];
  assetOptions: PolicyAssetOption[];
  error?: "invalid_asset";
  onChange: (assets: string[]) => void;
}) {
  const t = useTranslations();
  const assetByMint = useMemo(
    () => new Map(assetOptions.map((asset) => [asset.mint, asset])),
    [assetOptions]
  );
  function toggleAsset(mint: string) {
    onChange(assets.includes(mint) ? assets.filter((asset) => asset !== mint) : [...assets, mint]);
  }

  return (
    <FormSection title={t("DashboardCustody.policyAllowedAssets")}>
      <AssetSearchCombobox
        assetOptions={assetOptions}
        selectedMints={assets}
        optionsId="policy-wallet-asset-options"
        onToggle={toggleAsset}
        onAddCustomMint={(mint) => onChange([...assets, mint])}
      />

      {assets.length > 0 ? (
        <div className="mt-5">
          <p className="text-xs font-medium text-muted">
            {t("DashboardCustody.policySelectedAssets")}
          </p>
          <div className="mt-2 divide-y divide-border-default border-t border-border-default">
            {assets.map((mint) => {
              const walletAsset = assetByMint.get(mint);
              const label = walletAsset
                ? walletAsset.token
                : t("DashboardCustody.policyCustomMint");
              const secondary = walletAsset?.name ? walletAsset.name : shortenAddress(mint);
              return (
                <div key={mint} className="flex min-h-14 items-center gap-3 py-2.5 last:pb-0">
                  <TokenMark
                    mint={mint}
                    symbol={walletAsset ? walletAsset.token : undefined}
                    logoUrl={walletAsset ? walletAsset.imageUrl : undefined}
                    size="md"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-medium text-primary">{label}</span>
                    <span className="block truncate text-sm text-muted" title={mint}>
                      {secondary}
                    </span>
                  </span>
                  <PolicyAssetBadge mint={mint} option={walletAsset} />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("DashboardCustody.policyRemoveAsset", { asset: label })}
                    onClick={() => onChange(assets.filter((asset) => asset !== mint))}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="mt-3 text-sm text-error">{t("DashboardCustody.policyInvalidMint")}</p>
      ) : null}
    </FormSection>
  );
}
