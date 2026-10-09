import type { CustodyMode, CustodyProvider } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import app from "@/index";
import { env } from "@/test/helpers/env";
import {
  installPaymentsRouteTestHooks,
  TEST_API_KEY,
  TEST_ORG,
} from "@/test/helpers/payments-routes";

const excludedCustodyPairs = vi.hoisted(() => new Set<`${CustodyProvider}:${CustodyMode}`>());

vi.mock(import("@sdp/types/release-channels"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    isCustodyProviderInReleaseChannel: (releaseChannel, provider, mode) =>
      !excludedCustodyPairs.has(`${provider}:${mode}`) &&
      original.isCustodyProviderInReleaseChannel(releaseChannel, provider, mode),
  };
});

const availabilityEntrySchema = z.object({
  entitled: z.boolean(),
  configured: z.boolean(),
  enabled: z.boolean(),
});

const providerAccessSchema = z.object({
  data: z.object({
    providers: z.object({ custody: z.record(z.string(), availabilityEntrySchema) }),
  }),
});

const configuredCustodyEnv = {
  ...env,
  PRIVY_APP_ID: "privy_provider_access_app",
  PRIVY_APP_SECRET: "privy_provider_access_secret",
  TURNKEY_API_PUBLIC_KEY: "turnkey_provider_access_public_key",
  TURNKEY_API_PRIVATE_KEY: "turnkey_provider_access_private_key",
  TURNKEY_ORGANIZATION_ID: "turnkey_provider_access_org",
};

async function custodyAccess() {
  const response = await app.request(
    `/v1/organizations/${TEST_ORG.id}/provider-access`,
    { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
    configuredCustodyEnv
  );
  expect(response.status).toBe(200);
  return providerAccessSchema.parse(await response.json()).data.providers.custody;
}

describe("GET /v1/organizations/:orgId/provider-access custody release channel", () => {
  installPaymentsRouteTestHooks();
  beforeEach(() => {
    excludedCustodyPairs.clear();
  });

  it("offers a configured, entitled custody provider while every pair is in channel", async () => {
    const custody = await custodyAccess();

    expect(custody.privy).toEqual({ entitled: true, configured: true, enabled: true });
    expect(custody.turnkey).toEqual({ entitled: true, configured: true, enabled: true });
  });

  it.each(["managed", "byok"] as const)(
    "keeps Privy enabled while only its %s pair is out of channel",
    async (mode) => {
      const inChannel = await custodyAccess();
      excludedCustodyPairs.add(`privy:${mode}`);

      expect(await custodyAccess()).toEqual(inChannel);
    }
  );

  it("disables Privy once both of its pairs are out of channel", async () => {
    const inChannel = await custodyAccess();
    excludedCustodyPairs.add("privy:managed");
    excludedCustodyPairs.add("privy:byok");

    expect(await custodyAccess()).toEqual({
      ...inChannel,
      privy: { entitled: true, configured: true, enabled: false },
    });
  });

  it("disables a provider without a BYOK runtime once its Managed pair is out of channel", async () => {
    const inChannel = await custodyAccess();
    excludedCustodyPairs.add("turnkey:managed");

    expect(await custodyAccess()).toEqual({
      ...inChannel,
      turnkey: { entitled: true, configured: true, enabled: false },
    });
  });
});
