import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SdpPaymentsError, type SdpPaymentsErrorCode } from "#/errors";
import { RAMP_PROVIDER_CLIENTS } from "#/ramps/index";
import { CONTRACT_DELIVERY_SIGNATURE, CONTRACT_WALLET, replayExchanges } from "#/ramps/test-kit";
import type { RampTransferLookup } from "#/ramps/types";
import {
  STRIPE_COMPLETED_SESSION,
  STRIPE_SESSION_TERMS,
  STRIPE_TEST_KIT,
  stripeSessionLookupExchange,
} from "./test-kit";

const LOOKUP: RampTransferLookup = {
  transferId: "xfr_5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e",
  rampType: "onramp",
  providerReference: "cos_contract",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Looks `lookup` up against `exchanges`, counting requests. */
async function lookUp(
  exchanges: ReturnType<typeof stripeSessionLookupExchange>[],
  lookup: RampTransferLookup
) {
  const replay = replayExchanges(exchanges);
  const settled = await RAMP_PROVIDER_CLIENTS.stripe
    .fetchTransferStatus({ env: STRIPE_TEST_KIT.env, mode: "sandbox" }, lookup)
    .then(
      (events) => ({ ok: true as const, events }),
      (cause: unknown) => ({ ok: false as const, cause })
    );
  return { settled, requests: replay.requests.length + replay.unrecorded.length };
}

/** The events a lookup answers for a session in `status` with `details`. */
async function eventsFor(status: string, details: Record<string, unknown>) {
  const { settled, requests } = await lookUp(
    [
      stripeSessionLookupExchange(200, {
        ...STRIPE_COMPLETED_SESSION,
        status,
        transaction_details: details,
      }),
    ],
    LOOKUP
  );
  assert.equal(requests, 1, "a lookup makes one request");
  assert.ok(settled.ok, "the lookup succeeds");
  return settled.events;
}

function failsWith(
  result: Awaited<ReturnType<typeof lookUp>>,
  code: SdpPaymentsErrorCode,
  requests: number,
  message?: string
) {
  assert.equal(result.requests, requests);
  assert.ok(!result.settled.ok, "the lookup fails");
  assert.ok(result.settled.cause instanceof SdpPaymentsError);
  assert.equal(result.settled.cause.code, code);
  if (message !== undefined) {
    assert.equal(result.settled.cause.message, message);
  }
}

const COMPLETED_DETAILS = STRIPE_COMPLETED_SESSION.transaction_details;

describe("StripeRampClient.fetchTransferStatus", () => {
  it("maps each session status as its webhook does", async () => {
    assert.deepEqual(await eventsFor("requires_payment", STRIPE_SESSION_TERMS), [
      { provider: "stripe", kind: "awaiting_payment", reference: "cos_contract" },
    ]);
    assert.deepEqual(await eventsFor("fulfillment_processing", STRIPE_SESSION_TERMS), [
      { provider: "stripe", kind: "settling", reference: "cos_contract" },
    ]);
    assert.deepEqual(await eventsFor("rejected", STRIPE_SESSION_TERMS), [
      {
        provider: "stripe",
        kind: "failed",
        reference: "cos_contract",
        error: "Stripe rejected the on-ramp session.",
      },
    ]);
    assert.deepEqual(await eventsFor("initialized", STRIPE_SESSION_TERMS), [
      { provider: "stripe", kind: "ignore", reason: "untracked_status:initialized" },
    ]);
    for (const status of ["fulfillment_paused", "toString"]) {
      assert.deepEqual(await eventsFor(status, STRIPE_SESSION_TERMS), [
        {
          provider: "stripe",
          kind: "ignore",
          reason: `unsupported_status:${status}`,
          unmappedStatus: status,
        },
      ]);
    }
  });

  it("reports the rail a completed session delivered, null for an asset SDP does not sell", async () => {
    const railFor = async (currency: string, network: string) => {
      const [event] = await eventsFor("fulfillment_complete", {
        ...COMPLETED_DETAILS,
        destination_currency: currency,
        destination_network: network,
      });
      assert.ok(event?.kind === "settled");
      return event.deliveredAssetRail;
    };

    assert.equal(await railFor("sol", "solana"), "sol.solana");
    assert.equal(await railFor("usdc", "ethereum"), null);
    assert.equal(await railFor("eth", "solana"), null);
  });

  it("reads a session that leaves out the fields it does not report", async () => {
    assert.deepEqual(
      await eventsFor("fulfillment_complete", {
        destination_currency: "usdc",
        destination_network: "solana",
      }),
      [
        {
          provider: "stripe",
          kind: "settled",
          reference: "cos_contract",
          deliveredAssetRail: "usdc.solana",
        },
      ]
    );
    const { settled, requests } = await lookUp(
      [
        stripeSessionLookupExchange(200, {
          ...STRIPE_COMPLETED_SESSION,
          status: "requires_payment",
          transaction_details: "garbled",
        }),
      ],
      LOOKUP
    );
    assert.equal(requests, 1);
    assert.ok(settled.ok, "an unread field never fails a lookup");
    assert.deepEqual(settled.events, [
      { provider: "stripe", kind: "awaiting_payment", reference: "cos_contract" },
    ]);
  });

  it("carries the chain transaction only when Stripe reports one", async () => {
    assert.deepEqual(
      await eventsFor("fulfillment_complete", { ...COMPLETED_DETAILS, wallet_address: null }),
      [
        {
          provider: "stripe",
          kind: "settled",
          reference: "cos_contract",
          deliveredAssetRail: "usdc.solana",
          receivedAmount: "96.500000",
          onchain: { signature: CONTRACT_DELIVERY_SIGNATURE },
        },
      ]
    );
    assert.deepEqual(
      await eventsFor("fulfillment_complete", {
        ...COMPLETED_DETAILS,
        destination_amount: null,
        transaction_id: null,
      }),
      [
        {
          provider: "stripe",
          kind: "settled",
          reference: "cos_contract",
          deliveredAssetRail: "usdc.solana",
        },
      ]
    );
    const [withWallet] = await eventsFor("fulfillment_complete", COMPLETED_DETAILS);
    assert.ok(withWallet?.kind === "settled");
    assert.equal(withWallet.onchain?.destinationAddress, CONTRACT_WALLET);
  });

  it("refuses a completed session without its destination currency or network", async () => {
    for (const missing of ["destination_currency", "destination_network"]) {
      failsWith(
        await lookUp(
          [
            stripeSessionLookupExchange(200, {
              ...STRIPE_COMPLETED_SESSION,
              transaction_details: { ...COMPLETED_DETAILS, [missing]: null },
            }),
          ],
          LOOKUP
        ),
        "PROVIDER_RESPONSE_INVALID",
        1,
        "A completed Stripe session is missing its destination currency or network"
      );
    }
  });

  it("refuses a completed session with malformed delivery proof, as its webhook does", async () => {
    for (const malformed of [
      { transaction_id: " " },
      { wallet_address: "" },
      { destination_amount: 96.5 },
    ]) {
      const result = await lookUp(
        [
          stripeSessionLookupExchange(200, {
            ...STRIPE_COMPLETED_SESSION,
            transaction_details: { ...COMPLETED_DETAILS, ...malformed },
          }),
        ],
        LOOKUP
      );
      failsWith(
        result,
        "PROVIDER_RESPONSE_INVALID",
        1,
        "A completed Stripe session has malformed delivery proof"
      );
      assert.ok(!result.settled.ok && result.settled.cause instanceof SdpPaymentsError);
      assert.deepEqual(
        result.settled.cause.diagnostics?.issues,
        Object.keys(malformed).map((path) => ({
          path,
          code: path === "destination_amount" ? "invalid_type" : "too_small",
        }))
      );
    }
  });

  it("does not read delivery proof before the session completes", async () => {
    assert.deepEqual(
      await eventsFor("requires_payment", { ...STRIPE_SESSION_TERMS, transaction_id: 5 }),
      [{ provider: "stripe", kind: "awaiting_payment", reference: "cos_contract" }]
    );
  });

  it("refuses an answer for another session", async () => {
    failsWith(
      await lookUp(
        [stripeSessionLookupExchange(200, { ...STRIPE_COMPLETED_SESSION, id: "cos_other" })],
        LOOKUP
      ),
      "PROVIDER_RESPONSE_INVALID",
      1,
      "stripe returned another session"
    );
  });

  it("reads a missing session as an error, never as no transaction", async () => {
    failsWith(
      await lookUp(
        [
          stripeSessionLookupExchange(404, {
            error: { code: "resource_missing", type: "invalid_request_error" },
          }),
        ],
        LOOKUP
      ),
      "BAD_REQUEST",
      1
    );
  });

  it("refuses an off-ramp or a transfer without its session before any request", async () => {
    failsWith(
      await lookUp([], { ...LOOKUP, rampType: "offramp" }),
      "BAD_REQUEST",
      0,
      "Stripe off-ramp is not supported."
    );
    failsWith(
      await lookUp([], { ...LOOKUP, providerReference: null }),
      "INTERNAL_ERROR",
      0,
      "A Stripe status lookup requires the session id."
    );
  });
});
