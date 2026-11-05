import { refreshThemeProps } from "@sdp/design-tokens";
import { SOLANA_CLUSTER_LABELS, type SolanaCluster } from "@sdp/types/well-known-tokens";
import { Badge } from "@sdp/ui/badge";
import { ArrowUpRightIcon, CheckCircle2Icon, ClockIcon, XIcon } from "lucide-react";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  formatDisplayAmount,
  shortenAddress,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-overview.utils";
import { resolvePlaygroundApiBaseUrl } from "@/app/(session)/dashboard/[projectId]/playground-api-data";
import { SolanaQrCode } from "@/components/solana-qr-code";
import { getRequestLocale, getTranslations } from "@/i18n/server";
import { findPublicSdpApiBaseUrl } from "@/lib/sdp-api-base-url";
import { PayExpiry } from "./pay-expiry";
import { PayStatusWatch } from "./pay-status-watch";
import { payTokenSchema } from "./pay-token";

export const dynamic = "force-dynamic";

type PayStatus = "awaiting_payment" | "paid" | "canceled" | "expired";

interface PayRequest {
  amount: string;
  tokenSymbol: string;
  recipient: string;
  status: PayStatus;
  expiresAt: string | null;
  network: SolanaCluster;
  solanaPayUrl: string | null;
}

interface StatusPanel {
  icon: ReactNode;
  title: string;
  body: string;
}

function getStatusPanels(t: Awaited<ReturnType<typeof getTranslations>>) {
  return {
    paid: {
      icon: <CheckCircle2Icon className="size-12 text-success" />,
      title: t("Shared.pay.paymentReceived"),
      body: t("Shared.pay.paymentReceivedDescription"),
    },
    expired: {
      icon: <ClockIcon className="size-12 text-tertiary" />,
      title: t("Shared.pay.linkExpired"),
      body: t("Shared.pay.linkExpiredDescription"),
    },
    canceled: {
      icon: <XIcon className="size-12 text-error" />,
      title: t("Shared.pay.requestCanceled"),
      body: t("Shared.pay.requestCanceledDescription"),
    },
  } as const satisfies Record<Exclude<PayStatus, "awaiting_payment">, StatusPanel>;
}

const DETAIL_VALUE = "min-w-0 truncate font-medium text-primary";

/** A label, and on the right its value: the caller's element, so a client value can own it. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-secondary">{label}</span>
      {children}
    </div>
  );
}

/**
 * Checks that an API-supplied Solana Pay URL is safe to render as a link
 * target and QR payload: parseable and https or the solana-pay scheme.
 * `new URL` alone accepts `javascript:` and `data:` schemes, which must
 * never reach an href even though the API derives the URL itself.
 */
function isRenderablePayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "solana:";
  } catch {
    return false;
  }
}

/**
 * The public pay page. It has no `loading.tsx`: a loading boundary streams a 200 before the read
 * below can call `notFound()`, and an unknown link must answer 404 (HOO-2619).
 */
