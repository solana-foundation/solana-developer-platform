import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { RampTransferType } from "@sdp/types/payments";
import { SdpPaymentsError, type SdpPaymentsErrorCode } from "#/errors";
import { RAMP_PROVIDER_CLIENTS } from "#/ramps/index";
import {
  CONTRACT_DELIVERY_SIGNATURE,
  type RecordedExchange,
  rampTestRuntime,
  replayExchanges,
} from "#/ramps/test-kit";
import {
  moonpaySellTransactionSchema,
  moonpaySellTransactionSettlementEvent,
} from "./event-status-mapping";
import {
  MOONPAY_COMPLETED_BUY,
  MOONPAY_SALE_AWAITING_DEPOSIT,
  MOONPAY_TEST_KIT,
  moonpayLookupExchange,
} from "./test-kit";

const TRANSFER_ID = MOONPAY_COMPLETED_BUY.externalTransactionId;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Looks the kit's transfer up against one recorded answer, counting requests. */
async function lookUp(rampType: RampTransferType, status: number, body: RecordedExchange["body"]) {
  const replay = replayExchanges([moonpayLookupExchange(rampType, status, body)]);
  const settled = await RAMP_PROVIDER_CLIENTS.moonpay
    .fetchTransferStatus(rampTestRuntime("sandbox", MOONPAY_TEST_KIT.credentials), {
      transferId: TRANSFER_ID,
      rampType,
      providerReference: null,
    })
    .then(
      (events) => ({ ok: true as const, events }),
      (cause: unknown) => ({ ok: false as const, cause })
    );
  assert.deepEqual(replay.unrecorded, []);
  assert.equal(replay.requests.length, 1, "a lookup makes one request");
  return settled;
}

async function lookUpEvents(rampType: RampTransferType, body: RecordedExchange["body"]) {
  const settled = await lookUp(rampType, 200, body);
  assert.ok(settled.ok, "the lookup succeeds");
  return settled.events;
}

function failsWith(
  settled: Awaited<ReturnType<typeof lookUp>>,
  code: SdpPaymentsErrorCode,
  message?: string
) {
  assert.ok(!settled.ok, "the lookup fails");
  assert.ok(settled.cause instanceof SdpPaymentsError);
  assert.equal(settled.cause.code, code);
  if (message !== undefined) {
    assert.equal(settled.cause.message, message);
  }
}

const COMPLETED_SALE = {
  ...MOONPAY_SALE_AWAITING_DEPOSIT,
  status: "completed",
  updatedAt: "2026-09-04T08:27:27.552Z",
  depositHash: CONTRACT_DELIVERY_SIGNATURE,
};

