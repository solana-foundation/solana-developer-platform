"use client";

import { Check, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { TokenMark } from "@/components/token-mark";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { PolicyAssetBadge } from "./policy-asset-badge";
import { isValidSolanaAddress, type PolicyAssetOption } from "./wallet-policy-authoring";

interface AssetSearchComboboxProps {
  assetOptions: PolicyAssetOption[];
  selectedMints: string[];
  optionsId: string;
  onToggle: (mint: string) => void;
  onAddCustomMint: (mint: string) => void;
}

/**
 * Shared controlled multi-select for catalogued and custom policy asset mints.
 *
 * @param props - Asset choices, current selection, listbox id, and selection callbacks.
 * @returns The grouped searchable asset picker.
 */
export function AssetSearchCombobox({
  assetOptions,
  selectedMints,
  optionsId,
  onToggle,
  onAddCustomMint,
}: AssetSearchComboboxProps) {
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
          (asset.name ? asset.name.toLowerCase().includes(normalizedQuery) : false) ||
          asset.mint.toLowerCase().includes(normalizedQuery)
      ),
    [assetOptions, normalizedQuery]
  );
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
  const canAddCustomMint =
    isValidSolanaAddress(query) &&
    !selectedMints.includes(query.trim()) &&
    !matchingWalletAssets.some((asset) => asset.mint === query.trim());

  function addCustomMint(mint: string) {
    const normalized = mint.trim();
    if (selectedMints.includes(normalized)) {
      setInputError("duplicate");
      return;
    }
    if (!isValidSolanaAddress(normalized)) {
      setInputError("invalid");
      return;
    }
    onAddCustomMint(normalized);
    setQuery("");
    setOpen(false);
    setInputError(null);
  }

  function toggleAsset(mint: string) {
    onToggle(mint);
    setInputError(null);
  }

  function submitSearch() {
    if (matchingWalletAssets.length === 1) {
      toggleAsset(matchingWalletAssets[0].mint);
      return;
    }
    if (canAddCustomMint) {
      addCustomMint(query);
      return;
    }
    if (query.trim()) setInputError("invalid");
  }

  return (
    <>
      <fieldset
        className="relative min-w-0"
        onBlur={(event) => {
          const nextTarget = event.relatedTarget;
          if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
            setOpen(false);
          }
        }}
      >
        <legend className="sr-only">{t("DashboardCustody.policyAllowedAssets")}</legend>
        <Input
          value={query}
          iconLeft={<Search />}
          placeholder={t("DashboardCustody.policySearchAssets")}
          role="combobox"
          aria-expanded={open}
          aria-controls={optionsId}
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
            id={optionsId}
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
                      const selected = selectedMints.includes(asset.mint);
                      return (
                        <button
                          key={asset.mint}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-sunken"
                          onClick={() => toggleAsset(asset.mint)}
                        >
                          <TokenMark
                            mint={asset.mint}
                            symbol={asset.token}
                            logoUrl={asset.imageUrl}
                            size="md"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-primary text-base font-medium">
                              {asset.token}
                            </span>
                            <span className="block truncate text-muted text-sm">
                              {asset.name ? asset.name : asset.mint}
                            </span>
                          </span>
                          <PolicyAssetBadge mint={asset.mint} option={asset} />
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
                onClick={() => addCustomMint(query)}
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
    </>
  );
}
