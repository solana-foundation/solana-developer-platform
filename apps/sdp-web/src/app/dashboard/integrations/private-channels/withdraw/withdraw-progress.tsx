"use client";

import type { PrivateChannelWithdrawal } from "@sdp/types";
import { CheckCircle2Icon, CircleIcon, Loader2Icon, XCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { cn } from "@/lib/utils";
import { fetchWithdrawalAction } from "./actions";

const RANK: Record<PrivateChannelWithdrawal["status"], number> = {
  pending: 0,
  submitted: 1,
  confirmed: 2,
  settled: 3,
  failed: -1,
};

const STAGES = [
  {
    rank: 1,
    titleKey: "DashboardPrivateChannels.withdraw.stageBurnSentTitle",
    descriptionKey: "DashboardPrivateChannels.withdraw.stageBurnSentDescription",
  },
  {
    rank: 2,
    titleKey: "DashboardPrivateChannels.withdraw.stageBurnConfirmedTitle",
    descriptionKey: "DashboardPrivateChannels.withdraw.stageBurnConfirmedDescription",
  },
  {
    rank: 3,
    titleKey: "DashboardPrivateChannels.withdraw.stageReleasedTitle",
    descriptionKey: "DashboardPrivateChannels.withdraw.stageReleasedDescription",
  },
] as const;

const TERMINAL: ReadonlySet<PrivateChannelWithdrawal["status"]> = new Set(["settled", "failed"]);
const POLL_INTERVAL_MS = 1500;

export function WithdrawProgress({
  withdrawal: initial,
  onReset,
}: {
  withdrawal: PrivateChannelWithdrawal;
  onReset: () => void;
}) {
  const [withdrawal, setWithdrawal] = useState(initial);
  const cluster = useSolanaCluster();
  const t = useTranslations();

  useEffect(() => {
    setWithdrawal(initial);
  }, [initial]);

  useEffect(() => {
    if (TERMINAL.has(withdrawal.status)) {
      return;
    }
    let active = true;
    const timer = setInterval(async () => {
      const next = await fetchWithdrawalAction(withdrawal.id);
      if (active && next) {
        setWithdrawal(next);
      }
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [withdrawal.id, withdrawal.status]);

  const rank = RANK[withdrawal.status];
  const failed = withdrawal.status === "failed";
  const settled = withdrawal.status === "settled";
  const terminal = failed || settled;

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between">
        <div>
          <p className="text-sm text-secondary">
            {t("DashboardPrivateChannels.withdraw.progressLabel")}
          </p>
          <p className="font-semibold text-lg">
            {t("DashboardPrivateChannels.common.amountWithUnit", { amount: withdrawal.amount })}
          </p>
        </div>
        <StatusBadge status={withdrawal.status} t={t} />
      </div>

      {failed && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive text-sm">
          {withdrawal.failureReason ?? t("DashboardPrivateChannels.withdraw.failed")}
        </div>
      )}

      <ol className="space-y-3">
        {STAGES.map((stage) => {
          const done = rank >= stage.rank;
          const activeStage = !failed && !done && rank + 1 === stage.rank;
          return (
            <li key={stage.rank} className="flex items-start gap-3">
              <StageIcon done={done} active={activeStage} failed={failed && !done} />
              <div className="space-y-0.5">
                <p
                  className={cn(
                    "font-medium text-sm",
                    done || activeStage ? "text-primary" : "text-tertiary"
                  )}
                >
                  {t(stage.titleKey)}
                </p>
                <p className="text-secondary text-xs">{t(stage.descriptionKey)}</p>
              </div>
            </li>
          );
        })}
      </ol>

      {withdrawal.signature && (
        <p className="text-secondary text-xs">
          {t("DashboardPrivateChannels.withdraw.burnSignature")}{" "}
          <span className="break-all text-primary">{withdrawal.signature}</span>
        </p>
      )}

      {withdrawal.settlementRef && (
        <a
          className="block w-fit text-primary text-xs underline underline-offset-2 hover:no-underline"
          href={explorerTxUrl(withdrawal.settlementRef, cluster)}
          rel="noreferrer"
          target="_blank"
        >
          {t("DashboardPrivateChannels.withdraw.viewRelease")}
        </a>
      )}

      {terminal && (
        <Button onClick={onReset} variant="secondary">
          {t("DashboardPrivateChannels.withdraw.newWithdrawal")}
        </Button>
      )}
    </div>
  );
}

function StageIcon({ done, active, failed }: { done: boolean; active: boolean; failed: boolean }) {
  if (done) {
    return <CheckCircle2Icon className="mt-0.5 size-5 text-success" />;
  }
  if (active) {
    return <Loader2Icon className="mt-0.5 size-5 animate-spin text-primary" />;
  }
  if (failed) {
    return <XCircleIcon className="mt-0.5 size-5 text-destructive" />;
  }
  return <CircleIcon className="mt-0.5 size-5 text-tertiary" />;
}

function StatusBadge({
  status,
  t,
}: {
  status: PrivateChannelWithdrawal["status"];
  t: ReturnType<typeof useTranslations>;
}) {
  const label: Record<PrivateChannelWithdrawal["status"], string> = {
    pending: t("DashboardPrivateChannels.withdraw.statusPending"),
    submitted: t("DashboardPrivateChannels.withdraw.statusSubmitted"),
    confirmed: t("DashboardPrivateChannels.withdraw.statusBurnConfirmed"),
    settled: t("DashboardPrivateChannels.withdraw.statusSettled"),
    failed: t("DashboardPrivateChannels.withdraw.statusFailed"),
  };
  const variant: BadgeVariant =
    status === "settled"
      ? "success"
      : status === "confirmed"
        ? "info"
        : status === "failed"
          ? "danger"
          : "default";
  return <Badge variant={variant}>{label[status]}</Badge>;
}
