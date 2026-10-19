// @vitest-environment jsdom

import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CounterpartyRequirementsParams,
  paymentsQueryKeys,
} from "@/app/dashboard/[projectId]/payments/payments-query-key";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { useCounterpartyRequirements } from "./use-counterparty-requirements";

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
  provider: "moonpay",
  direction: "offramp",
  status: "collect",
  fields: [{ kind: "text", key: "taxResidence", label: "Tax residence", required: true }],
};

const COLLECT_COUNTERPARTY: CounterpartyRequirements = {
  provider: "moonpay",
  direction: "offramp",
  status: "collect",
  fields: [{ kind: "text", key: "fullName", label: "Full name", required: true }],
};

const READY_OFFRAMP: CounterpartyRequirements = {
  provider: "moonpay",
  direction: "offramp",
  status: "ready",
};

const OFFRAMP_PARAMS: CounterpartyRequirementsParams = {
  counterpartyId: "cpty_behavior",
  provider: "moonpay",
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
      submitPromise = result.current.submitRequirements(OFFRAMP_ADVANCE);
    });
    const advanceRequest = await release("POST", COLLECT_COUNTERPARTY);
    await submitPromise;

    expect(advanceRequest.body).toEqual({
      provider: "moonpay",
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
      submitPromise = rendered.result.current.submitRequirements(OFFRAMP_ADVANCE);
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
      submitPromise = result.current.submitRequirements(OFFRAMP_ADVANCE);
    });
    await release("POST", READY_OFFRAMP);
    await submitPromise;

    expect(result.current.onboarding).toEqual(READY_OFFRAMP);
  });

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
});
