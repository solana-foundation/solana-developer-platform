import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "@/app";
import { getDb } from "@/db";
import app from "@/index";
import { noopObservability } from "@/runtime/observability";
import { env } from "@/test/helpers/env";
import {
  installPaymentsRouteTestHooks,
  TEST_API_KEY,
  TEST_ORG,
} from "@/test/helpers/payments-routes";

// provider-access must evaluate the same ramp provider stages as the ramp routes:
// the stages createApp was given, not the manifest (ADR 0005).

const moonpayInBetaApp = createApp({
  observability: noopObservability,
  rampProviderStages: { ...SDP_RAMP_PROVIDER_STAGES, moonpay: "beta" },
});

const providerAccessSchema = z.object({
  data: z.object({
    providers: z.object({ ramps: z.record(z.string(), z.object({ enabled: z.boolean() })) }),
  }),
});

async function rampsEnabled(on: typeof app, releaseChannel: string) {
  const response = await on.request(
    `/v1/organizations/${TEST_ORG.id}/provider-access`,
    { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
    { ...env, SDP_RELEASE_CHANNEL: releaseChannel }
  );
  expect(response.status).toBe(200);
  const ramps = providerAccessSchema.parse(await response.json()).data.providers.ramps;
  return Object.fromEntries(Object.entries(ramps).map(([id, entry]) => [id, entry.enabled]));
}

describe("GET /v1/organizations/:orgId/provider-access release channel", () => {
  installPaymentsRouteTestHooks();
  beforeEach(async () => {
    await getDb(env)
      .prepare("UPDATE organizations SET tier = 'enterprise' WHERE id = ?")
      .bind(TEST_ORG.id)
      .run();
  });

  it("follows the ramp provider stages the app runs", async () => {
    const onExperimental = await rampsEnabled(app, "experimental");
    expect(onExperimental.moonpay).toBe(true);

    expect((await rampsEnabled(app, "beta")).moonpay).toBe(false);
    const onBeta = await rampsEnabled(moonpayInBetaApp, "beta");
    expect(onBeta.moonpay).toBe(true);
    expect(onBeta.lightspark).toBe(false);
  });
});
