import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { PaymentRampEstimate, PaymentRampQuote, SdpEnvironment } from "@sdp/types";
import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import type { RampDirection } from "@sdp/types/ramp-requirements";
import { SdpPaymentsError } from "../errors";
import { RAMP_PROVIDER_CLIENTS } from "./index";
import { MOONPAY_TEST_KIT } from "./providers/moonpay/test-kit";
import { STRIPE_TEST_KIT } from "./providers/stripe/test-kit";
import {
  type RampProviderTestKit,
  type RecordedExchange,
  type Replay,
  replayExchanges,
} from "./test-kit";
import type { RampProvider } from "./types";

/**
 * Every registered provider has a kit. A provider on its way out names the
 * ticket that removes it instead, so adding a provider to RAMP_PROVIDERS fails
 * typecheck until it has a kit.
 */
const KITS: Readonly<Record<RampProviderId, RampProviderTestKit | { removedBy: string }>> = {
  moonpay: MOONPAY_TEST_KIT,
  stripe: STRIPE_TEST_KIT,
  bvnk: { removedBy: "HOO-2037" },
  coinbase: { removedBy: "HOO-2035" },
};

const DECIMAL = /^\d+(\.\d+)?$/;
const MODES = ["sandbox", "production"] as const satisfies readonly SdpEnvironment[];

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function assertReplayed(replay: Replay): void {
  assert.deepEqual(replay.unrecorded, []);
  assert.ok(replay.exhausted(), "every recorded exchange is used");
}

function assertEstimateShape(
  estimate: PaymentRampEstimate,
  provider: RampProviderId,
  direction: RampDirection,
  input: { assetRail: string; fiatCurrency: string }
): void {
  assert.equal(estimate.provider, provider);
  assert.equal(estimate.direction, direction);
  assert.equal(estimate.assetRail, input.assetRail);
  assert.equal(estimate.fiatCurrency, input.fiatCurrency);
  for (const amount of [
    estimate.fiatAmount,
    estimate.cryptoAmount,
    estimate.exchangeRate,
    estimate.fees.total,
  ]) {
    assert.match(amount, DECIMAL);
  }
}

function assertQuoteShape(quote: PaymentRampQuote, provider: RampProviderId): void {
  assert.equal(quote.provider, provider);
  assert.ok(quote.id.trim() !== "", "a quote names the provider reference");
  switch (quote.deliveryMode) {
    case "hosted":
      assert.equal(new URL(quote.hostedUrl).protocol, "https:");
      return;
    case "session_widget":
      assert.ok(quote.clientSecret.trim() !== "");
      return;
    case "manual_instructions":
      assert.ok(quote.paymentInstructions.length > 0);
      return;
    default: {
      const exhaustive: never = quote;
      assert.fail(`Unknown delivery mode: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function estimateExchanges(
  kit: RampProviderTestKit,
  direction: RampDirection
): readonly RecordedExchange[] {
  const directionKit = direction === "onramp" ? kit.onramp : kit.offramp;
  assert.ok(directionKit, `the kit records an ${direction} estimate`);
  return directionKit.estimate.exchanges;
}

async function estimate(
  client: RampProvider,
  kit: RampProviderTestKit,
  direction: RampDirection,
  mode: SdpEnvironment
): Promise<PaymentRampEstimate> {
  const ctx = { env: kit.env, mode };
  if (direction === "onramp") {
    assert.ok(kit.onramp, "the kit records an onramp estimate");
    return client.estimateOnramp(ctx, kit.onramp.estimate.input);
  }
  assert.ok(kit.offramp, "the kit records an offramp estimate");
  return client.estimateOfframp(ctx, kit.offramp.estimate.input);
}

describe("ramp provider contract", () => {
  it("covers every registered provider", () => {
    assert.deepEqual(Object.keys(RAMP_PROVIDER_CLIENTS).sort(), [...RAMP_PROVIDERS].sort());
  });

  for (const provider of RAMP_PROVIDERS) {
    const kit = KITS[provider];
    if ("removedBy" in kit) {
      it(`${provider} has no kit because ${kit.removedBy} removes it`, () => {
        assert.match(kit.removedBy, /^HOO-\d+$/);
      });
      continue;
    }
    const client: RampProvider = RAMP_PROVIDER_CLIENTS[provider];

    describe(provider, () => {
      const onramp = kit.onramp;
      if (onramp !== undefined) {
        it("estimates an onramp in the contract shape", async () => {
          const replay = replayExchanges(onramp.estimate.exchanges);
          const result = await client.estimateOnramp(
            { env: kit.env, mode: "sandbox" },
            onramp.estimate.input
          );
          assertReplayed(replay);
          assertEstimateShape(result, provider, "onramp", onramp.estimate.input);
        });

        it("quotes an onramp in the shape of its delivery mode", async () => {
          assert.ok(client.createOnrampQuote, "a provider that runs onramp can quote it");
          const replay = replayExchanges(onramp.quote.exchanges);
          const quote = await client.createOnrampQuote(
            { env: kit.env, mode: "sandbox" },
            onramp.quote.input
          );
          assertReplayed(replay);
          assertQuoteShape(quote, provider);
        });
      }

      const offramp = kit.offramp;
      if (offramp !== undefined) {
        it("estimates an offramp in the contract shape", async () => {
          const replay = replayExchanges(offramp.estimate.exchanges);
          const result = await client.estimateOfframp(
            { env: kit.env, mode: "sandbox" },
            offramp.estimate.input
          );
          assertReplayed(replay);
          assertEstimateShape(result, provider, "offramp", offramp.estimate.input);
        });

        it("quotes an offramp in the shape of its delivery mode", async () => {
          const replay = replayExchanges(offramp.quote.exchanges);
          const quote = await client.createOfframpQuote(
            { env: kit.env, mode: "sandbox" },
            offramp.quote.input
          );
          assertReplayed(replay);
          assertQuoteShape(quote, provider);
        });
      }

      for (const mode of MODES) {
        it(`uses the ${mode} credentials for a ${mode} request`, async () => {
          const direction = onramp !== undefined ? "onramp" : "offramp";
          const replay = replayExchanges(estimateExchanges(kit, direction));
          await estimate(client, kit, direction, mode);
          assertReplayed(replay);
          for (const request of replay.requests) {
            assert.ok(kit.usesModeCredential(request, mode), `${request.method} ${request.url}`);
          }
        });
      }

      it("fails closed on a response it cannot read", async () => {
        const { direction, exchange } = kit.malformedEstimate;
        replayExchanges([exchange]);
        await assert.rejects(estimate(client, kit, direction, "sandbox"), (error: unknown) => {
          assert.ok(error instanceof SdpPaymentsError);
          assert.equal(error.code, "PROVIDER_UNAVAILABLE");
          assert.equal(error.message, `${provider} returned an unexpected response`);
          assert.ok(Array.isArray(error.diagnostics?.issues));
          return true;
        });
      });
    });
  }
});
