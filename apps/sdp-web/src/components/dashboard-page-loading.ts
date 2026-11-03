"use client";

import type { ComponentType } from "react";
import DashboardLoading from "@/app/dashboard/[projectId]/(home)/loading";
import AllowlistLoading from "@/app/dashboard/[projectId]/allowlist/loading";
import ApiKeyEditLoading from "@/app/dashboard/[projectId]/api-keys/[keyId]/edit/loading";
import { ApiKeysListSkeleton } from "@/app/dashboard/[projectId]/api-keys/api-key-page-skeletons";
import ApiKeyNewLoading from "@/app/dashboard/[projectId]/api-keys/new/loading";
import { HeliusRingsSkeleton } from "@/app/dashboard/[projectId]/helius-rings/helius-rings-skeleton";
import {
  IntegrationDetailSkeleton,
  IntegrationsFlagsSkeleton,
} from "@/app/dashboard/[projectId]/integrations/integrations-skeleton";
import { PrivateChannelsSetupSkeleton } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-route-skeletons";
import {
  CurrentIssuanceCreateSkeleton,
  CurrentIssuanceDetailSkeleton,
  CurrentIssuancePageSkeleton,
} from "@/app/dashboard/[projectId]/issuance/issuance-route-skeletons";
import {
  DvpCreateSkeleton,
  DvpTradeDetailSkeleton,
  DvpTradesSkeleton,
  EarnIntegrationGuideSkeleton,
  EmbeddedYieldPortfolioSkeleton,
  MarketsLandingFlagsSkeleton,
  TreasurySolutionsSkeleton,
} from "@/app/dashboard/[projectId]/markets/markets-route-skeletons";
import { SettingsPageSkeleton } from "@/app/dashboard/[projectId]/operations-card-page-skeletons";
import CounterpartyDirectoryLoading from "@/app/dashboard/[projectId]/payments/counterparty/loading";
import { PaymentsPageSkeleton } from "@/app/dashboard/[projectId]/payments/payments-page-skeleton";
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
} from "@/app/dashboard/[projectId]/payments/payments-route-skeletons";
import PaymentRequestsLoading from "@/app/dashboard/[projectId]/payments/requests/loading";
import TokenHoldingsLoading from "@/app/dashboard/[projectId]/tokens/loading";
import {
  WalletConnectionsListSkeleton,
  WalletDetailSkeleton,
  WalletSetupSkeleton,
  WalletsOverviewSkeleton,
} from "@/app/dashboard/[projectId]/wallets/wallet-route-skeletons";
import type { DashboardFlags } from "@/flags/dashboard";
import type { DashboardLoadingRoute } from "@/lib/dashboard-navigation-loading";

interface PageLoadingProps {
  assetProfilesEnabled?: boolean;
  /** The shell's flag snapshot, for skeletons that draw only what the page will render. */
  flags?: DashboardFlags;
}

export function resolvePageLoadingComponent(
  route: DashboardLoadingRoute
): ComponentType<PageLoadingProps> {
  return resolveCurrentPageLoadingComponent(route);
}

function resolveCurrentPageLoadingComponent(
  route: DashboardLoadingRoute
): ComponentType<PageLoadingProps> {
  switch (route) {
    case "home":
      return DashboardLoading;
    case "integrations":
      return IntegrationsFlagsSkeleton;
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
    case "issuance-overview":
      return CurrentIssuancePageSkeleton;
    case "issuance-create":
      return CurrentIssuanceCreateSkeleton;
    case "issuance-detail":
      return CurrentIssuanceDetailSkeleton;
    case "payments-overview":
      return PaymentsPageSkeleton;
    case "markets-landing":
      return MarketsLandingFlagsSkeleton;
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
    case "settings":
      return SettingsPageSkeleton;
    case "helius-rings":
      return HeliusRingsSkeleton;
    case "allowlist":
      return AllowlistLoading;
  }
}
