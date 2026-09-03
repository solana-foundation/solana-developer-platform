// @vitest-environment jsdom

import type { CounterpartyRequirements, PayoutRequirementTree } from "@sdp/types/ramp-requirements";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import {
  type CounterpartyRequirementsParams,
  useCounterpartyRequirements,
} from "./use-counterparty-requirements";

interface HeldRequest {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  respond: (data: CounterpartyRequirements) => void;
}

let held: HeldRequest[] = [];

/**
 * Fetch stub that parks every request until the test releases it, so response
 * ordering — the whole subject under test — is controlled explicitly.
 */
function stubFetch(): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((resolveResponse) => {
      held.push({
        url: String(input),
        method: init?.method === undefined ? "GET" : init.method,
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
        respond: (data) => {
          resolveResponse(
            new Response(JSON.stringify({ data }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          );
        },
      });
    });
  });
}

/**
 * Releases the oldest held request matching the method, asserting it exists.
 *
 * @param method - HTTP method of the expected request.
 * @param data - Requirements payload the request resolves with.
 * @returns The released request, for body assertions.
 */
async function release(method: string, data: CounterpartyRequirements): Promise<HeldRequest> {
  const index = held.findIndex((request) => request.method === method);
  expect(index).toBeGreaterThanOrEqual(0);
  const request = held[index];
  held.splice(index, 1);
  await act(async () => {
    request.respond(data);
  });
  return request;
}

const PAYOUT_TREE: PayoutRequirementTree = {
  countryRails: {
    US: [{ value: "ACH", label: "ACH" }],
    MX: [{ value: "SPEI", label: "SPEI" }],
  },
  railFields: {
    ACH: [
      { kind: "text", key: "bankAccount.accountNumber", label: "Account number", required: true },
    ],
    SPEI: [{ kind: "text", key: "bankAccount.clabe", label: "CLABE", required: true }],
  },
  accounts: [
    {
      id: "cpa_us_primary",
      destinationCountry: "US",
      paymentRail: "ACH",
      status: "ACTIVE",
      bankName: "First US",
      accountNumberLast4: "1111",
    },
    {
      id: "cpa_us_secondary",
      destinationCountry: "US",
      paymentRail: "ACH",
      status: "ACTIVE",
      bankName: "Second US",
      accountNumberLast4: "2222",
    },
  ],
};

const COLLECT_ACCOUNT: CounterpartyRequirements = {
  provider: "lightspark",
  direction: "offramp",
  status: "collect_account",
  payout: PAYOUT_TREE,
};

const READY_US_ACCOUNT: CounterpartyRequirements = {
  provider: "lightspark",
  direction: "offramp",
  status: "ready",
  providerAccountId: "cpa_us_primary",
};

const OFFRAMP_PARAMS: CounterpartyRequirementsParams = {
  counterpartyId: "cpty_behavior",
  provider: "lightspark",
  direction: "offramp",
  cryptoToken: "USDC",
  destinationWallet: "",
  fiatCurrency: "USD",
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
    </I18nProvider>
  );
}

