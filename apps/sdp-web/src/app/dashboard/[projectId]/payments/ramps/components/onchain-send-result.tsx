"use client";
import type { PaymentTransferSummary } from "@sdp/types/payments";
import { Button } from "@sdp/ui/button";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
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
      <p className="text-sm text-tertiary">
        {transferResult.status === "failed"
          ? transferResult.error
          : transferResult.fireblocks && signature === null
            ? t(
                transferResult.fireblocks.transactionId
                  ? "DashboardPayments.onchainSend.fireblocksPending"
                  : "DashboardPayments.onchainSend.fireblocksUnknown"
              )
            : signature === null
              ? t("DashboardPayments.onchainSend.transferStatus", { status: transferResult.status })
              : t("DashboardPayments.onchainSend.transferSuccess")}
      </p>
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
