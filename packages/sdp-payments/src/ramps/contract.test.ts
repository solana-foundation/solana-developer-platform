import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  type PaymentRampEstimate,
  type PaymentRampQuote,
  RAMP_DIRECTIONS,
  type RampDirection,
  SDP_ENVIRONMENTS,
  type SdpEnvironment,
} from "@sdp/types";
import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
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
const KITS = {
  moonpay: MOONPAY_TEST_KIT,
  stripe: STRIPE_TEST_KIT,
  bvnk: { removedBy: "HOO-2037" },
  coinbase: { removedBy: "HOO-2035" },
} as const satisfies Record<RampProviderId, RampProviderTestKit | { removedBy: string }>;

const DECIMAL = /^\d+(\.\d+)?$/;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Runs `operation` against a replay of `exchanges`. A request no exchange
 * matched fails the test with its reason before the provider error it caused.
 */
async function replayed<T>(
  exchanges: readonly RecordedExchange[],
  operation: () => Promise<T>
): Promise<{ result: T; replay: Replay }> {
  const replay = replayExchanges(exchanges);
  const settled = await operation().then(
    (result) => ({ ok: true as const, result }),
    (cause: unknown) => ({ ok: false as const, cause })
  );
  assert.deepEqual(replay.unrecorded, [], "every request matches a recorded exchange");
  if (!settled.ok) {
    throw settled.cause;
  }
  assert.ok(replay.exhausted(), "every recorded exchange is used");
  return { result: settled.result, replay };
}

/** The kit's cases for `direction`, or undefined when the provider does not run it. */
function casesFor(kit: RampProviderTestKit, direction: RampDirection) {
  return direction === "onramp" ? kit.onramp : kit.offramp;
}

async function runEstimate(
  client: RampProvider,
  kit: RampProviderTestKit,
  direction: RampDirection,
  mode: SdpEnvironment
): Promise<PaymentRampEstimate> {
  const ctx = { env: kit.env, mode };
  if (direction === "onramp") {
    assert.ok(kit.onramp, "the kit records an onramp");
    return client.estimateOnramp(ctx, kit.onramp.estimate.input);
  }
  assert.ok(kit.offramp, "the kit records an offramp");
  return client.estimateOfframp(ctx, kit.offramp.estimate.input);
}

async function runQuote(
  client: RampProvider,
  kit: RampProviderTestKit,
  direction: RampDirection,
  mode: SdpEnvironment
): Promise<PaymentRampQuote> {
  const ctx = { env: kit.env, mode };
  if (direction === "onramp") {
    assert.ok(kit.onramp, "the kit records an onramp");
    assert.ok(client.createOnrampQuote, "a provider that runs onramp can quote it");
    return client.createOnrampQuote(ctx, kit.onramp.quote.input);
  }
  assert.ok(kit.offramp, "the kit records an offramp");
  return client.createOfframpQuote(ctx, kit.offramp.quote.input);
}

function assertEstimateContract(
  estimate: PaymentRampEstimate,
  provider: RampProviderId,
  direction: RampDirection,
  input: Pick<PaymentRampEstimate, "assetRail" | "fiatCurrency">
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

function assertQuoteContract(quote: PaymentRampQuote, provider: RampProviderId): void {
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

function assertRequestCredentials(
  kit: RampProviderTestKit,
  replay: Replay,
  mode: SdpEnvironment
): void {
  for (const request of replay.requests) {
    assert.ok(
      kit.usesModeCredential(request, mode),
      `${request.method} ${request.url} carries the ${mode} credential`
    );
  }
}

function assertQuoteCredentials(
  kit: RampProviderTestKit,
  replay: Replay,
  quote: PaymentRampQuote,
  mode: SdpEnvironment
): void {
  assertRequestCredentials(kit, replay, mode);
  const { quoteUsesModeCredential } = kit;
  if (quoteUsesModeCredential === undefined) {
    assert.ok(replay.requests.length > 0, "a quote built without a request needs a quote check");
    return;
  }
  assert.ok(quoteUsesModeCredential(quote, mode), `the quote carries the ${mode} credential`);
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
      for (const direction of RAMP_DIRECTIONS) {
        const cases = casesFor(kit, direction);
        if (cases === undefined) {
          continue;
        }
        for (const mode of SDP_ENVIRONMENTS) {
          it(`estimates an ${direction} in ${mode} to the contract`, async () => {
            const { result, replay } = await replayed(cases.estimate.exchanges, () =>
              runEstimate(client, kit, direction, mode)
            );
            assertEstimateContract(result, provider, direction, cases.estimate.input);
            assertRequestCredentials(kit, replay, mode);
          });

          it(`quotes an ${direction} in ${mode} for its delivery mode`, async () => {
            const { result, replay } = await replayed(cases.quote.exchanges, () =>
              runQuote(client, kit, direction, mode)
            );
            assertQuoteContract(result, provider);
            assertQuoteCredentials(kit, replay, result, mode);
          });
        }
      }

      it("fails closed on a response it cannot read", async () => {
        const { direction, exchange } = kit.malformedEstimate;
        replayExchanges([exchange]);
        await assert.rejects(runEstimate(client, kit, direction, "sandbox"), (cause: unknown) => {
          assert.ok(cause instanceof SdpPaymentsError);
          assert.equal(cause.code, "PROVIDER_UNAVAILABLE");
          assert.equal(cause.message, `${provider} returned an unexpected response`);
          assert.ok(Array.isArray(cause.diagnostics?.issues));
          return true;
        });
      });
    });
  }
});
