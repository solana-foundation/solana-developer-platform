import type { RampDirection } from "@sdp/types/ramp-requirements";
import { Loader2Icon, ShieldCheckIcon, XCircleIcon } from "lucide-react";
import type { OnboardingCopy, SimulateActionLabels, StandardOnboardingPanelStatus } from "./index";

export const BVNK_ONBOARDING_COPY = {
  customer_verification_required: {
    title: "Verify your identity",
    description:
      "BVNK partners with Sumsub to confirm your identity before activating your funding account. Hit “Complete Verification” to get started — this page refreshes automatically once you're approved, and your instructions will appear right here.",
    icon: ShieldCheckIcon,
    iconClassName: "text-primary",
  },
  customer_verifying: {
    title: "Verification in review",
    description:
      "Sumsub is reviewing your details — this usually takes just a few minutes. Feel free to come back later; your instructions will show up here as soon as you're approved.",
    icon: Loader2Icon,
    iconClassName: "animate-spin text-secondary",
  },
  customer_verification_failed: {
    title: "Identity verification was not approved",
    description:
      "BVNK couldn't verify your identity, so this funding account can't be activated. Contact support if you believe this is a mistake.",
    icon: XCircleIcon,
    iconClassName: "text-error",
  },
  funding_account_provisioning: {
    title: "Setting up your funding account",
    description:
      "Almost there — we're provisioning your virtual account now. Your instructions will appear here in a moment.",
    icon: Loader2Icon,
    iconClassName: "animate-spin text-secondary",
  },
  provisioning_failed: {
    title: "We couldn't finish setting up your account",
    description: "Something went wrong provisioning your funding account. Please try again.",
    icon: XCircleIcon,
    iconClassName: "text-error",
  },
  ready: {
    title: "Preparing your instructions",
    description: "Your funding account is ready — fetching your details now.",
    icon: Loader2Icon,
    iconClassName: "animate-spin text-secondary",
  },
} as const satisfies Record<StandardOnboardingPanelStatus, OnboardingCopy>;

export const BVNK_PROVISIONING_DETAIL = {
  onramp: "Provisioning a BVNK wallet and fiat→crypto payment rule for this quote.",
  offramp: "Provisioning a dedicated BVNK payout wallet for this currency.",
} as const satisfies Record<RampDirection, string>;

export const BVNK_SIMULATE_LABELS = {
  idle: "Simulate Deposit",
  busy: "Simulating...",
  done: "Deposit Simulated",
} as const satisfies SimulateActionLabels;
