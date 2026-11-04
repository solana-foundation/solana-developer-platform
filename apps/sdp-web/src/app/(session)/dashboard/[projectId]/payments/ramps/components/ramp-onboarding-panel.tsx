"use client";

import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { Loader2Icon, type LucideIcon, ShieldCheckIcon, XCircleIcon } from "lucide-react";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

export interface OnboardingPanelCopy {
  title: string;
  description: string;
  icon: LucideIcon;
  iconClassName: string;
}

/**
 * What the onboarding panel shows for an answer that waits on the provider's own onboarding.
 * It is null for an answer the wizard handles: `ready` quotes, `collect` asks for fields, `unsupported` blocks.
 *
 * @param requirements - The live requirements answer.
 * @param t - Translation function for the active locale.
 * @returns The panel copy, or null.
 */
export function onboardingPanelCopy(
  requirements: CounterpartyRequirements,
  t: Translate
): OnboardingPanelCopy | null {
  switch (requirements.status) {
    case "ready":
    case "collect":
    case "unsupported":
      return null;
    case "customer_verification_required":
      return {
        title: t("DashboardPayments.hercle.verificationRequiredTitle"),
        description: t("DashboardPayments.hercle.verificationRequiredDescription"),
        icon: ShieldCheckIcon,
        iconClassName: "text-primary",
      };
    case "customer_verifying":
      return {
        title: t("DashboardPayments.hercle.verificationInReviewTitle"),
        description: t("DashboardPayments.hercle.verificationInReviewDescription"),
        icon: Loader2Icon,
        iconClassName: "animate-spin text-secondary",
      };
    case "customer_verification_failed":
      return {
        title: t("DashboardPayments.hercle.verificationFailedTitle"),
        description: t("DashboardPayments.hercle.verificationFailedDescription"),
        icon: XCircleIcon,
        iconClassName: "text-error",
      };
    default: {
      const exhaustive: never = requirements;
      throw new Error(`Unhandled requirements status: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Where the provider's onboarding of the business stands, in place of the quote it holds back.
 * The footer's primary action opens the provider's hosted verification while it waits for one.
 */
export function RampOnboardingPanel({ copy }: { copy: OnboardingPanelCopy }) {
  const Icon = copy.icon;
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
      <Icon className={`size-10 ${copy.iconClassName}`} aria-hidden="true" />
      <p className="text-lg font-medium text-primary">{copy.title}</p>
      <p className="max-w-md text-sm leading-relaxed text-tertiary">{copy.description}</p>
    </div>
  );
}
