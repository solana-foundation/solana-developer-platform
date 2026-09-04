"use client";

import { useTranslations } from "@/i18n/provider";
import {
  isTrustedRampDestination,
  MOONPAY_HOSTED_APPROVED_HOSTS,
} from "@/lib/trusted-ramp-destinations";

const FRAME_ALLOW =
  "accelerometer; autoplay; camera; encrypted-media; fullscreen; geolocation; gyroscope; payment";

/**
 * Embeds the MoonPay widget for on-ramp deposits and off-ramp payouts. The
 * widget renders its whole KYC + payment flow inline.
 */
export function MoonpayRampFrame({ title, src }: { title: string; src: string }) {
  const t = useTranslations();

  // The frame gets camera/payment permissions, so only HTTPS MoonPay checkout
  // hosts may ever be embedded — anything else fails closed.
  if (!isTrustedRampDestination(src, MOONPAY_HOSTED_APPROVED_HOSTS)) {
    return (
      <div className="rounded-2xl border border-error-border bg-error-bg px-5 py-5 text-sm text-error">
        {t("DashboardPayments.ramps.untrustedProviderUrl")}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl">
      <iframe title={title} src={src} className="h-[640px] w-full border-0" allow={FRAME_ALLOW} />
    </div>
  );
}
