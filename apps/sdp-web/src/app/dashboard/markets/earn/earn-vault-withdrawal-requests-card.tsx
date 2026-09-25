"use client";

import type { EarnVaultWithdrawalRequestRecord } from "@sdp/types";
import { Clock3Icon, Loader2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { formatEpochSecondsOr, formatTokenValue, shortenMarketAddress } from "./earn-format";
import {
  cancelEarnVaultWithdrawalRequest,
  useEarnVaultWithdrawalRequests,
} from "./earn-program-data";
import {
  earnVaultParRedemptionStatusPresentation,
  isEarnVaultParRedemptionCancelable,
} from "./earn-vault-par-redemption-presentation";
import { earnVaultQueuedWithdrawalStatusPresentation } from "./earn-vault-queued-withdrawal-presentation";

function freshestRequest(
  server: EarnVaultWithdrawalRequestRecord,
  local: EarnVaultWithdrawalRequestRecord | undefined
): EarnVaultWithdrawalRequestRecord {
  if (!local) return server;
  if (["fulfilled", "cancelled", "failed"].includes(server.status)) return server;
  return Date.parse(local.updatedAt) >= Date.parse(server.updatedAt) ? local : server;
}

function parRedemptionSummaryKey(status: EarnVaultWithdrawalRequestRecord["status"]): MessageKey {
  if (status === "creating") return "DashboardEarn.parRedemption.activeSummaryCreating";
  if (status === "cancelling") return "DashboardEarn.parRedemption.activeSummaryCancelling";
  if (status === "closedOrUnknown") return "DashboardEarn.parRedemption.activeSummaryChecking";
  return "DashboardEarn.parRedemption.activeSummary";
}

function WithdrawalRequestSummary({
  parRedemption,
  request,
}: {
  parRedemption: boolean;
  request: EarnVaultWithdrawalRequestRecord;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const amount = formatTokenValue(request.quotedAssets, request.assetMint, locale);
  if (parRedemption) {
    return <>{t(parRedemptionSummaryKey(request.status), { amount })}</>;
  }
  return (
    <>
      {t("DashboardEarn.queuedWithdraw.activeSummary", {
        amount,
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
    </>
  );
}

function WithdrawalRequestItem({
  busy,
  cancelError,
  onCancel,
  request,
}: {
  busy: boolean;
  cancelError: string | undefined;
  onCancel: () => void;
  request: EarnVaultWithdrawalRequestRecord;
}) {
  const t = useTranslations();
  const parRedemption = request.mechanism === "operatorRedemption";
  const status = parRedemption
    ? earnVaultParRedemptionStatusPresentation(request.status)
    : earnVaultQueuedWithdrawalStatusPresentation(request.status);
  const cancelable = parRedemption
    ? isEarnVaultParRedemptionCancelable(request)
    : request.status === "expiredCancelable";
  const cancellingKey = parRedemption
    ? "DashboardEarn.parRedemption.cancelling"
    : "DashboardEarn.queuedWithdraw.cancelling";
  const cancelKey = parRedemption
    ? "DashboardEarn.parRedemption.cancelAction"
    : "DashboardEarn.queuedWithdraw.cancelAction";

  return (
    <li className="grid gap-4 px-6 py-4 md:grid-cols-[1fr_auto] md:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Clock3Icon aria-hidden="true" className="size-4 text-tertiary" />
          <span className="truncate text-sm font-medium text-primary">
            {shortenMarketAddress(request.providerReference)}
          </span>
          <Badge variant={status.variant}>{t(status.labelKey)}</Badge>
        </div>
        <p className="mt-1 text-xs leading-5 text-secondary">
          <WithdrawalRequestSummary parRedemption={parRedemption} request={request} />
        </p>
        {cancelError ? (
          <p className="mt-2 text-xs text-error" role="alert">
            {cancelError}
          </p>
        ) : null}
      </div>
      {cancelable ? (
        <Button
          disabled={busy}
          iconLeft={busy ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : null}
          onClick={onCancel}
          size="sm"
          variant="outline"
        >
          {t(busy ? cancellingKey : cancelKey)}
        </Button>
      ) : null}
    </li>
  );
}

/** Durable recovery surface for queued requests that outlive their create modal. */
export function EarnVaultWithdrawalRequestsCard({ onChanged }: { onChanged?: () => void }) {
  const t = useTranslations();
  const { withdrawalRequests, error, isLoading, refresh } = useEarnVaultWithdrawalRequests();
  const cancelKeys = useRef(new Map<string, string>());
  const observedOpenRequestIds = useRef<ReadonlySet<string> | null>(null);
  const reportedDisappearances = useRef(new Set<string>());
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(() => new Set());
  const [cancelError, setCancelError] = useState<Record<string, string>>({});
  const [cancelResults, setCancelResults] = useState<
    Record<string, EarnVaultWithdrawalRequestRecord>
  >({});
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
    setCancelResults((current) => ({ ...current, [id]: result.data }));
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
            {(withdrawalRequests ?? []).map((serverRequest) => {
              const request = freshestRequest(
                serverRequest,
                cancelResults[serverRequest.withdrawalRequestId]
              );
              return (
                <WithdrawalRequestItem
                  busy={cancelling.has(request.withdrawalRequestId)}
                  cancelError={cancelError[request.withdrawalRequestId]}
                  key={request.withdrawalRequestId}
                  onCancel={() => void cancel(request)}
                  request={request}
                />
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}
