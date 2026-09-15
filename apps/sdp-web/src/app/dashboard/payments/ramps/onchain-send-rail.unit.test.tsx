// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import type { OnchainSendWizard } from "./hooks/use-onchain-send-wizard";
import { OnchainSendRail } from "./onchain-send-rail";
import type { RailProps } from "./ramp-action-page";

const mocks = vi.hoisted(() => ({ wizard: null as OnchainSendWizard | null }));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: false }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard/payments",
  useSearchParams: () => new URLSearchParams(),
}));
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
  stepIndex: 2,
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
  transferResult: null,
  heldApprovalRequestId: null,
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

  it("gives a held transfer one heading that says it waits for approval", () => {
    renderRail({ ...reviewWizard, heldApprovalRequestId: "apr_test", finished: true });

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Waiting for approval");
    expect(screen.getAllByText("Waiting for approval")).toHaveLength(1);
    expect(screen.queryByText("Review transfer")).toBeNull();
  });

  it("gives a sent transfer one heading that says it was submitted", () => {
    renderRail({
      ...reviewWizard,
      finished: true,
      transferResult: {
        id: "xfr_test",
        custodyWalletId: "cwlt_treasury",
        providerWalletId: "wallet_treasury",
        status: "confirmed",
        signature: "Signature111111111111111111111111111111111111",
        rampsMemo: {},
      },
    });

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Transfer submitted");
    expect(screen.getAllByText("Transfer submitted")).toHaveLength(1);
    expect(screen.queryByText("Review transfer")).toBeNull();
    expect(screen.queryByText("Your transfer was sent successfully.")).not.toBeNull();
  });
});
