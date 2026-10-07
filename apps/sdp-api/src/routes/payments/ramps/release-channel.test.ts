import { RAMP_PROVIDERS, SDP_RAMP_PROVIDER_STAGES, type SdpRampProviderStages } from "@sdp/types";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { requirePermissions } from "@/middleware/auth";
import { getCounterpartyRequirements } from "@/routes/counterparties/handlers";
import { listCounterpartyProviderAccounts } from "@/routes/counterparty-provider-accounts/handlers";
import { env as baseEnv } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import events from "./events";
import { listOfframpCurrencies } from "./offramp/handlers";
import { listOnrampCurrencies } from "./onramp/handlers";
import { filterProviders, resolveRampQuoteRequest } from "./shared";

// Today every provider is `experimental`, so a `beta` deployment leaves them all
// out. These stages put MoonPay in `beta` and keep every other provider out.
const MOONPAY_ONLY: SdpRampProviderStages = { ...SDP_RAMP_PROVIDER_STAGES, moonpay: "beta" };
const env: Env = { ...baseEnv, SDP_RELEASE_CHANNEL: "beta" };

function buildApp(stages: SdpRampProviderStages) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    c.set("rampProviderStages", stages);
    c.set("projectId", "prj_ramp_channel_test");
    c.set("apiKey", {
      id: "key_ramp_channel_test",
      organizationId: "org_ramp_channel_test",
      projectId: "prj_ramp_channel_test",
      role: "api_admin",
      permissions: ["payments:read", "payments:write", "counterparties:read"],
      environment: "sandbox",
      signingWalletId: null,
    });
    await next();
  });
  app.get("/onramp/currency", requirePermissions("payments:read"), listOnrampCurrencies);
  app.get("/offramp/currency", requirePermissions("payments:read"), listOfframpCurrencies);
  app.get("/offered", (c) => c.json({ providers: filterProviders(c, RAMP_PROVIDERS, undefined) }));
  app.post("/onramp/quote", async (c) => {
    await resolveRampQuoteRequest(
      c,
      "onramp",
      {
        provider: "lightspark",
        counterpartyId: "cp_ramp_channel_test",
        destinationCustodyWalletId: "cw_ramp_channel_test",
        assetRail: "usdc.solana",
        fiatCurrency: "USD",
        fiatAmount: "100",
      },
      "cw_ramp_channel_test"
    );
    return c.body(null, 204);
  });
  app.get("/counterparties/:counterpartyId/requirements", getCounterpartyRequirements);
  app.get("/counterparties/:counterpartyId/provider-accounts", listCounterpartyProviderAccounts);
  app.route("/", events);
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toResponse(), err.statusCode as 400);
    }
    throw err;
  });
  return app;
}

async function providersListed(response: Response): Promise<string[]> {
  const body = (await response.json()) as {
    data: { pairs: { providers: string[] }[] };
  };
  return [...new Set(body.data.pairs.flatMap((pair) => pair.providers))].sort();
}

describe("ramp providers outside the release channel", () => {
  const app = buildApp(MOONPAY_ONLY);

  it("offers only the providers in the release channel", async () => {
    const response = await app.request("/offered", {}, env);
    expect(await response.json()).toEqual({ providers: ["moonpay"] });
  });

  it.each(["onramp", "offramp"])("lists only included providers' %s currencies", async (dir) => {
    const response = await app.request(`/${dir}/currency`, {}, env);
    expect(response.status).toBe(200);
    expect(await providersListed(response)).toEqual(["moonpay"]);
  });

  it.each([
    ["GET", "/onramp/currency?provider=lightspark"],
    ["GET", "/offramp/currency?provider=lightspark"],
    ["POST", "/onramp/quote"],
    [
      "GET",
      "/counterparties/cp_1/requirements?provider=lightspark&direction=onramp&assetRail=usdc.solana&fiatCurrency=USD&destinationCustodyWalletId=cw_1",
    ],
    ["GET", "/counterparties/cp_1/provider-accounts?provider=lightspark"],
    ["POST", "/coinbase/events"],
    ["POST", "/moneygram/events"],
  ])("refuses %s %s, which names an excluded provider, with 403", async (method, path) => {
    const response = await app.request(path, { method }, env);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("not available in this release channel") },
    });
  });

  it("serves an included provider's client events past the release channel gate", async () => {
    const included = buildApp({ ...MOONPAY_ONLY, coinbase: "beta" });
    // An empty body fails validation: the request got past the gate.
    const response = await included.request("/coinbase/events", { method: "POST" }, env);
    expect(response.status).toBe(400);
  });
});
