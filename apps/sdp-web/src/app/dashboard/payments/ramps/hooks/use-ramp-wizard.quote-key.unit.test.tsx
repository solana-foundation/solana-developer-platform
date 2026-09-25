// @vitest-environment jsdom

import type { PaymentsDashboardWallet } from "@sdp/types";
import type { RenderHookResult } from "@testing-library/react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { useOnrampWizard } from "./use-onramp-wizard";
import type { UseRampWizardProps } from "./use-ramp-wizard";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  toastDismiss: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastLoading: vi.fn(() => "toast-id"),
  toastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/payments",
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({
  toast: {
    dismiss: mocks.toastDismiss,
    error: mocks.toastError,
    info: mocks.toastInfo,
    loading: mocks.toastLoading,
    success: mocks.toastSuccess,
  },
}));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: false, orgId: null, userId: null }),
}));

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TRANSFER_ID = "xfr_bvnk_wizard";

const WALLET: PaymentsDashboardWallet = {
  id: "wallet-bvnk",
  walletId: "provider-bvnk",
  isRuntimeExecutionAllowed: true,
  custodyConfigId: "cc_test",
  publicKey: "wallet-pubkey",
  label: "USDC Treasury",
  balances: [{ token: "USDC", mint: USDC_MINT, amount: "1000000", uiAmount: "1", decimals: 6 }],
};

// A bvnk onramp requirements answer that needs no collection and no onboarding:
// the advance straight to `ready` lets the transaction stage fire the quote.
const REQUIREMENTS_READY = { provider: "bvnk", direction: "onramp", status: "ready" };

const BVNK_QUOTE = {
  id: "quote_bvnk",
  provider: "bvnk",
  status: "pending",
  deliveryMode: "manual_instructions",
  paymentInstructions: [],
};

const PROPS: UseRampWizardProps = {
  wallets: [WALLET],
  walletsError: null,
  enabledRampProviders: ["bvnk"],
  rampProviderAccess: null,
  counterpartiesResult: { ok: true, data: [] },
  selectedCounterparty: null,
  initialCounterpartyId: "counterparty-test",
  onExit: vi.fn(),
};

const QUOTE_ENDPOINT = "/api/dashboard/payments/ramps/onramp/quote";

const fetchMock = vi.fn<typeof fetch>();

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
        serverDashboardCacheScope={{ orgId: "org-test", userId: "user-test" }}
        projects={[]}
        initialSelectedProjectId={null}
        shouldRepairInitialProjectCookie={false}
      >
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
      </DashboardWorkspaceProvider>
    </I18nProvider>
  );
}

function quoteKeysFromFetchCalls(): string[] {
  return fetchMock.mock.calls
    .map((call) => {
      const [input, init] = call;
      if (String(input) !== QUOTE_ENDPOINT || (init?.method ?? "GET") !== "POST") {
        return null;
      }
      return new Headers(init?.headers).get("Idempotency-Key");
    })
    .filter((key): key is string => key !== null);
}

type WizardRender = RenderHookResult<ReturnType<typeof useOnrampWizard>, unknown>;

/**
 * Drives the real wizard from the deposit step to the transaction stage, where
 * the readiness effect fires the quote POST, and waits for the quote outcome
 * the current fetch mock produces.
 */
async function driveToQuote(rendered: WizardRender) {
  await act(async () => {});
  act(() => rendered.result.current.selectProvider("bvnk"));
  act(() => rendered.result.current.setField("amount", "100"));
  act(() => rendered.result.current.setField("walletId", WALLET.id));
  await waitFor(() => expect(rendered.result.current.canProceed).toBe(true));
  await act(async () => {
    await rendered.result.current.handlePrimary();
  });
  await act(async () => {
    await rendered.result.current.handlePrimary();
  });
}

describe("useRampWizard quote operation key (SOLA9-302)", () => {
  beforeEach(() => {
    fetchMock.mockReset().mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.startsWith("/api/dashboard/wallets")) {
        return Promise.resolve(Response.json({ data: { wallets: [WALLET] } }));
      }
      if (url.startsWith("/api/dashboard/counterparty?page=")) {
        return Promise.resolve(Response.json({ data: { counterparties: [], total: 0 } }));
      }
      if (url.startsWith("/api/dashboard/counterparty/counterparty-test/requirements")) {
        return Promise.resolve(Response.json({ data: REQUIREMENTS_READY }));
      }
      if (url === QUOTE_ENDPOINT && method === "POST") {
        return Promise.resolve(
          Response.json({ data: { quote: BVNK_QUOTE, transferId: TRANSFER_ID } })
        );
      }
      return Promise.resolve(Response.json({ data: {} }));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("retains one operation key across a failed quote POST and the explicit retry", async () => {
    let quotePostCalls = 0;
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === QUOTE_ENDPOINT && method === "POST") {
        quotePostCalls += 1;
        if (quotePostCalls === 1) {
          // The ambiguous failure: the request went out, the response never
          // came back (network loss after the server committed its work).
          return Promise.reject(new TypeError("network response lost"));
        }
        return Promise.resolve(
          Response.json({ data: { quote: BVNK_QUOTE, transferId: TRANSFER_ID } })
        );
      }
      if (url.startsWith("/api/dashboard/wallets")) {
        return Promise.resolve(Response.json({ data: { wallets: [WALLET] } }));
      }
      if (url.startsWith("/api/dashboard/counterparty?page=")) {
        return Promise.resolve(Response.json({ data: { counterparties: [], total: 0 } }));
      }
      if (url.startsWith("/api/dashboard/counterparty/counterparty-test/requirements")) {
        return Promise.resolve(Response.json({ data: REQUIREMENTS_READY }));
      }
      return Promise.resolve(Response.json({ data: {} }));
    });

    const rendered = renderHook(() => useOnrampWizard(PROPS), { wrapper });
    await driveToQuote(rendered);
    await waitFor(() => expect(rendered.result.current.quoteCreationError).not.toBeNull());

    await act(async () => {
      rendered.result.current.retryQuoteCreation();
      await Promise.resolve();
    });
    await waitFor(() => expect(rendered.result.current.quoteTransferId).toBe(TRANSFER_ID));

    const keys = quoteKeysFromFetchCalls();
    expect(keys.length).toBe(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
  });

  it("mints a fresh operation key when an expiring session deliberately re-quotes", async () => {
    const rendered = renderHook(() => useOnrampWizard(PROPS), { wrapper });
    await driveToQuote(rendered);
    await waitFor(() => expect(rendered.result.current.quoteTransferId).toBe(TRANSFER_ID));

    await act(async () => {
      await rendered.result.current.refreshQuote();
    });
    await waitFor(() => expect(quoteKeysFromFetchCalls().length).toBe(2));

    const keys = quoteKeysFromFetchCalls();
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[1]).not.toBe(keys[0]);
  });
});
