import type { RampDirection } from "@sdp/types/ramp-requirements";
import { FileSignatureIcon, Loader2Icon, ShieldCheckIcon, XCircleIcon } from "lucide-react";
import type { MuralOnboardingPanelStatus, OnboardingCopy, SimulateActionLabels } from "./index";

export const MURAL_ONBOARDING_COPY = {
  terms_of_service_required: {
    title: "Accept Mural Pay terms",
    description:
      "Mural Pay requires the counterparty to accept hosted terms before identity verification can begin.",
    icon: FileSignatureIcon,
    iconClassName: "text-text-extra-high",
  },
  customer_verification_required: {
    title: "Verify your identity",
    description:
      "Mural Pay needs the counterparty to complete hosted verification before activating a funding account.",
    icon: ShieldCheckIcon,
    iconClassName: "text-text-extra-high",
  },
  customer_verifying: {
    title: "Verification in review",
    description:
      "Mural Pay is reviewing the counterparty. Funding instructions will appear once verification is approved.",
    icon: Loader2Icon,
    iconClassName: "animate-spin text-text-medium",
  },
  customer_verification_failed: {
    title: "Identity verification was not approved",
    description:
      "Mural Pay couldn't approve this counterparty, so a funding account can't be activated.",
    icon: XCircleIcon,
    iconClassName: "text-status-error-text",
  },
  funding_account_provisioning: {
    title: "Setting up your funding account",
    description:
      "Mural Pay is activating a funding account. Bank details will appear here when it is ready.",
    icon: Loader2Icon,
    iconClassName: "animate-spin text-text-medium",
  },
  ready: {
    title: "Preparing your instructions",
    description: "Your Mural Pay funding account is ready. Fetching the latest details now.",
    icon: Loader2Icon,
    iconClassName: "animate-spin text-text-medium",
  },
} as const satisfies Record<MuralOnboardingPanelStatus, OnboardingCopy>;

export const MURAL_PROVISIONING_DETAIL = {
  onramp: "Provisioning a Mural Pay funding account for this counterparty.",
  offramp: "Checking Mural Pay organization verification before withdrawal.",
} as const satisfies Record<RampDirection, string>;

export const MURAL_SIMULATE_LABELS = {
  idle: "Simulate Deposit",
  busy: "Simulating...",
  done: "Deposit Simulated",
} as const satisfies SimulateActionLabels;
