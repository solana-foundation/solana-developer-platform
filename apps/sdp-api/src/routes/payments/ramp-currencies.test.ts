import { isRampProviderSurfaced, RAMP_PROVIDERS } from "@sdp/types/provider-access";
import { SDP_RAMP_PROVIDER_MATURITY } from "@sdp/types/release-channels";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { requireAction } from "@/middleware/require-action";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import { listOfframpCurrencies } from "./ramps/offramp/handlers";
import { listOnrampCurrencies } from "./ramps/onramp/handlers";

type CurrencyPair = {
  source: string;
  dest: string;
  providers: readonly string[];
};

type CurrenciesResponse = {
  pairs: readonly CurrencyPair[];
  providerDetails: Record<string, unknown>;
};

function buildApp(environment: "sandbox" | "production" = "sandbox") {
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", async (c, next) => {
    // createApp sets these stages on every request; this app mounts handlers directly.
    c.set("rampProviderMaturity", SDP_RAMP_PROVIDER_MATURITY);
    c.set("apiKey", {
      id: "key_ramp_currency_test",
      organizationId: "org_ramp_currency_test",
      projectId: "prj_ramp_currency_test",
      grants: ALL_API_KEY_GRANTS,
      environment,
      walletAccess: { scope: "all" } as const,
    });
    // projectContextMiddleware sets this for every actor in the real app.
    c.set("projectEnvironment", environment);
    await next();
  });

  app.get("/v1/payments/ramps/onramp/currency", requireAction("onramp.read"), listOnrampCurrencies);
  app.get(
    "/v1/payments/ramps/offramp/currency",
    requireAction("offramp.read"),
    listOfframpCurrencies
  );

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toResponse(), err.statusCode as 400);
    }
    throw err;
  });

  return app;
}

async function responseData(response: Response): Promise<CurrenciesResponse> {
  const body = (await response.json()) as { data: CurrenciesResponse };
  return body.data;
}

function sortedProvidersFromPairs(pairs: readonly CurrencyPair[]): string[] {
  return [...new Set(pairs.flatMap((pair) => pair.providers))].sort();
}

describe("ramp currency provider details", () => {
  it("returns on-ramp providerDetails keyed by the providers present in source and dest filtered pairs", async () => {
    const response = await buildApp().request(
      "/v1/payments/ramps/onramp/currency?source=USD&dest=usdc.solana",
      {},
      env
    );

    expect(response.status).toBe(200);
    const data = await responseData(response);

    expect(Object.keys(data.providerDetails).sort()).toEqual(sortedProvidersFromPairs(data.pairs));
    expect(data.providerDetails.stripe).toMatchObject({
      currencies: { USD: { min: null, max: null } },
      countrySupport: { coverage: "by-country" },
      entityTypes: ["individual"],
    });
  });

  it("narrows on-ramp providerDetails when the provider query filter is present", async () => {
    const response = await buildApp().request(
      "/v1/payments/ramps/onramp/currency?source=USD&dest=usdc.solana&provider=stripe",
      {},
      env
    );

    expect(response.status).toBe(200);
    const data = await responseData(response);

    expect(data.pairs).toEqual([{ source: "USD", dest: "usdc.solana", providers: ["stripe"] }]);
    expect(Object.keys(data.providerDetails).sort()).toEqual(["stripe"]);
  });

  it("returns off-ramp providerDetails keyed by the providers present in source and dest filtered pairs", async () => {
    const response = await buildApp().request(
      "/v1/payments/ramps/offramp/currency?source=usdc.solana&dest=USD",
      {},
      env
    );

    expect(response.status).toBe(200);
    const data = await responseData(response);

    expect(Object.keys(data.providerDetails).sort()).toEqual(sortedProvidersFromPairs(data.pairs));
  });

  it("narrows off-ramp providerDetails when the provider query filter is present", async () => {
    const response = await buildApp().request(
      "/v1/payments/ramps/offramp/currency?source=usdc.solana&dest=USD&provider=moonpay",
      {},
      env
    );

    expect(response.status).toBe(200);
    const data = await responseData(response);

    expect(data.pairs).toEqual([{ source: "usdc.solana", dest: "USD", providers: ["moonpay"] }]);
    expect(Object.keys(data.providerDetails).sort()).toEqual(["moonpay"]);
  });

  it("omits un-surfaced providers from listings even when the support matrix includes them", async () => {
    for (const direction of ["onramp", "offramp"] as const) {
      const response = await buildApp().request(
        `/v1/payments/ramps/${direction}/currency`,
        {},
        env
      );

      expect(response.status).toBe(200);
      const data = await responseData(response);

      for (const unsurfaced of RAMP_PROVIDERS.filter(
        (p) => !isRampProviderSurfaced(p, "sandbox")
      )) {
        expect(sortedProvidersFromPairs(data.pairs)).not.toContain(unsurfaced);
        expect(data.providerDetails).not.toHaveProperty(unsurfaced);
      }
    }
  });
});
