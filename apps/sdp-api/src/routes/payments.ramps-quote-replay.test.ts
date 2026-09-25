/**
 * Regression coverage for the ramp-quote retry finding (SOLA9-302 / APE-689):
 * a retried quote operation that carries the same Idempotency-Key must replay
 * the first operation's recorded outcome — one provider session and one
 * payment_transfers row — instead of minting a second provider session and a
 * second transfer after the first response was lost.
 *
 * The provider boundary is a deterministic MoneyGram sandbox response. The
 * route, auth, policy, quota, provider dispatch, and PostgreSQL persistence are
 * exercised through the real public API endpoints.
 */

import { SdpPaymentsError } from "@sdp/payments/errors";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type { PaymentRampQuote } from "@sdp/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import {
  installPaymentsRouteTestHooks,
  seedCachedKey,
  seedCounterparty,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
} from "@/test/helpers/payments-routes";

const MONEYGRAM_WIDGET_URL = "https://playground.xramps.moneygram.com/widget?intent=transfer";

function sessionToken(expSeconds: number): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ exp: expSeconds })}.sig`;
}

function moneygramSessionResponse(sessionId: string): Response {
  return new Response(
    JSON.stringify({
      sessionToken: sessionToken(Math.floor(Date.now() / 1000) + 3600),
      sessionId,
      widgetUrl: MONEYGRAM_WIDGET_URL,
      walletType: "custodial",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function counterpartyTransfers(counterpartyId: string) {
  const rows = await getDb(env)
    .prepare(
      `SELECT id, provider_reference, status, delivery_mode
         FROM payment_transfers
        WHERE counterparty_id = ?
        ORDER BY provider_reference`
    )
    .bind(counterpartyId)
    .all<{
      id: string;
      provider_reference: string | null;
      status: string;
      delivery_mode: string | null;
    }>();
  return rows.results;
}

describe("ramp quote Idempotency-Key replay", () => {
  installPaymentsRouteTestHooks();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replays the recorded on-ramp quote for a retried key instead of minting a second session and transfer", async () => {
    await seedCachedKey({ permissions: ["payments:write", "wallets:read"] });
    const counterpartyId = await seedCounterparty({ externalId: "replay_quote_retry" });
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(moneygramSessionResponse("mg_replay_session_1"))
      .mockResolvedValueOnce(moneygramSessionResponse("mg_replay_session_2"));

    const postQuote = () =>
      app.request(
        "/v1/payments/ramps/onramp/quote",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Idempotency-Key": "quote-retry-onramp-1",
          },
          body: JSON.stringify({
            provider: "moneygram",
            counterpartyId,
            destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            assetRail: "usdc.solana",
            fiatCurrency: "USD",
            fiatAmount: "25",
          }),
        },
        env
      );

    // The provider and API have completed, but the browser loses this response.
    const lostResponse = await postQuote();
    expect(lostResponse.status).toBe(200);
    const lostBody = (await lostResponse.json()) as {
      data: { quote: { id: string }; transferId: string };
    };

    // This is the dashboard's explicit Try Again path: the same POST body and
    // the same retained Idempotency-Key, through the same public route.
    const retryResponse = await postQuote();
    expect(retryResponse.status).toBe(200);
    const retryBody = (await retryResponse.json()) as {
      data: { quote: { id: string }; transferId: string };
    };

    // The retry is the first operation's recorded outcome, not new provider work.
    expect(retryBody.data.transferId).toBe(lostBody.data.transferId);
    expect(retryBody.data.quote.id).toBe(lostBody.data.quote.id);

    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(providerFetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://playground.xramps.moneygram.com/api/v1/sessions",
    ]);

    const rows = await counterpartyTransfers(counterpartyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider_reference).toBe("mg_replay_session_1");
    expect(rows[0]?.id).toBe(lostBody.data.transferId);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.delivery_mode).toBe("session_widget");
  });

  it("replays the recorded off-ramp quote for a retried key", async () => {
    await seedCachedKey({ permissions: ["payments:write", "wallets:read"] });
    const counterpartyId = await seedCounterparty({ externalId: "replay_quote_offramp" });
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(moneygramSessionResponse("mg_replay_offramp_1"))
      .mockResolvedValueOnce(moneygramSessionResponse("mg_replay_offramp_2"));

    const postQuote = () =>
      app.request(
        "/v1/payments/ramps/offramp/quote",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Idempotency-Key": "quote-retry-offramp-1",
          },
          body: JSON.stringify({
            provider: "moneygram",
            counterpartyId,
            sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            assetRail: "usdc.solana",
            fiatCurrency: "USD",
            cryptoAmount: "25",
          }),
        },
        env
      );

    const firstResponse = await postQuote();
    expect(firstResponse.status).toBe(200);
    const firstBody = (await firstResponse.json()) as {
      data: { quote: { id: string }; transferId: string };
    };

    const retryResponse = await postQuote();
    expect(retryResponse.status).toBe(200);
    const retryBody = (await retryResponse.json()) as {
      data: { quote: { id: string }; transferId: string };
    };

    expect(retryBody.data.transferId).toBe(firstBody.data.transferId);
    expect(retryBody.data.quote.id).toBe(firstBody.data.quote.id);
    expect(providerFetch).toHaveBeenCalledTimes(1);

    const rows = await counterpartyTransfers(counterpartyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider_reference).toBe("mg_replay_offramp_1");
  });

  it("conflicts when a used key is replayed with a different request payload", async () => {
    await seedCachedKey({ permissions: ["payments:write", "wallets:read"] });
    const counterpartyId = await seedCounterparty({ externalId: "replay_quote_conflict" });
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => moneygramSessionResponse("mg_replay_conflict"));

    const postQuote = (fiatAmount: string) =>
      app.request(
        "/v1/payments/ramps/onramp/quote",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Idempotency-Key": "quote-retry-conflict",
          },
          body: JSON.stringify({
            provider: "moneygram",
            counterpartyId,
            destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            assetRail: "usdc.solana",
            fiatCurrency: "USD",
            fiatAmount,
          }),
        },
        env
      );

    const firstResponse = await postQuote("25");
    expect(firstResponse.status).toBe(200);

    const conflictResponse = await postQuote("30");
    expect(conflictResponse.status).toBe(409);

    // The refused replay must not mint another provider session either.
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const rows = await counterpartyTransfers(counterpartyId);
    expect(rows).toHaveLength(1);
  });

  it("treats a distinct key as a distinct quote operation", async () => {
    await seedCachedKey({ permissions: ["payments:write", "wallets:read"] });
    const counterpartyId = await seedCounterparty({ externalId: "replay_quote_new_key" });
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(moneygramSessionResponse("mg_replay_key_a"))
      .mockResolvedValueOnce(moneygramSessionResponse("mg_replay_key_b"));

    const postQuote = (idempotencyKey: string) =>
      app.request(
        "/v1/payments/ramps/onramp/quote",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            provider: "moneygram",
            counterpartyId,
            destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            assetRail: "usdc.solana",
            fiatCurrency: "USD",
            fiatAmount: "25",
          }),
        },
        env
      );

    const firstResponse = await postQuote("quote-operation-a");
    expect(firstResponse.status).toBe(200);
    const secondResponse = await postQuote("quote-operation-b");
    expect(secondResponse.status).toBe(200);

    expect(providerFetch).toHaveBeenCalledTimes(2);
    const rows = await counterpartyTransfers(counterpartyId);
    expect(rows.map((row) => row.provider_reference)).toEqual([
      "mg_replay_key_a",
      "mg_replay_key_b",
    ]);
  });

  it("runs a fresh quote when a keyed attempt provably failed and frees the key", async () => {
    await seedCachedKey({ permissions: ["payments:write", "wallets:read"] });
    const counterpartyId = await seedCounterparty({ externalId: "replay_quote_failed" });
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("moneygram session unavailable"))
      .mockResolvedValueOnce(moneygramSessionResponse("mg_replay_after_failure"));

    const postQuote = () =>
      app.request(
        "/v1/payments/ramps/onramp/quote",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Idempotency-Key": "quote-retry-after-failure",
          },
          body: JSON.stringify({
            provider: "moneygram",
            counterpartyId,
            destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            assetRail: "usdc.solana",
            fiatCurrency: "USD",
            fiatAmount: "25",
          }),
        },
        env
      );

    const failedResponse = await postQuote();
    expect(failedResponse.status).toBeGreaterThanOrEqual(500);

    const retryResponse = await postQuote();
    expect(retryResponse.status).toBe(200);

    expect(providerFetch).toHaveBeenCalledTimes(2);
    const rows = await counterpartyTransfers(counterpartyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider_reference).toBe("mg_replay_after_failure");
    expect(rows[0]?.status).toBe("pending");
  });

  it("replays the recorded quote when the transfer was marked failed after the response was lost", async () => {
    await seedCachedKey({ permissions: ["payments:write", "wallets:read"] });
    const counterpartyId = await seedCounterparty({ externalId: "replay_quote_marked_failed" });
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(moneygramSessionResponse("mg_replay_marked_failed_1"))
      .mockResolvedValueOnce(moneygramSessionResponse("mg_replay_marked_failed_2"));

    const postQuote = () =>
      app.request(
        "/v1/payments/ramps/onramp/quote",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Idempotency-Key": "quote-retry-marked-failed",
          },
          body: JSON.stringify({
            provider: "moneygram",
            counterpartyId,
            destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            assetRail: "usdc.solana",
            fiatCurrency: "USD",
            fiatAmount: "25",
          }),
        },
        env
      );

    const firstResponse = await postQuote();
    expect(firstResponse.status).toBe(200);
    const firstBody = (await firstResponse.json()) as {
      data: { quote: { id: string }; transferId: string };
    };

    // A provider webhook or reconciliation marks the successfully quoted
    // transfer failed after the client lost the response: the recorded quote
    // outcome still exists, so a keyed retry must replay it instead of freeing
    // the key and minting a second provider session and transfer.
    await getDb(env)
      .prepare(`UPDATE payment_transfers SET status = 'failed', updated_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), firstBody.data.transferId)
      .run();

    const retryResponse = await postQuote();
    expect(retryResponse.status).toBe(200);
    const retryBody = (await retryResponse.json()) as {
      data: { quote: { id: string }; transferId: string };
    };
    expect(retryBody.data.transferId).toBe(firstBody.data.transferId);
    expect(retryBody.data.quote.id).toBe(firstBody.data.quote.id);

    expect(providerFetch).toHaveBeenCalledTimes(1);
    const rows = await counterpartyTransfers(counterpartyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider_reference).toBe("mg_replay_marked_failed_1");
  });

  it("frees the key and runs fresh when the failed quote recorded no replayable outcome", async () => {
    await seedCachedKey({ permissions: ["payments:write", "wallets:read"] });
    const counterpartyId = await seedCounterparty({ externalId: "replay_quote_failed_unrecorded" });
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(moneygramSessionResponse("mg_replay_unrecorded_1"))
      .mockResolvedValueOnce(moneygramSessionResponse("mg_replay_unrecorded_2"));

    const postQuote = () =>
      app.request(
        "/v1/payments/ramps/onramp/quote",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Idempotency-Key": "quote-retry-unrecorded-failure",
          },
          body: JSON.stringify({
            provider: "moneygram",
            counterpartyId,
            destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            assetRail: "usdc.solana",
            fiatCurrency: "USD",
            fiatAmount: "25",
          }),
        },
        env
      );

    const firstResponse = await postQuote();
    expect(firstResponse.status).toBe(200);
    const firstBody = (await firstResponse.json()) as { data: { transferId: string } };

    // A failure with no reconstructable recorded outcome (a pre-upgrade or
    // precreate row) is provably fruitless: the key is freed and the retry
    // runs a fresh quote operation.
    await getDb(env)
      .prepare(
        `UPDATE payment_transfers
            SET status = 'failed',
                provider_data = provider_data - 'rampQuoteReplay',
                updated_at = ?
          WHERE id = ?`
      )
      .bind(new Date().toISOString(), firstBody.data.transferId)
      .run();

    const retryResponse = await postQuote();
    expect(retryResponse.status).toBe(200);
    const retryBody = (await retryResponse.json()) as {
      data: { quote: { id: string }; transferId: string };
    };
    expect(retryBody.data.transferId).not.toBe(firstBody.data.transferId);

    expect(providerFetch).toHaveBeenCalledTimes(2);
    const rows = await counterpartyTransfers(counterpartyId);
    expect(rows.map((row) => row.provider_reference)).toEqual([
      "mg_replay_unrecorded_1",
      "mg_replay_unrecorded_2",
    ]);
  });

  // The precreated-row quote flows (MoonPay on-ramp, BVNK off-ramp) only mark
  // the keyed row failed when the provider rejection is definitive — an
  // ambiguous failure (lost response, timeout, outage) may have minted a
  // session whose outcome was never recorded, and the replay gate frees the
  // key of a failed row with no recorded outcome. Keeping such a row pending
  // makes the keyed retry conflict instead of minting a second provider
  // session and transfer for the same operation.
  it("keeps the keyed row pending and conflicts the retry when the quote failed ambiguously", async () => {
    await seedCachedKey({ permissions: ["payments:write", "wallets:read"] });
    const counterpartyId = await seedCounterparty({
      externalId: "replay_quote_ambiguous_failure",
    });
    const createQuote = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.moonpay, "createOnrampQuote")
      .mockRejectedValueOnce(new Error("moonpay session response lost after commit"));

    const postQuote = () =>
      app.request(
        "/v1/payments/ramps/onramp/quote",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Idempotency-Key": "quote-retry-ambiguous-failure",
          },
          body: JSON.stringify({
            provider: "moonpay",
            counterpartyId,
            destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            assetRail: "sol.solana",
            fiatCurrency: "USD",
            fiatAmount: "120.50",
          }),
        },
        env
      );

    const failedResponse = await postQuote();
    expect(failedResponse.status).toBe(500);

    // The ambiguous failure never marks the keyed row failed: it stays
    // pending with only the error recorded, so the key stays held.
    const rowsAfterFailure = await counterpartyTransfers(counterpartyId);
    expect(rowsAfterFailure).toHaveLength(1);
    expect(rowsAfterFailure[0]?.status).toBe("pending");

    // The retry with the same key conflicts: it can neither replay an outcome
    // that was never recorded nor mint a second provider session.
    const retryResponse = await postQuote();
    expect(retryResponse.status).toBe(409);

    expect(createQuote).toHaveBeenCalledTimes(1);
    const rows = await counterpartyTransfers(counterpartyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
  });

  it("runs a fresh keyed quote when the provider definitively rejected and frees the key", async () => {
    await seedCachedKey({ permissions: ["payments:write", "wallets:read"] });
    const counterpartyId = await seedCounterparty({
      externalId: "replay_quote_definitive_failure",
    });
    const createQuote = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.moonpay, "createOnrampQuote")
      .mockRejectedValueOnce(new SdpPaymentsError("BAD_REQUEST", "MoonPay rejected the quote"))
      .mockImplementationOnce(
        async (_runtime, input): Promise<PaymentRampQuote> => ({
          provider: "moonpay",
          id: input.paymentTransferId ?? "xfr_retry_quote",
          status: "pending",
          deliveryMode: "hosted",
          hostedUrl: "https://buy.moonpay.test/widget",
        })
      );

    const postQuote = () =>
      app.request(
        "/v1/payments/ramps/onramp/quote",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Idempotency-Key": "quote-retry-definitive-failure",
          },
          body: JSON.stringify({
            provider: "moonpay",
            counterpartyId,
            destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            assetRail: "sol.solana",
            fiatCurrency: "USD",
            fiatAmount: "120.50",
          }),
        },
        env
      );

    const failedResponse = await postQuote();
    expect(failedResponse.status).toBe(400);

    // A definitive rejection provably minted no provider session: the keyed
    // row is marked failed, so the retry may free the key and run fresh.
    const rowsAfterFailure = await counterpartyTransfers(counterpartyId);
    expect(rowsAfterFailure).toHaveLength(1);
    expect(rowsAfterFailure[0]?.status).toBe("failed");

    const retryResponse = await postQuote();
    expect(retryResponse.status).toBe(200);
    const retryBody = (await retryResponse.json()) as { data: { transferId: string } };

    expect(createQuote).toHaveBeenCalledTimes(2);
    const rows = await counterpartyTransfers(counterpartyId);
    expect(rows.map((row) => row.status)).toEqual(["pending", "failed"]);
    expect(retryBody.data.transferId).not.toBe(rowsAfterFailure[0]?.id);
  });
});
