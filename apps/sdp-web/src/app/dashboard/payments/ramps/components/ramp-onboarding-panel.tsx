"use client";

import type { CounterpartyRequirements, RampDirection } from "@sdp/types/ramp-requirements";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { onboardingCopy, provisioningDetail } from "./providers";

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
  const { provider, status } = onboarding;
  if (status === "collect" || status === "unsupported" || status === "onboarding_not_started") {
    throw new Error(`RampOnboardingPanel received non-onboarding status: ${status}`);
  }
  const copy = onboardingCopy(provider, status, t);
  const Icon = copy.icon;
  const hostedAction =
    status === "terms_of_service_required"
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
      {hostedAction ? (
        <Button
          type="button"
          variant="secondary"
          onClick={() => window.open(hostedAction.url, "_blank", "noopener")}
        >
          {hostedAction.label}
        </Button>
      ) : null}
      {status === "funding_account_provisioning" ? (
        <div className="flex items-center gap-2 rounded-full bg-fill-subtle px-3 py-1.5">
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-secondary" />
          <span className="text-xs text-tertiary">
            {provisioningDetail(provider, direction, t)}
          </span>
        </div>
      ) : null}
      {status === "provisioning_failed" ? (
        <Button type="button" variant="secondary" onClick={onRetry}>
          {t("DashboardPayments.ramps.tryAgain")}
        </Button>
      ) : null}
    </div>
  );
}
