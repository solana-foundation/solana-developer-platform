// @vitest-environment jsdom

import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paymentsQueryKeys } from "@/app/dashboard/[projectId]/payments/payments-query-key";
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

const COLLECT_RESIDENCE: CounterpartyRequirements = {
  provider: "bvnk",
  direction: "offramp",
  status: "collect_counterparty_residence",
  fields: [{ kind: "text", key: "taxResidence", label: "Tax residence", required: true }],
};

const COLLECT_COUNTERPARTY: CounterpartyRequirements = {
  provider: "bvnk",
  direction: "offramp",
  status: "collect_counterparty",
  fields: [{ kind: "text", key: "fullName", label: "Full name", required: true }],
};

const READY_OFFRAMP: CounterpartyRequirements = {
  provider: "bvnk",
  direction: "offramp",
  status: "ready",
};

const COLLECT_AGREEMENTS: CounterpartyRequirements = {
  provider: "bvnk",
  direction: "onramp",
  status: "counterparty_collect_agreement",
  agreements: [
    {
      name: "bvnk_platform_agreement",
      displayName: "BVNK Platform Agreement",
      description: "BVNK Platform Agreement",
      url: "https://help.bvnk.com/en/articles/platform-agreement",
      privacyPolicyUrl: "https://www.bvnk.com/privacy-policy",
    },
    {
      name: "bvnk_privacy_policy",
      displayName: "BVNK Privacy Policy",
      description: "BVNK Privacy Policy",
      url: "https://www.bvnk.com/privacy-policy",
      privacyPolicyUrl: "https://www.bvnk.com/privacy-policy",
    },
  ],
};

