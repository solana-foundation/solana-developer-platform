"use client";

import type { EarnVaultWithdrawalRequestRecord } from "@sdp/types/earn";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { StatusText } from "@sdp/ui/status-text";
import { Loader2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { RecordBlock } from "@/components/refresh-record";
import { useCanWrite } from "@/contexts/dashboard-workspace-context";
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
import { earnStatusTextTone } from "./earn-vault-ui-state";

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
  // A read-only member (`viewer`) sees the request but not the cancel, which the API refuses them.
  const canWrite = useCanWrite();
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

  // A ruled row as the design lists activity: the vault and its status over what the request
  // will pay, and the one way out of it at the end.
  return (
    <li className="grid gap-3 border-b border-border-subtle py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-6">
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-2 text-body">
          <span className="truncate font-medium text-primary">
            {shortenMarketAddress(request.providerReference)}
          </span>
          <StatusText className="shrink-0" tone={earnStatusTextTone(status.variant)}>
            {t(status.labelKey)}
          </StatusText>
        </p>
        <p className="mt-0.5 text-meta text-secondary">
          <WithdrawalRequestSummary parRedemption={parRedemption} request={request} />
        </p>
        {cancelError ? (
          <p className="mt-2 text-meta text-error" role="alert">
            {cancelError}
          </p>
        ) : null}
      </div>
      {cancelable && canWrite ? (
        <Button
          className="justify-self-start md:justify-self-end"
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
  const { withdrawalRequests, error, refresh } = useEarnVaultWithdrawalRequests();
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

  // Nothing stands in while the list loads: most treasuries hold no request, and a placeholder
  // that then disappears would move every section under it.
  if (!error && (withdrawalRequests?.length ?? 0) === 0) return null;

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
    <RecordBlock title={t("DashboardEarn.queuedWithdraw.activeTitle")}>
      {error ? (
        <Callout live variant="warning">
          {t("DashboardEarn.queuedWithdraw.activeError")}
        </Callout>
      ) : (
        <ul>
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
    </RecordBlock>
  );
}
