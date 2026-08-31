// @vitest-environment jsdom

import type { PaymentRecurringPayment } from "@sdp/types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { RecurringPaymentDetailWorkspace } from "./recurring-payment-detail-workspace";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/lib/use-solana-cluster", () => ({
  useSolanaCluster: () => "devnet",
}));

const recurringPayment = {
  id: "prp_legacy",
  organizationId: "org_1",
  projectId: "proj_1",
  sourceCustodyWalletId: null,
  sourceProviderWalletId: "wallet_1",
  sourceAddress: "source_address",
  counterpartyId: "cpty_1",
  counterpartyAccountId: "cpa_1",
  destinationAddress: "destination_address",
  destinationTokenAccount: null,
  token: "USDC",
  amount: "10",
  periodHours: 24,
  firstCollectionAt: "2026-07-01T12:00:00.000Z",
  nextCollectionDueAt: "2026-07-02T12:00:00.000Z",
  planId: "plan_1",
  subscriptionId: "sub_1",
  planPda: "plan_pda",
  planCreatedAt: "2026-07-01T12:00:00.000Z",
  planCreationSignature: "plan_signature",
  subscriptionPda: "subscription_pda",
  subscriptionAuthorityAddress: "subscription_authority",
  authorizationSignature: "authorization_signature",
  status: "active",
  metadataUri: null,
  createdBy: null,
  createdAt: "2026-07-01T11:00:00.000Z",
  updatedAt: "2026-07-01T12:00:00.000Z",
} satisfies PaymentRecurringPayment;

describe("RecurringPaymentDetailWorkspace", () => {
  afterEach(cleanup);

  it("keeps legacy rows without an exact source wallet readable but not actionable", () => {
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <RecurringPaymentDetailWorkspace
          recurringPayment={recurringPayment}
          wallet={null}
          wallets={[]}
          issuedTokensByMint={{}}
          counterpartyAccounts={[]}
          counterpartyLabel="Legacy counterparty"
          amountLabel="10 USDC"
          collectionAttempts={[]}
          collectionAttemptsTotal={0}
        />
      </I18nProvider>
    );

    expect(screen.getByText("Source wallet unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actions" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });
});