const OFFRAMP_PARAMS: CounterpartyRequirementsParams = {
  counterpartyId: "cpty_behavior",
  provider: "bvnk",
  direction: "offramp",
  assetRail: "usdc.solana",
  destinationCustodyWalletId: "",
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

  const OFFRAMP_ADVANCE = {
    assetRail: "usdc.solana",
    destinationCustodyWalletId: "",
    fiatCurrency: "USD",
  } as const;

  async function renderResolvedOfframp() {
    const rendered = renderHook(
      (props: CounterpartyRequirementsParams) => useCounterpartyRequirements(props),
      { wrapper, initialProps: OFFRAMP_PARAMS }
    );
    await release("GET", COLLECT_RESIDENCE);
    await waitFor(() => expect(rendered.result.current.isResolved).toBe(true));
    return rendered;
  }

  it("walks the provider's collect stages, sending each stage's answers", async () => {
    const { result } = await renderResolvedOfframp();
    expect(result.current.fields.map((field) => field.key)).toEqual(["taxResidence"]);
    expect(result.current.isComplete).toBe(false);

    act(() => result.current.setField("taxResidence", "US"));
    expect(result.current.isComplete).toBe(true);
    let submitPromise: Promise<CounterpartyRequirements> | null = null;
    act(() => {
      submitPromise = result.current.submitRequirements(OFFRAMP_ADVANCE, "collected");
    });
    const advanceRequest = await release("POST", COLLECT_COUNTERPARTY);
    await submitPromise;

    expect(advanceRequest.body).toEqual({
      provider: "bvnk",
      direction: "offramp",
      ...OFFRAMP_ADVANCE,
      collectedData: { taxResidence: "US" },
    });
    // The next stage comes from the advance itself; nothing is refetched.
    expect(held).toEqual([]);
    expect(result.current.fields.map((field) => field.key)).toEqual(["fullName"]);
  });

  it("discards an advance ready response that lands after the corridor changed", async () => {
    const rendered = await renderResolvedOfframp();
    let submitPromise: Promise<CounterpartyRequirements> | null = null;
    act(() => {
      submitPromise = rendered.result.current.submitRequirements(OFFRAMP_ADVANCE, "collected");
    });
    expect(rendered.result.current.isAdvancing).toBe(true);

    rendered.rerender({ ...OFFRAMP_PARAMS, fiatCurrency: "EUR" });
    await release("POST", READY_OFFRAMP);
    await submitPromise;

    expect(rendered.result.current.onboarding).toBeNull();
    expect(rendered.result.current.isAdvancing).toBe(false);
  });

  it("applies an advance ready response for the corridor that is still current", async () => {
    const { result } = await renderResolvedOfframp();
    let submitPromise: Promise<CounterpartyRequirements> | null = null;
    act(() => {
      submitPromise = result.current.submitRequirements(OFFRAMP_ADVANCE, "collected");
    });
    await release("POST", READY_OFFRAMP);
    await submitPromise;

    expect(result.current.onboarding).toEqual(READY_OFFRAMP);
  });

  it("never surfaces a poll result issued for an abandoned corridor", async () => {
    const onrampParams: CounterpartyRequirementsParams = {
      counterpartyId: "cpty_behavior",
      provider: "bvnk",
      direction: "onramp",
      assetRail: "usdc.solana",
      destinationCustodyWalletId: "wlt_behavior",
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
      submitPromise = rendered.result.current.submitRequirements(
        {
          assetRail: "usdc.solana",
          destinationCustodyWalletId: "wlt_behavior",
          fiatCurrency: "USD",
        },
        "collected"
      );
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

  it("never promotes an advance collect answer that lands after the corridor changed", async () => {
    const rendered = await renderResolvedOfframp();
    let submitPromise: Promise<CounterpartyRequirements> | null = null;
    act(() => {
      submitPromise = rendered.result.current.submitRequirements(OFFRAMP_ADVANCE, "collected");
    });

    rendered.rerender({ ...OFFRAMP_PARAMS, fiatCurrency: "EUR" });
    await release("POST", COLLECT_COUNTERPARTY);
    await submitPromise;
    await release("GET", COLLECT_RESIDENCE);

    expect(rendered.result.current.fields.map((field) => field.key)).toEqual(["taxResidence"]);
  });

  it("never lets an earlier advance's poll verdict answer for a later same-corridor advance", async () => {
    const onrampParams: CounterpartyRequirementsParams = {
      counterpartyId: "cpty_behavior",
      provider: "bvnk",
      direction: "onramp",
      assetRail: "usdc.solana",
      destinationCustodyWalletId: "wlt_behavior",
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
      firstSubmit = rendered.result.current.submitRequirements(
        {
          assetRail: "usdc.solana",
          destinationCustodyWalletId: "wlt_behavior",
          fiatCurrency: "USD",
        },
        "collected"
      );
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
      secondSubmit = rendered.result.current.submitRequirements(
        {
          assetRail: "usdc.solana",
          destinationCustodyWalletId: "wlt_behavior",
          fiatCurrency: "USD",
        },
        "collected"
      );
    });
    await release("POST", provisioning);
    await secondSubmit;

    expect(rendered.result.current.onboarding).toEqual(provisioning);
  });

  it("gates completion on every pending agreement being accepted", async () => {
    const onrampParams: CounterpartyRequirementsParams = {
      counterpartyId: "cpty_behavior",
      provider: "bvnk",
      direction: "onramp",
      assetRail: "usdc.solana",
      destinationCustodyWalletId: "wlt_behavior",
      fiatCurrency: "USD",
    };
    const rendered = renderHook(
      (props: CounterpartyRequirementsParams) => useCounterpartyRequirements(props),
      { wrapper, initialProps: onrampParams }
    );
    await release("GET", COLLECT_AGREEMENTS);
    await waitFor(() => expect(rendered.result.current.isResolved).toBe(true));

    expect(rendered.result.current.pendingAgreements).toHaveLength(2);
    expect(rendered.result.current.isComplete).toBe(false);

    act(() => rendered.result.current.toggleAgreement("bvnk_platform_agreement", true));
    act(() => rendered.result.current.toggleAgreement("bvnk_privacy_policy", true));
    act(() => rendered.result.current.toggleAgreement("bvnk_privacy_policy:privacy-policy", true));
    expect(rendered.result.current.isComplete).toBe(false);

    act(() =>
      rendered.result.current.toggleAgreement("bvnk_platform_agreement:privacy-policy", true)
    );
    expect(rendered.result.current.isComplete).toBe(true);

    act(() => rendered.result.current.toggleAgreement("bvnk_platform_agreement", false));
    expect(rendered.result.current.isComplete).toBe(false);
  });

  /**
   * Mirrors the wizard's `selectProvider` purge (use-ramp-wizard.ts): every
   * provider-card click clears all cached requirements answers before setting
   * the provider field.
   */
  function usePurgeHarness(params: CounterpartyRequirementsParams) {
    const requirements = useCounterpartyRequirements(params);
    const { mutate } = useSWRConfig();
    const purgeRequirements = () => {
      void mutate(paymentsQueryKeys.isCounterpartyRequirementsKey, undefined, {
        revalidate: true,
      });
    };
    return { requirements, purgeRequirements };
  }

  it("re-selecting the same provider refetches a subject the cache already answered", async () => {
    const rendered = renderHook((props: CounterpartyRequirementsParams) => usePurgeHarness(props), {
      wrapper,
      initialProps: OFFRAMP_PARAMS,
    });
    await release("GET", COLLECT_COUNTERPARTY);
    await waitFor(() => expect(rendered.result.current.requirements.needsCollection).toBe(true));

    // The frozen SWR options serve the cached answer on re-render — this is the
    // stale state a provider click must not trust.
    rendered.rerender(OFFRAMP_PARAMS);
    expect(held).toHaveLength(0);

    act(() => {
      rendered.result.current.purgeRequirements();
    });
    await waitFor(() => expect(held).toHaveLength(1));
    await release("GET", READY_OFFRAMP);

    await waitFor(() => expect(rendered.result.current.requirements.needsCollection).toBe(false));
    expect(rendered.result.current.requirements.isResolved).toBe(true);
  });

  it("returning to a previously answered provider refetches after the purge", async () => {
    const moonpayParams: CounterpartyRequirementsParams = {
      ...OFFRAMP_PARAMS,
      provider: "moonpay",
    };
    const rendered = renderHook((props: CounterpartyRequirementsParams) => usePurgeHarness(props), {
      wrapper,
      initialProps: OFFRAMP_PARAMS,
    });
    await release("GET", COLLECT_COUNTERPARTY);

    rendered.rerender(moonpayParams);
    const moonpayRequest = await release("GET", COLLECT_COUNTERPARTY);
    expect(moonpayRequest.url).toContain("provider=moonpay");

    act(() => {
      rendered.result.current.purgeRequirements();
    });
    rendered.rerender(OFFRAMP_PARAMS);
    // The purge revalidates the still-mounted moonpay key, then the switch back to
    // bvnk finds an empty cache and must fetch: two requests, in order.
    await waitFor(() => expect(held).toHaveLength(2));
    const revalidatedMoonpay = await release("GET", COLLECT_COUNTERPARTY);
    expect(revalidatedMoonpay.url).toContain("provider=moonpay");
    const bvnkRequest = await release("GET", READY_OFFRAMP);
    expect(bvnkRequest.url).toContain("provider=bvnk");

    await waitFor(() => expect(rendered.result.current.requirements.needsCollection).toBe(false));
  });
});
