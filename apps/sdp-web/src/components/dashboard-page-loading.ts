"use client";

import type { ComponentType } from "react";
import LegacyDashboardLoading from "@/app/dashboard/_legacy/(home)/loading";
import { CurrentDashboardLoading } from "@/app/dashboard/(home)/loading";
import AllowlistLoading from "@/app/dashboard/allowlist/loading";
import ApiKeyEditLoading from "@/app/dashboard/api-keys/[keyId]/edit/loading";
import { ApiKeysListSkeleton } from "@/app/dashboard/api-keys/api-key-page-skeletons";
import ApiKeyNewLoading from "@/app/dashboard/api-keys/new/loading";
import {
  ApprovalDetailSkeleton,
  ApprovalInboxSkeleton,
} from "@/app/dashboard/approvals/approval-page-skeletons";
import { HeliusRingsSkeleton } from "@/app/dashboard/helius-rings/helius-rings-skeleton";
import {
  IntegrationDetailSkeleton,
  IntegrationsSkeleton,
} from "@/app/dashboard/integrations/integrations-skeleton";
import { PrivateChannelsSetupSkeleton } from "@/app/dashboard/integrations/private-channels/private-channels-route-skeletons";
import { IssuanceCreateSkeleton } from "@/app/dashboard/issuance/issuance-create-skeleton";
import { IssuanceDetailSkeleton } from "@/app/dashboard/issuance/issuance-detail-skeleton";
import { IssuancePageSkeleton } from "@/app/dashboard/issuance/issuance-page-skeleton";
import {
  DvpCreateSkeleton,
  DvpTradeDetailSkeleton,
  DvpTradesSkeleton,
  EarnIntegrationGuideSkeleton,
  EmbeddedYieldPortfolioSkeleton,
  MarketsLandingSkeleton,
  TreasurySolutionsSkeleton,
} from "@/app/dashboard/markets/markets-route-skeletons";
import { SettingsPageSkeleton } from "@/app/dashboard/operations-card-page-skeletons";
import LegacyCounterpartyDirectoryLoading from "@/app/dashboard/payments/_legacy/counterparty/loading";
import { PaymentsPageSkeleton as LegacyPaymentsPageSkeleton } from "@/app/dashboard/payments/_legacy/payments-page-skeleton";
import {
  CounterpartyCreateSkeleton as LegacyCounterpartyCreateSkeleton,
  CounterpartyDetailSkeleton as LegacyCounterpartyDetailSkeleton,
  PaymentsDepositPageSkeleton as LegacyPaymentsDepositPageSkeleton,
  PaymentsPayPageSkeleton as LegacyPaymentsPayPageSkeleton,
  PaymentsTransactionsPageSkeleton as LegacyPaymentsTransactionsPageSkeleton,
  RecurringPaymentCreateSkeleton as LegacyRecurringPaymentCreateSkeleton,
  RecurringPaymentDetailSkeleton as LegacyRecurringPaymentDetailSkeleton,
  RecurringPaymentsPageSkeleton as LegacyRecurringPaymentsPageSkeleton,
} from "@/app/dashboard/payments/_legacy/payments-route-skeletons";
import LegacyPaymentRequestsLoading from "@/app/dashboard/payments/_legacy/requests/loading";
import CounterpartyDirectoryLoading from "@/app/dashboard/payments/counterparty/loading";
import { PaymentsPageSkeleton } from "@/app/dashboard/payments/payments-page-skeleton";
import {
  CounterpartyCreateSkeleton,
  CounterpartyDetailSkeleton,
  PaymentRequestCreateSkeleton,
  PaymentRequestDetailSkeleton,
  PaymentsDepositPageSkeleton,
  PaymentsPayPageSkeleton,
  PaymentsTransactionsPageSkeleton,
  PaymentTransactionDetailSkeleton,
  RecurringPaymentCreateSkeleton,
  RecurringPaymentDetailSkeleton,
  RecurringPaymentsPageSkeleton,
} from "@/app/dashboard/payments/payments-route-skeletons";
import PaymentRequestsLoading from "@/app/dashboard/payments/requests/loading";
import { PoliciesOverviewSkeleton } from "@/app/dashboard/policies/policies-overview";
import TokenHoldingsLoading from "@/app/dashboard/tokens/loading";
import {
  WalletDetailSkeleton as LegacyWalletDetailSkeleton,
  WalletSetupSkeleton as LegacyWalletSetupSkeleton,
  WalletsOverviewSkeleton as LegacyWalletsOverviewSkeleton,
} from "@/app/dashboard/wallets/_legacy/wallet-route-skeletons";
import {
  CurrentWalletDetailSkeleton,
  CurrentWalletSetupSkeleton,
  CurrentWalletsOverviewSkeleton,
  WalletConnectionsListSkeleton,
  WalletPolicyAuditDetailSkeleton,
  WalletPolicyAuditListSkeleton,
  WalletPolicySkeleton,
} from "@/app/dashboard/wallets/wallet-route-skeletons";
import type { DashboardLoadingRoute } from "@/lib/dashboard-navigation-loading";

interface PageLoadingProps {
  assetProfilesEnabled?: boolean;
}

