import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type { RampProviderEstimateResult } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "@/index";
import * as moneyPathEvents from "@/runtime/money-path-events";
import * as providerAvailability from "@/services/provider-availability.service";
import { env } from "@/test/helpers/env";
import {
  installPaymentsRouteTestHooks,
  seedCounterparty,
  seedProductionApiKey,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PRODUCTION_API_KEY,
} from "@/test/helpers/payments-routes";
import { countTransferRows } from "@/test/helpers/payments-transfers";
import { providerStages } from "@/test/helpers/provider-stages";
import { countTableRows } from "@/test/helpers/row-counts";

vi.mock("@sdp/types", async (importOriginal) => {
  const { mockProviderStages } = await import("@/test/helpers/provider-stages");
  return mockProviderStages(await importOriginal<typeof import("@sdp/types")>());
});

const MOONPAY_NOT_STABLE_MESSAGE =
  "MoonPay is not stable yet, so a production project cannot use it.";
const MOONPAY_STAGE_REFUSAL_BODY = {
  error: {
    code: "FORBIDDEN",
    message: MOONPAY_NOT_STABLE_MESSAGE,
    details: { reason: "provider_stage_not_allowed" },
  },
  meta: { requestId: expect.any(String) },
};

function postRamp(path: string, apiKey: string, body: Record<string, unknown>) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
    env
  );
}

async function expectNoQuoteWrites(): Promise<void> {
  expect(await countTableRows("payment_transfers")).toBe(0);
  expect(await countTableRows("approval_requests")).toBe(0);
  expect(await countTableRows("wallet_operations")).toBe(0);
}

describe("Payments routes — ramps in a Production project", () => {
  installPaymentsRouteTestHooks();

  beforeEach(async () => {
    providerStages.rampStageOverride = { provider: "moonpay", stage: "beta" };
    providerStages.moduleStageOverride = null;
    await seedProductionApiKey();
  });

  it("refuses a Production on-ramp quote for a non-stable provider before any provider call or write", async () => {
    const createOnrampQuote = vi.spyOn(RAMP_PROVIDER_CLIENTS.moonpay, "createOnrampQuote");

    const response = await postRamp(
      "/v1/payments/ramps/onramp/quote",
      TEST_PRODUCTION_API_KEY.raw,
      {
        provider: "moonpay",
        counterpartyId: "cpty_production_stage_onramp",
        destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        assetRail: "sol.solana",
        fiatCurrency: "USD",
        fiatAmount: "120.50",
      }
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(MOONPAY_STAGE_REFUSAL_BODY);
    expect(createOnrampQuote).not.toHaveBeenCalled();
    await expectNoQuoteWrites();
    createOnrampQuote.mockRestore();
  });

  it("refuses a Production off-ramp quote for a non-stable provider before any provider call or write", async () => {
    const createOfframpQuote = vi.spyOn(RAMP_PROVIDER_CLIENTS.moonpay, "createOfframpQuote");

    const response = await postRamp(
      "/v1/payments/ramps/offramp/quote",
      TEST_PRODUCTION_API_KEY.raw,
      {
        provider: "moonpay",
        counterpartyId: "cpty_production_stage_offramp",
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        assetRail: "sol.solana",
        fiatCurrency: "USD",
        cryptoAmount: "75.25",
      }
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(MOONPAY_STAGE_REFUSAL_BODY);
    expect(createOfframpQuote).not.toHaveBeenCalled();
    await expectNoQuoteWrites();
    createOfframpQuote.mockRestore();
  });

  it("quotes the same non-stable provider from a Sandbox project", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "production_stage_sandbox" });
    const createOnrampQuote = vi.spyOn(RAMP_PROVIDER_CLIENTS.moonpay, "createOnrampQuote");

    const response = await postRamp("/v1/payments/ramps/onramp/quote", TEST_API_KEY.raw, {
      provider: "moonpay",
      counterpartyId,
      destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      assetRail: "sol.solana",
      fiatCurrency: "USD",
      fiatAmount: "120.50",
    });

    expect(response.status).toBe(200);
    const body: { data: { quote: { provider: string }; transferId: string } } =
      await response.json();
    expect(body.data.quote.provider).toBe("moonpay");
    expect(createOnrampQuote).toHaveBeenCalledTimes(1);
    expect(await countTransferRows()).toBe(1);
    createOnrampQuote.mockRestore();
  });

  it("answers a Production estimate's non-stable provider as a reasoned error logged once at info, from one facts load", async () => {
    const loadProjectProviderVerdict = vi.spyOn(providerAvailability, "loadProjectProviderVerdict");
    const logEvent = vi.spyOn(moneyPathEvents, "logEvent");
    const estimateOnramp = vi.spyOn(RAMP_PROVIDER_CLIENTS.moonpay, "estimateOnramp");

    const response = await postRamp(
      "/v1/payments/ramps/onramp/estimate",
      TEST_PRODUCTION_API_KEY.raw,
      { assetRail: "sol.solana", fiatCurrency: "USD", fiatAmount: "100.00" }
    );

    expect(response.status).toBe(200);
    const body: { data: { estimates: RampProviderEstimateResult[] } } = await response.json();
    expect(body.data.estimates).toContainEqual({
      provider: "moonpay",
      status: "error",
      error: MOONPAY_NOT_STABLE_MESSAGE,
      reason: "provider_stage_not_allowed",
    });
    expect(estimateOnramp).not.toHaveBeenCalled();
    expect(loadProjectProviderVerdict).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls.filter(([, payload]) => payload.provider === "moonpay")).toEqual([
      [
        "info",
        {
          event: "sdp_api_ramp_provider_refused",
          provider: "moonpay",
          organization_id: TEST_ORG.id,
          reason: "provider_stage_not_allowed",
        },
      ],
    ]);
    expect(logEvent.mock.calls.filter(([level]) => level !== "info")).toEqual([]);
    loadProjectProviderVerdict.mockRestore();
    logEvent.mockRestore();
    estimateOnramp.mockRestore();
  });
});
