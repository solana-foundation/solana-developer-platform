"use client";

import type { ComponentType } from "react";
import DashboardLoading from "@/app/dashboard/(home)/loading";
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
import CounterpartyDirectoryLoading from "@/app/dashboard/payments/counterparty/loading";
import { PaymentsPageSkeleton } from "@/app/dashboard/payments/payments-page-skeleton";
import {
  CounterpartyCreateSkeleton,
  CounterpartyDetailSkeleton,
  PaymentsDepositPageSkeleton,
  PaymentsPayPageSkeleton,
  PaymentsTransactionsPageSkeleton,
  RecurringPaymentCreateSkeleton,
  RecurringPaymentDetailSkeleton,
  RecurringPaymentsPageSkeleton,
} from "@/app/dashboard/payments/payments-route-skeletons";
import PaymentRequestsLoading from "@/app/dashboard/payments/requests/loading";
import { PoliciesOverviewSkeleton } from "@/app/dashboard/policies/policies-overview";
import TokenHoldingsLoading from "@/app/dashboard/tokens/loading";
import {
  WalletConnectionsListSkeleton,
  WalletDetailSkeleton,
  WalletPolicyAuditDetailSkeleton,
  WalletPolicyAuditListSkeleton,
  WalletPolicySkeleton,
  WalletSetupSkeleton,
  WalletsOverviewSkeleton,
} from "@/app/dashboard/wallets/wallet-route-skeletons";
import type { DashboardLoadingRoute } from "@/lib/dashboard-navigation-loading";

interface PageLoadingProps {
  assetProfilesEnabled?: boolean;
}

export function resolvePageLoadingComponent(
  route: DashboardLoadingRoute
): ComponentType<PageLoadingProps> {
  switch (route) {
    case "home":
      return DashboardLoading;
    case "integrations":
      return IntegrationsSkeleton;
    case "integration-detail":
      return IntegrationDetailSkeleton;
    case "private-channels-setup":
      return PrivateChannelsSetupSkeleton;
    case "token-holdings":
      return TokenHoldingsLoading;
    case "wallets-overview":
      return WalletsOverviewSkeleton;
    case "wallet-setup":
      return WalletSetupSkeleton;
    case "wallet-connections":
      return WalletConnectionsListSkeleton;
    case "wallet-detail":
      return WalletDetailSkeleton;
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
    case "payments-pay":
      return PaymentsPayPageSkeleton;
    case "payments-deposit":
      return PaymentsDepositPageSkeleton;
    case "payment-requests":
      return PaymentRequestsLoading;
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
