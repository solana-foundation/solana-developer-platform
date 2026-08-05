"use client";

import type { CustodyWalletSummary } from "@sdp/types";
import { ExternalLinkIcon, LockIcon, PlusIcon, ShieldCheckIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { formatCustodyProviderName } from "@/app/dashboard/custody/provider-catalog";
import { DashboardNavigationLink } from "@/components/dashboard-navigation-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/i18n/provider";
import {
  SelectableCard,
  SelectionAnnouncement,
  SelectionMark,
  StepListSkeleton,
  StepNote,
  StepNotice,
} from "./earn-deposit-chrome";
import {
  EARN_CONNECT_WALLET_HREF,
  matchesWalletQuery,
  shortenAddress,
  walletDisplayName,
  walletStablecoinHoldings,
} from "./earn-funding-wallets";

/** Above this many wallets a search field is worth the extra chrome. */
const SEARCH_THRESHOLD = 6;

/**
 * One funding-wallet row. Per SDP wallet-card grammar the user-set name is the
 * first line and the address the second — and neither is monospaced.
 */
function WalletRow({
  onSelect,
  selected,
  wallet,
}: {
  onSelect: () => void;
  selected: boolean;
  wallet: CustodyWalletSummary;
}) {
  const t = useTranslations();
  const inputId = `earn-funding-wallet-${wallet.id}`;
  const nameId = `${inputId}-name`;
  const detailId = `${inputId}-detail`;
  const holdings = walletStablecoinHoldings(wallet);

  return (
    <SelectableCard
      describedBy={detailId}
      inputId={inputId}
      labelledBy={nameId}
      name="earn-funding-wallet"
      onSelect={onSelect}
      selected={selected}
      value={wallet.id}
    >
      <span className="flex items-start gap-3.5">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-base font-medium tracking-tight text-primary" id={nameId}>
              {walletDisplayName(wallet, t("DashboardEarn.deposit.walletUnnamed"))}
            </span>
            {/* The custodian, not a "Default" flag: which platform signs for
                this wallet is the fact that matters when choosing where funds
                are sent from — and most orgs' wallet is literally named
                "Default wallet", so a Default chip beside it read as noise.
                (Not a Badge: Badge is status-only in this design system.) */}
            {wallet.provider ? (
              <span className="rounded-md bg-fill px-2 py-1 text-[11px] font-medium text-secondary">
                {formatCustodyProviderName(wallet.provider)}
              </span>
            ) : null}
          </span>
          <span className="mt-1 block text-[13px] leading-5 text-secondary" id={detailId}>
            {shortenAddress(wallet.publicKey)}
          </span>
          <span className="mt-2 block text-xs leading-5 text-tertiary">
            {holdings.length > 0
              ? holdings
                  .map((balance) =>
                    t("DashboardEarn.deposit.walletHolding", {
                      amount: balance.uiAmount,
                      token: balance.token.toUpperCase(),
                    })
                  )
                  .join(" · ")
              : t("DashboardEarn.deposit.walletBalanceUnknown")}
          </span>
        </span>
        <SelectionMark selected={selected} />
      </span>
    </SelectableCard>
  );
}

/** The "bring a wallet in" affordance, in its enabled and not-entitled forms. */
function ConnectWalletCard({ fireblocksEnabled }: { fireblocksEnabled: boolean }) {
  const t = useTranslations();

  return (
    <div className="rounded-2xl border border-dashed border-border-strong bg-surface-raised p-4 sm:p-5">
      <div className="flex items-start gap-3.5">
        <span className="mt-0.5 shrink-0 text-secondary">
          {fireblocksEnabled ? <PlusIcon className="size-5" /> : <LockIcon className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-medium tracking-tight text-primary">
            {t(
              fireblocksEnabled
                ? "DashboardEarn.deposit.connectFireblocksTitle"
                : "DashboardEarn.deposit.connectFireblocksLockedTitle"
            )}
          </p>
          <p className="mt-1 text-[13px] leading-5 text-secondary">
            {t(
              fireblocksEnabled
                ? "DashboardEarn.deposit.connectFireblocksBody"
                : "DashboardEarn.deposit.connectFireblocksLockedBody"
            )}
          </p>
          {/* Not-entitled still gets a way forward: Wallets is where provider
              activation is requested, so the card never dead-ends. */}
          <Button asChild className="mt-3" size="sm" variant="secondary">
            <DashboardNavigationLink
              href={fireblocksEnabled ? EARN_CONNECT_WALLET_HREF : "/dashboard/wallets"}
            >
              {t(
                fireblocksEnabled
                  ? "DashboardEarn.deposit.connectFireblocksTitle"
                  : "DashboardEarn.deposit.goToWallets"
              )}
              <ExternalLinkIcon />
            </DashboardNavigationLink>
          </Button>
        </div>
      </div>
    </div>
  );
}

export function WalletStep({
  fireblocksEnabled,
  hasError,
  isLoading,
  onSelect,
  selectedWalletId,
  wallets,
}: {
  fireblocksEnabled: boolean;
  hasError: boolean;
  isLoading: boolean;
  /** Receives `custody_wallets.id` — the id the program persists. */
  onSelect: (custodyWalletId: string) => void;
  selectedWalletId: string | null;
  wallets: readonly CustodyWalletSummary[];
}) {
  const t = useTranslations();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const showSearch = wallets.length > SEARCH_THRESHOLD;

  const visible = useMemo(
    () => (showSearch ? wallets.filter((wallet) => matchesWalletQuery(wallet, query)) : wallets),
    [query, showSearch, wallets]
  );
  const selectedWallet = wallets.find((wallet) => wallet.id === selectedWalletId);

  return (
    <div className="space-y-5">
      <StepNote
        body={t("DashboardEarn.deposit.walletCustodyBody")}
        icon={<ShieldCheckIcon className="size-5" />}
        title={t("DashboardEarn.deposit.walletCustodyTitle")}
      />

      {isLoading ? <StepListSkeleton rowClassName="h-28 w-full rounded-2xl" /> : null}

      {hasError ? <StepNotice>{t("DashboardEarn.deposit.walletsLoadError")}</StepNotice> : null}

      {!isLoading && !hasError && wallets.length === 0 ? (
        <div className="space-y-3">
          <StepNotice>
            <span className="block font-medium text-primary">
              {t("DashboardEarn.deposit.walletsEmptyTitle")}
            </span>
            {t("DashboardEarn.deposit.walletsEmptyBody")}
          </StepNotice>
          <ConnectWalletCard fireblocksEnabled={fireblocksEnabled} />
        </div>
      ) : null}

      {wallets.length > 0 ? (
        <>
          {showSearch ? (
            <div>
              <label className="sr-only" htmlFor={searchId}>
                {t("DashboardEarn.deposit.walletSearchLabel")}
              </label>
              <Input
                id={searchId}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("DashboardEarn.deposit.walletSearchPlaceholder")}
                value={query}
              />
            </div>
          ) : null}

          <fieldset className="space-y-3">
            <legend className="sr-only">{t("DashboardEarn.deposit.walletLegend")}</legend>
            {visible.map((wallet) => (
              <WalletRow
                key={wallet.id}
                onSelect={() => onSelect(wallet.id)}
                selected={wallet.id === selectedWalletId}
                wallet={wallet}
              />
            ))}
          </fieldset>

          {visible.length === 0 ? (
            <StepNotice>{t("DashboardEarn.deposit.walletsFiltered")}</StepNotice>
          ) : null}

          <ConnectWalletCard fireblocksEnabled={fireblocksEnabled} />
        </>
      ) : null}

      <SelectionAnnouncement>
        {selectedWallet
          ? t("DashboardEarn.deposit.selectedWalletAnnouncement", {
              wallet: walletDisplayName(selectedWallet, t("DashboardEarn.deposit.walletUnnamed")),
            })
          : ""}
      </SelectionAnnouncement>
    </div>
  );
}
