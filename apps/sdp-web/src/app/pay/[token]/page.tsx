import { refreshThemeProps } from "@sdp/design-tokens";
import { SOLANA_CLUSTER_LABELS, type SolanaCluster } from "@sdp/types/well-known-tokens";
import { Badge } from "@sdp/ui/badge";
import { ArrowUpRightIcon, CheckCircle2Icon, ClockIcon, XIcon } from "lucide-react";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  formatDisplayAmount,
  formatTimestamp,
  shortenAddress,
} from "@/app/dashboard/[projectId]/payments/payments-overview.utils";
import { resolvePlaygroundApiBaseUrl } from "@/app/dashboard/[projectId]/playground-api-data";
import { SolanaQrCode } from "@/components/solana-qr-code";
import { getRequestLocale, getTranslations } from "@/i18n/server";

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

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-secondary">{label}</span>
      <span className="min-w-0 truncate font-medium text-primary">{value}</span>
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

export default async function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const t = await getTranslations();
  const locale = await getRequestLocale();
  const { token } = await params;
  const apiBaseUrl = resolvePlaygroundApiBaseUrl();
  if (!apiBaseUrl) {
    throw new Error("SDP API base URL is not configured");
  }

  const response = await fetch(`${apiBaseUrl}/pay/${encodeURIComponent(token)}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    notFound();
  }
  const request = (await response.json()) as PayRequest;

  const payUrl =
    request.solanaPayUrl && isRenderablePayUrl(request.solanaPayUrl) ? request.solanaPayUrl : null;
  const statusPanel =
    request.status === "awaiting_payment" ? null : getStatusPanels(t)[request.status];

  return (
    <main
      {...refreshThemeProps}
      className="flex min-h-screen items-center justify-center bg-surface px-4 py-12"
    >
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
            <div className="mt-7 flex flex-col items-center gap-3 py-6 text-center">
              {statusPanel.icon}
              <p className="text-subheading font-medium text-primary">{statusPanel.title}</p>
              <p className="max-w-xs text-body text-secondary">{statusPanel.body}</p>
            </div>
          ) : null}

          <div className="mt-8 space-y-3 border-t border-border-default pt-6 text-body">
            <DetailRow label={t("Shared.pay.to")} value={shortenAddress(request.recipient)} />
            <DetailRow label={t("Shared.pay.token")} value={request.tokenSymbol} />
            <DetailRow
              label={t("Shared.pay.expires")}
              value={
                request.expiresAt
                  ? formatTimestamp(request.expiresAt, t, locale)
                  : t("Shared.pay.noExpiry")
              }
            />
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
