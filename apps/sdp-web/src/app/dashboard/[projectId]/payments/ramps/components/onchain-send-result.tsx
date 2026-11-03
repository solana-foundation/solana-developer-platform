"use client";
import {
  assertNever,
  isSuccessfulPaymentTransferStatus,
  type PaymentTransferSummary,
} from "@sdp/types/payments";
import { Button } from "@sdp/ui/button";
import { StatusText } from "@sdp/ui/status-text";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  shortenAddress,
  statusMessageKey,
} from "@/app/dashboard/[projectId]/payments/payments-overview.utils";
import { PAYMENT_STATUS_TONE } from "@/app/dashboard/[projectId]/payments/payments-presentation";
import { RecordList, RecordRow } from "@/app/dashboard/[projectId]/payments/payments-record";
import { useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { useSolanaCluster } from "@/lib/use-solana-cluster";

/**
 * What became of a sent transfer, for its heading and its message. A signature alone is not
 * success: a transfer is sent once its status says it settled, and failed whatever it carries.
 */
export type SendResultKind =
  | "failed"
  | "sent"
  | "fireblocksPending"
  | "fireblocksUnknown"
  | "pending";

export function sendResultKind(transfer: PaymentTransferSummary): SendResultKind {
  if (transfer.status === "failed") return "failed";
  if (isSuccessfulPaymentTransferStatus(transfer.status)) return "sent";
  if (transfer.fireblocks && transfer.signature === null) {
    return transfer.fireblocks.transactionId ? "fireblocksPending" : "fireblocksUnknown";
  }
  return "pending";
}

function resultMessage(transfer: PaymentTransferSummary, t: ReturnType<typeof useTranslations>) {
  const kind = sendResultKind(transfer);
  switch (kind) {
    case "failed":
      return transfer.error?.trim() || t("DashboardPayments.onchainSend.transferFailedNoReason");
    case "fireblocksPending":
      return t("DashboardPayments.onchainSend.fireblocksPending");
    case "fireblocksUnknown":
      return t("DashboardPayments.onchainSend.fireblocksUnknown");
    case "pending":
      return t("DashboardPayments.onchainSend.transferStatus", { status: transfer.status });
    case "sent":
      return t("DashboardPayments.onchainSend.transferSuccess");
    default:
      return assertNever(kind);
  }
}

export function OnchainSendResult({
  transferResult,
  summary,
}: {
  transferResult: PaymentTransferSummary;
  summary: ReactNode;
}) {
  const t = useTranslations();
  const href = useProjectHref();
  const cluster = useSolanaCluster();
  const signature = transferResult.signature;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-tertiary">{resultMessage(transferResult, t)}</p>
      <RecordList>
        <RecordRow label={t("DashboardPayments.transactions.status")}>
          <StatusText tone={PAYMENT_STATUS_TONE[transferResult.status]}>
            {t(statusMessageKey(transferResult.status))}
          </StatusText>
        </RecordRow>
        {signature === null ? null : (
          <RecordRow label={t("DashboardPayments.transactions.signature")} copy={signature}>
            <span className="tabular-nums">{shortenAddress(signature)}</span>
          </RecordRow>
        )}
      </RecordList>
      {summary}
      {transferResult.fireblocks ? (
        <Button asChild variant="secondary">
          <Link
            href={href(`/dashboard/payments/transactions/${encodeURIComponent(transferResult.id)}`)}
          >
            {t("DashboardPayments.onchainSend.viewTransaction")}
          </Link>
        </Button>
      ) : null}
      {signature === null ? null : (
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          iconLeft={<ExternalLinkIcon />}
          onClick={() =>
            window.open(explorerTxUrl(signature, cluster), "_blank", "noopener,noreferrer")
          }
        >
          {t("DashboardPayments.onchainSend.viewOnExplorer")}
        </Button>
      )}
    </div>
  );
}
