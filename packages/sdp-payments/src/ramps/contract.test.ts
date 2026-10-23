import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import {
  type PaymentRampEstimate,
  type PaymentRampQuote,
  RAMP_DIRECTIONS,
  type RampDirection,
} from "@sdp/types/payments";
import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import { SdpPaymentsError } from "#/errors";
import { RAMP_PROVIDER_CLIENTS } from "./index";
import { MOONPAY_TEST_KIT } from "./providers/moonpay/test-kit";
import { STRIPE_TEST_KIT } from "./providers/stripe/test-kit";
import { checkRampCredentials, checkRampWebhookSecret } from "./shared";
import {
  type RampProviderTestKit,
  type RecordedExchange,
  type Replay,
  rampTestRuntime,
  replayExchanges,
} from "./test-kit";
import {
  RAMP_DIRECTION_MEMBERS,
  type RampProvider,
  type RampProviderCredentials,
  type RampRuntimeContext,
  supportsRampDirection,
} from "./types";

/**
 * Every registered provider has a kit. A provider on its way out names the
 * ticket that removes it instead, so adding a provider to RAMP_PROVIDERS fails
 * typecheck until it has a kit.
 */
const KITS = {
  moonpay: MOONPAY_TEST_KIT,
  stripe: STRIPE_TEST_KIT,
} as const satisfies Record<RampProviderId, RampProviderTestKit>;

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

function isProviderNotConfigured(cause: unknown): boolean {
  assert.ok(cause instanceof SdpPaymentsError);
  assert.equal(cause.code, "PROVIDER_NOT_CONFIGURED");
  return true;
}

/** The kit's cases for `direction`, or undefined when the provider does not run it. */
function casesFor(kit: RampProviderTestKit, direction: RampDirection) {
  return direction === "onramp" ? kit.onramp : kit.offramp;
}

/** The kit's keys for the other mode, which every call in `mode` refuses. */
function otherModeCredentials(
  kit: RampProviderTestKit,
  mode: SdpEnvironment
): RampProviderCredentials {
  return mode === "sandbox" ? kit.liveCredentials : kit.credentials;
}

async function runEstimate(
  client: RampProvider,
  kit: RampProviderTestKit,
  direction: RampDirection,
  ctx: RampRuntimeContext
): Promise<PaymentRampEstimate> {
  if (direction === "onramp") {
    assert.ok(kit.onramp, "the kit records an onramp");
    assert.ok(supportsRampDirection(client, "onramp"), "a provider with onramp cases runs onramp");
    return client.estimateOnramp(ctx, kit.onramp.estimate.input);
  }
  assert.ok(kit.offramp, "the kit records an offramp");
  assert.ok(supportsRampDirection(client, "offramp"), "a provider with offramp cases runs offramp");
  return client.estimateOfframp(ctx, kit.offramp.estimate.input);
}

