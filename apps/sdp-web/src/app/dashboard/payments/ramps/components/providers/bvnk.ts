import { Loader2Icon } from "lucide-react";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import type { BvnkOnboardingPanelStatus, OnboardingCopy, SimulateActionLabels } from "./index";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

export function getBvnkOnboardingCopy(
  t: Translate
): Record<BvnkOnboardingPanelStatus, OnboardingCopy> {
  return {
    provisioning: {
      title: t("DashboardPayments.bvnk.provisioningTitle"),
      description: t("DashboardPayments.bvnk.provisioningDescription"),
      icon: Loader2Icon,
      iconClassName: "animate-spin text-secondary",
    },
    ready: {
      title: t("DashboardPayments.bvnk.readyTitle"),
      description: t("DashboardPayments.bvnk.readyDescription"),
      icon: Loader2Icon,
      iconClassName: "animate-spin text-secondary",
    },
  };
}

export function getBvnkSimulateLabels(t: Translate): SimulateActionLabels {
  return {
    idle: t("DashboardPayments.bvnk.simulateDeposit"),
    busy: t("DashboardPayments.bvnk.simulating"),
    done: t("DashboardPayments.bvnk.depositSimulated"),
  };
}
