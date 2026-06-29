import type { RampDirection } from "@sdp/types/ramp-requirements";
import { Loader2Icon, ShieldCheckIcon, XCircleIcon } from "lucide-react";
import type { OnboardingCopy, OnboardingPanelStatus, SimulateActionLabels } from "./index";

export const LIGHTSPARK_ONBOARDING_COPY = {
  customer_verification_required: {
    title: "Verify your identity",
    description:
      "We need to confirm your identity before activating your funding account. This page refreshes automatically once you're approved.",
    icon: ShieldCheckIcon,
    iconClassName: "text-text-extra-high",
  },
  customer_verifying: {
    title: "Verification in review",
    description:
      "Your details are under review — this usually takes just a few minutes. Your instructions will show up here as soon as you're approved.",
    icon: Loader2Icon,
    iconClassName: "animate-spin text-text-medium",
  },
  customer_verification_failed: {
    title: "Identity verification was not approved",
    description:
      "We couldn't verify your identity, so this funding account can't be activated. Contact support if you believe this is a mistake.",
    icon: XCircleIcon,
    iconClassName: "text-status-error-text",
  },
  funding_account_provisioning: {
    title: "Setting up your account",
    description:
      "Almost there — we're getting your funding account ready. Your instructions will appear here in a moment.",
    icon: Loader2Icon,
    iconClassName: "animate-spin text-text-medium",
  },
  provisioning_failed: {
    title: "We couldn't finish setting up your account",
    description: "Something went wrong getting your funding account ready. Please try again.",
    icon: XCircleIcon,
    iconClassName: "text-status-error-text",
  },
  ready: {
    title: "Preparing your instructions",
    description: "Your account is ready — fetching your details now.",
    icon: Loader2Icon,
    iconClassName: "animate-spin text-text-medium",
  },
} as const satisfies Record<OnboardingPanelStatus, OnboardingCopy>;

export const LIGHTSPARK_PROVISIONING_DETAIL = {
  onramp: "Provisioning your Lightspark customer and deposit details for this quote.",
  offramp: "Provisioning a just-in-time Lightspark payout account for this withdrawal.",
} as const satisfies Record<RampDirection, string>;

export const LIGHTSPARK_SIMULATE_LABELS = {
  idle: "Simulate Quote",
  busy: "Simulating...",
  done: "Quote Simulated",
} as const satisfies SimulateActionLabels;