async function runQuote(
  client: RampProvider,
  kit: RampProviderTestKit,
  direction: RampDirection,
  ctx: RampRuntimeContext
): Promise<PaymentRampQuote> {
  if (direction === "onramp") {
    assert.ok(kit.onramp, "the kit records an onramp");
    assert.ok(supportsRampDirection(client, "onramp"), "a provider with onramp cases runs onramp");
    return client.createOnrampQuote(ctx, kit.onramp.quote.input);
  }
  assert.ok(kit.offramp, "the kit records an offramp");
  assert.ok(supportsRampDirection(client, "offramp"), "a provider with offramp cases runs offramp");
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
    default: {
      const exhaustive: never = quote;
      assert.fail(`Unknown delivery mode: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function assertRequestCredentials(kit: RampProviderTestKit, replay: Replay): void {
  for (const request of replay.requests) {
    assert.ok(kit.usesCredentials(request), `${request.method} ${request.url} carries the keys`);
  }
}

function assertQuoteCredentials(
  kit: RampProviderTestKit,
  replay: Replay,
  quote: PaymentRampQuote
): void {
  assertRequestCredentials(kit, replay);
  const { quoteUsesCredentials } = kit;
  if (quoteUsesCredentials === undefined) {
    assert.ok(replay.requests.length > 0, "a quote built without a request needs a quote check");
    return;
  }
  assert.ok(quoteUsesCredentials(quote), "the quote carries the keys");
}

describe("ramp provider contract", () => {
  it("covers every registered provider", () => {
    assert.deepEqual(Object.keys(RAMP_PROVIDER_CLIENTS).sort(), [...RAMP_PROVIDERS].sort());
  });

  for (const provider of RAMP_PROVIDERS) {
    const kit = KITS[provider];
    const client: RampProvider = RAMP_PROVIDER_CLIENTS[provider];
    const sandbox = rampTestRuntime("sandbox", kit.credentials);

    describe(provider, () => {
      it("has every member of a direction or none", () => {
        for (const direction of RAMP_DIRECTIONS) {
          const present = RAMP_DIRECTION_MEMBERS[direction].filter(
            (member) => client[member] !== undefined
          );
          assert.ok(
            present.length === 0 || present.length === RAMP_DIRECTION_MEMBERS[direction].length,
            `${direction} members: ${present.join(", ")}`
          );
        }
      });

      it("records a direction exactly when it runs it", () => {
        for (const direction of RAMP_DIRECTIONS) {
          assert.equal(
            casesFor(kit, direction) !== undefined,
            supportsRampDirection(client, direction),
            direction
          );
        }
      });

      it("accepts keys only in the mode they name", () => {
        const { credentials, liveCredentials } = kit;
        assert.equal(checkRampCredentials(client, credentials, "sandbox"), null);
        assert.equal(checkRampCredentials(client, liveCredentials, "production"), null);
        assert.equal(
          checkRampCredentials(client, liveCredentials, "sandbox"),
          `${client.label} sandbox keys must be test-mode keys.`
        );
        assert.equal(
          checkRampCredentials(client, credentials, "production"),
          `${client.label} production keys must be live-mode keys.`
        );
        for (const mixed of [
          { ...credentials, publicKey: liveCredentials.publicKey },
          { ...credentials, secretKey: liveCredentials.secretKey },
        ]) {
          for (const mode of SDP_ENVIRONMENTS) {
            assert.notEqual(
              checkRampCredentials(client, mixed, mode),
              null,
              `mixed keys in ${mode}`
            );
          }
        }
      });

      it("declares the same keys in both modes", () => {
        assert.deepEqual(
          Object.keys(client.keyFormats.sandbox).sort(),
          Object.keys(client.keyFormats.production).sort()
        );
      });

      // sdp-infra mounts `placeholder` for a listed secret Doppler hasn't synced.
      it("refuses an unsynced `placeholder` for every key in both modes", () => {
        for (const mode of SDP_ENVIRONMENTS) {
          for (const [role, format] of Object.entries(client.keyFormats[mode])) {
            assert.equal(format.test("placeholder"), false, `${mode} ${role}`);
          }
        }
      });

      it("declares a webhook secret exactly when its kit carries webhook secrets", () => {
        assert.equal(
          client.keyFormats.sandbox.webhookSecret !== undefined,
          kit.webhookSecrets !== undefined
        );
      });

      it("accepts a webhook secret in its mode, and the other mode's where its format names one", (t) => {
        const secrets = kit.webhookSecrets;
        if (secrets === undefined) {
          t.skip(`${provider} takes no webhooks`);
          return;
        }
        for (const mode of SDP_ENVIRONMENTS) {
          assert.equal(checkRampWebhookSecret(client, secrets[mode], mode), null, mode);
        }
        const namesMode =
          client.keyFormats.sandbox.webhookSecret?.source !==
          client.keyFormats.production.webhookSecret?.source;
        if (namesMode) {
          assert.equal(
            checkRampWebhookSecret(client, secrets.production, "sandbox"),
            `${client.label} sandbox webhook secret has the wrong format.`
          );
          assert.equal(
            checkRampWebhookSecret(client, secrets.sandbox, "production"),
            `${client.label} production webhook secret has the wrong format.`
          );
        }
      });

      for (const direction of RAMP_DIRECTIONS) {
        const cases = casesFor(kit, direction);
        if (cases === undefined) {
          continue;
        }

        for (const mode of SDP_ENVIRONMENTS) {
          it(`refuses an ${direction} in ${mode} on the other mode's keys before any request`, async () => {
            const ctx = rampTestRuntime(mode, otherModeCredentials(kit, mode));
            await assert.rejects(
              replayed([], () => runEstimate(client, kit, direction, ctx)),
              isProviderNotConfigured
            );
            await assert.rejects(
              replayed([], () => runQuote(client, kit, direction, ctx)),
              isProviderNotConfigured
            );
          });
        }

        it(`estimates an ${direction} to the contract`, async () => {
          const { result, replay } = await replayed(cases.estimate.exchanges, () =>
            runEstimate(client, kit, direction, sandbox)
          );
          assertEstimateContract(result, provider, direction, cases.estimate.input);
          assertRequestCredentials(kit, replay);
        });

        it(`quotes an ${direction} for its delivery mode`, async () => {
          const { result, replay } = await replayed(cases.quote.exchanges, () =>
            runQuote(client, kit, direction, sandbox)
          );
          assertQuoteContract(result, provider);
          assertQuoteCredentials(kit, replay, result);
        });
      }

      it("records at least one status lookup", () => {
        assert.ok(Object.keys(kit.transferStatus).length > 0);
      });

      for (const [name, statusCase] of Object.entries(kit.transferStatus)) {
        for (const mode of SDP_ENVIRONMENTS) {
          it(`refuses to look up ${name} in ${mode} on the other mode's keys before any request`, async () => {
            const ctx = rampTestRuntime(mode, otherModeCredentials(kit, mode));
            await assert.rejects(
              replayed([], () => client.fetchTransferStatus(ctx, statusCase.input)),
              isProviderNotConfigured
            );
          });
        }

        it(`looks up ${name} with one request`, async () => {
          const { result, replay } = await replayed(statusCase.exchanges, () =>
            client.fetchTransferStatus(sandbox, statusCase.input)
          );
          assert.equal(replay.requests.length, 1, "a status lookup makes one request");
          assertRequestCredentials(kit, replay);
          assert.deepEqual(result, statusCase.events);
        });
      }

      it("fails closed on a response it cannot read", async () => {
        const { direction, exchange } = kit.malformedEstimate;
        replayExchanges([exchange]);
        await assert.rejects(runEstimate(client, kit, direction, sandbox), (cause: unknown) => {
          assert.ok(cause instanceof SdpPaymentsError);
          assert.equal(cause.code, "PROVIDER_RESPONSE_INVALID");
          assert.equal(cause.message, `${provider} returned an unexpected response`);
          assert.ok(Array.isArray(cause.diagnostics?.issues));
          return true;
        });
      });
    });
  }
});
