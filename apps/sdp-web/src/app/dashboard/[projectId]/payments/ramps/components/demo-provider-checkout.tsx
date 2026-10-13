"use client";

import type { PaymentTransferSummary, RampDirection, RampProviderId } from "@sdp/types";
import Image from "next/image";
import { useTranslations } from "@/i18n/provider";
import { getRampProviderLabel, RAMP_PROVIDER_LOGOS } from "@/lib/ramps";

/**
 * Demo mode's stand-in for a provider's own checkout (MoonPay's and Coinbase's pages, Stripe's
 * and MoneyGram's widgets), which can't open on sample data. A deposit is paid with the footer's
 * Simulate deposit; a payout's crypto is sent with its Send button, as for a bank payout. Either
 * way the transfer then settles and the flow finishes on its own completion screen.
 */
export function DemoProviderCheckout({
  direction,
  provider,
  transfer,
}: {
  direction: RampDirection;
  provider: RampProviderId;
  transfer: PaymentTransferSummary | undefined;
}) {
  const t = useTranslations();
  const name = getRampProviderLabel(provider);
  const settling = transfer !== undefined && transfer.status !== "awaiting_payment";
  const body =
    direction === "offramp"
      ? t("DashboardPayments.demo.checkout.offrampBody", { provider: name })
      : settling
        ? t("DashboardPayments.demo.checkout.settling", { provider: name })
        : t("DashboardPayments.demo.checkout.onrampBody", { provider: name });

  return (
    <section className="space-y-4 rounded-card border border-border-subtle p-6">
      <div className="flex items-center gap-3">
        <Image
          src={RAMP_PROVIDER_LOGOS[provider]}
          alt=""
          width={32}
          height={32}
          className="size-8 shrink-0 rounded-control object-contain"
        />
        <h2 className="text-body font-medium text-primary">
          {t("DashboardPayments.demo.checkout.title", { provider: name })}
        </h2>
      </div>
      <p className="text-body text-secondary">{body}</p>
    </section>
  );
}