describe("useCounterpartyRequirements — corridor-addressed responses", () => {
  beforeEach(() => {
    held = [];
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function renderResolvedOfframp(params: CounterpartyRequirementsParams = OFFRAMP_PARAMS) {
    const rendered = renderHook(
      (props: CounterpartyRequirementsParams) => useCounterpartyRequirements(props),
      {
        wrapper,
        initialProps: params,
      }
    );
    await release("GET", COLLECT_ACCOUNT);
    await waitFor(() => expect(rendered.result.current.isResolved).toBe(true));
    return rendered;
  }

  it("discards a ready response that lands after the destination country changed", async () => {
    const { result } = await renderResolvedOfframp();

    act(() => result.current.setField("destinationCountry", "US"));
    let submitPromise: Promise<CounterpartyRequirements> | null = null;
    act(() => {
      submitPromise = result.current.submitRequirements({
        cryptoToken: "USDC",
        destinationWallet: "",
        fiatCurrency: "USD",
      });
    });
    expect(result.current.isAdvancing).toBe(true);

    act(() => result.current.setField("destinationCountry", "MX"));

    await release("POST", READY_US_ACCOUNT);
    await submitPromise;

    expect(result.current.onboarding).toBeNull();
    expect(result.current.resolvedProviderAccountId).toBeNull();
    expect(result.current.payoutAccountSelection).toEqual({ kind: "none" });
    expect(result.current.isAdvancing).toBe(false);
  });

  it("applies a ready response for the corridor that is still current", async () => {
    const { result } = await renderResolvedOfframp();

    act(() => result.current.setField("destinationCountry", "US"));
    let submitPromise: Promise<CounterpartyRequirements> | null = null;
    act(() => {
      submitPromise = result.current.submitRequirements({
        cryptoToken: "USDC",
        destinationWallet: "",
        fiatCurrency: "USD",
      });
    });
    await release("POST", READY_US_ACCOUNT);
    await submitPromise;

    expect(result.current.onboarding).toEqual(READY_US_ACCOUNT);
    expect(result.current.resolvedProviderAccountId).toBe("cpa_us_primary");
    expect(result.current.selectedProviderAccountId).toBe("cpa_us_primary");
  });

  it("lets an explicit account choice made after readiness win over the resolved seed", async () => {
    const { result } = await renderResolvedOfframp();

    act(() => result.current.setField("destinationCountry", "US"));
    let submitPromise: Promise<CounterpartyRequirements> | null = null;
    act(() => {
      submitPromise = result.current.submitRequirements({
        cryptoToken: "USDC",
        destinationWallet: "",
        fiatCurrency: "USD",
      });
    });
    await release("POST", READY_US_ACCOUNT);
    await submitPromise;
    expect(result.current.selectedProviderAccountId).toBe("cpa_us_primary");

    act(() => result.current.selectPayoutAccount({ kind: "existing", id: "cpa_us_secondary" }));

    expect(result.current.selectedProviderAccountId).toBe("cpa_us_secondary");
  });

  it("sends providerAccountId only for an existing-account choice", async () => {
    const { result } = await renderResolvedOfframp();

    act(() => result.current.setField("destinationCountry", "US"));
    act(() => result.current.selectPayoutAccount({ kind: "existing", id: "cpa_us_secondary" }));
    act(() => {
      void result.current.submitRequirements({
        cryptoToken: "USDC",
        destinationWallet: "",
        fiatCurrency: "USD",
      });
    });
    const reuseRequest = await release("POST", READY_US_ACCOUNT);
    expect(reuseRequest.body).toMatchObject({ providerAccountId: "cpa_us_secondary" });

    act(() => result.current.selectPayoutAccount({ kind: "new" }));
    act(() => result.current.setField("bankAccount.accountNumber", "12345678"));
    act(() => {
      void result.current.submitRequirements({
        cryptoToken: "USDC",
        destinationWallet: "",
        fiatCurrency: "USD",
      });
    });
    const newAccountRequest = await release("POST", READY_US_ACCOUNT);
    expect(newAccountRequest.body).not.toHaveProperty("providerAccountId");
    expect(newAccountRequest.body).toMatchObject({
      collectedData: { destinationCountry: "US", "bankAccount.accountNumber": "12345678" },
    });
  });

  it("never surfaces a poll result issued for an abandoned corridor", async () => {
    const onrampParams: CounterpartyRequirementsParams = {
      counterpartyId: "cpty_behavior",
      provider: "bvnk",
      direction: "onramp",
      cryptoToken: "USDC",
      destinationWallet: "wlt_behavior",
      fiatCurrency: "USD",
    };
    const provisioning: CounterpartyRequirements = {
      provider: "bvnk",
      direction: "onramp",
      status: "customer_funding_account_provisioning",
    };
    const rendered = renderHook(
      (props: CounterpartyRequirementsParams) => useCounterpartyRequirements(props),
      { wrapper, initialProps: onrampParams }
    );
    await release("GET", provisioning);
    await waitFor(() => expect(rendered.result.current.isResolved).toBe(true));

    let submitPromise: Promise<CounterpartyRequirements> | null = null;
    act(() => {
      submitPromise = rendered.result.current.submitRequirements({
        cryptoToken: "USDC",
        destinationWallet: "wlt_behavior",
        fiatCurrency: "USD",
      });
    });
    await release("POST", provisioning);
    await submitPromise;
    expect(rendered.result.current.onboarding).toEqual(provisioning);
    // The status poll for the USD corridor fires immediately on mount and is
    // now parked in `held`.
    await waitFor(() => expect(held.some((request) => request.method === "GET")).toBe(true));

    rendered.rerender({ ...onrampParams, fiatCurrency: "EUR" });
    await release("GET", {
      provider: "bvnk",
      direction: "onramp",
      status: "collect_counterparty",
      fields: [],
    });

    // The parked USD poll tick resolves ready AFTER the corridor moved to EUR:
    // its data belongs to the dead USD key and must never surface.
    await release("GET", {
      provider: "bvnk",
      direction: "onramp",
      status: "ready",
      providerAccountId: "cpa_usd_stale",
    });

    expect(rendered.result.current.onboarding).toBeNull();
    expect(rendered.result.current.resolvedProviderAccountId).toBeNull();
  });

  it("never lets an earlier advance's poll verdict answer for a later same-corridor advance", async () => {
    const onrampParams: CounterpartyRequirementsParams = {
      counterpartyId: "cpty_behavior",
      provider: "bvnk",
      direction: "onramp",
      cryptoToken: "USDC",
      destinationWallet: "wlt_behavior",
      fiatCurrency: "USD",
    };
    const provisioning: CounterpartyRequirements = {
      provider: "bvnk",
      direction: "onramp",
      status: "customer_funding_account_provisioning",
    };
    const rendered = renderHook(
      (props: CounterpartyRequirementsParams) => useCounterpartyRequirements(props),
      { wrapper, initialProps: onrampParams }
    );
    await release("GET", provisioning);
    await waitFor(() => expect(rendered.result.current.isResolved).toBe(true));

    let firstSubmit: Promise<CounterpartyRequirements> | null = null;
    act(() => {
      firstSubmit = rendered.result.current.submitRequirements({
        cryptoToken: "USDC",
        destinationWallet: "wlt_behavior",
        fiatCurrency: "USD",
      });
    });
    await release("POST", provisioning);
    await firstSubmit;
    // The first advance's poll observes ready with an account.
    await waitFor(() => expect(held.some((request) => request.method === "GET")).toBe(true));
    await release("GET", {
      provider: "bvnk",
      direction: "onramp",
      status: "ready",
      providerAccountId: "cpa_first_advance",
    });
    expect(rendered.result.current.resolvedProviderAccountId).toBe("cpa_first_advance");

    // A second advance in the SAME corridor answers pending again — the first
    // advance's cached ready verdict must not answer for it.
    let secondSubmit: Promise<CounterpartyRequirements> | null = null;
    act(() => {
      secondSubmit = rendered.result.current.submitRequirements({
        cryptoToken: "USDC",
        destinationWallet: "wlt_behavior",
        fiatCurrency: "USD",
      });
    });
    await release("POST", provisioning);
    await secondSubmit;

    expect(rendered.result.current.onboarding).toEqual(provisioning);
    expect(rendered.result.current.resolvedProviderAccountId).toBeNull();
  });
});
