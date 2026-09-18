// @vitest-environment jsdom

import type { PaymentsDashboardWallet } from "@sdp/types";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import type { OnchainSendWizard } from "../hooks/use-onchain-send-wizard";
import { OnchainSendStepContent } from "./onchain-send-step-content";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: false }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard/payments",
  useSearchParams: () => new URLSearchParams(),
}));

const labeledWallet: PaymentsDashboardWallet = {
  id: "cwlt_treasury",
  walletId: "provider_treasury",
  isRuntimeExecutionAllowed: true,
  custodyConfigId: "cc_test",
  publicKey: "TreasuryPublicKey111111111111111111111111111",
  label: "Treasury",
};

const unlabeledWallet: PaymentsDashboardWallet = {
  id: "cwlt_unlabeled",
  walletId: "provider_unlabeled",
  isRuntimeExecutionAllowed: true,
  custodyConfigId: "cc_test",
  publicKey: "UnlabeledPublicKey1111111111111111111111111",
  label: null,
};

const setAddAccountOpen = vi.fn();

const baseWizard = {
  summaryDetails: [],
  stepIndex: 0,
  currentStepId: "DESTINATION",
  isLastStep: false,
  canProceed: false,
  readySubmission: null,
  liveWallets: [],
  walletsLoading: false,
  liveWalletsError: null,
  sourceWalletHint: null,
  cryptoAccounts: [],
  accountsLoading: false,
  counterpartyId: "cpty_test",
  selectedWallet: null,
  selectedAccount: null,
  destinationAddress: null,
  assetOptions: [],
  selectedAsset: null,
  selectedAssetBalance: null,
  availableAmount: null,
  exceedsBalance: false,
  fields: { accountId: "", walletId: "", asset: "", amount: "", memo: "" },
  setField: vi.fn(),
  selectWallet: vi.fn(),
  addAccountOpen: false,
  setAddAccountOpen,
  handleAccountAdded: vi.fn(),
  submitting: false,
  transferResult: null,
  heldApprovalRequestId: null,
  finished: false,
  handlePrimary: vi.fn(async () => undefined),
  handleSecondary: vi.fn(),
} satisfies OnchainSendWizard;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DashboardWorkspaceProvider
        scopeRefreshFallback={null}
        dashboardAccess={resolveDashboardAccess("org:admin")}
        flags={{
          assetProfiles: false,
          custody: true,
          dvp: false,
          earn: false,
          heliusRings: false,
          issuance: false,
          markets: false,
          payments: true,
          policies: false,
          privateChannels: false,
        }}
        serverDashboardCacheScope={{ orgId: "org_test", userId: "user_test" }}
        projects={[]}
        initialSelectedProjectId={null}
        shouldRepairInitialProjectCookie={false}
      >
        {children}
      </DashboardWorkspaceProvider>
    </I18nProvider>
  );
}

