import type { RampDirection } from "@sdp/types/ramp-requirements";
import { Loader2Icon } from "lucide-react";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import type {
  LightsparkOnboardingPanelStatus,
  OnboardingCopy,
  SimulateActionLabels,
} from "./index";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

export function getLightsparkOnboardingCopy(
  t: Translate
): Record<LightsparkOnboardingPanelStatus, OnboardingCopy> {
  return {
    ready: {
      title: t("DashboardPayments.lightspark.readyTitle"),
      description: t("DashboardPayments.lightspark.readyDescription"),
      icon: Loader2Icon,
      iconClassName: "animate-spin text-secondary",
    },
  };
}

export function getLightsparkProvisioningDetail(t: Translate): Record<RampDirection, string> {
  return {
    onramp: t("DashboardPayments.lightspark.onrampProvisioningDetail"),
    offramp: t("DashboardPayments.lightspark.offrampProvisioningDetail"),
  };
}

export function getLightsparkSimulateLabels(t: Translate): SimulateActionLabels {
  return {
    idle: t("DashboardPayments.lightspark.simulateQuote"),
    busy: t("DashboardPayments.lightspark.simulating"),
    done: t("DashboardPayments.lightspark.quoteSimulated"),
  };
}
