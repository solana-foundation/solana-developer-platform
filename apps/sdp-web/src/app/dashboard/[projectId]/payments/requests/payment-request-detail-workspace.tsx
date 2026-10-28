"use client";

import { isPaymentRequestPayableAt, type PaymentRequest } from "@sdp/types/payments";
import { CLUSTER_BY_SDP_ENVIRONMENT } from "@sdp/types/well-known-tokens";
import { Button } from "@sdp/ui/button";
import { CopyIcon, DownloadIcon, Loader2Icon, Share2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { shortenAddress } from "@/app/dashboard/[projectId]/payments/payments-overview.utils";
import {
  formatDateTime,
  formatDecimalAmount,
} from "@/app/dashboard/[projectId]/payments/payments-presentation";
import {
  RecordAmount,
  RecordColumns,
  RecordList,
  RecordLoadError,
  RecordRow,
  RecordStateBand,
} from "@/app/dashboard/[projectId]/payments/payments-record";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { downloadSolanaQrCode, SolanaQrCode } from "@/components/solana-qr-code";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { usePaymentsDemo } from "@/lib/payments-demo/payments-demo-context";
import { transactionHref } from "@/lib/payments-routes";
import { useClientNow } from "@/lib/use-client-now";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { REQUEST_STATUS_TONE, REQUEST_STATUS_TRANSLATION_KEYS } from "./payment-request-status";
import { cancelPaymentRequest, deriveTokenOptions } from "./payment-requests-page.data";

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

/**
 * The request's pay link on this origin, as the design lays it out: its QR code on a 128px tile,
 * the link beside it, and the copy, share and QR download under the link. A demo request lives
 * in this browser only, so it shows no code or link that would open a page that cannot find it,
 * and its actions say so instead of handing out a link nobody can open.
 */
function RequestPaymentLink({
  request,
  publicToken,
  symbol,
}: {
  request: PaymentRequest;
  publicToken: string;
  symbol: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const demo = usePaymentsDemo();
  // The link is on this origin; read after mount so the server render does not guess it.
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const payLink = origin ? `${origin}/pay/${publicToken}` : "";
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
    await downloadSolanaQrCode({
      url: payLink,
      size: 512,
      fileName: `payment-request-${request.id}`,
    });
  }

  return (
    // On a phone the tile sits over the link, so the link and its actions keep the full width.
    <div className="flex flex-col gap-4 border-t border-border-default pt-4 sm:flex-row sm:items-start sm:gap-6">
      {/* The design's 128px tile: a 96px code on white with a 16px quiet zone; a demo request has
          no link to draw. */}
      {demo ? null : (
        <div className="size-32 shrink-0 rounded-xs bg-white p-4">
          {payLink ? (
            <SolanaQrCode
              url={payLink}
              size={96}
              label={t("DashboardPayments.requestDetail.qrCodeAlt")}
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

/**
 * The footer under a rule while the request is open, for a member who may manage payment
 * requests: Cancel request, then the inline question it asks before it acts, as the recurring
 * page asks. Every control is disabled while the cancel is in flight; the page reads the request
 * again once it settles either way.
 */
function RequestCancelFooter({ requestId }: { requestId: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const panelRef = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (!confirming) return;
    panelRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    panelRef.current?.scrollIntoView({ block: "nearest" });
  }, [confirming]);

  async function cancel() {
    setCanceling(true);
    const result = await cancelPaymentRequest(requestId);
    setCanceling(false);
    setConfirming(false);
    if (result.ok) {
      toast.success(t("DashboardPayments.requestDetail.requestCanceled"));
    } else {
      toast.error(t("DashboardPayments.requestDetail.cancelFailed"), {
        description: result.error,
      });
    }
    router.refresh();
  }

  const head = t("DashboardPayments.requestDetail.cancelConfirmHead");
  return (
    <div className="flex flex-col gap-4 border-t border-border-default pt-4">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={canceling}
          aria-expanded={confirming}
          onClick={() => setConfirming((open) => !open)}
        >
          {t("DashboardPayments.requestDetail.cancelRequest")}
        </Button>
      </div>
      {confirming ? (
        <fieldset
          ref={panelRef}
          aria-label={head}
          className="min-w-0 rounded-card border border-error/32 bg-error/8 p-4 text-body"
        >
          <p className="max-w-xl text-secondary">
            <b className="mb-1 block font-medium text-error">{head}</b>
            {t("DashboardPayments.requestDetail.cancelConfirmBody")}
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={canceling}
              onClick={() => setConfirming(false)}
            >
              {t("DashboardPayments.requestDetail.keepIt")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={canceling}
              iconLeft={
                canceling ? <Loader2Icon className="size-4 shrink-0 animate-spin" /> : undefined
              }
              onClick={() => void cancel()}
            >
              {canceling
                ? t("DashboardPayments.requestDetail.canceling")
                : t("DashboardPayments.requestDetail.cancelRequest")}
            </Button>
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

/** How often an open request's Cancel is re-decided, so it goes once the request expires. */
const CANCEL_ELIGIBILITY_REFRESH_MS = 30_000;

interface PaymentRequestDetailWorkspaceProps {
  request: PaymentRequest | null;
  /**
   * The pay link's token, null when the member's role may not manage payment
   * requests: the token is a bearer credential (APE-849).
   */
  publicToken: string | null;
  /** The destination wallet's label, when it has one. */
  walletName: string | null;
  /** Set when the requests could not be read; the page says so and offers a retry. */
  error?: string;
}

/**
 * One payment request as the design's record: its state and why, the amount asked, the link
 * to copy, where it lands, its reference, expiry and creation.
 */
export function PaymentRequestDetailWorkspace({
  request,
  publicToken,
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
    <PaymentRequestRecord request={request} publicToken={publicToken} walletName={walletName} />
  );
}

/** The record once the request could be read: the band, the amount and link, then the rows. */
function PaymentRequestRecord({
  request,
  publicToken,
  walletName,
}: {
  request: PaymentRequest;
  publicToken: string | null;
  walletName: string | null;
}) {
  const t = useTranslations();
  const projectHref = useProjectHref();
  const locale = useLocale();
  const { sdpEnvironment, dashboardAccess } = useDashboardWorkspace();
  // Whether it is still payable depends on the clock, so it is decided only in the browser: the
  // server render and the first client render both leave Cancel out, and agree.
  const now = useClientNow(CANCEL_ELIGIBILITY_REFRESH_MS);
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
                <Link href={projectHref(transactionHref(request.fulfilledByTransferId))}>
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
          {/* The pay link is a bearer credential: only a member who may manage payment
              requests receives its token (APE-849). */}
          {publicToken ? (
            <RequestPaymentLink request={request} publicToken={publicToken} symbol={symbol} />
          ) : null}
        </section>

        <div className="pt-2">
          <RecordColumns>
            <RecordList>
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

        {now !== null &&
        isPaymentRequestPayableAt(request, now) &&
        dashboardAccess.capabilities.canManagePaymentRequests ? (
          <RequestCancelFooter requestId={request.id} />
        ) : null}
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
