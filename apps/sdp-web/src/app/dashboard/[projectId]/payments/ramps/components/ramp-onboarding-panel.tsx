"use client";

import type { CounterpartyRequirements, RampDirection } from "@sdp/types/ramp-requirements";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { usePaymentsDemo } from "@/lib/payments-demo/payments-demo-context";
import { getRampProviderLabel } from "@/lib/ramps";
import { openExternalRampUrl } from "@/lib/trusted-ramp-destinations";
import { isOnboardingPanelStatus, onboardingCopy, provisioningDetail } from "./providers";

export function RampOnboardingPanel({
  direction,
  onboarding,
  onRetry,
}: {
  direction: RampDirection;
  onboarding: CounterpartyRequirements;
  onRetry: () => void;
}) {
  const t = useTranslations();
  const demo = usePaymentsDemo();
  if (!isOnboardingPanelStatus(onboarding)) {
    throw new Error(`RampOnboardingPanel received non-onboarding status: ${onboarding.status}`);
  }
  const { provider, status } = onboarding;
  const copy = onboardingCopy(onboarding, t);
  const Icon = copy.icon;
  // The provider's own verification page can't open on sample data; the footer's Simulate
  // verification stands in for it.
  const demoVerification =
    demo && provider === "bvnk" && status === "customer_verification_required";
  const hostedAction = demoVerification
    ? null
    : status === "terms_of_service_required"
      ? { label: t("DashboardPayments.ramps.acceptTerms"), url: onboarding.termsOfServiceUrl }
      : status === "customer_verification_required"
        ? {
            label: t("DashboardPayments.ramps.completeVerification"),
            url: onboarding.verificationUrl,
          }
        : null;
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
      <Icon className={`size-10 ${copy.iconClassName}`} />
      <p className="text-lg font-medium text-primary">{copy.title}</p>
      <p className="max-w-md text-sm leading-relaxed text-tertiary">{copy.description}</p>
      {demoVerification ? (
        <p className="max-w-md text-sm leading-relaxed text-secondary">
          {t("DashboardPayments.demo.verification.body", {
            provider: getRampProviderLabel(provider),
          })}
        </p>
      ) : null}
      {hostedAction ? (
        <Button
          type="button"
          variant="secondary"
          onClick={() => openExternalRampUrl(hostedAction.url)}
        >
          {hostedAction.label}
        </Button>
      ) : null}
      {(status === "customer_funding_account_provisioning" ||
        status === "funding_account_provisioning") && (
        <div className="flex items-center gap-2 rounded-full bg-fill-subtle px-3 py-1.5">
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-secondary" />
          <span className="text-xs text-tertiary">
            {provisioningDetail(provider, direction, t)}
          </span>
        </div>
      )}
      {status === "customer_funding_account_provisioning_failed" ? (
        <Button type="button" variant="secondary" onClick={onRetry}>
          {t("DashboardPayments.ramps.tryAgain")}
        </Button>
      ) : null}
    </div>
  );
}
