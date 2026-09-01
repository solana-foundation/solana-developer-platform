import { Loader2Icon, ShieldCheckIcon, XCircleIcon } from "lucide-react";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import type { HercleOnboardingPanelStatus, OnboardingCopy } from "./index";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

export function getHercleOnboardingCopy(
  t: Translate
): Record<HercleOnboardingPanelStatus, OnboardingCopy> {
  return {
    customer_verification_required: {
      title: t("DashboardPayments.hercle.verificationRequiredTitle"),
      description: t("DashboardPayments.hercle.verificationRequiredDescription"),
      icon: ShieldCheckIcon,
      iconClassName: "text-primary",
    },
    customer_verifying: {
      title: t("DashboardPayments.hercle.verificationInReviewTitle"),
      description: t("DashboardPayments.hercle.verificationInReviewDescription"),
      icon: Loader2Icon,
      iconClassName: "animate-spin text-secondary",
    },
    customer_verification_failed: {
      title: t("DashboardPayments.hercle.verificationFailedTitle"),
      description: t("DashboardPayments.hercle.verificationFailedDescription"),
      icon: XCircleIcon,
      iconClassName: "text-error",
    },
    ready: {
      title: t("DashboardPayments.hercle.readyTitle"),
      description: t("DashboardPayments.hercle.readyDescription"),
      icon: Loader2Icon,
      iconClassName: "animate-spin text-secondary",
    },
  };
}
