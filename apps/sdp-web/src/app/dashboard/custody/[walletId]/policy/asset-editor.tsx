"use client";

import { Check, Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { shortenAddress } from "@/app/dashboard/payments/payments-overview.utils";
import { TokenMark } from "@/components/token-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { isValidSolanaAddress, type PolicyAssetOption } from "./wallet-policy-authoring";
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
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [inputError, setInputError] = useState<"invalid" | "duplicate" | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const matchingWalletAssets = useMemo(
    () =>
      assetOptions.filter(
        (asset) =>
          !normalizedQuery ||
          asset.token.toLowerCase().includes(normalizedQuery) ||
          asset.name?.toLowerCase().includes(normalizedQuery) ||
          asset.mint.toLowerCase().includes(normalizedQuery)
      ),
    [assetOptions, normalizedQuery]
  );
  // Holdings and suggestions are labelled separately so it stays obvious which
  // assets the wallet actually holds; the list scrolls rather than truncating,
  // which used to hide catalogue entries behind an arbitrary cut-off.
  const assetGroups = useMemo(
    () =>
      (
        [
          {
            key: "wallet",
            label: t("DashboardCustody.policyAssetsInWallet"),
            items: matchingWalletAssets.filter((asset) => asset.source === "wallet"),
          },
          {
            key: "issued",
            label: t("DashboardCustody.policyAssetsIssued"),
            items: matchingWalletAssets.filter((asset) => asset.source === "issued"),
          },
          {
            key: "well-known",
            label: t("DashboardCustody.policyAssetsCommon"),
            items: matchingWalletAssets.filter((asset) => asset.source === "well-known"),
          },
        ] as const
      ).filter((group) => group.items.length > 0),
    [matchingWalletAssets, t]
  );
  const assetByMint = useMemo(
    () => new Map(assetOptions.map((asset) => [asset.mint, asset])),
    [assetOptions]
  );
  const canAddCustomMint =
    isValidSolanaAddress(query) &&
    !assets.includes(query.trim()) &&
    !matchingWalletAssets.some((asset) => asset.mint === query.trim());

  function addAsset(mint: string) {
    const normalized = mint.trim();
    if (assets.includes(normalized)) {
      setInputError("duplicate");
      return;
    }
    if (!isValidSolanaAddress(normalized)) {
      setInputError("invalid");
      return;
    }
    onChange([...assets, normalized]);
    setQuery("");
    setOpen(false);
    setInputError(null);
  }

  function toggleWalletAsset(mint: string) {
    onChange(assets.includes(mint) ? assets.filter((asset) => asset !== mint) : [...assets, mint]);
    setQuery("");
    setOpen(false);
    setInputError(null);
  }

  function submitSearch() {
    if (matchingWalletAssets.length === 1) {
      toggleWalletAsset(matchingWalletAssets[0].mint);
      return;
    }
    if (canAddCustomMint) {
      addAsset(query);
      return;
    }
    if (query.trim()) setInputError("invalid");
  }

  return (
    <FormSection title={t("DashboardCustody.policyAllowedAssets")}>
      <fieldset
        className="relative min-w-0"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
        }}
      >
        <legend className="sr-only">{t("DashboardCustody.policyAllowedAssets")}</legend>
        <Input
          value={query}
          iconLeft={<Search />}
          placeholder={t("DashboardCustody.policySearchAssets")}
          role="combobox"
          aria-expanded={open}
          aria-controls="policy-wallet-asset-options"
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setInputError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitSearch();
            }
            if (event.key === "Escape") setOpen(false);
          }}
        />

        {open ? (
          <div
            id="policy-wallet-asset-options"
            role="listbox"
            aria-multiselectable="true"
            className="absolute z-20 mt-2 w-full overflow-hidden rounded-lg border border-border-default bg-surface-raised shadow-lg"
          >
            {assetGroups.length > 0 ? (
              <div className="max-h-72 overflow-y-auto">
                {assetGroups.map((group) => (
                  <div key={group.key}>
                    <p className="sticky top-0 z-10 bg-surface-raised px-3 pt-2.5 pb-1 font-medium text-[11px] text-muted uppercase tracking-wide">
                      {group.label}
                    </p>
                    {group.items.map((asset) => {
                      const selected = assets.includes(asset.mint);
                      return (
                        <button
                          key={asset.mint}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-sunken"
                          onClick={() => toggleWalletAsset(asset.mint)}
                        >
                          <TokenMark mint={asset.mint} symbol={asset.token} size="md" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-primary text-base font-medium">
                              {asset.token}
                            </span>
                            <span className="block truncate text-muted text-sm">
                              {asset.name ?? asset.mint}
                            </span>
                          </span>
                          {asset.uiAmount ? (
                            <span className="shrink-0 text-secondary text-sm tabular-nums">
                              {asset.uiAmount}
                            </span>
                          ) : null}
                          <span
                            className={cn(
                              "flex size-5 shrink-0 items-center justify-center rounded border",
                              selected
                                ? "border-primary bg-primary text-on-primary"
                                : "border-border-strong bg-surface-raised text-transparent"
                            )}
                          >
                            <Check className="size-3.5" />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            ) : query.trim() && !canAddCustomMint ? (
              <p className="px-3 py-4 text-sm text-muted">
                {t("DashboardCustody.policyNoMatchingAssets")}
              </p>
            ) : null}
            {canAddCustomMint ? (
              <button
                type="button"
                className="flex w-full items-center gap-2 border-t border-border-default px-3 py-2.5 text-left text-sm font-medium text-primary hover:bg-surface-sunken first:border-t-0"
                onClick={() => addAsset(query)}
              >
                <Plus className="size-4" />
                <span className="min-w-0 flex-1">
                  <span className="block">{t("DashboardCustody.policyAddCustomMint")}</span>
                  <span className="block truncate text-xs font-normal text-muted">
                    {query.trim()}
                  </span>
                </span>
              </button>
            ) : null}
          </div>
        ) : null}
      </fieldset>

      {inputError ? (
        <p className="mt-2 text-sm text-error">
          {t(
            inputError === "duplicate"
              ? "DashboardCustody.policyDuplicateAsset"
              : "DashboardCustody.policyInvalidMint"
          )}
        </p>
      ) : null}

      {assets.length > 0 ? (
        <div className="mt-5">
          <p className="text-xs font-medium text-muted">
            {t("DashboardCustody.policySelectedAssets")}
          </p>
          <div className="mt-2 divide-y divide-border-default border-t border-border-default">
            {assets.map((mint) => {
              const walletAsset = assetByMint.get(mint);
              const label = walletAsset?.token ?? t("DashboardCustody.policyCustomMint");
              // Named tokens read better than a 44-character address; the full
              // mint stays available on hover and for anything uncatalogued.
              const secondary = walletAsset?.name ?? shortenAddress(mint);
              return (
                <div key={mint} className="flex min-h-14 items-center gap-3 py-2.5 last:pb-0">
                  <TokenMark mint={mint} symbol={walletAsset?.token} size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-medium text-primary">{label}</span>
                    <span className="block truncate text-sm text-muted" title={mint}>
                      {secondary}
                    </span>
                  </span>
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
