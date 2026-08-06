"use client";

import type { EarnPortfolioDeposit, EarnPortfolioWalletStatus, EarnStrategy } from "@sdp/types";
import { CheckCircle2Icon, CheckIcon, CopyIcon, Loader2Icon } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useCopy } from "@/lib/use-copy";
import { formatApy, formatUsd } from "../earn-format";
import { useEarnProgram, useEarnProgramDeposits } from "../earn-program-data";
import { strategyToken, useLiquidityLabel } from "../earn-program-presentation";
import { SKELETON_ROW_IDS, StepNotice, StepSection, SummaryRow } from "./earn-deposit-chrome";
import { OutcomeFrame } from "./earn-deposit-outcome";
import { shortenAddress } from "./earn-funding-wallets";

const WALLET_STATUS_BADGES: Record<
  EarnPortfolioWalletStatus,
  { variant: "success" | "warning" | "danger"; key: MessageKey }
> = {
  creating: { variant: "warning", key: "DashboardEarn.deposit.walletStatusCreating" },
  ready: { variant: "success", key: "DashboardEarn.deposit.walletStatusReady" },
  busy: { variant: "warning", key: "DashboardEarn.deposit.walletStatusBusy" },
  failed: { variant: "danger", key: "DashboardEarn.deposit.walletStatusFailed" },
};

const DEPOSIT_STATUS_BADGES: Record<
  EarnPortfolioDeposit["status"],
  { variant: "success" | "warning" | "danger"; key: MessageKey }
> = {
  processing: { variant: "warning", key: "DashboardEarn.deposit.depositStatusProcessing" },
  completed: { variant: "success", key: "DashboardEarn.deposit.depositStatusCompleted" },
  failed: { variant: "danger", key: "DashboardEarn.deposit.depositStatusFailed" },
};

function DepositAddressCard({ address, token }: { address: string; token: string }) {
  const t = useTranslations();
  const { copied, copy } = useCopy(1800);

  return (
    <section className="rounded-2xl border border-border-default bg-surface-raised p-5">
      <h3 className="text-sm font-medium text-primary">
        {t("DashboardEarn.deposit.depositAddressTitle")}
      </h3>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Deliberately not monospaced — the module's typography rule covers
            addresses, and this is product UI, not a code surface. */}
        <p className="min-w-0 rounded-xl border border-border-subtle bg-fill-subtle px-3.5 py-3 text-sm leading-6 break-all text-primary">
          {address}
        </p>
        <Button
          className="shrink-0 self-start sm:self-auto"
          iconLeft={copied ? <CheckIcon /> : <CopyIcon />}
          onClick={() => void copy(address)}
          type="button"
          variant="secondary"
        >
          {t(copied ? "DashboardEarn.deposit.copied" : "DashboardEarn.deposit.copy")}
        </Button>
      </div>
      <p className="mt-3 text-[13px] leading-5 text-secondary">
        {t("DashboardEarn.deposit.depositAddressBody", { token })}
      </p>
    </section>
  );
}

