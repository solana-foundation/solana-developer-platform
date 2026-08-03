"use client";

import type { PaymentWalletPolicy, WalletOperationFamily } from "@sdp/types";
import type { ReactNode } from "react";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import type {
  AuthoringDefaultAction,
  AuthoringRuleAction,
  PolicyAuthoringState,
  PolicyFlowStep,
  RestrictionCategory,
} from "./wallet-policy-authoring";

export interface WalletAssetOption {
  token: string;
  mint: string;
  uiAmount: string;
}

export interface PolicyFlowWallet {
  walletId: string;
  publicKey: string;
  label: string | null;
  provider: string | null;
}

export const FLOW_STEPS = [
  "intent",
  "limits-assets",
  "destinations-operations",
  "review",
] as const satisfies readonly PolicyFlowStep[];

export const CATEGORY_OPTIONS = [
  {
    id: "limits",
    titleKey: "DashboardCustody.policyTransferLimits",
    descriptionKey: "DashboardCustody.policyCategoryLimitsDescription",
  },
  {
    id: "assets",
    titleKey: "DashboardCustody.policyAllowedAssets",
    descriptionKey: "DashboardCustody.policyAllowedAssetsDescription",
  },
  {
    id: "destinations",
    titleKey: "DashboardCustody.policyDestinationControls",
    descriptionKey: "DashboardCustody.policyDestinationControlsDescription",
  },
  {
    id: "operations",
    titleKey: "DashboardCustody.policyOperationControls",
    descriptionKey: "DashboardCustody.policyOperationControlsDescription",
  },
] as const satisfies readonly {
  id: RestrictionCategory;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
}[];

export const STEP_COPY = {
  intent: {
    titleKey: "DashboardCustody.policyAuthoringIntentTitle",
    descriptionKey: "DashboardCustody.policyAuthoringIntentDescription",
  },
  "limits-assets": {
    titleKey: "DashboardCustody.policyAuthoringLimitsTitle",
    descriptionKey: "DashboardCustody.policyAuthoringLimitsDescription",
  },
  "destinations-operations": {
    titleKey: "DashboardCustody.policyAuthoringDestinationsTitle",
    descriptionKey: "DashboardCustody.policyAuthoringDestinationsDescription",
  },
  review: {
    titleKey: "DashboardCustody.policyAuthoringReviewTitle",
    descriptionKey: "DashboardCustody.policyAuthoringReviewDescription",
  },
} as const;

export const DEFAULT_ACTION_LABEL_KEYS = {
  allow: "DashboardCustody.policyDefaultAllow",
  approval_required: "DashboardCustody.policyDefaultApproval",
  deny: "DashboardCustody.policyDefaultDeny",
} as const satisfies Record<AuthoringDefaultAction, MessageKey>;

export const RULE_ACTION_LABEL_KEYS = {
  allow: "DashboardCustody.policyActionAllow",
  deny: "DashboardCustody.policyActionDeny",
  approval_required: "DashboardCustody.policyActionApproval",
} as const satisfies Record<AuthoringRuleAction, MessageKey>;

export const FAMILY_LABEL_KEYS = {
  transfer: "DashboardCustody.policyTransfers",
  payment: "DashboardCustody.policyPayments",
  ramp: "DashboardCustody.policyRamps",
  issuance: "DashboardCustody.policyIssuance",
  raw_sign: "DashboardCustody.policyRawSigning",
  program: "DashboardCustody.policyProgramOperations",
  provider_admin: "DashboardCustody.policyProviderAdministration",
} as const satisfies Record<WalletOperationFamily, MessageKey>;

export const FAMILY_DESCRIPTION_KEYS = {
  transfer: "DashboardCustody.policyTransfersDescription",
  payment: "DashboardCustody.policyPaymentsDescription",
  ramp: "DashboardCustody.policyRampsDescription",
  issuance: "DashboardCustody.policyIssuanceDescription",
  raw_sign: "DashboardCustody.policyRawSigningDescription",
  program: "DashboardCustody.policyProgramOperationsDescription",
  provider_admin: "DashboardCustody.policyProviderAdministrationDescription",
} as const satisfies Record<WalletOperationFamily, MessageKey>;

export function toggleValue<TValue extends string>(values: TValue[], value: TValue): TValue[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function walletDetailHref(pathname: string, walletId: string): string {
  const section = pathname.startsWith("/dashboard/custody/") ? "custody" : "wallets";
  return `/dashboard/${section}/${encodeURIComponent(walletId)}`;
}

export function operationControlCount(state: PolicyAuthoringState): number {
  return (
    Object.values(state.familyActions).filter(Boolean).length + state.operationTypeRules.length
  );
}

export function hasActiveRestrictions(policy: PaymentWalletPolicy): boolean {
  return Boolean(
    policy.destinationAllowlist.length ||
      policy.maxTransferAmount ||
      policy.maxDailyAmount ||
      policy.rules?.length
  );
}

export function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="h-32 animate-pulse rounded-lg bg-surface-sunken" />
      <div className="h-48 animate-pulse rounded-lg bg-surface-sunken" />
    </div>
  );
}

export function FormSection({
  title,
  description,
  trailing,
  children,
}: {
  title: string;
  description?: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border-default bg-surface-raised p-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold text-primary">{title}</h2>
        {trailing}
      </div>
      {description ? <p className="mt-1 text-sm leading-5 text-secondary">{description}</p> : null}
      <div className="mt-5">{children}</div>
    </section>
  );
}

export function EmptyStepState() {
  const t = useTranslations();
  return (
    <div className="rounded-lg bg-surface-sunken px-5 py-8 text-center text-sm text-secondary">
      {t("DashboardCustody.policyNoStepControls")}
    </div>
  );
}