function renderStep(wizard: OnchainSendWizard, counterpartyName = "Ada Trading") {
  return render(<OnchainSendStepContent wizard={wizard} counterpartyName={counterpartyName} />, {
    wrapper,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OnchainSendStepContent", () => {
  it("shows the empty destination selector and opens the add-address dialog", async () => {
    const user = userEvent.setup();
    renderStep(baseWizard);

    expect(screen.getByRole("button", { name: "Destination account" })).toHaveProperty(
      "disabled",
      true
    );
    expect(screen.getByRole("button", { name: /Add Solana address/ }).textContent).toContain(
      "Ada Trading has no Solana address on file yet."
    );

    await user.click(screen.getByRole("button", { name: /Add Solana address/ }));

    expect(setAddAccountOpen).toHaveBeenCalledWith(true);
  });

  it("shows all detail controls and the available balance", () => {
    renderStep({
      ...baseWizard,
      currentStepId: "DETAILS",
      liveWallets: [labeledWallet],
      assetOptions: [{ value: "mint_usdc", label: "USDC" }],
      selectedAsset: { value: "mint_usdc", label: "USDC" },
      availableAmount: "25.5",
      fields: {
        accountId: "account_test",
        walletId: labeledWallet.id,
        asset: "mint_usdc",
        amount: "2",
        memo: "Invoice 7",
      },
    });

    expect(screen.getByRole("button", { name: "Source wallet" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("spinbutton", { name: "Amount" })).toHaveProperty("value", "2");
    expect(screen.getByRole("button", { name: "Asset" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("textbox", { name: "Memo (optional)" })).toHaveProperty(
      "value",
      "Invoice 7"
    );
    expect(screen.queryByText("25.5 USDC")).not.toBeNull();
  });

  it("hides balance and disables assets until a wallet is selected", () => {
    renderStep({ ...baseWizard, currentStepId: "DETAILS" });

    expect(screen.getByRole("button", { name: "Asset" })).toHaveProperty("disabled", true);
    expect(screen.queryByText(/USDC/)).toBeNull();
    expect(screen.queryByText("This wallet has no assets available to send.")).toBeNull();
  });

  it("shows the no-assets hint for a selected wallet", () => {
    renderStep({
      ...baseWizard,
      currentStepId: "DETAILS",
      liveWallets: [labeledWallet],
      selectedWallet: labeledWallet,
      fields: { ...baseWizard.fields, walletId: labeledWallet.id },
    });

    expect(screen.getByRole("button", { name: "Asset" })).toHaveProperty("disabled", true);
    expect(screen.queryByText("This wallet has no assets available to send.")).not.toBeNull();
  });

  it("shows empty review fallbacks and omits a blank memo", () => {
    renderStep({ ...baseWizard, currentStepId: "REVIEW" }, "");

    expect(screen.queryByText(/^0$/)).not.toBeNull();
    expect(screen.getAllByText("—")).toHaveLength(3);
    expect(screen.queryByText("Memo")).toBeNull();
  });

  it.each([
    { name: "label", wallet: labeledWallet, expected: "Treasury" },
    { name: "provider wallet id", wallet: unlabeledWallet, expected: "provider_unlabeled" },
  ])("shows the source wallet $name and a non-empty memo", ({ wallet, expected }) => {
    renderStep({
      ...baseWizard,
      currentStepId: "REVIEW",
      selectedWallet: wallet,
      destinationAddress: "Destination111111111111111111111111111111111",
      selectedAsset: { value: "mint_usdc", label: "USDC" },
      fields: {
        accountId: "account_test",
        walletId: wallet.id,
        asset: "mint_usdc",
        amount: "3.25",
        memo: "  Invoice 7  ",
      },
    });

    expect(screen.queryByText("3.25 USDC")).not.toBeNull();
    expect(screen.queryByText(expected)).not.toBeNull();
    expect(screen.queryByText("Invoice 7")).not.toBeNull();
  });

  it.each([
    {
      name: "signature",
      signature: "Signature111111111111111111111111111111111111",
      expectedCopy: "Your transfer was sent successfully.",
      explorerVisible: true,
    },
    {
      name: "no signature",
      signature: null,
      expectedCopy: "Status: processing",
      explorerVisible: false,
    },
  ])(
    "shows submitted transfer behavior with $name",
    ({ signature, expectedCopy, explorerVisible }) => {
      renderStep({
        ...baseWizard,
        currentStepId: "REVIEW",
        transferResult: {
          id: "xfr_test",
          custodyWalletId: labeledWallet.id,
          providerWalletId: labeledWallet.walletId,
          status: "processing",
          signature,
          rampsMemo: {},
        },
      });

      // The outcome heading belongs to the frame; the body never repeats it.
      expect(screen.queryByText("Transfer submitted")).toBeNull();
      expect(screen.queryByText(expectedCopy)).not.toBeNull();
      expect(screen.queryByRole("button", { name: "View on explorer" }) !== null).toBe(
        explorerVisible
      );
    }
  );

  it("explains a held payment and links the request, with no explorer", () => {
    renderStep({
      ...baseWizard,
      currentStepId: "REVIEW",
      heldApprovalRequestId: "apr_test",
      finished: true,
    });

    expect(screen.queryByText(/Nothing has moved yet/)).not.toBeNull();
    expect(screen.queryByText("Waiting for approval")).toBeNull();
    expect(screen.queryByText("Transfer submitted")).toBeNull();
    expect(screen.queryByRole("button", { name: "View on explorer" })).toBeNull();
    expect(screen.getByRole("link", { name: "View approval request" }).getAttribute("href")).toBe(
      "/dashboard/approvals/apr_test"
    );
  });
});
