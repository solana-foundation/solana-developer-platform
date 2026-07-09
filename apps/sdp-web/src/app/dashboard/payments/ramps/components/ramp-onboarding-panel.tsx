"use client";

import type { CounterpartyRequirements, RampDirection } from "@sdp/types/ramp-requirements";
import { Button } from "@/components/ui/button";
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
  const { provider, status } = onboarding;
  if (status === "collect" || status === "unsupported" || status === "onboarding_not_started") {
    throw new Error(`RampOnboardingPanel received non-onboarding status: ${status}`);
  }
  const copy = onboardingCopy(provider, status);
  const Icon = copy.icon;
  const hostedAction =
    status === "terms_of_service_required"
      ? { label: "Accept terms", url: onboarding.termsOfServiceUrl }
      : status === "customer_verification_required"
        ? { label: "Complete verification", url: onboarding.verificationUrl }
        : null;
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
      <Icon className={`size-10 ${copy.iconClassName}`} />
      <p className="text-lg font-medium text-text-extra-high">{copy.title}</p>
      <p className="max-w-md text-sm leading-relaxed text-text-low">{copy.description}</p>
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
        <div className="flex items-center gap-2 rounded-full bg-border-extra-light px-3 py-1.5">
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-text-medium" />
          <span className="text-xs text-text-low">{provisioningDetail(provider, direction)}</span>
        </div>
      ) : null}
      {status === "provisioning_failed" ? (
        <Button type="button" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