export default async function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const parsedToken = payTokenSchema.safeParse((await params).token);
  if (!parsedToken.success) {
    notFound();
  }
  const token = parsedToken.data;
  const apiBaseUrl = resolvePlaygroundApiBaseUrl();
  if (!apiBaseUrl) {
    throw new Error("SDP API base URL is not configured");
  }

  const response = await fetch(`${apiBaseUrl}/pay/${encodeURIComponent(token)}`, {
    cache: "no-store",
  });
  if (response.status === 404) {
    notFound();
  }
  if (!response.ok) {
    // A refused or failed read is not a missing link: the error page lets the payer retry.
    throw new Error(`Pay link read failed (${response.status})`);
  }
  const [request, t, locale] = await Promise.all([
    response.json() as Promise<PayRequest>,
    getTranslations(),
    getRequestLocale(),
  ]);

  const payUrl =
    request.solanaPayUrl && isRenderablePayUrl(request.solanaPayUrl) ? request.solanaPayUrl : null;
  const statusPanel =
    request.status === "awaiting_payment" ? null : getStatusPanels(t)[request.status];
  // The watch reads from the payer's browser, so it takes the address a browser can reach.
  const publicApiBaseUrl = findPublicSdpApiBaseUrl({
    NEXT_PUBLIC_SDP_API_BASE_URL: process.env.NEXT_PUBLIC_SDP_API_BASE_URL,
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  });

  return (
    <main
      {...refreshThemeProps}
      className="flex min-h-screen items-center justify-center bg-surface px-4 py-12"
    >
      {publicApiBaseUrl ? (
        <PayStatusWatch
          statusUrl={`${publicApiBaseUrl}/pay/${encodeURIComponent(token)}`}
          status={request.status}
        />
      ) : null}
      <div className="w-full max-w-md overflow-hidden rounded-card border border-border-default bg-surface-raised">
        <div className="p-8">
          <div className="flex items-center justify-center">
            <span className="text-nav font-medium text-primary">{t("Shared.pay.productName")}</span>
          </div>

          <div className="mt-7 space-y-2.5 text-center">
            <div className="flex items-center justify-center gap-2">
              <p className="text-meta text-secondary">{t("Shared.pay.paymentRequest")}</p>
              <Badge variant="info">{SOLANA_CLUSTER_LABELS[request.network]}</Badge>
            </div>
            <p className="text-amount font-medium tabular-nums text-primary">
              {formatDisplayAmount(request.amount, undefined, locale)}{" "}
              <span className="text-secondary">{request.tokenSymbol}</span>
            </p>
          </div>

          {payUrl ? (
            <div className="mt-7 flex flex-col items-center gap-5">
              <div className="rounded-xs bg-white p-4">
                <SolanaQrCode url={payUrl} size={208} label={t("Shared.pay.qrCode")} />
              </div>
              <p className="text-body text-secondary">{t("Shared.pay.scanWallet")}</p>
              <a
                href={payUrl}
                className="hidden h-12 w-full items-center justify-center rounded-control bg-primary text-body font-medium text-on-primary transition hover:opacity-90 pointer-coarse:flex"
              >
                {t("Shared.pay.openWallet")}
              </a>
            </div>
          ) : statusPanel ? (
            <div className="mt-5 flex flex-col items-center gap-3 text-center">
              {statusPanel.icon}
              <p className="text-subheading font-medium text-primary">{statusPanel.title}</p>
              <p className="max-w-xs text-body text-secondary">{statusPanel.body}</p>
            </div>
          ) : null}

          <div className="mt-8 space-y-3 border-t border-border-default pt-6 text-body">
            <DetailRow label={t("Shared.pay.to")}>
              <span className={DETAIL_VALUE}>{shortenAddress(request.recipient)}</span>
            </DetailRow>
            <DetailRow label={t("Shared.pay.token")}>
              <span className={DETAIL_VALUE}>{request.tokenSymbol}</span>
            </DetailRow>
            <DetailRow label={t("Shared.pay.expires")}>
              {request.expiresAt ? (
                <PayExpiry expiresAt={request.expiresAt} className={DETAIL_VALUE} />
              ) : (
                <span className={DETAIL_VALUE}>{t("Shared.pay.noExpiry")}</span>
              )}
            </DetailRow>
          </div>
        </div>

        <div className="flex items-center justify-center gap-1.5 border-t border-border-default bg-fill-subtle py-3.5">
          <a
            href="https://solana.com/docs/tools/solana-pay"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-meta text-tertiary underline underline-offset-4 transition-colors hover:text-secondary"
          >
            {t("Shared.pay.securedBySolanaPay")}
            <ArrowUpRightIcon aria-hidden="true" className="size-3.5 shrink-0" />
          </a>
        </div>
      </div>
    </main>
  );
}
