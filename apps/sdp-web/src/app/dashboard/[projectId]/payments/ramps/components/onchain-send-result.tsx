"use client";
import { assertNever, type PaymentTransferSummary } from "@sdp/types/payments";
import { Button } from "@sdp/ui/button";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { useSolanaCluster } from "@/lib/use-solana-cluster";

function resultMessage(transfer: PaymentTransferSummary, t: ReturnType<typeof useTranslations>) {
  let kind: "failed" | "fireblocksPending" | "fireblocksUnknown" | "pending" | "confirmed" =
    transfer.signature === null ? "pending" : "confirmed";
  if (transfer.fireblocks && transfer.signature === null) {
    kind = transfer.fireblocks.transactionId ? "fireblocksPending" : "fireblocksUnknown";
  }
  if (transfer.status === "failed") kind = "failed";
  switch (kind) {
    case "failed":
      return transfer.error;
    case "fireblocksPending":
      return t("DashboardPayments.onchainSend.fireblocksPending");
    case "fireblocksUnknown":
      return t("DashboardPayments.onchainSend.fireblocksUnknown");
    case "pending":
      return t("DashboardPayments.onchainSend.transferStatus", { status: transfer.status });
    case "confirmed":
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
