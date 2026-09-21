"use client";

import type { EarnVaultWithdrawalRequestRecord } from "@sdp/types";
import { Clock3Icon, Loader2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useLocale, useTranslations } from "@/i18n/provider";
import { formatEpochSecondsOr, formatProviderAmount, shortenMarketAddress } from "./earn-format";
import { earnMintAsset } from "./earn-market-presentation";
import {
  cancelEarnVaultWithdrawalRequest,
  useEarnVaultWithdrawalRequests,
} from "./earn-program-data";
import { earnVaultQueuedWithdrawalStatusPresentation } from "./earn-vault-queued-withdrawal-presentation";

/** Durable recovery surface for queued requests that outlive their create modal. */
export function EarnVaultWithdrawalRequestsCard({ onChanged }: { onChanged?: () => void }) {
  const t = useTranslations();
  const locale = useLocale();
  const { withdrawalRequests, error, isLoading, refresh } = useEarnVaultWithdrawalRequests();
  const cancelKeys = useRef(new Map<string, string>());
  const observedOpenRequestIds = useRef<ReadonlySet<string> | null>(null);
  const reportedDisappearances = useRef(new Set<string>());
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(() => new Set());
  const [cancelError, setCancelError] = useState<Record<string, string>>({});
  const reportServerSettlement = useEffectEvent(() => onChanged?.());

  useEffect(() => {
    // A successful `settled=false` snapshot is the durable settlement signal
    // when no detail modal is left open. Do not interpret the initial empty
    // load or an errored revalidation as a transition.
    if (error || !withdrawalRequests) return;
    const nextOpenRequestIds = new Set(
      withdrawalRequests.map(({ withdrawalRequestId }) => withdrawalRequestId)
    );
    const previousOpenRequestIds = observedOpenRequestIds.current;
    observedOpenRequestIds.current = nextOpenRequestIds;
    if (!previousOpenRequestIds) return;

    // A request may be reopened by reconciliation after a dropped cancel.
    // That makes a later disappearance a new terminal observation.
    for (const requestId of nextOpenRequestIds) reportedDisappearances.current.delete(requestId);
    for (const requestId of previousOpenRequestIds) {
      if (nextOpenRequestIds.has(requestId) || reportedDisappearances.current.has(requestId)) {
        continue;
      }
      reportedDisappearances.current.add(requestId);
      reportServerSettlement();
    }
  }, [error, withdrawalRequests]);

  if (!error && !isLoading && (withdrawalRequests?.length ?? 0) === 0) return null;

  async function cancel(request: EarnVaultWithdrawalRequestRecord) {
    if (cancelling.has(request.withdrawalRequestId)) return;
    const id = request.withdrawalRequestId;
    const key = cancelKeys.current.get(id) ?? crypto.randomUUID();
    cancelKeys.current.set(id, key);
    setCancelling((current) => new Set(current).add(id));
    setCancelError((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    const result = await cancelEarnVaultWithdrawalRequest(id, key);
    setCancelling((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    if (!result.ok) {
      setCancelError((current) => ({ ...current, [id]: result.error }));
      return;
    }
    cancelKeys.current.delete(id);
    refresh();
  }

  return (
    <section>
      <h2 className="mb-4 text-[19px] font-medium leading-6 text-primary">
        {t("DashboardEarn.queuedWithdraw.activeTitle")}
      </h2>
      <Card className="overflow-hidden rounded-2xl py-0">
        {error ? (
          <div className="px-6 py-5 text-sm text-error" role="alert">
            {t("DashboardEarn.queuedWithdraw.activeError")}
          </div>
        ) : isLoading && !withdrawalRequests ? (
          <div className="flex items-center gap-2 px-6 py-5 text-sm text-secondary" role="status">
            <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
            {t("DashboardEarn.queuedWithdraw.activeLoading")}
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {(withdrawalRequests ?? []).map((request) => {
              const status = earnVaultQueuedWithdrawalStatusPresentation(request.status);
              const busy = cancelling.has(request.withdrawalRequestId);
              return (
                <li
                  className="grid gap-4 px-6 py-4 md:grid-cols-[1fr_auto] md:items-center"
                  key={request.withdrawalRequestId}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Clock3Icon aria-hidden="true" className="size-4 text-tertiary" />
                      <span className="truncate text-sm font-medium text-primary">
                        {shortenMarketAddress(request.providerReference)}
                      </span>
                      <Badge variant={status.variant}>{t(status.labelKey)}</Badge>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-secondary">
                      {t("DashboardEarn.queuedWithdraw.activeSummary", {
                        amount: formatProviderAmount(
                          request.quotedAssets,
                          locale,
                          earnMintAsset(request.assetMint).symbol
                        ),
                        maturity: formatEpochSecondsOr(
                          request.maturityTimestamp,
                          locale,
                          t("DashboardEarn.unavailable")
                        ),
                        deadline: formatEpochSecondsOr(
                          request.deadlineTimestamp,
                          locale,
                          t("DashboardEarn.unavailable")
                        ),
                      })}
                    </p>
                    {cancelError[request.withdrawalRequestId] ? (
                      <p className="mt-2 text-xs text-error" role="alert">
                        {cancelError[request.withdrawalRequestId]}
                      </p>
                    ) : null}
                  </div>
                  {request.status === "expiredCancelable" ? (
                    <Button
                      disabled={busy}
                      iconLeft={
                        busy ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : null
                      }
                      onClick={() => void cancel(request)}
                      size="sm"
                      variant="outline"
                    >
                      {busy
                        ? t("DashboardEarn.queuedWithdraw.cancelling")
                        : t("DashboardEarn.queuedWithdraw.cancelAction")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}
