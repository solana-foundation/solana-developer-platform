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
  respondRaw: (response: Response) => void;
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
        respondRaw: resolveResponse,
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

/**
 * Releases the oldest held request matching the method with an error response.
 *
 * @param method - HTTP method of the expected request.
 * @param message - Error message the API responds with.
 * @returns The released request.
 */
async function releaseFailure(method: string, message: string): Promise<HeldRequest> {
  const index = held.findIndex((request) => request.method === method);
  expect(index).toBeGreaterThanOrEqual(0);
  const request = held[index];
  held.splice(index, 1);
  await act(async () => {
    request.respondRaw(
      new Response(JSON.stringify({ error: { message } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    );
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
  ],
};

const COLLECT_COUNTERPARTY: CounterpartyRequirements = {
  provider: "lightspark",
  direction: "offramp",
  status: "collect_counterparty",
  fields: [{ kind: "text", key: "fullName", label: "Full name", required: true }],
};

const COLLECT_ACCOUNT: CounterpartyRequirements = {
  provider: "lightspark",
  direction: "offramp",
  status: "collect_account",
  payout: PAYOUT_TREE,
};

const READY_US_ADVANCE: CounterpartyRequirements = {
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

describe("useCounterpartyRequirements — subject-addressed responses", () => {
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

  it("walks collect_counterparty → collect_account, deriving corridor fields locally with no preselection", async () => {
    const rendered = renderHook(
      (props: CounterpartyRequirementsParams) => useCounterpartyRequirements(props),
      { wrapper, initialProps: OFFRAMP_PARAMS }
    );
    await release("GET", COLLECT_COUNTERPARTY);
    await waitFor(() => expect(rendered.result.current.isResolved).toBe(true));
    expect(rendered.result.current.fields.map((field) => field.key)).toEqual(["fullName"]);

    act(() => rendered.result.current.setField("fullName", "Ada Lovelace"));
    let submitPromise: Promise<CounterpartyRequirements> | null = null;
    act(() => {
      submitPromise = rendered.result.current.submitRequirements({
        cryptoToken: "USDC",
        destinationWallet: "",
        fiatCurrency: "USD",
      });
    });
    await release("POST", COLLECT_ACCOUNT);
    await submitPromise;
    await release("GET", COLLECT_ACCOUNT);
    expect(rendered.result.current.fields.map((field) => field.key)).toEqual([
      "destinationCountry",
    ]);

    act(() => rendered.result.current.setField("destinationCountry", "MX"));
    expect(held.filter((request) => request.method === "GET")).toEqual([]);
    expect(rendered.result.current.fields.map((field) => field.key)).toEqual([
      "destinationCountry",
      "paymentRails",
    ]);

    act(() => rendered.result.current.setField("destinationCountry", "US"));
    expect(held.filter((request) => request.method === "GET")).toEqual([]);
    expect(rendered.result.current.fields.map((field) => field.key)).toEqual([
      "destinationCountry",
      "paymentRails",
    ]);
    expect(rendered.result.current.payoutAccounts.map((account) => account.id)).toEqual([
      "cpa_us_primary",
    ]);
    expect(rendered.result.current.selectedProviderAccountId).toBeNull();
    expect(rendered.result.current.isComplete).toBe(false);
  });

  it("an explicit pick completes the step without touching the form, and clears on unpick", async () => {
    const { result } = await renderResolvedOfframp();
    act(() => result.current.setField("destinationCountry", "MX"));

    const account = result.current.payoutAccounts[0];
    act(() => result.current.selectPayoutAccount(account));
    expect(result.current.selectedProviderAccountId).toBe("cpa_us_primary");
    expect(result.current.collectedData).toEqual({ destinationCountry: "MX" });
    expect(result.current.isComplete).toBe(true);

    act(() => {
      void result.current.submitRequirements({
        cryptoToken: "USDC",
        destinationWallet: "",
        fiatCurrency: "USD",
      });
    });
    const reuseRequest = await release("POST", READY_US_ADVANCE);
    expect(reuseRequest.body).toMatchObject({
      providerAccountId: "cpa_us_primary",
      collectedData: { destinationCountry: "US" },
    });

    act(() => result.current.selectPayoutAccount(null));
    expect(result.current.selectedProviderAccountId).toBeNull();
    expect(result.current.isComplete).toBe(false);
    expect(result.current.collectedData).toEqual({ destinationCountry: "MX" });
  });

  it("a failed post-advance refresh never blocks a usable collect answer", async () => {
    const { result } = await renderResolvedOfframp();

    let submitPromise: Promise<CounterpartyRequirements> | null = null;
    act(() => {
      submitPromise = result.current.submitRequirements({
        cryptoToken: "USDC",
        destinationWallet: "",
        fiatCurrency: "USD",
      });
    });
    await release("POST", COLLECT_ACCOUNT);
    await submitPromise;
    await releaseFailure("GET", "requirements refresh failed");

    expect(result.current.blockReason).toBeNull();
    expect(result.current.isResolved).toBe(true);
    expect(result.current.fields.map((field) => field.key)).toEqual(["destinationCountry"]);
  });

  it("a successful offramp advance clears and refetches the requirements answer", async () => {
    const { result } = await renderResolvedOfframp();
    act(() => result.current.setField("destinationCountry", "MX"));
    act(() => result.current.setField("paymentRails", "SPEI"));
    act(() => result.current.setField("bankAccount.clabe", "002010077777777771"));

    let submitPromise: Promise<CounterpartyRequirements> | null = null;
    act(() => {
      submitPromise = result.current.submitRequirements({
        cryptoToken: "USDC",
        destinationWallet: "",
        fiatCurrency: "USD",
      });
    });
    await release("POST", READY_US_ADVANCE);
    await submitPromise;

    const refreshedTree: PayoutRequirementTree = {
      ...PAYOUT_TREE,
      accounts: [
        ...PAYOUT_TREE.accounts,
        { id: "cpa_mx_new", destinationCountry: "MX", paymentRail: "SPEI", status: "ACTIVE" },
      ],
    };
    await release("GET", { ...COLLECT_ACCOUNT, payout: refreshedTree });
    await waitFor(() =>
      expect(result.current.payoutAccounts.map((account) => account.id)).toEqual([
        "cpa_us_primary",
        "cpa_mx_new",
      ])
    );
  });

  it("discards an advance ready response that lands after the destination country changed", async () => {
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

    await release("POST", READY_US_ADVANCE);
    await submitPromise;

    expect(result.current.onboarding).toBeNull();
    expect(result.current.resolvedProviderAccountId).toBeNull();
    expect(result.current.isAdvancing).toBe(false);
  });

  it("applies an advance ready response for the corridor that is still current", async () => {
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
    await release("POST", READY_US_ADVANCE);
    await submitPromise;

    expect(result.current.onboarding).toEqual(READY_US_ADVANCE);
    expect(result.current.resolvedProviderAccountId).toBe("cpa_us_primary");
    expect(result.current.selectedProviderAccountId).toBeNull();
  });

  it("sends no account id when collecting a new account", async () => {
    const { result } = await renderResolvedOfframp();

    act(() => result.current.setField("destinationCountry", "MX"));
    act(() => result.current.setField("paymentRails", "SPEI"));
    act(() => result.current.setField("bankAccount.clabe", "002010077777777771"));
    act(() => {
      void result.current.submitRequirements({
        cryptoToken: "USDC",
        destinationWallet: "",
        fiatCurrency: "USD",
      });
    });
    const newAccountRequest = await release("POST", READY_US_ADVANCE);
    expect(newAccountRequest.body).not.toHaveProperty("providerAccountId");
    expect(newAccountRequest.body).toMatchObject({
      collectedData: {
        destinationCountry: "MX",
        paymentRails: "SPEI",
        "bankAccount.clabe": "002010077777777771",
      },
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
    });

    expect(rendered.result.current.onboarding).toBeNull();
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
    const ready: CounterpartyRequirements = {
      provider: "bvnk",
      direction: "onramp",
      status: "ready",
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
    // The first advance's poll observes ready.
    await waitFor(() => expect(held.some((request) => request.method === "GET")).toBe(true));
    await release("GET", ready);
    expect(rendered.result.current.onboarding).toEqual(ready);

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
  });
});
