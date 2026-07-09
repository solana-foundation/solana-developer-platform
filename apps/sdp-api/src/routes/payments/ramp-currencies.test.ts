import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { requirePermissions } from "@/middleware/auth";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import { listOfframpCurrencies, listOnrampCurrencies } from "./handlers/ramps";

type CurrencyPair = {
  source: string;
  dest: string;
  providers: readonly string[];
};

type CurrenciesResponse = {
  pairs: readonly CurrencyPair[];
  providerDetails: Record<string, unknown>;
};

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", async (c, next) => {
    c.set("apiKey", {
      id: "key_ramp_currency_test",
      organizationId: "org_ramp_currency_test",
      projectId: "prj_ramp_currency_test",
      role: "api_admin",
      permissions: ["payments:read"],
      environment: "sandbox",
      signingWalletId: null,
    });
    await next();
  });

  app.get(
    "/v1/payments/ramps/onramp/currency",
    requirePermissions("payments:read"),
    listOnrampCurrencies
  );
  app.get(
    "/v1/payments/ramps/offramp/currency",
    requirePermissions("payments:read"),
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
    expect(data.providerDetails.mural).toMatchObject({
      currencies: { USD: { min: null, max: null } },
      countrySupport: { coverage: "by-country" },
      entityTypes: ["business"],
    });
  });

  it("narrows on-ramp providerDetails when the provider query filter is present", async () => {
    const response = await buildApp().request(
      "/v1/payments/ramps/onramp/currency?source=USD&dest=usdc.solana&provider=mural",
      {},
      env
    );

    expect(response.status).toBe(200);
    const data = await responseData(response);

    expect(data.pairs).toEqual([{ source: "USD", dest: "usdc.solana", providers: ["mural"] }]);
    expect(Object.keys(data.providerDetails).sort()).toEqual(["mural"]);
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
      "/v1/payments/ramps/offramp/currency?source=usdc.solana&dest=USD&provider=bvnk",
      {},
      env
    );

    expect(response.status).toBe(200);
    const data = await responseData(response);

    expect(data.pairs).toEqual([{ source: "usdc.solana", dest: "USD", providers: ["bvnk"] }]);
    expect(Object.keys(data.providerDetails).sort()).toEqual(["bvnk"]);
  });
});
