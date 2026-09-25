"use client";

import { CLUSTER_BY_SDP_ENVIRONMENT, type PaymentRequest } from "@sdp/types";
import { CopyIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { transactionHref } from "@/lib/payments-routes";
import { shortenAddress } from "../payments-overview.utils";
import { formatDateTime, formatDecimalAmount } from "../payments-presentation";
import {
  RecordAmount,
  RecordColumns,
  RecordList,
  RecordLoadError,
  RecordRow,
  RecordStateBand,
} from "../payments-record";
import { REQUEST_STATUS_TONE, REQUEST_STATUS_TRANSLATION_KEYS } from "./payment-request-status";
import { deriveTokenOptions } from "./payment-requests-page.data";

interface PaymentRequestDetailWorkspaceProps {
  request: PaymentRequest | null;
  /** The contact the request names, when it names one and the contact could be read. */
  contactName: string | null;
  /** The destination wallet's label, when it has one. */
  walletName: string | null;
  /** Set when the requests could not be read; the page says so and offers a retry. */
  error?: string;
}

/**
 * One payment request as the design's record: its state and why, the amount asked, the link
 * to copy, who may pay it and where it lands, its reference, expiry and creation.
 */
export function PaymentRequestDetailWorkspace({
  request,
  contactName,
  walletName,
  error,
}: PaymentRequestDetailWorkspaceProps) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { sdpEnvironment } = useDashboardWorkspace();
  const tokenSymbolByMint = useMemo(
    () =>
      new Map(
        deriveTokenOptions(CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment]).map((token) => [
          token.mintAddress,
          token.symbol,
        ])
      ),
    [sdpEnvironment]
  );
  // The link is on this origin; read after mount so the server render does not guess it.
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  if (!request) {
    return (
      <DashboardWorkspaceOverviewPanel>
        <RecordLoadError
          title={t("DashboardPayments.requestDetail.loadFailedTitle")}
          description={error ?? t("DashboardPayments.requestDetail.loadFailedDescription")}
          onRetry={() => router.refresh()}
        />
      </DashboardWorkspaceOverviewPanel>
    );
  }

  const symbol = tokenSymbolByMint.get(request.token) ?? shortenAddress(request.token);
  const payLink = `${origin}/pay/${request.publicToken}`;
  const expires = request.expiresAt ? formatDateTime(request.expiresAt, locale) : null;
  const why =
    request.status === "paid"
      ? t("DashboardPayments.requestDetail.why.paid")
      : request.status === "awaiting_payment"
        ? expires
          ? t("DashboardPayments.requestDetail.why.awaitingUntil", { date: expires })
          : t("DashboardPayments.requestDetail.why.awaiting")
        : request.status === "canceled"
          ? t("DashboardPayments.requestDetail.why.canceled")
          : t("DashboardPayments.requestDetail.why.expired");

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(payLink);
    } catch {
      toast.error(t("DashboardPayments.record.copyFailed"));
      return;
    }
    toast.success(t("DashboardPayments.requestDetail.linkCopied"), {
      id: `request-link-${request?.id}`,
      description: t("DashboardPayments.requestDetail.linkCopiedDescription", {
        amount: `${formatDecimalAmount(request?.amount ?? "", locale)} ${symbol}`,
      }),
    });
  }

  return (
    <DashboardWorkspaceOverviewPanel>
      {/* 24px between blocks, the band 4px nearer the title than a first block, the rows 8px
          further from the link. */}
      <div className="-mt-1 flex flex-col gap-6" data-payment-request-detail>
        <RecordStateBand
          state={t(REQUEST_STATUS_TRANSLATION_KEYS[request.status])}
          tone={REQUEST_STATUS_TONE[request.status]}
          why={why}
          action={
            request.status === "paid" && request.fulfilledByTransferId ? (
              <Button asChild variant="outline" size="sm">
                <Link href={transactionHref(request.fulfilledByTransferId)}>
                  {t("DashboardPayments.requestDetail.openPayment")}
                </Link>
              </Button>
            ) : undefined
          }
        />

        <section className="flex flex-col gap-4">
          <RecordAmount label={t("DashboardPayments.requests.amountRequested")}>
            {formatDecimalAmount(request.amount, locale)} {symbol}
          </RecordAmount>
          <div className="flex flex-col gap-2 border-t border-border-default pt-4">
            <span className="text-meta text-secondary">
              {t("DashboardPayments.requestDetail.paymentLink")}
            </span>
            <div className="flex flex-wrap items-center gap-3">
              <span className="min-w-0 flex-1 truncate font-mono text-body text-primary">
                {origin ? payLink : null}
              </span>
              <Button
                type="button"
                variant={request.status === "awaiting_payment" ? "default" : "outline"}
                size="sm"
                iconLeft={<CopyIcon />}
                disabled={!origin}
                onClick={() => void copyLink()}
              >
                {t("Shared.SharedComponents.copyLink")}
              </Button>
            </div>
          </div>
        </section>

        <div className="pt-2">
          <RecordColumns>
            <RecordList>
              <RecordRow label={t("DashboardPayments.requests.from")}>
                {contactName ?? t("DashboardPayments.requests.anyoneWithLink")}
              </RecordRow>
              <RecordRow label={t("DashboardPayments.requests.to")}>
                {walletName ? (
                  <>
                    {walletName}
                    <span className="ms-2 font-mono text-secondary">
                      {shortenAddress(request.destinationAddress)}
                    </span>
                  </>
                ) : (
                  <span className="font-mono">{shortenAddress(request.destinationAddress)}</span>
                )}
              </RecordRow>
            </RecordList>
            <RecordList>
              <RecordRow label={t("DashboardPayments.requests.reference")}>
                <span className="font-mono">{request.reference}</span>
              </RecordRow>
              <RecordRow label={t("DashboardPayments.requests.expires")}>
                {expires ?? t("DashboardPayments.requests.noExpiry")}
              </RecordRow>
              <RecordRow label={t("DashboardPayments.recurring.created")}>
                {formatDateTime(request.createdAt, locale) ?? request.createdAt}
              </RecordRow>
            </RecordList>
          </RecordColumns>
        </div>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
