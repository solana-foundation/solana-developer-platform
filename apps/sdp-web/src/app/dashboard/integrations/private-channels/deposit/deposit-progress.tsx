"use client";

import type { PrivateChannelDeposit } from "@sdp/types";
import { CheckCircle2Icon, CircleIcon, Loader2Icon, XCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { cn } from "@/lib/utils";
import { fetchDepositAction } from "./actions";

const RANK: Record<PrivateChannelDeposit["status"], number> = {
  pending: 0,
  submitted: 1,
  confirmed: 2,
  // `settled` is unreachable for deposits under the chain-heuristic oracle;
  // reserved for when SPC ships an event stream.
  settled: 3,
  failed: -1,
};

const STAGES = [
  {
    rank: 1,
    titleKey: "DashboardPrivateChannels.deposit.stageSentTitle",
    descriptionKey: "DashboardPrivateChannels.deposit.stageSentDescription",
  },
  {
    rank: 2,
    titleKey: "DashboardPrivateChannels.deposit.stageConfirmedTitle",
    descriptionKey: "DashboardPrivateChannels.deposit.stageConfirmedDescription",
  },
] as const;

const TERMINAL: ReadonlySet<PrivateChannelDeposit["status"]> = new Set([
  "confirmed",
  "settled",
  "failed",
]);
const POLL_INTERVAL_MS = 1500;

export function DepositProgress({
  deposit: initial,
  onReset,
}: {
  deposit: PrivateChannelDeposit;
  onReset: () => void;
}) {
  const [deposit, setDeposit] = useState(initial);
  const cluster = useSolanaCluster();
  const t = useTranslations();

  useEffect(() => {
    setDeposit(initial);
  }, [initial]);

  useEffect(() => {
    if (TERMINAL.has(deposit.status)) {
      return;
    }
    let active = true;
    const timer = setInterval(async () => {
      const next = await fetchDepositAction(deposit.id);
      if (active && next) {
        setDeposit(next);
      }
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [deposit.id, deposit.status]);

  const rank = RANK[deposit.status];
  const failed = deposit.status === "failed";
  const done = deposit.status === "confirmed" || deposit.status === "settled";

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between">
        <div>
          <p className="text-sm text-secondary">
            {t("DashboardPrivateChannels.deposit.progressLabel")}
          </p>
          <p className="font-semibold text-lg">
            {t("DashboardPrivateChannels.common.amountWithUnit", { amount: deposit.amount })}
          </p>
        </div>
        <StatusBadge status={deposit.status} t={t} />
      </div>

      {failed && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive text-sm">
          {deposit.failureReason ?? t("DashboardPrivateChannels.deposit.failed")}
        </div>
      )}

      <ol className="space-y-3">
        {STAGES.map((stage) => {
          const stageDone = rank >= stage.rank;
          const activeStage = !failed && !stageDone && rank + 1 === stage.rank;
          return (
            <li key={stage.rank} className="flex items-start gap-3">
              <StageIcon done={stageDone} active={activeStage} failed={failed && !stageDone} />
              <div className="space-y-0.5">
                <p
                  className={cn(
                    "font-medium text-sm",
                    stageDone || activeStage ? "text-primary" : "text-tertiary"
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

      {deposit.signature && (
        <a
          className="block w-fit text-primary text-xs underline underline-offset-2 hover:no-underline"
          href={explorerTxUrl(deposit.signature, cluster)}
          rel="noreferrer"
          target="_blank"
        >
          {t("DashboardPrivateChannels.deposit.viewTransaction")}
        </a>
      )}

      {(done || failed) && (
        <Button onClick={onReset} variant="secondary">
          {t("DashboardPrivateChannels.deposit.newDeposit")}
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
  status: PrivateChannelDeposit["status"];
  t: ReturnType<typeof useTranslations>;
}) {
  const label: Record<PrivateChannelDeposit["status"], string> = {
    pending: t("DashboardPrivateChannels.deposit.statusPending"),
    submitted: t("DashboardPrivateChannels.deposit.statusSubmitted"),
    confirmed: t("DashboardPrivateChannels.deposit.statusConfirmed"),
    settled: t("DashboardPrivateChannels.deposit.statusSettled"),
    failed: t("DashboardPrivateChannels.deposit.statusFailed"),
  };
  const variant: BadgeVariant =
    status === "confirmed" || status === "settled"
      ? "success"
      : status === "failed"
        ? "danger"
        : "default";
  return <Badge variant={variant}>{label[status]}</Badge>;
}
