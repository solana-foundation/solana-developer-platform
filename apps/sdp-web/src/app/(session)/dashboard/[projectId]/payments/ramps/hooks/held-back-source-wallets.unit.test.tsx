// @vitest-environment jsdom

/**
 * Which wallets the Payments source pickers offer (PRO-2435 D1): a Fireblocks
 * wallet the customer connected may only send direct payments, so the batch
 * and off-ramp sources leave it out and say why when nothing else is left,
 * while the on-ramp destination keeps it.
 */

import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { stubClerkSession } from "@/test/clerk";
import { useBatchSendWizard } from "./use-batch-send-wizard";
import { useOfframpWizard } from "./use-offramp-wizard";
import { useOnrampWizard } from "./use-onramp-wizard";
import type { UseRampWizardProps } from "./use-ramp-wizard";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
beforeEach(() => {
  stubClerkSession({ orgId: "org-test", userId: "user-test" });
});

const MINT = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;
const HELD_BACK =
  "Fireblocks wallets your organization connected send direct payments only. Choose a wallet on another custody provider.";

const fireblocksByok: PaymentsDashboardWallet = {
  id: "cwlt_fireblocks_byok",
  walletId: "vault_1",
  publicKey: "FbByok1111111111111111111111111111111111111",
  label: "Fireblocks vault",
  provider: "fireblocks",
  custodyConnectionId: "cconn_fireblocks",
  isRuntimeExecutionAllowed: true,
  balances: [{ token: "USDC", mint: MINT, amount: "50000000", uiAmount: "50", decimals: 6 }],
};
const fireblocksManaged: PaymentsDashboardWallet = {
  ...fireblocksByok,
  id: "cwlt_fireblocks_managed",
  label: "Managed vault",
  custodyConnectionId: undefined,
  custodyConfigId: "cc_fireblocks",
};
const privyByok: PaymentsDashboardWallet = {
  ...fireblocksByok,
  id: "cwlt_privy",
  label: "Privy wallet",
  provider: "privy",
  custodyConnectionId: "cconn_privy",
};
const mixed = [fireblocksByok, fireblocksManaged, privyByok];

let inventory: PaymentsDashboardWallet[] = mixed;
const fetchMock = vi.fn<typeof fetch>();

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
          sandboxOnBeta: false,
        }}
        serverDashboardCacheScope={{ orgId: "org-test", userId: "user-test" }}
        projects={[]}
      >
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
      </DashboardWorkspaceProvider>
    </I18nProvider>
  );
}

function rampProps(wallets: PaymentsDashboardWallet[]): UseRampWizardProps {
  return {
    wallets,
    walletsError: null,
    enabledRampProviders: ["moonpay"],
    rampProviderAccess: null,
    counterpartiesResult: { ok: true, data: [] },
    selectedCounterparty: null,
    initialCounterpartyId: "counterparty-test",
    onExit: vi.fn(),
  };
}

const ids = (wallets: readonly PaymentsDashboardWallet[]) => wallets.map((wallet) => wallet.id);

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  inventory = mixed;
  fetchMock.mockReset().mockImplementation((input) => {
    const url = String(input);
    if (url.startsWith("/api/dashboard/wallets")) {
      return Promise.resolve(Response.json({ data: { wallets: inventory } }));
    }
    if (url.startsWith("/api/dashboard/counterparty?page=")) {
      return Promise.resolve(Response.json({ data: { counterparties: [], total: 0 } }));
    }
    if (url.startsWith("/api/dashboard/counterparty/accounts?")) {
      return Promise.resolve(
        Response.json({ data: { accounts: [], total: 0, page: 1, pageSize: 6 } })
      );
    }
    return Promise.resolve(Response.json({ data: {} }));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("batch send source wallets", () => {
  it("leaves a connected Fireblocks wallet out and keeps a managed one and a Privy connection", async () => {
    const { result } = renderHook(
      () =>
        useBatchSendWizard({
          wallets: mixed,
          walletsError: null,
          issuedTokenSymbolsByMint: {},
          cluster: "devnet",
          onExit: vi.fn(),
        }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.walletsLoading).toBe(false));
    expect(ids(result.current.liveWallets)).toEqual(["cwlt_fireblocks_managed", "cwlt_privy"]);
    expect(result.current.sourceWalletHint).toBeNull();
  });

  it("says why the picker is empty when only connected Fireblocks wallets exist", async () => {
    inventory = [fireblocksByok];
    const { result } = renderHook(
      () =>
        useBatchSendWizard({
          wallets: [fireblocksByok],
          walletsError: null,
          issuedTokenSymbolsByMint: {},
          cluster: "devnet",
          onExit: vi.fn(),
        }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.walletsLoading).toBe(false));
    expect(result.current.liveWallets).toEqual([]);
    expect(result.current.sourceWalletHint).toBe(HELD_BACK);
  });

  it("keeps a project with no wallets on its own empty state", async () => {
    inventory = [];
    const { result } = renderHook(
      () =>
        useBatchSendWizard({
          wallets: [],
          walletsError: null,
          issuedTokenSymbolsByMint: {},
          cluster: "devnet",
          onExit: vi.fn(),
        }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.walletsLoading).toBe(false));
    expect(result.current.sourceWalletHint).toBeNull();
  });
});

describe("off-ramp source wallets", () => {
  it("leaves a connected Fireblocks wallet out and keeps a managed one and a Privy connection", async () => {
    const { result } = renderHook(() => useOfframpWizard(rampProps(mixed)), { wrapper });
    await waitFor(() => expect(result.current.walletsLoading).toBe(false));
    expect(ids(result.current.liveWallets)).toEqual(["cwlt_fireblocks_managed", "cwlt_privy"]);
    expect(result.current.sourceWalletHint).toBeNull();
  });

  it("says why the picker is empty when only connected Fireblocks wallets exist", async () => {
    inventory = [fireblocksByok];
    const { result } = renderHook(() => useOfframpWizard(rampProps([fireblocksByok])), {
      wrapper,
    });
    await waitFor(() => expect(result.current.walletsLoading).toBe(false));
    expect(result.current.liveWallets).toEqual([]);
    expect(result.current.sourceWalletHint).toBe(HELD_BACK);
  });
});

describe("on-ramp destination wallets", () => {
  it("still offers a connected Fireblocks wallet, which only receives", async () => {
    const { result } = renderHook(() => useOnrampWizard(rampProps(mixed)), { wrapper });
    await waitFor(() => expect(result.current.walletsLoading).toBe(false));
    expect(ids(result.current.liveWallets)).toEqual(ids(mixed));
    expect(result.current.heldBackHint).toBeNull();
  });
});