describe("MoonpayRampClient.fetchTransferStatus", () => {
  it("asks with the publishable key alone", async () => {
    let requested: { url: string; headers: Headers } | undefined;
    globalThis.fetch = async (input, init) => {
      requested = { url: String(input), headers: new Headers(init?.headers) };
      return Response.json([]);
    };

    await RAMP_PROVIDER_CLIENTS.moonpay.fetchTransferStatus(
      rampTestRuntime("sandbox", MOONPAY_TEST_KIT.credentials),
      { transferId: TRANSFER_ID, rampType: "offramp", providerReference: null }
    );

    assert.ok(requested, "MoonPay is asked");
    const url = new URL(requested.url);
    assert.equal(url.pathname, `/v3/sell_transactions/ext/${TRANSFER_ID}`);
    assert.deepEqual([...url.searchParams.keys()], ["apiKey"]);
    assert.equal(url.searchParams.get("apiKey"), MOONPAY_TEST_KIT.credentials.publicKey);
    assert.equal(requested.headers.get("Authorization"), null);
  });

  it("maps a completed sale as the webhook path does, with the crypto it sold", async () => {
    const events = await lookUpEvents("offramp", [COMPLETED_SALE]);

    assert.deepEqual(events, [
      {
        ...moonpaySellTransactionSettlementEvent(
          moonpaySellTransactionSchema.parse(COMPLETED_SALE)
        ),
        deliveredAssetRail: "sol.solana",
      },
    ]);
  });

  it("answers one event per checkout attempt, oldest update first", async () => {
    const failedAttempt = {
      ...MOONPAY_COMPLETED_BUY,
      id: "0b3f3c6e-8d0e-4b7a-9d8c-2f1e0a9b8c7d",
      status: "failed",
      failureReason: "Card declined",
      cryptoTransactionId: null,
      createdAt: "2026-08-31T05:20:00.000Z",
      updatedAt: "2026-08-31T05:21:00.000Z",
    };

    // MoonPay lists the newest attempt first.
    const events = await lookUpEvents("onramp", [MOONPAY_COMPLETED_BUY, failedAttempt]);

    assert.deepEqual(
      events.map((event) => ({
        kind: event.kind,
        reference: event.kind === "ignore" ? undefined : event.reference,
        observedAt: event.kind === "ignore" ? undefined : event.providerObservedAt,
      })),
      [
        { kind: "failed", reference: failedAttempt.id, observedAt: failedAttempt.updatedAt },
        {
          kind: "settled",
          reference: MOONPAY_COMPLETED_BUY.id,
          observedAt: MOONPAY_COMPLETED_BUY.updatedAt,
        },
      ]
    );
  });

  it("keeps a status MoonPay ships later as an ignore event", async () => {
    const events = await lookUpEvents("onramp", [{ ...MOONPAY_COMPLETED_BUY, status: "refunded" }]);

    assert.deepEqual(events, [
      {
        provider: "moonpay",
        kind: "ignore",
        reason: "unsupported_status:refunded",
        unmappedStatus: "refunded",
      },
    ]);
  });

  it("reads only MoonPay's 404 as no transaction; every other failure throws", async () => {
    failsWith(await lookUp("onramp", 500, { message: "upstream" }), "PROVIDER_UNAVAILABLE");
    failsWith(
      await lookUp("onramp", 401, { message: "Not authorized" }),
      "PROVIDER_NOT_CONFIGURED"
    );
    failsWith(await lookUp("onramp", 429, { message: "Slow down" }), "RATE_LIMITED");
  });

  it("refuses a transaction that names another transfer", async () => {
    const message = "moonpay returned a transaction for another transfer";

    failsWith(
      await lookUp("onramp", 200, [
        MOONPAY_COMPLETED_BUY,
        { ...MOONPAY_COMPLETED_BUY, id: "other", externalTransactionId: "xfr_other" },
      ]),
      "PROVIDER_RESPONSE_INVALID",
      message
    );
    failsWith(
      await lookUp("offramp", 200, [
        { ...MOONPAY_SALE_AWAITING_DEPOSIT, externalTransactionId: null },
      ]),
      "PROVIDER_RESPONSE_INVALID",
      message
    );
  });

  it("refuses a completed transaction that does not name its crypto", async () => {
    const message = "moonpay returned a completed transaction without its crypto";
    const { currency: _bought, ...buyWithoutCrypto } = MOONPAY_COMPLETED_BUY;
    const { baseCurrency: _sold, ...saleWithoutCrypto } = COMPLETED_SALE;

    failsWith(
      await lookUp("onramp", 200, [buyWithoutCrypto]),
      "PROVIDER_RESPONSE_INVALID",
      message
    );
    failsWith(
      await lookUp("offramp", 200, [saleWithoutCrypto]),
      "PROVIDER_RESPONSE_INVALID",
      message
    );
  });

  it("fails closed on a transaction without its update time", async () => {
    const { updatedAt: _updatedAt, ...withoutUpdateTime } = MOONPAY_COMPLETED_BUY;

    failsWith(
      await lookUp("onramp", 200, [withoutUpdateTime]),
      "PROVIDER_RESPONSE_INVALID",
      "moonpay returned an unexpected response"
    );
  });
});
