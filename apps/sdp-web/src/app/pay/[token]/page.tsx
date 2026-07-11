import { SOLANA_CLUSTER_LABELS, type SolanaCluster } from "@sdp/types";
import { CheckCircle2Icon, ClockIcon, XCircleIcon } from "lucide-react";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getRequestLocale, getTranslations } from "@/i18n/server";
import {
  formatDisplayAmount,
  formatTimestamp,
  shortenAddress,
} from "../../dashboard/payments/payments-overview.utils";
import { resolvePlaygroundApiBaseUrl } from "../../dashboard/playground-api-data";
import { PayQrCode } from "./pay-qr-code";

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
      icon: <CheckCircle2Icon className="size-12 text-status-success-text" />,
      title: t("Shared.pay.paymentReceived"),
      body: t("Shared.pay.paymentReceivedDescription"),
    },
    expired: {
      icon: <ClockIcon className="size-12 text-text-low" />,
      title: t("Shared.pay.linkExpired"),
      body: t("Shared.pay.linkExpiredDescription"),
    },
    canceled: {
      icon: <XCircleIcon className="size-12 text-status-error-text" />,
      title: t("Shared.pay.requestCanceled"),
      body: t("Shared.pay.requestCanceledDescription"),
    },
  } as const satisfies Record<Exclude<PayStatus, "awaiting_payment">, StatusPanel>;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-text-medium">{label}</span>
      <span className="min-w-0 truncate font-medium text-text-extra-high">{value}</span>
    </div>
  );
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

  const payUrl = request.solanaPayUrl;
  const statusPanel =
    request.status === "awaiting_payment" ? null : getStatusPanels(t)[request.status];

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-b from-[#e9e7de] to-[#f5f4ef] px-4 py-12">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(rgba(28,28,29,0.09) 1.25px, transparent 1.25px), radial-gradient(rgba(28,28,29,0.05) 1.25px, transparent 1.25px)",
          backgroundSize: "26px 26px",
          backgroundPosition: "0 0, 13px 13px",
          maskImage: "radial-gradient(ellipse 80% 62% at 50% 38%, #000 8%, transparent 78%)",
          WebkitMaskImage: "radial-gradient(ellipse 80% 62% at 50% 38%, #000 8%, transparent 78%)",
        }}
      />

      <div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-[rgba(28,28,29,0.08)] bg-white shadow-[0_24px_70px_-24px_rgba(28,28,29,0.22)]">
        <div className="p-8">
          <div className="flex items-center justify-center border-b border-border-light pb-6">
            <span className="text-sm font-semibold tracking-tight text-text-extra-high">
              {t("Shared.pay.productName")}
            </span>
          </div>

          <div className="mt-7 space-y-2.5 text-center">
            <div className="flex items-center justify-center gap-2">
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-text-low">
                {t("Shared.pay.paymentRequest")}
              </p>
              <span className="inline-flex items-center rounded-full bg-[var(--sdp-color-info-bg)] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--sdp-color-info-text)]">
                {SOLANA_CLUSTER_LABELS[request.network]}
              </span>
            </div>
            <p className="text-5xl font-medium tracking-tight text-text-extra-high">
              {formatDisplayAmount(request.amount, undefined, locale)}{" "}
              <span className="text-2xl text-text-medium">{request.tokenSymbol}</span>
            </p>
          </div>

          {payUrl ? (
            <div className="mt-7 flex flex-col items-center gap-5">
              <div className="rounded-2xl border border-border-light bg-white p-4 shadow-[0_2px_12px_rgba(28,28,29,0.05)]">
                <PayQrCode url={payUrl} size={208} />
              </div>
              <p className="text-sm text-text-medium">{t("Shared.pay.scanWallet")}</p>
              <a
                href={payUrl}
                className="hidden h-12 w-full items-center justify-center rounded-full bg-[#0f0f10] text-sm font-semibold text-white transition-colors hover:bg-black pointer-coarse:flex"
              >
                {t("Shared.pay.openWallet")}
              </a>
            </div>
          ) : statusPanel ? (
            <div className="mt-7 flex flex-col items-center gap-3 py-6 text-center">
              {statusPanel.icon}
              <p className="text-lg font-medium tracking-tight text-text-extra-high">
                {statusPanel.title}
              </p>
              <p className="max-w-xs text-sm text-text-medium">{statusPanel.body}</p>
            </div>
          ) : null}

          <div className="mt-8 space-y-3 border-t border-border-light pt-6 text-sm">
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

        <div className="flex items-center justify-center gap-1.5 border-t border-border-light bg-[rgba(28,28,29,0.015)] py-3.5">
          <a
            href="https://solana.com/docs/tools/solana-pay"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-text-low transition-colors hover:text-text-medium"
          >
            {t("Shared.pay.securedBySolanaPay")}
          </a>
        </div>
      </div>
    </main>
  );
}