function RecentDepositsCard() {
  const t = useTranslations();
  const locale = useLocale();
  const { page, error, isLoading } = useEarnProgramDeposits();
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale]
  );

  return (
    <section className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
      <div className="border-b border-border-subtle bg-fill-subtle px-4 py-3">
        <h3 className="text-sm font-medium text-primary">
          {t("DashboardEarn.deposit.recentDepositsTitle")}
        </h3>
      </div>

      {isLoading ? (
        <div aria-busy="true" className="grid gap-3 p-4">
          {SKELETON_ROW_IDS.map((id) => (
            <SkeletonBlock className="h-10 w-full rounded-lg" key={id} />
          ))}
        </div>
      ) : null}

      {error ? (
        <p className="px-4 py-3 text-[13px] leading-5 text-secondary">
          {t("DashboardEarn.deposit.depositsLoadError")}
        </p>
      ) : null}

      {!isLoading && !error && page?.deposits.length === 0 ? (
        <p className="px-4 py-3 text-[13px] leading-5 text-secondary">
          {t("DashboardEarn.deposit.depositsEmpty")}
        </p>
      ) : null}

      {page && page.deposits.length > 0 ? (
        <ul className="divide-y divide-border-subtle">
          {page.deposits.map((deposit) => {
            const badge = DEPOSIT_STATUS_BADGES[deposit.status];
            return (
              <li
                className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                key={deposit.id}
              >
                <div className="min-w-0">
                  <p className="text-sm text-primary tabular-nums">
                    {formatUsd(deposit.amountUsd)} · {deposit.token.toUpperCase()}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-tertiary">
                    {[
                      dateFormatter.format(new Date(deposit.createdAt)),
                      deposit.fromAddress
                        ? t("DashboardEarn.deposit.depositFrom", {
                            address: shortenAddress(deposit.fromAddress),
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Badge variant={badge.variant}>{t(badge.key)}</Badge>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * The flow's final screen: the program exists, so all that remains is moving
 * stablecoins to its Solana deposit address. Polls the program while the
 * provider wallet is still provisioning, then surfaces the address and the live
 * deposits feed.
 */
export function ProgramLiveScreen({
  created,
  fundingWalletLabel,
  onDone,
  strategy,
}: {
  created: boolean;
  fundingWalletLabel: string | undefined;
  onDone: () => void;
  strategy: EarnStrategy;
}) {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();
  const { state } = useEarnProgram({ refreshWhileCreating: true });
  const program = state?.kind === "active" ? state.program : undefined;
  const wallet = program?.wallet;
  const address = wallet?.solanaDepositAddress;
  const statusBadge = wallet ? WALLET_STATUS_BADGES[wallet.status] : undefined;
  const tokenLabel = strategyToken(strategy)?.toUpperCase() ?? "";

  return (
    <OutcomeFrame
      description={t("DashboardEarn.deposit.liveDescription", { strategy: strategy.name })}
      eyebrow={t("DashboardEarn.deposit.liveEyebrow")}
      footer={
        <div className="flex justify-end">
          <Button onClick={onDone} type="button">
            {t("DashboardEarn.deposit.backToEarn")}
          </Button>
        </div>
      }
      title={t("DashboardEarn.deposit.liveTitle")}
    >
      <div
        className="mb-5 flex items-start gap-3 rounded-2xl border border-success-border bg-success-bg p-4 text-success"
        role="status"
      >
        <CheckCircle2Icon aria-hidden="true" className="size-5 shrink-0" />
        <p className="text-sm leading-6">
          {created
            ? t("DashboardEarn.deposit.createdNotice")
            : t("DashboardEarn.deposit.updatedNotice", { strategy: strategy.name })}
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="space-y-5">
          {wallet?.status === "failed" ? (
            <StepNotice tone="error">{t("DashboardEarn.deposit.walletFailed")}</StepNotice>
          ) : address ? (
            <>
              <DepositAddressCard address={address} token={tokenLabel} />
              {fundingWalletLabel ? (
                <p className="text-[13px] leading-5 text-secondary">
                  {t("DashboardEarn.deposit.depositFromWallet", { wallet: fundingWalletLabel })}
                </p>
              ) : null}
            </>
          ) : (
            <section
              aria-busy="true"
              className="flex items-start gap-3 rounded-2xl border border-border-default bg-surface-raised p-5"
            >
              <Loader2Icon
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 animate-spin text-secondary motion-reduce:animate-none"
              />
              <div>
                <p className="text-sm font-medium text-primary">
                  {t("DashboardEarn.deposit.walletCreatingTitle")}
                </p>
                <p className="mt-1 text-[13px] leading-5 text-secondary">
                  {t("DashboardEarn.deposit.walletCreatingBody")}
                </p>
              </div>
            </section>
          )}

          {address ? <RecentDepositsCard /> : null}
        </div>

        <aside className="h-fit">
          <StepSection title={t("DashboardEarn.deposit.liveSummaryTitle")}>
            <SummaryRow label={t("DashboardEarn.deposit.liveStrategy")} value={strategy.name} />
            <SummaryRow
              label={t("DashboardEarn.deposit.reviewAccess")}
              value={liquidityLabel(strategy)}
            />
            <SummaryRow
              label={t("DashboardEarn.deposit.liveStatus")}
              value={
                statusBadge ? (
                  <Badge variant={statusBadge.variant}>{t(statusBadge.key)}</Badge>
                ) : (
                  "—"
                )
              }
            />
            <SummaryRow
              label={t("DashboardEarn.deposit.liveBalance")}
              value={wallet ? formatUsd(wallet.balance.totalUsd) : "—"}
            />
            <SummaryRow
              label={t("DashboardEarn.deposit.liveApy")}
              value={
                program?.yield?.currentApy
                  ? formatApy(program.yield.currentApy)
                  : formatApy(strategy.currentApy)
              }
            />
          </StepSection>
        </aside>
      </div>
    </OutcomeFrame>
  );
}
