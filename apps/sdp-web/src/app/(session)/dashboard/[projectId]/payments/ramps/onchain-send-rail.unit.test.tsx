// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { stubClerkSession } from "@/test/clerk";
import type { OnchainSendWizard } from "./hooks/use-onchain-send-wizard";
import { OnchainSendRail } from "./onchain-send-rail";
import type { RailProps } from "./ramp-action-page";

const mocks = vi.hoisted(() => ({ wizard: null as OnchainSendWizard | null }));

beforeEach(() => {
  stubClerkSession();
});
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("./hooks/use-onchain-send-wizard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hooks/use-onchain-send-wizard")>()),
  useOnchainSendWizard: () => {
    if (mocks.wizard === null) {
      throw new Error("Set mocks.wizard before rendering the rail.");
    }
    return mocks.wizard;
  },
}));

const reviewWizard = {
  summaryDetails: [],
  stepIndex: 1,
  currentStepId: "REVIEW",
  isLastStep: true,
  canProceed: true,
  readySubmission: null,
  liveWallets: [],
  walletsLoading: false,
  liveWalletsError: null,
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
  setAddAccountOpen: vi.fn(),
  handleAccountAdded: vi.fn(),
  submitting: false,
  sourceWalletHint: null,
  transferResult: null,
  finished: false,
  handlePrimary: vi.fn(async () => undefined),
  handleSecondary: vi.fn(),
} satisfies OnchainSendWizard;

const railProps: RailProps = {
  wallets: [],
  walletsError: null,
  issuedTokenSymbolsByMint: {},
  enabledRampProviders: [],
  rampProviderAccess: null,
  counterpartiesResult: { ok: true, data: [] },
  selectedCounterparty: null,
  counterpartyId: "cpty_test",
  counterpartyName: "Ada Trading",
  methodLabel: "Solana address",
  preSteps: [],
  onExit: vi.fn(),
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DashboardWorkspaceProvider
        scopeRefreshFallback={null}
        dashboardAccess={resolveDashboardAccess("admin")}
        flags={{
          assetProfiles: false,
          compliance: false,
          custody: true,
          dvp: false,
          earn: false,
          heliusRings: false,
          issuance: false,
          markets: false,
          payments: true,
          privateChannels: false,
          releaseChannel: "experimental",
          ramps: true,
        }}
        serverDashboardCacheScope={{ orgId: "org_test", userId: "user_test" }}
        projects={[]}
      >
        {children}
      </DashboardWorkspaceProvider>
    </I18nProvider>
  );
}

function renderRail(wizard: OnchainSendWizard) {
  mocks.wizard = wizard;
  return render(<OnchainSendRail {...railProps} />, { wrapper });
}

afterEach(() => {
  cleanup();
  mocks.wizard = null;
});

describe("OnchainSendRail heading", () => {
  it("titles the unsent review step as a review", () => {
    renderRail(reviewWizard);

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Review transfer");
  });

  const result = {
    id: "xfr_test",
    custodyWalletId: "cwlt_treasury",
    providerWalletId: "wallet_treasury",
    signature: "Signature111111111111111111111111111111111111",
    rampsMemo: {},
  };

  it("gives a confirmed transfer one heading that says it was sent", () => {
    renderRail({
      ...reviewWizard,
      finished: true,
      transferResult: { ...result, status: "confirmed" },
    });

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Transfer sent");
    expect(screen.getAllByText("Transfer sent")).toHaveLength(1);
    expect(screen.queryByText("Review transfer")).toBeNull();
    expect(screen.queryByText("Your transfer was sent successfully.")).not.toBeNull();
  });

  it("never heads a failed transfer as submitted, and says why it failed", () => {
    renderRail({
      ...reviewWizard,
      finished: true,
      transferResult: { ...result, status: "failed", signature: null, error: null },
    });

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Transfer failed");
    expect(screen.queryByText("Transfer submitted")).toBeNull();
    expect(
      screen.getByText("No reason came back. Check the transaction before sending again.")
    ).toBeTruthy();
  });

  it("heads a transfer that has a signature but no confirmation as submitted, not sent", () => {
    renderRail({
      ...reviewWizard,
      finished: true,
      transferResult: { ...result, status: "processing" },
    });

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Transfer submitted");
    expect(screen.queryByText("Your transfer was sent successfully.")).toBeNull();
  });
});

describe("OnchainSendRail while sending", () => {
  it("keeps the send label on a spinning button and says what it is waiting on", () => {
    renderRail({ ...reviewWizard, submitting: true });

    // The spinner joins the button's name, so match the label inside it.
    const send = screen.getByRole("button", { name: /Send transfer/ });
    expect(send.textContent).toBe("Send transfer");
    expect(send.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Sending and confirming on Solana…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
});
