"use client";

import type { CustodyWalletSummary, EarnStrategy } from "@sdp/types";
import { LandmarkIcon, RouteIcon, WalletIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { formatApy, formatUsdCompact } from "../earn-format";
import {
  strategyCuratorLabel,
  strategyPoolUsd,
  strategySourceLabel,
  strategyToken,
  useLiquidityLabel,
} from "../earn-program-presentation";
import { StepNote, StepNotice, StepSection, SummaryRow } from "./earn-deposit-chrome";
import { shortenAddress, walletDisplayName } from "./earn-funding-wallets";

export function ReviewStep({
  onEditStrategy,
  onEditWallet,
  programExists,
  providerUnconfigured,
  strategy,
  submitError,
  wallet,
}: {
  onEditStrategy: () => void;
  onEditWallet: () => void;
  programExists: boolean;
  providerUnconfigured: boolean;
  strategy: EarnStrategy;
  submitError: string | null;
  wallet: CustodyWalletSummary | undefined;
}) {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();
  const token = strategyToken(strategy);
  const tokenLabel = token?.toUpperCase() ?? "";
  const poolUsd = strategyPoolUsd(strategy);
  const sourceLabel = strategySourceLabel(strategy);
  const curatorLabel = strategyCuratorLabel(strategy);

  return (
    <div className="space-y-4">
      {/* Absent on a change-strategy run: the update flow has no wallet
          step, so there is nothing to review here. */}
      {wallet ? (
        <StepSection
          action={
            <Button
              aria-label={t("DashboardEarn.deposit.reviewEditSection", {
                section: t("DashboardEarn.deposit.reviewWallet"),
              })}
              onClick={onEditWallet}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("DashboardEarn.deposit.reviewEdit")}
            </Button>
          }
          title={
            <span className="flex items-center gap-2.5">
              <WalletIcon aria-hidden="true" className="size-4 text-secondary" />
              {t("DashboardEarn.deposit.reviewWallet")}
            </span>
          }
        >
          <SummaryRow
            label={t("DashboardEarn.deposit.reviewWallet")}
            value={walletDisplayName(wallet, t("DashboardEarn.deposit.walletUnnamed"))}
          />
          {wallet ? (
            <SummaryRow
              label={t("DashboardEarn.deposit.reviewWalletAddress")}
              value={shortenAddress(wallet.publicKey)}
            />
          ) : null}
        </StepSection>
      ) : null}

      <StepSection
        action={
          <Button
            aria-label={t("DashboardEarn.deposit.reviewEditSection", {
              section: t("DashboardEarn.deposit.reviewStrategy"),
            })}
            onClick={onEditStrategy}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("DashboardEarn.deposit.reviewEdit")}
          </Button>
        }
        title={
          <span className="flex items-center gap-2.5">
            <RouteIcon aria-hidden="true" className="size-4 text-secondary" />
            {t("DashboardEarn.deposit.reviewStrategy")}
          </span>
        }
      >
        <SummaryRow label={t("DashboardEarn.deposit.reviewStrategy")} value={strategy.name} />
        <SummaryRow
          label={t("DashboardEarn.deposit.reviewApy")}
          value={`${formatApy(strategy.currentApy)} · ${t(`DashboardEarn.apyType.${strategy.apyType}`)}`}
        />
        <SummaryRow
          label={t("DashboardEarn.deposit.reviewAccess")}
          value={liquidityLabel(strategy)}
        />
        <SummaryRow
          label={t("DashboardEarn.deposit.reviewBacking")}
          value={
            sourceLabel
              ? `${t(`DashboardEarn.source.${strategy.sourceKind}`)} · ${sourceLabel}`
              : t(`DashboardEarn.source.${strategy.sourceKind}`)
          }
        />
        {curatorLabel ? (
          <SummaryRow label={t("DashboardEarn.deposit.reviewCurator")} value={curatorLabel} />
        ) : null}
        <SummaryRow label={t("DashboardEarn.deposit.reviewStablecoin")} value={tokenLabel} />
        <SummaryRow
          label={t("DashboardEarn.deposit.reviewPool")}
          value={
            poolUsd === undefined
              ? t("DashboardEarn.deposit.poolUnknown")
              : formatUsdCompact(poolUsd)
          }
        />
      </StepSection>

      {/* Omitted token groups keep their current allocation server-side, so say
          so rather than implying this rewrites the whole program. */}
      <StepNote
        body={t("DashboardEarn.deposit.routingBody", { token: tokenLabel })}
        icon={<RouteIcon className="size-5" />}
        title={t("DashboardEarn.deposit.routingTitle")}
      />

      {providerUnconfigured ? (
        <StepNotice>{t("DashboardEarn.overview.providerNotConfigured")}</StepNotice>
      ) : (
        <StepNote
          body={t(
            programExists ? "DashboardEarn.deposit.updateBody" : "DashboardEarn.deposit.createBody",
            { token: tokenLabel }
          )}
          icon={<LandmarkIcon className="size-5" />}
          title={t(
            programExists
              ? "DashboardEarn.deposit.updateTitle"
              : "DashboardEarn.deposit.createTitle"
          )}
        />
      )}

      {submitError ? <StepNotice tone="error">{submitError}</StepNotice> : null}

      <p className="text-xs leading-5 text-muted">
        {t("DashboardEarn.deposit.timingDisclosure")} {t("DashboardEarn.deposit.rateDisclosure")}
      </p>
    </div>
  );
}
