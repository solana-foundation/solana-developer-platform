"use client";

import { CLUSTER_BY_SDP_ENVIRONMENT, type PaymentRequest } from "@sdp/types";
import { CopyIcon, DownloadIcon, Share2Icon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { usePaymentsDemo } from "@/lib/payments-demo/payments-demo-context";
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

type Translate = ReturnType<typeof useTranslations>;

/** Why a request is in its state, in the design's words; an open one says until when. */
function requestWhy(
  status: PaymentRequest["status"],
  expires: string | null,
  t: Translate
): string {
  if (status === "paid") {
    return t("DashboardPayments.requestDetail.why.paid");
  }
  if (status === "awaiting_payment") {
    return expires
      ? t("DashboardPayments.requestDetail.why.awaitingUntil", { date: expires })
      : t("DashboardPayments.requestDetail.why.awaiting");
  }
  return status === "canceled"
    ? t("DashboardPayments.requestDetail.why.canceled")
    : t("DashboardPayments.requestDetail.why.expired");
}

const QR_COLORS = { dark: "#0f0f12", light: "#ffffff" };

/** The link drawn as a QR code, as a data URL once it is drawn; null before and without a link. */
function useQrDataUrl(text: string, width: number): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!text) return;
    let current = true;
    void QRCode.toDataURL(text, { margin: 0, width, color: QR_COLORS }).then((drawn) => {
      if (current) setDataUrl(drawn);
    });
    return () => {
      current = false;
    };
  }, [text, width]);
  return text ? dataUrl : null;
}

/**
 * The request's pay link on this origin, as the design lays it out: its QR code on a 128px tile,
 * the link beside it, and the copy, share and QR download under the link. A demo request lives
 * in this browser only, so it shows no code or link that would open a page that cannot find it,
 * and its actions say so instead of handing out a link nobody can open.
 */
function RequestPaymentLink({ request, symbol }: { request: PaymentRequest; symbol: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const demo = usePaymentsDemo();
  // The link is on this origin; read after mount so the server render does not guess it.
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const payLink = origin ? `${origin}/pay/${request.publicToken}` : "";
  const qrDataUrl = useQrDataUrl(demo ? "" : payLink, 256);
  const amount = `${formatDecimalAmount(request.amount, locale)} ${symbol}`;

  const demoOnly = () => toast.info(t("DashboardPayments.demo.noPayLink"));

  async function copyLink() {
    if (demo) return demoOnly();
    try {
      await navigator.clipboard.writeText(payLink);
    } catch {
      toast.error(t("DashboardPayments.record.copyFailed"));
      return;
    }
    toast.success(t("DashboardPayments.requestDetail.linkCopied"), {
      id: `request-link-${request.id}`,
      description: t("DashboardPayments.requestDetail.linkCopiedDescription", { amount }),
    });
  }

  // The browser's share sheet where there is one; copying stands in elsewhere.
  async function shareLink() {
    if (demo) return demoOnly();
    if (typeof navigator.share !== "function") return copyLink();
    try {
      await navigator.share({
        title: t("DashboardPayments.requestDetail.shareTitle", { amount }),
        url: payLink,
      });
    } catch (error) {
      // Closing the sheet rejects with AbortError; that is not a failure.
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        toast.error(t("DashboardPayments.record.copyFailed"));
      }
    }
  }

  async function downloadQrCode() {
    if (demo) return demoOnly();
    const file = await QRCode.toDataURL(payLink, { margin: 2, width: 512, color: QR_COLORS });
    const anchor = document.createElement("a");
    anchor.href = file;
    anchor.download = `payment-request-${request.id}.png`;
    anchor.click();
  }

  return (
    <div className="flex items-start gap-6 border-t border-border-default pt-4">
      {/* The design's 128px tile: a 96px code on white with a 16px quiet zone; a demo request has
          no link to draw. */}
      {demo ? null : (
        <div className="size-32 shrink-0 rounded-xs bg-white p-4">
          {qrDataUrl ? (
            <Image
              src={qrDataUrl}
              alt={t("DashboardPayments.requestDetail.qrCodeAlt")}
              width={96}
              height={96}
              unoptimized
              className="size-full"
            />
          ) : (
            <div className="size-full animate-pulse rounded-xs bg-fill" />
          )}
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-meta text-secondary">
          {t("DashboardPayments.requestDetail.paymentLink")}
        </span>
        {demo ? (
          <p className="text-body text-secondary">{t("DashboardPayments.demo.noPayLink")}</p>
        ) : (
          <span className="min-w-0 truncate font-mono text-body text-primary">
            {payLink || null}
          </span>
        )}
        {/* 16px to the design's 30px buttons, 8px apart; the copy is filled while the request
            can still be paid. */}
        <div className="mt-2.5 flex flex-wrap items-center gap-2 [&_button]:[--button-height-md:1.875rem]">
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            iconLeft={<Share2Icon />}
            disabled={!origin}
            onClick={() => void shareLink()}
          >
            {t("DashboardPayments.requestDetail.share")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            iconLeft={<DownloadIcon />}
            disabled={!origin}
            onClick={() => void downloadQrCode()}
          >
            {t("DashboardPayments.requestDetail.downloadQrCode")}
          </Button>
        </div>
      </div>
    </div>
  );
}

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
  const router = useRouter();

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
  return (
    <PaymentRequestRecord request={request} contactName={contactName} walletName={walletName} />
  );
}

/** The record once the request could be read: the band, the amount and link, then the rows. */
function PaymentRequestRecord({
  request,
  contactName,
  walletName,
}: {
  request: PaymentRequest;
  contactName: string | null;
  walletName: string | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
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

  const symbol = tokenSymbolByMint.get(request.token) ?? shortenAddress(request.token);
  const expires = request.expiresAt ? formatDateTime(request.expiresAt, locale) : null;

  return (
    <DashboardWorkspaceOverviewPanel>
      {/* 24px between blocks, the band 12px nearer the title than a first block, the rows 8px
          further from the link. */}
      <div className="-mt-3 flex flex-col gap-6" data-payment-request-detail>
        <RecordStateBand
          state={t(REQUEST_STATUS_TRANSLATION_KEYS[request.status])}
          tone={REQUEST_STATUS_TONE[request.status]}
          why={requestWhy(request.status, expires, t)}
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
          <RequestPaymentLink request={request} symbol={symbol} />
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
