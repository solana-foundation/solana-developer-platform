"use client";

import type { ComponentType } from "react";
import { PreviousDashboardLoading as LegacyDashboardLoading } from "@/app/dashboard/[projectId]/(home)/loading";
import { CurrentDashboardLoading } from "@/app/dashboard/[projectId]/(home)/loading.redesign";
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
import { IssuanceCreateSkeleton as LegacyIssuanceCreateSkeleton } from "@/app/dashboard/[projectId]/issuance/issuance-create-skeleton";
import { IssuanceDetailSkeleton as LegacyIssuanceDetailSkeleton } from "@/app/dashboard/[projectId]/issuance/issuance-detail-skeleton";
import { IssuancePageSkeleton as LegacyIssuancePageSkeleton } from "@/app/dashboard/[projectId]/issuance/issuance-page-skeleton";
import {
  CurrentIssuanceCreateSkeleton,
  CurrentIssuanceDetailSkeleton,
  CurrentIssuancePageSkeleton,
} from "@/app/dashboard/[projectId]/issuance/issuance-route-skeletons.redesign";
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
import CounterpartyDirectoryLoading, {
  PreviousCounterpartyLoading as LegacyCounterpartyDirectoryLoading,
} from "@/app/dashboard/[projectId]/payments/counterparty/loading";
import { PaymentsPageSkeleton as LegacyPaymentsPageSkeleton } from "@/app/dashboard/[projectId]/payments/payments-page-skeleton";
import { PaymentsPageSkeleton } from "@/app/dashboard/[projectId]/payments/payments-page-skeleton.redesign";
import {
  CounterpartyCreateSkeleton,
  CounterpartyCreateSkeleton as LegacyCounterpartyCreateSkeleton,
  CounterpartyDetailSkeleton as LegacyCounterpartyDetailSkeleton,
  PaymentsDepositPageSkeleton as LegacyPaymentsDepositPageSkeleton,
  PaymentsPayPageSkeleton as LegacyPaymentsPayPageSkeleton,
  PaymentsTransactionsPageSkeleton as LegacyPaymentsTransactionsPageSkeleton,
  RecurringPaymentCreateSkeleton as LegacyRecurringPaymentCreateSkeleton,
  RecurringPaymentDetailSkeleton as LegacyRecurringPaymentDetailSkeleton,
  RecurringPaymentsPageSkeleton as LegacyRecurringPaymentsPageSkeleton,
} from "@/app/dashboard/[projectId]/payments/payments-route-skeletons";
import {
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
} from "@/app/dashboard/[projectId]/payments/payments-route-skeletons.redesign";
import PaymentRequestsLoading, {
  PreviousPaymentRequestsLoading as LegacyPaymentRequestsLoading,
} from "@/app/dashboard/[projectId]/payments/requests/loading";
import TokenHoldingsLoading from "@/app/dashboard/[projectId]/tokens/loading";
import { WalletConnectionsListSkeleton } from "@/app/dashboard/[projectId]/wallets/wallet-route-skeletons";
import {
  CurrentWalletDetailSkeleton,
  CurrentWalletSetupSkeleton,
  CurrentWalletsOverviewSkeleton,
  WalletDetailSkeleton as LegacyWalletDetailSkeleton,
  WalletSetupSkeleton as LegacyWalletSetupSkeleton,
  WalletsOverviewSkeleton as LegacyWalletsOverviewSkeleton,
} from "@/app/dashboard/[projectId]/wallets/wallet-route-skeletons.redesign";
import type { DashboardFlags } from "@/flags/dashboard";
import type { DashboardLoadingRoute } from "@/lib/dashboard-navigation-loading";

interface PageLoadingProps {
  assetProfilesEnabled?: boolean;
  /** The shell's flag snapshot, for skeletons that draw only what the page will render. */
  flags?: DashboardFlags;
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
  "issuance-overview": LegacyIssuancePageSkeleton,
  "issuance-create": LegacyIssuanceCreateSkeleton,
  "issuance-detail": LegacyIssuanceDetailSkeleton,
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
      return IntegrationsFlagsSkeleton;
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
