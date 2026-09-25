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
import { useOfframpWizard } from "./use-offramp-wizard";
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

type WizardRender = RenderHookResult<
  ReturnType<typeof useOnrampWizard> | ReturnType<typeof useOfframpWizard>,
  unknown
>;

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

  it("mints a fresh operation key when the selection is edited after a failed attempt", async () => {
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

    // The user edits the committed selection (amount, wallet, provider, or
    // memo) and retries: the edited request is a NEW quote operation, so the
    // retry must carry a fresh key — the retained key's fingerprint covers the
    // original payload and the API would conflict instead of quoting the edit.
    await act(async () => {
      rendered.result.current.setField("amount", "250");
    });
    await act(async () => {
      rendered.result.current.retryQuoteCreation();
      await Promise.resolve();
    });
    await waitFor(() => expect(rendered.result.current.quoteTransferId).toBe(TRANSFER_ID));

    const keys = quoteKeysFromFetchCalls();
    expect(keys.length).toBe(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[1]).not.toBe(keys[0]);
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

describe("useRampWizard quote operation key — lightspark offramp collected payout (SOLA9-302)", () => {
  const OFFRAMP_ENDPOINT = "/api/dashboard/payments/ramps/offramp/quote";
  const TRANSFER_ID_OFFRAMP = "xfr_lightspark_wizard";

  // The lightspark offramp ready arm is the only requirements answer that
  // resolves a payout account: the collect-details flow quotes against the
  // RESOLVED account while no account is explicitly picked.
  const LIGHTSPARK_READY = {
    provider: "lightspark",
    direction: "offramp",
    status: "ready",
    providerAccountId: "cpa_us_primary",
  };

  const LIGHTSPARK_QUOTE = {
    id: "quote_lightspark",
    provider: "lightspark",
    status: "pending",
    deliveryMode: "manual_instructions",
    paymentInstructions: [],
  };

  // Two active saved payout accounts in one corridor: picking either must put
  // its id on the quote, so the API never guesses between them.
  const SAVED_PAYOUT_TREE = {
    countryRails: { US: [] },
    railFields: {},
    accounts: [
      {
        id: "cpa_us_primary",
        destinationCountry: "US",
        paymentRail: "ach",
        status: "ACTIVE",
      },
      {
        id: "cpa_us_secondary",
        destinationCountry: "US",
        paymentRail: "ach",
        status: "ACTIVE",
      },
    ],
  };

  const OFFRAMP_PROPS: UseRampWizardProps = {
    ...PROPS,
    enabledRampProviders: ["lightspark"],
  };

  function offrampQuotePosts(): { key: string | null; body: Record<string, unknown> }[] {
    return fetchMock.mock.calls
      .map((call) => {
        const [input, init] = call;
        if (String(input) !== OFFRAMP_ENDPOINT || (init?.method ?? "GET") !== "POST") {
          return null;
        }
        return {
          key: new Headers(init?.headers).get("Idempotency-Key"),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        };
      })
      .filter((entry): entry is { key: string | null; body: Record<string, unknown> } =>
        Boolean(entry)
      );
  }

  /** Drives the offramp wizard to the transaction stage with payout details
   * collected (no saved account picked) and waits for the quote POST outcome. */
  async function driveOfframpToQuote(rendered: WizardRender) {
    await act(async () => {});
    act(() => rendered.result.current.selectProvider("lightspark"));
    act(() => rendered.result.current.setField("amount", "100"));
    act(() => rendered.result.current.setField("walletId", WALLET.id));
    act(() => rendered.result.current.setCollectedField("destinationCountry", "US"));
    for (let step = 0; step < 4; step += 1) {
      await waitFor(() => expect(rendered.result.current.canProceed).toBe(true));
      await act(async () => {
        await rendered.result.current.handlePrimary();
      });
    }
  }

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("replays the retained operation when the retry has no explicitly picked payout account", async () => {
    let quotePostCalls = 0;
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === OFFRAMP_ENDPOINT && method === "POST") {
        quotePostCalls += 1;
        if (quotePostCalls === 1) {
          // The ambiguous failure: the request went out, the response never
          // came back (network loss after the server committed its work).
          return Promise.reject(new TypeError("network response lost"));
        }
        return Promise.resolve(
          Response.json({ data: { quote: LIGHTSPARK_QUOTE, transferId: TRANSFER_ID_OFFRAMP } })
        );
      }
      if (url.startsWith("/api/dashboard/wallets")) {
        return Promise.resolve(Response.json({ data: { wallets: [WALLET] } }));
      }
      if (url.startsWith("/api/dashboard/counterparty?page=")) {
        return Promise.resolve(Response.json({ data: { counterparties: [], total: 0 } }));
      }
      if (url.startsWith("/api/dashboard/counterparty/counterparty-test/requirements")) {
        return Promise.resolve(Response.json({ data: LIGHTSPARK_READY }));
      }
      return Promise.resolve(Response.json({ data: {} }));
    });

    const rendered = renderHook(() => useOfframpWizard(OFFRAMP_PROPS), { wrapper });
    await driveOfframpToQuote(rendered);
    await waitFor(() => expect(rendered.result.current.quoteCreationError).not.toBeNull());

    await act(async () => {
      rendered.result.current.retryQuoteCreation();
      await Promise.resolve();
    });
    await waitFor(() => expect(rendered.result.current.quoteTransferId).toBe(TRANSFER_ID_OFFRAMP));

    const posts = offrampQuotePosts();
    expect(posts.length).toBe(2);
    expect(posts[0].key).toBeTruthy();
    // The unchanged selection must repeat the retained operation verbatim: the
    // same key and the same payload (the resolved payout account included), so
    // the API replays the recorded quote instead of minting a second session
    // and transfer row.
    expect(posts[1].key).toBe(posts[0].key);
    expect(posts[1].body).toEqual(posts[0].body);
    expect(posts[0].body.providerAccountId).toBe("cpa_us_primary");
  });

  it("mints a fresh operation key when the offramp selection is edited after a failed attempt", async () => {
    let quotePostCalls = 0;
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === OFFRAMP_ENDPOINT && method === "POST") {
        quotePostCalls += 1;
        if (quotePostCalls === 1) {
          return Promise.reject(new TypeError("network response lost"));
        }
        return Promise.resolve(
          Response.json({ data: { quote: LIGHTSPARK_QUOTE, transferId: TRANSFER_ID_OFFRAMP } })
        );
      }
      if (url.startsWith("/api/dashboard/wallets")) {
        return Promise.resolve(Response.json({ data: { wallets: [WALLET] } }));
      }
      if (url.startsWith("/api/dashboard/counterparty?page=")) {
        return Promise.resolve(Response.json({ data: { counterparties: [], total: 0 } }));
      }
      if (url.startsWith("/api/dashboard/counterparty/counterparty-test/requirements")) {
        return Promise.resolve(Response.json({ data: LIGHTSPARK_READY }));
      }
      return Promise.resolve(Response.json({ data: {} }));
    });

    const rendered = renderHook(() => useOfframpWizard(OFFRAMP_PROPS), { wrapper });
    await driveOfframpToQuote(rendered);
    await waitFor(() => expect(rendered.result.current.quoteCreationError).not.toBeNull());

    await act(async () => {
      rendered.result.current.setField("amount", "250");
    });
    await act(async () => {
      rendered.result.current.retryQuoteCreation();
      await Promise.resolve();
    });
    await waitFor(() => expect(rendered.result.current.quoteTransferId).toBe(TRANSFER_ID_OFFRAMP));

    const keys = offrampQuotePosts().map((post) => post.key);
    expect(keys.length).toBe(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("mints a fresh operation key when the corridor re-resolves a different payout account", async () => {
    let quotePostCalls = 0;
    // The user steps back after a failed attempt and re-advances: the fresh
    // ready answer resolves a DIFFERENT saved payout account for the same
    // destination country, so the only payload difference is the account id.
    let switched = false;
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === OFFRAMP_ENDPOINT && method === "POST") {
        quotePostCalls += 1;
        if (quotePostCalls === 1) {
          return Promise.reject(new TypeError("network response lost"));
        }
        return Promise.resolve(
          Response.json({ data: { quote: LIGHTSPARK_QUOTE, transferId: TRANSFER_ID_OFFRAMP } })
        );
      }
      if (url.startsWith("/api/dashboard/wallets")) {
        return Promise.resolve(Response.json({ data: { wallets: [WALLET] } }));
      }
      if (url.startsWith("/api/dashboard/counterparty?page=")) {
        return Promise.resolve(Response.json({ data: { counterparties: [], total: 0 } }));
      }
      if (url.startsWith("/api/dashboard/counterparty/counterparty-test/requirements")) {
        const answer = switched
          ? { ...LIGHTSPARK_READY, providerAccountId: "cpa_us_secondary" }
          : LIGHTSPARK_READY;
        return Promise.resolve(Response.json({ data: answer }));
      }
      return Promise.resolve(Response.json({ data: {} }));
    });

    const rendered = renderHook(() => useOfframpWizard(OFFRAMP_PROPS), { wrapper });
    await driveOfframpToQuote(rendered);
    await waitFor(() => expect(rendered.result.current.quoteCreationError).not.toBeNull());

    switched = true;
    for (let step = 0; step < 2; step += 1) {
      await act(async () => {
        rendered.result.current.handleSecondary();
      });
    }
    for (let step = 0; step < 2; step += 1) {
      await waitFor(() => expect(rendered.result.current.canProceed).toBe(true));
      await act(async () => {
        await rendered.result.current.handlePrimary();
      });
    }
    await waitFor(() => {
      const onboarding = rendered.result.current.onboarding;
      expect(
        onboarding !== null && "providerAccountId" in onboarding
          ? onboarding.providerAccountId
          : null
      ).toBe("cpa_us_secondary");
    });

    await act(async () => {
      rendered.result.current.retryQuoteCreation();
      await Promise.resolve();
    });
    await waitFor(() => expect(rendered.result.current.quoteTransferId).toBe(TRANSFER_ID_OFFRAMP));

    const posts = offrampQuotePosts();
    expect(posts.length).toBe(2);
    // The re-resolved payout account is a NEW quote operation: a fresh key
    // quoting the account the corridor now resolves, never a replay of the
    // previous account's recorded quote.
    expect(posts[0].key).toBeTruthy();
    expect(posts[1].key).not.toBe(posts[0].key);
    expect(posts[1].body.providerAccountId).toBe("cpa_us_secondary");
  });

  it("quotes the newly picked saved account when the retry skips the advance", async () => {
    // Saved-account flow: the user picked cpa_us_primary, the ready advance
    // resolved it, and the quote POST was lost. They then pick
    // cpa_us_secondary for the same destination country and walk back to the
    // transaction stage without re-advancing — the corridor's resolved account
    // is gone, and the retry must quote the account the user picked, not an
    // account-less payload the API would resolve (or reject) on its own.
    let quotePostCalls = 0;
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === OFFRAMP_ENDPOINT && method === "POST") {
        quotePostCalls += 1;
        if (quotePostCalls === 1) {
          return Promise.reject(new TypeError("network response lost"));
        }
        return Promise.resolve(
          Response.json({ data: { quote: LIGHTSPARK_QUOTE, transferId: TRANSFER_ID_OFFRAMP } })
        );
      }
      if (url.startsWith("/api/dashboard/wallets")) {
        return Promise.resolve(Response.json({ data: { wallets: [WALLET] } }));
      }
      if (url.startsWith("/api/dashboard/counterparty?page=")) {
        return Promise.resolve(Response.json({ data: { counterparties: [], total: 0 } }));
      }
      if (url.startsWith("/api/dashboard/counterparty/counterparty-test/requirements")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body)) as { providerAccountId?: string };
          return Promise.resolve(
            Response.json({
              data: {
                provider: "lightspark",
                direction: "offramp",
                status: "ready",
                providerAccountId: body.providerAccountId ?? "cpa_us_primary",
              },
            })
          );
        }
        return Promise.resolve(
          Response.json({
            data: {
              provider: "lightspark",
              direction: "offramp",
              status: "collect_account",
              payout: SAVED_PAYOUT_TREE,
            },
          })
        );
      }
      return Promise.resolve(Response.json({ data: {} }));
    });

    const rendered = renderHook(() => useOfframpWizard(OFFRAMP_PROPS), { wrapper });
    await act(async () => {});
    act(() => rendered.result.current.selectProvider("lightspark"));
    act(() => rendered.result.current.setField("amount", "100"));
    act(() => rendered.result.current.setField("walletId", WALLET.id));
    await waitFor(() => expect(rendered.result.current.payoutAccounts.length).toBeGreaterThan(0));
    act(() => {
      rendered.result.current.selectPayoutAccount(
        rendered.result.current.payoutAccounts.find((account) => account.id === "cpa_us_primary") ??
          null
      );
    });
    for (let step = 0; step < 4; step += 1) {
      await waitFor(() => expect(rendered.result.current.canProceed).toBe(true));
      await act(async () => {
        await rendered.result.current.handlePrimary();
      });
    }
    await waitFor(() => expect(rendered.result.current.quoteCreationError).not.toBeNull());

    // Pick the other saved account and reach the transaction stage without a
    // fresh advance: back to the memo step, then forward again.
    act(() => {
      rendered.result.current.selectPayoutAccount(
        rendered.result.current.payoutAccounts.find(
          (account) => account.id === "cpa_us_secondary"
        ) ?? null
      );
    });
    await act(async () => {
      rendered.result.current.handleSecondary();
    });
    await act(async () => {
      await rendered.result.current.handlePrimary();
    });

    await act(async () => {
      rendered.result.current.retryQuoteCreation();
      await Promise.resolve();
    });
    await waitFor(() => expect(rendered.result.current.quoteTransferId).toBe(TRANSFER_ID_OFFRAMP));

    const posts = offrampQuotePosts();
    expect(posts.length).toBe(2);
    // The picked account is a NEW quote operation: a fresh key quoting the
    // account the user selected, never a replay of the previous account's
    // recorded quote and never an account-less request.
    expect(posts[0].key).toBeTruthy();
    expect(posts[1].key).not.toBe(posts[0].key);
    expect(posts[0].body.providerAccountId).toBe("cpa_us_primary");
    expect(posts[1].body.providerAccountId).toBe("cpa_us_secondary");
    expect(posts[1].body.destinationCountry).toBe("US");
  });
});
