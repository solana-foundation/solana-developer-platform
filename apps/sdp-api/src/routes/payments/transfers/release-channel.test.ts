import {
  SDP_RAMP_PROVIDER_MATURITY,
  type SdpRampProviderMaturity,
  type SdpReleaseChannel,
} from "@sdp/types/release-channels";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import * as paymentContext from "@/routes/payments/context";
import * as wallets from "@/routes/payments/wallets";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import { transfers } from "./index";

const body = {
  sourceCustodyWalletId: "cwlt_source",
  destination: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  token: "USDC",
  amount: "1",
};

function buildApp(maturity: SdpRampProviderMaturity = SDP_RAMP_PROVIDER_MATURITY) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    c.set("rampProviderMaturity", maturity);
    c.set("projectId", "prj_channel_test");
    c.set("apiKey", {
      id: "key_channel_test",
      organizationId: "org_channel_test",
      projectId: "prj_channel_test",
      environment: "sandbox",
      grants: ALL_API_KEY_GRANTS,
      walletAccess: { scope: "all" },
    });
    await next();
  });
  app.route("/v1/payments/transfers", transfers);
  app.onError((error) => {
    if (error instanceof AppError)
      return new Response(JSON.stringify(error.toResponse()), {
        status: error.statusCode,
        headers: { "Content-Type": "application/json" },
      });
    throw error;
  });
  return app;
}

function request(
  app: ReturnType<typeof buildApp>,
  channel: SdpReleaseChannel,
  extra: Record<string, string>
) {
  return app.request(
    "/v1/payments/transfers/execute",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "channel-test" },
      body: JSON.stringify({ ...body, ...extra }),
    },
    { ...env, SDP_RELEASE_CHANNEL: channel }
  );
}

afterEach(() => vi.restoreAllMocks());

describe("transfer funding release channel", () => {
  it.each(["stable", "beta"] as const)(
    "%s refuses transferId before any wallet or ramp lookup",
    async (channel) => {
      const walletLookup = vi.spyOn(wallets, "resolveScope");
      const rampLookup = vi.spyOn(paymentContext, "getPaymentsRepository");
      const response = await request(buildApp(), channel, { transferId: "xfr_existing" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { message: expect.stringContaining('Unrecognized key: "transferId"') },
      });
      expect(walletLookup).not.toHaveBeenCalled();
      expect(rampLookup).not.toHaveBeenCalled();
    }
  );

  it.each(["stable", "experimental"] as const)(
    "%s still validates ordinary wallet transfers",
    async (channel) => {
      const walletLookup = vi
        .spyOn(wallets, "resolveScope")
        .mockRejectedValue(new AppError("NOT_FOUND", "Reached wallet authorization"));
      const response = await request(buildApp(), channel, {});
      expect(response.status).toBe(404);
      expect(walletLookup).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ["experimental", SDP_RAMP_PROVIDER_MATURITY],
    ["stable", { ...SDP_RAMP_PROVIDER_MATURITY, moonpay: "stable" }],
  ] as const)(
    "%s accepts transferId when a ramp provider is in the channel",
    async (channel, maturity) => {
      const walletLookup = vi
        .spyOn(wallets, "resolveScope")
        .mockRejectedValue(new AppError("NOT_FOUND", "Reached wallet authorization"));
      const response = await request(buildApp(maturity), channel, { transferId: "xfr_existing" });
      expect(response.status).toBe(404);
      expect(walletLookup).toHaveBeenCalledOnce();
    }
  );
});
