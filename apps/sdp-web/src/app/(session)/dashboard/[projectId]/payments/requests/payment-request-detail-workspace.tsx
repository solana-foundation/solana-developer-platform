"use client";

import { isPaymentRequestPayableAt, type PaymentRequest } from "@sdp/types/payments";
import { CLUSTER_BY_SDP_ENVIRONMENT } from "@sdp/types/well-known-tokens";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { cn } from "@sdp/ui/cn";
import { Modal } from "@sdp/ui/modal";
import { playMark } from "@sdp/ui/motion";
import { CheckIcon, CopyIcon, DownloadIcon, Share2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { shortenAddress } from "@/app/(session)/dashboard/[projectId]/payments/payments-overview.utils";
import {
  formatDateTime,
  formatDecimalAmount,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-presentation";
import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import {
  RecordAmount,
  RecordLoadError,
  RecordSection,
  RecordStateBand,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-record";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { RecordFact, RecordFactColumns } from "@/components/refresh-record";
import { SolanaQrCode } from "@/components/solana-qr-code";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { usePaymentsDemo } from "@/lib/payments-demo/payments-demo-context";
import { transactionHref } from "@/lib/payments-routes";
import { downloadSolanaQrCode } from "@/lib/solana-qr";
import { useClientNow } from "@/lib/use-client-now";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { createdRequestLinkCopied, forgetCreatedRequestLink } from "./created-request-link";
import { REQUEST_STATUS_TONE, REQUEST_STATUS_TRANSLATION_KEYS } from "./payment-request-status";
import {
  cancelPaymentRequest,
  deriveTokenOptions,
  fetchPaymentRequestFromBrowser,
  type PaymentRequestCanceler,
} from "./payment-requests-page.data";

type Translate = ReturnType<typeof useTranslations>;

/**
 * Who canceled it, as the band names them: the key's or member's name, else "an API key" or "a
 * member". Null when the request does not say who did.
 */
function cancelerLabel(
  request: PaymentRequest,
  canceler: PaymentRequestCanceler | null,
  t: Translate
): string | null {
  const id = request.canceledByApiKeyId ?? request.canceledByUserId;
  if (!id) return null;
  const name = canceler?.id === id ? canceler.name : null;
  if (request.canceledByApiKeyId) {
    return name
      ? t("DashboardPayments.requestDetail.canceledByApiKey", { name })
      : t("DashboardPayments.requestDetail.canceledByUnnamedApiKey");
  }
  return name ?? t("DashboardPayments.requestDetail.canceledByUnnamedMember");
}

/** Why a request is in its state, in the design's words; an open one says until when. */
function requestWhy(
  request: PaymentRequest,
  expires: string | null,
  canceler: PaymentRequestCanceler | null,
  locale: string,
  t: Translate
): string {
  const status = request.status;
  switch (status) {
    case "paid":
      return t("DashboardPayments.requestDetail.why.paid");
    case "awaiting_payment":
      return expires
        ? t("DashboardPayments.requestDetail.why.awaitingUntil", { date: expires })
        : t("DashboardPayments.requestDetail.why.awaiting");
    case "expired":
      return t("DashboardPayments.requestDetail.why.expired");
    case "canceled":
      return canceledWhy(request, canceler, locale, t);
    default: {
      const unhandled: never = status;
      throw new Error(`Unhandled payment request status: ${String(unhandled)}`);
    }
  }
}

/** A canceled request's why: who canceled it and when, as far as both are known. */
function canceledWhy(
  request: PaymentRequest,
  canceler: PaymentRequestCanceler | null,
  locale: string,
  t: Translate
): string {
  const actor = cancelerLabel(request, canceler, t);
  const date = request.canceledAt ? formatDateTime(request.canceledAt, locale) : null;
  if (actor && date) {
    return t("DashboardPayments.requestDetail.why.canceledByOn", { actor, date });
  }
  if (actor) {
    return t("DashboardPayments.requestDetail.why.canceledBy", { actor });
  }
  return date
    ? t("DashboardPayments.requestDetail.why.canceledOn", { date })
    : t("DashboardPayments.requestDetail.why.canceled");
}

/** The page's origin never changes while it is open, so there is nothing to subscribe to. */
function subscribeToNothing(): () => void {
  return () => {};
}

function readOrigin(): string {
  return window.location.origin;
}

/** The server render's origin: none, so it never guesses one the browser would contradict. */
function noOrigin(): string {
  return "";
}

/** How long Copy link reads Copied: the design's done state, as long as the link's mark. */
const COPIED_MS = 1400;

/**
 * Whether Copy link reads Copied: for 1.4s after `flash`, and from the first frame when the
 * new-request page copied the link on its way here.
 *
 * @param copiedOnArrival - Whether the link was copied before this page opened.
 * @returns Whether it reads Copied, and `flash`, which starts the 1.4s again.
 */
function useCopiedFlash(copiedOnArrival: boolean): [boolean, () => void] {
  const [copied, setCopied] = useState(copiedOnArrival);
  const timer = useRef<number | undefined>(undefined);
  const flash = useCallback(() => {
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  }, []);
  useEffect(() => {
    if (copiedOnArrival) flash();
  }, [copiedOnArrival, flash]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [copied, flash];
}

/** One of Copy link's two faces: the button's gap, and its icon at the button's icon size. */
const COPY_LINK_FACE =
  "col-start-1 row-start-1 inline-flex items-center gap-[var(--button-gap-md)] [&_svg]:size-[var(--icon-size)] [&_svg]:shrink-0";

/**
 * Copy link's icon and words, or a check and Copied once it has copied. Both faces sit in one
 * grid cell with the other hidden, so the button keeps the wider one's width with the shown face
 * centred in it, as the design's done state is, and the buttons beside it never move.
 */
function CopyLinkContent({ copied }: { copied: boolean }) {
  const t = useTranslations();
  return (
    <span className="grid justify-items-center">
      <span aria-hidden={copied} className={cn(COPY_LINK_FACE, copied && "invisible")}>
        <CopyIcon />
        {t("Shared.SharedComponents.copyLink")}
      </span>
      <span aria-hidden={!copied} className={cn(COPY_LINK_FACE, !copied && "invisible")}>
        <CheckIcon />
        {t("DashboardPayments.record.copied")}
      </span>
    </span>
  );
}

/**
 * The request's pay link on this origin, as the design lays it out: its QR code on a 128px tile,
 * the link beside it, and the copy, share and QR download under the link. A demo request lives
 * in this browser only, so it shows no code or link that would open a page that cannot find it,
 * and its actions say so instead of handing out a link nobody can open. It shows only while the
 * request can be paid. Opened by the new-request page, the link is marked and Copy link reads
 * Copied; when that copy failed, a line under the buttons says so until Copy link copies it.
 */
function RequestPaymentLink({
  request,
  publicToken,
  symbol,
  linkCopiedOnCreate,
}: {
  request: PaymentRequest;
  publicToken: string;
  symbol: string;
  linkCopiedOnCreate: boolean | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const demo = usePaymentsDemo();
  // The link is on this origin. The server render does not guess it, so a page it rendered gets
  // the link once hydrated; a page opened in the browser has it from its first frame, so the
  // link and its mark never arrive a frame apart.
  const origin = useSyncExternalStore(subscribeToNothing, readOrigin, noOrigin);
  const payLink = origin ? `${origin}/pay/${publicToken}` : "";
  const amount = `${formatDecimalAmount(request.amount, locale)} ${symbol}`;
  const [copied, flashCopied] = useCopiedFlash(linkCopiedOnCreate === true);
  // A copy that failed on the way here is said under the buttons until Copy link copies it.
  const [arrivalCopyFailed, setArrivalCopyFailed] = useState(linkCopiedOnCreate === false);
  const linkRef = useRef<HTMLSpanElement>(null);
  // Before paint, so the mark never shows a frame of the bare link first.
  useLayoutEffect(() => {
    if (linkCopiedOnCreate !== null && linkRef.current !== null) playMark(linkRef.current);
  }, [linkCopiedOnCreate]);

  const demoOnly = () => toast.info(t("DashboardPayments.demo.noPayLink"));

  async function copyLink() {
    if (demo) return demoOnly();
    try {
      await navigator.clipboard.writeText(payLink);
    } catch {
      toast.error(t("DashboardPayments.record.copyFailed"));
      return;
    }
    setArrivalCopyFailed(false);
    flashCopied();
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
    await downloadSolanaQrCode({ url: payLink, fileName: `payment-request-${request.id}` });
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
          // Padded out to the mark's box and pulled back by as much, so the text stays put.
          <span
            ref={linkRef}
            className="-mx-3 -my-1.5 min-w-0 truncate rounded-sm px-3 py-1.5 font-mono text-body text-primary"
          >
            {payLink || null}
          </span>
        )}
        {/* 16px to the design's 30px buttons, 8px apart; the copy is filled while the request
            can still be paid. */}
        <div className="mt-2.5 flex flex-wrap items-center gap-2 [&_button]:[--button-height-md:1.875rem]">
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={!origin}
            onClick={() => void copyLink()}
          >
            <CopyLinkContent copied={copied} />
          </Button>
          <span className="sr-only" aria-live="polite">
            {copied ? t("DashboardPayments.record.copied") : ""}
          </span>
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
        {/* Under the buttons, so clearing it moves nothing a press is aimed at. */}
        {arrivalCopyFailed ? (
          <p className="text-body text-secondary">
            {t("DashboardPayments.requests.paymentLinkCopyFailed")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The record's danger zone while the request is open, for a member who may manage payment
 * requests: Cancel request, what it does, and its button, which asks in a modal before it acts.
 * The modal cannot be closed and its controls are disabled while the cancel is in flight; the
 * page reads the request again once it settles either way.
 */
function RequestDangerZone({ requestId }: { requestId: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [canceling, setCanceling] = useState(false);

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

  const title = t("DashboardPayments.requestDetail.cancelRequest");
  return (
    <RecordSection title={t("DashboardPayments.requestDetail.dangerZone")}>
      <div className="flex flex-col items-start gap-3 @2xl:flex-row @2xl:items-center @2xl:justify-between @2xl:gap-6">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-body font-medium text-primary">{title}</p>
          <p className="max-w-[40em] text-body text-secondary">
            {t("DashboardPayments.requestDetail.cancelEffect")}
          </p>
        </div>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="shrink-0"
          onClick={() => setConfirming(true)}
        >
          {t("DashboardPayments.requestDetail.cancelRequestEllipsis")}
        </Button>
      </div>
      <Modal
        isOpen={confirming}
        ariaLabel={title}
        onClose={() => setConfirming(false)}
        closeDisabled={canceling}
        size="sm"
      >
        <div className="space-y-4 p-6">
          <h2 className="font-medium text-lg text-primary">{title}</h2>
          <Callout variant="warning">
            {t("DashboardPayments.requestDetail.cancelConfirmHead")}
          </Callout>
          <p className="text-sm text-secondary">
            {t("DashboardPayments.requestDetail.cancelConfirmBody")}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={canceling}
              onClick={() => setConfirming(false)}
            >
              {t("DashboardPayments.requestDetail.keepIt")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={canceling}
              onClick={() => void cancel()}
            >
              {title}
            </Button>
          </div>
        </div>
      </Modal>
    </RecordSection>
  );
}

/** How often an open request's Cancel is re-decided, so it goes once the request expires. */
const CANCEL_ELIGIBILITY_REFRESH_MS = 30_000;

/**
 * How often an open request is read again. The API marks a request paid within 30s of its
 * payment landing, so a payment shows on the page within about 40s, without a reload.
 */
const PAYMENT_WATCH_INTERVAL_MS = 10_000;

/**
 * The request as the API holds it now. An open one is read again until it is paid, canceled or
 * expired, in a visible tab, and never in demo mode, whose requests are fixtures. The newer of
 * this read and the server's wins, so a cancel's refresh shows at once.
 */
function useWatchedPaymentRequest(served: PaymentRequest): PaymentRequest {
  const demo = usePaymentsDemo();
  const { data } = useSWR(
    demo || served.status !== "awaiting_payment"
      ? null
      : paymentsQueryKeys.paymentRequestWatch(served.id),
    ([, requestId]: readonly [string, string]) => fetchPaymentRequestFromBrowser(requestId),
    {
      // A fresh function each render re-arms SWR's timer with the latest read. Before the first
      // read it sees nothing, and the server's open request stands in.
      refreshInterval: (latest) =>
        (latest ?? served).status === "awaiting_payment" ? PAYMENT_WATCH_INTERVAL_MS : 0,
      revalidateOnMount: false,
      revalidateOnFocus: true,
      dedupingInterval: 2_000,
      // Once the server's request closes, the key goes null and its last read must go with it.
      keepPreviousData: false,
    }
  );
  // A tie goes to the read: the API derives `expired` from the clock, before anything writes it.
  return data !== undefined && data.updatedAt >= served.updatedAt ? data : served;
}

interface PaymentRequestDetailWorkspaceProps {
  request: PaymentRequest | null;
  /**
   * The pay link's token, null when the member's role may not manage payment
   * requests: the token is a bearer credential (APE-849).
   */
  publicToken: string | null;
  /** The destination wallet's label, when it has one. */
  walletName: string | null;
  /** Who canceled the request as the server read it; null when it is not canceled. */
  canceler?: PaymentRequestCanceler | null;
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
  canceler = null,
  error,
}: PaymentRequestDetailWorkspaceProps) {
  const t = useTranslations();
  const router = useRouter();
  // The new-request page's note is read once, on arrival, and dropped, so a reload or a later
  // visit says nothing about a copy made earlier.
  const [linkCopiedOnCreate] = useState(() =>
    request === null ? null : createdRequestLinkCopied(request.id)
  );
  useEffect(forgetCreatedRequestLink, []);

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
    <PaymentRequestRecord
      request={request}
      publicToken={publicToken}
      walletName={walletName}
      canceler={canceler}
      linkCopiedOnCreate={linkCopiedOnCreate}
    />
  );
}

/** The record once the request could be read: the band, the amount and link, then the rows. */
function PaymentRequestRecord({
  request: served,
  publicToken,
  walletName,
  canceler,
  linkCopiedOnCreate,
}: {
  request: PaymentRequest;
  publicToken: string | null;
  walletName: string | null;
  canceler: PaymentRequestCanceler | null;
  /** Whether the new-request page that opened this page copied the link; null otherwise. */
  linkCopiedOnCreate: boolean | null;
}) {
  const request = useWatchedPaymentRequest(served);
  const router = useRouter();
  // Who canceled is read on the server, so a cancel the watch sees first refreshes the page once;
  // the refreshed request is canceled, so it does not refresh again.
  const canceledUnderWatch = served.status === "awaiting_payment" && request.status === "canceled";
  useEffect(() => {
    if (canceledUnderWatch) router.refresh();
  }, [canceledUnderWatch, router]);
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

  const linkLive =
    request.status === "awaiting_payment" &&
    (now === null || isPaymentRequestPayableAt(request, now));
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
          why={requestWhy(request, expires, canceler, locale, t)}
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
              requests receives its token (APE-849). Once paid, canceled or expired the link only
              says so, so the page stops handing it out: the server and first client render go by
              the status, then the clock decides an expiry the API has not reported yet. */}
          {publicToken && linkLive ? (
            <RequestPaymentLink
              request={request}
              publicToken={publicToken}
              symbol={symbol}
              linkCopiedOnCreate={linkCopiedOnCreate}
            />
          ) : null}
        </section>

        {/* Who pays and where it lands, then how it is known: two columns of facts. Anyone
            holding the link can pay it, so From names nobody. */}
        <div className="pt-2">
          <RecordFactColumns>
            <dl>
              <RecordFact label={t("DashboardPayments.requests.from")}>
                {t("DashboardPayments.requestDetail.anyoneWithTheLink")}
              </RecordFact>
              <RecordFact label={t("DashboardPayments.requests.to")}>
                {walletName ? (
                  <>
                    <span className="truncate">{walletName}</span>
                    <span className="shrink-0 text-secondary tabular-nums">
                      {shortenAddress(request.destinationAddress)}
                    </span>
                  </>
                ) : (
                  <span className="tabular-nums">{shortenAddress(request.destinationAddress)}</span>
                )}
              </RecordFact>
            </dl>
            <dl>
              <RecordFact label={t("DashboardPayments.requests.reference")}>
                <span className="truncate tabular-nums">{request.reference}</span>
              </RecordFact>
              <RecordFact label={t("DashboardPayments.requests.expires")}>
                {expires ?? t("DashboardPayments.requests.noExpiry")}
              </RecordFact>
              <RecordFact label={t("DashboardPayments.recurring.created")}>
                {formatDateTime(request.createdAt, locale) ?? request.createdAt}
              </RecordFact>
            </dl>
          </RecordFactColumns>
        </div>

        {now !== null &&
        isPaymentRequestPayableAt(request, now) &&
        dashboardAccess.capabilities.canManagePaymentRequests ? (
          <RequestDangerZone requestId={request.id} />
        ) : null}
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
