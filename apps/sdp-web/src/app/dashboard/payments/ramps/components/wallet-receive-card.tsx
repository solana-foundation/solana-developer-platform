"use client";

import { CopyIcon } from "lucide-react";
import Image from "next/image";
import QRCode from "qrcode";
import { toast } from "sonner";
import useSWR from "swr";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";

function QrCodeBox({
  qrCodeUrl,
  isLoading,
  alt,
}: {
  qrCodeUrl: string | null;
  isLoading: boolean;
  alt: string;
}) {
  if (qrCodeUrl !== null) {
    return (
      <Image src={qrCodeUrl} alt={alt} width={148} height={148} unoptimized className="size-full" />
    );
  }
  if (isLoading) {
    return <div className="size-full animate-pulse rounded-xl bg-fill-strong" />;
  }
  return null;
}

export function WalletReceiveCard({ address }: { address: string }) {
  const t = useTranslations();
  const {
    data: qrCodeUrl,
    error,
    isLoading,
  } = useSWR(
    paymentsQueryKeys.walletAddressQr(address),
    () =>
      QRCode.toDataURL(address, {
        margin: 1,
        width: 240,
        color: { dark: "#1c1c1d", light: "#ffffff" },
      }),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
    }
  );

  return (
    <section className="rounded-2xl border border-border-default bg-fill-subtle p-6">
      <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
        <div className="flex size-[180px] items-center justify-center rounded-2xl bg-[white] p-4 ring-1 ring-border-subtle">
          <QrCodeBox
            qrCodeUrl={error === undefined && qrCodeUrl !== undefined ? qrCodeUrl : null}
            isLoading={isLoading}
            alt={t("DashboardPayments.ramps.walletAddressQrCode")}
          />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <p className="text-sm text-tertiary">
            {t("DashboardPayments.ramps.walletReceiveDescription")}
          </p>
          <div className="rounded-2xl border border-border-subtle bg-surface-raised px-4 py-3">
            <p className="break-all font-mono text-xs text-secondary">{address}</p>
          </div>
          <div className="flex justify-end">
            <Button
              type="button"
              variant="secondary"
              iconLeft={<CopyIcon />}
              onClick={() => {
                void navigator.clipboard.writeText(address);
                toast.success(t("DashboardPayments.ramps.addressCopied"), {
                  position: "bottom-right",
                });
              }}
            >
              {t("DashboardPayments.ramps.copyAddress")}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