// The previous design's skeletons for the routes NEW DESIGN redesigns. Its own new routes (a
// transaction's or a request's page, the new-request page) send the previous design to their
// list, so they load as the list does.
const LEGACY_DESIGN_PAGE_LOADING: Partial<
  Record<DashboardLoadingRoute, ComponentType<PageLoadingProps>>
> = {
  "payments-overview": LegacyPaymentsPageSkeleton,
  "payments-transactions": LegacyPaymentsTransactionsPageSkeleton,
  "payment-transaction-detail": LegacyPaymentsTransactionsPageSkeleton,
  "payments-pay": LegacyPaymentsPayPageSkeleton,
  "payments-deposit": LegacyPaymentsDepositPageSkeleton,
  "payment-requests": LegacyPaymentRequestsLoading,
  "payment-request-create": LegacyPaymentRequestsLoading,
  "payment-request-detail": LegacyPaymentRequestsLoading,
  "counterparty-directory": LegacyCounterpartyDirectoryLoading,
  "counterparty-create": LegacyCounterpartyCreateSkeleton,
  "counterparty-detail": LegacyCounterpartyDetailSkeleton,
  "recurring-payments": LegacyRecurringPaymentsPageSkeleton,
  "recurring-payment-create": LegacyRecurringPaymentCreateSkeleton,
  "recurring-payment-detail": LegacyRecurringPaymentDetailSkeleton,
  home: LegacyDashboardLoading,
  "wallets-overview": LegacyWalletsOverviewSkeleton,
  "wallet-setup": LegacyWalletSetupSkeleton,
  "wallet-detail": LegacyWalletDetailSkeleton,
};

export function resolvePageLoadingComponent(
  route: DashboardLoadingRoute,
  newDesign = true
): ComponentType<PageLoadingProps> {
  const legacy = newDesign ? undefined : LEGACY_DESIGN_PAGE_LOADING[route];
  return legacy ?? resolveCurrentPageLoadingComponent(route);
}

function resolveCurrentPageLoadingComponent(
  route: DashboardLoadingRoute
): ComponentType<PageLoadingProps> {
  switch (route) {
    case "home":
      return CurrentDashboardLoading;
    case "integrations":
      return IntegrationsSkeleton;
    case "integration-detail":
      return IntegrationDetailSkeleton;
    case "private-channels-setup":
      return PrivateChannelsSetupSkeleton;
    case "token-holdings":
      return TokenHoldingsLoading;
    case "wallets-overview":
      return CurrentWalletsOverviewSkeleton;
    case "wallet-setup":
      return CurrentWalletSetupSkeleton;
    case "wallet-connections":
      return WalletConnectionsListSkeleton;
    case "wallet-detail":
      return CurrentWalletDetailSkeleton;
    case "wallet-policy":
      return WalletPolicySkeleton;
    case "wallet-policy-audit-list":
      return WalletPolicyAuditListSkeleton;
    case "wallet-policy-audit-detail":
      return WalletPolicyAuditDetailSkeleton;
    case "issuance-overview":
      return IssuancePageSkeleton;
    case "issuance-create":
      return IssuanceCreateSkeleton;
    case "issuance-detail":
      return IssuanceDetailSkeleton;
    case "payments-overview":
      return PaymentsPageSkeleton;
    case "markets-landing":
      return MarketsLandingSkeleton;
    case "treasury-solutions":
      return TreasurySolutionsSkeleton;
    case "embedded-yield-portfolio":
      return EmbeddedYieldPortfolioSkeleton;
    case "embedded-yield-configure":
      return EarnIntegrationGuideSkeleton;
    case "embedded-yield-integrate":
      return EarnIntegrationGuideSkeleton;
    case "dvp-trades":
      return DvpTradesSkeleton;
    case "dvp-trade-create":
      return DvpCreateSkeleton;
    case "dvp-trade-detail":
      return DvpTradeDetailSkeleton;
    case "payments-transactions":
      return PaymentsTransactionsPageSkeleton;
    case "payment-transaction-detail":
      return PaymentTransactionDetailSkeleton;
    case "payments-pay":
      return PaymentsPayPageSkeleton;
    case "payments-deposit":
      return PaymentsDepositPageSkeleton;
    case "payment-requests":
      return PaymentRequestsLoading;
    case "payment-request-create":
      return PaymentRequestCreateSkeleton;
    case "payment-request-detail":
      return PaymentRequestDetailSkeleton;
    case "counterparty-directory":
      return CounterpartyDirectoryLoading;
    case "counterparty-create":
      return CounterpartyCreateSkeleton;
    case "counterparty-detail":
      return CounterpartyDetailSkeleton;
    case "recurring-payments":
      return RecurringPaymentsPageSkeleton;
    case "recurring-payment-create":
      return RecurringPaymentCreateSkeleton;
    case "recurring-payment-detail":
      return RecurringPaymentDetailSkeleton;
    case "api-keys-list":
      return ApiKeysListSkeleton;
    case "api-key-new":
      return ApiKeyNewLoading;
    case "api-key-edit":
      return ApiKeyEditLoading;
    case "policies":
      return PoliciesOverviewSkeleton;
    case "approvals-list":
      return ApprovalInboxSkeleton;
    case "approval-detail":
      return ApprovalDetailSkeleton;
    case "settings":
      return SettingsPageSkeleton;
    case "helius-rings":
      return HeliusRingsSkeleton;
    case "allowlist":
      return AllowlistLoading;
  }
}
