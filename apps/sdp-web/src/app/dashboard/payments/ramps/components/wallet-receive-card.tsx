"use client";

import { CopyIcon } from "lucide-react";
import Image from "next/image";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";

export function WalletReceiveCard({ address }: { address: string }) {
  const t = useTranslations();
  const [qrCodeUrl, setQrCodeUrl] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!address) {
      setQrCodeUrl("");
      return;
    }

    void QRCode.toDataURL(address, {
      margin: 1,
      width: 240,
      color: { dark: "#1c1c1d", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) {
          setQrCodeUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQrCodeUrl("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [address]);

  if (!address) {
    return null;
  }

  return (
    <section className="rounded-2xl border border-border-default bg-fill-subtle p-6">
      <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
        <div className="flex size-[180px] items-center justify-center rounded-2xl bg-[white] p-4 ring-1 ring-border-subtle">
          {qrCodeUrl ? (
            <Image
              src={qrCodeUrl}
              alt={t("DashboardPayments.ramps.walletAddressQrCode")}
              width={148}
              height={148}
              unoptimized
              className="size-full"
            />
          ) : (
            <div className="size-full animate-pulse rounded-xl bg-fill-strong" />
          )}
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
