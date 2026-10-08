import {
  SDP_MODULES,
  SDP_RAMP_PROVIDER_STAGES,
  SDP_RELEASE_CHANNEL_NAMES,
  SDP_RELEASE_CHANNELS,
  type SdpModule,
  type SdpReleaseChannel,
} from "@sdp/types";
import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { noopObservability } from "@/runtime/observability";
import { env as baseEnv } from "@/test/helpers/env";

// One request per module, into a route that module owns. A module joins a
// release channel's exclusions only once its probe is refused here.
const MODULE_PROBES = {
  custody: [["GET", "/v1/wallets"]],
  payments: [["GET", "/v1/payments/transfers"]],
  recurring_payments: [["GET", "/v1/payments/recurring-payments"]],
  ramps: [
    ["GET", "/v1/payments/ramps/onramp/currency"],
    ["POST", "/webhooks/payments/ramps/sandbox/moonpay"],
    ["GET", "/v1/counterparties/cp_1/requirements"],
    ["POST", "/v1/counterparties/cp_1/requirements"],
    ["GET", "/v1/counterparties/cp_1/provider-accounts"],
  ],
  compliance: [["GET", "/v1/compliance"]],
  policies: [
    ["GET", "/v1/policies"],
    ["GET", "/v1/payments/wallets/wallet_1/policies"],
    ["PUT", "/v1/payments/wallets/wallet_1/policies"],
    ["GET", "/v1/payments/wallets/wallet_1/policies/evaluations"],
    ["POST", "/v1/api-keys/key_1/policy-profiles"],
    ["POST", "/v1/api-keys/key_1/policy-profiles/profile_1/revisions"],
    ["PUT", "/v1/api-keys/key_1/policy-bindings"],
  ],
  issuance: [
    ["GET", "/v1/issuance/templates"],
    ["GET", "/v1/issuance/asset-profiles"],
  ],
  // Markets has no route of its own: it is the parent of Earn and DvP, and
  // leaving it out refuses both.
  markets: [
    ["GET", "/v1/earn/movements"],
    ["GET", "/v1/dvp/trades"],
  ],
  earn: [["GET", "/v1/earn/movements"]],
  dvp: [["GET", "/v1/dvp/trades"]],
  private_channels: [["GET", "/v1/private-channels/health"]],
  helius_rings: [
    ["GET", "/v1/helius-rings/health"],
    ["GET", "/internal/dashboard/helius-rings/connections"],
  ],
} as const satisfies Record<SdpModule, readonly (readonly [string, string])[]>;

// Every module flag on, so only the release channel can refuse a request.
const ALL_FLAGS_ON = {
  MARKETS_ENABLED: "true",
  EARN_ENABLED: "true",
  PRIVATE_CHANNELS_ENABLED: "true",
  HELIUS_RINGS_ENABLED: "true",
  SDP_FLAG_ASSET_PROFILES: "true",
};

// Each probe is a distinct client, so the per-address anonymous rate limit
// never answers in place of the route under test.
let clientAddress = 0;
function nextClientHeaders() {
  clientAddress += 1;
  return { "x-forwarded-for": `10.0.${Math.floor(clientAddress / 256)}.${clientAddress % 256}` };
}

async function probe(releaseChannel: SdpReleaseChannel, module: SdpModule) {
  const app = createApp({
    rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
    observability: noopObservability,
  });
  const env = {
    ...baseEnv,
    ...ALL_FLAGS_ON,
    SDP_RELEASE_CHANNEL: releaseChannel,
    TRUST_PROXY_HEADERS: "true",
  };
  return Promise.all(
    MODULE_PROBES[module].map(([method, path]) =>
      app.request(path, { method, headers: nextClientHeaders() }, env)
    )
  );
}

describe("release channels at the API", () => {
  for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES) {
    const included = SDP_RELEASE_CHANNELS[releaseChannel];
    const excluded = SDP_MODULES.filter((module) => !included.includes(module));

    it.each(excluded)(`${releaseChannel}: refuses every %s route with 403`, async (module) => {
      for (const response of await probe(releaseChannel, module)) {
        expect(response.status).toBe(403);
      }
    });
  }

  // Balances share the wallet-policies router; the policy cut must not take them.
  it("stable: keeps wallet balances next to the cut policy routes", async () => {
    const app = createApp({
      observability: noopObservability,
      rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
    });
    const response = await app.request(
      "/v1/payments/wallets/wallet_1/balances",
      { headers: nextClientHeaders() },
      { ...baseEnv, SDP_RELEASE_CHANNEL: "stable", TRUST_PROXY_HEADERS: "true" }
    );
    expect([403, 429]).not.toContain(response.status);
  });

  it.each(SDP_MODULES)(
    "experimental: does not refuse %s routes once its flags are on",
    async (module) => {
      for (const response of await probe("experimental", module)) {
        // Past every gate: auth, validation or the provider answers instead. A
        // 429 would mean the rate limiter answered first and the probe proved nothing.
        expect([403, 429]).not.toContain(response.status);
      }
    }
  );
});

// Background jobs assert their own release channel gates against seeded rows:
// replay-ramp-webhook-events in webhooks.ramp-event-inbox.test.ts and
// reconcile-bvnk-onramp-payouts in its own test file.
