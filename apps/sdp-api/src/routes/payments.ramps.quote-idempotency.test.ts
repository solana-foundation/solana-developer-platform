/**
 * Regression for APE-689 (SOLA9-302): a dashboard ramp-quote retry after an
 * ambiguous response — lost body, JSON parse failure, or the explicit Try
 * Again — must reuse the first operation instead of minting a second provider
 * session and a second Payment Transfer. The dashboard retains one stable
 * operation key across those retries and sends it as `Idempotency-Key`, so the
 * quote routes must treat the same key + same payload as a replay of the
 * original quote.
 *
 * The provider boundary is a deterministic MoneyGram sandbox response. The
 * route, auth, policy, quota, provider dispatch, and PostgreSQL persistence
 * are exercised through the real public API endpoint.
 */

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
const MONEYGRAM_SESSIONS_URL = "https://playground.xramps.moneygram.com/api/v1/sessions";

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

async function postQuote(options: {
  counterpartyId: string;
  fiatAmount?: string;
  idempotencyKey?: string;
}): Promise<Response> {
  return app.request(
    "/v1/payments/ramps/onramp/quote",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        provider: "moneygram",
        counterpartyId: options.counterpartyId,
        destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        assetRail: "usdc.solana",
        fiatCurrency: "USD",
        fiatAmount: options.fiatAmount ?? "25",
      }),
    },
    env
  );
}

interface QuoteResponseBody {
  data: { quote: { sessionId: string; id: string }; transferId: string };
}

async function transferRows(counterpartyId: string) {
  return getDb(env)
    .prepare(
      `SELECT id, provider_reference, status, delivery_mode, idempotency_key
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
      idempotency_key: string | null;
    }>();
}

describe("ramp quote idempotent retry (APE-689)", () => {
  installPaymentsRouteTestHooks();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replays the first operation when the retry presents the same operation key", async () => {
    await seedCachedKey({ permissions: ["payments:write", "wallets:read"] });
    const counterpartyId = await seedCounterparty({ externalId: "ape689_keyed_replay" });
    // A second session response is staged so an accidental second provider
    // call would still succeed and the assertion below catches the count.
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(moneygramSessionResponse("mg_ape689_session_1"))
      .mockResolvedValueOnce(moneygramSessionResponse("mg_ape689_session_2"));

    // The dashboard's committed quote selection, whose response is lost.
    const lostResponse = await postQuote({ counterpartyId, idempotencyKey: "ape689-op-key-1" });
    expect(lostResponse.status).toBe(200);
    const lostBody = (await lostResponse.json()) as QuoteResponseBody;

    // The explicit Try Again path: the same POST body and the SAME operation key.
    const retryResponse = await postQuote({ counterpartyId, idempotencyKey: "ape689-op-key-1" });
    expect(retryResponse.status).toBe(200);
    const retryBody = (await retryResponse.json()) as QuoteResponseBody;

    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(providerFetch.mock.calls.map(([url]) => String(url))).toEqual([MONEYGRAM_SESSIONS_URL]);
    expect(retryBody.data.transferId).toBe(lostBody.data.transferId);
    expect(retryBody.data.quote).toEqual(lostBody.data.quote);
    expect(retryBody.data.quote.sessionId).toBe("mg_ape689_session_1");

    const rows = await transferRows(counterpartyId);
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      id: lostBody.data.transferId,
      provider_reference: "mg_ape689_session_1",
      status: "pending",
      delivery_mode: "session_widget",
      idempotency_key: "ape689-op-key-1",
    });
  });

  it("conflicts when the same operation key is reused with a different payload", async () => {
    await seedCachedKey({ permissions: ["payments:write", "wallets:read"] });
    const counterpartyId = await seedCounterparty({ externalId: "ape689_key_mutation" });
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(moneygramSessionResponse("mg_ape689_session_mutation"));

    const first = await postQuote({ counterpartyId, idempotencyKey: "ape689-op-key-2" });
    expect(first.status).toBe(200);

    const mutated = await postQuote({
      counterpartyId,
      fiatAmount: "30",
      idempotencyKey: "ape689-op-key-2",
    });
    expect(mutated.status).toBe(409);

    const rows = await transferRows(counterpartyId);
    expect(rows.results).toHaveLength(1);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("starts a new operation under a different operation key", async () => {
    await seedCachedKey({ permissions: ["payments:write", "wallets:read"] });
    const counterpartyId = await seedCounterparty({ externalId: "ape689_distinct_keys" });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(moneygramSessionResponse("mg_ape689_session_a"))
      .mockResolvedValueOnce(moneygramSessionResponse("mg_ape689_session_b"));

    const first = await postQuote({ counterpartyId, idempotencyKey: "ape689-op-key-a" });
    expect(first.status).toBe(200);
    const second = await postQuote({ counterpartyId, idempotencyKey: "ape689-op-key-b" });
    expect(second.status).toBe(200);

    const firstBody = (await first.json()) as QuoteResponseBody;
    const secondBody = (await second.json()) as QuoteResponseBody;
    expect(secondBody.data.transferId).not.toBe(firstBody.data.transferId);
    expect(secondBody.data.quote.sessionId).toBe("mg_ape689_session_b");

    const rows = await transferRows(counterpartyId);
    expect(rows.results.map((row) => row.idempotency_key)).toEqual([
      "ape689-op-key-a",
      "ape689-op-key-b",
    ]);
  });

  it("reuses the reserved transfer row when a failed quote is retried under the same key", async () => {
    await seedCachedKey({ permissions: ["payments:write", "wallets:read"] });
    const counterpartyId = await seedCounterparty({ externalId: "ape689_failed_retry" });
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("sandbox down", { status: 500 }))
      .mockResolvedValueOnce(moneygramSessionResponse("mg_ape689_session_retry"));

    const failed = await postQuote({ counterpartyId, idempotencyKey: "ape689-op-key-3" });
    expect(failed.ok).toBe(false);

    const retry = await postQuote({ counterpartyId, idempotencyKey: "ape689-op-key-3" });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as QuoteResponseBody;
    expect(retryBody.data.quote.sessionId).toBe("mg_ape689_session_retry");

    expect(providerFetch).toHaveBeenCalledTimes(2);
    const rows = await transferRows(counterpartyId);
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      id: retryBody.data.transferId,
      provider_reference: "mg_ape689_session_retry",
      status: "pending",
      idempotency_key: "ape689-op-key-3",
    });
  });

  it("fails a keyed reservation whose finalization conflicts, and lets its retry converge", async () => {
    await seedCachedKey({ permissions: ["payments:write", "wallets:read"] });
    const counterpartyId = await seedCounterparty({ externalId: "ape689_finalize_conflict" });
    // The second attempt's provider session id collides with the first
    // operation's while its amounts differ, so binding the reference fails
    // closed AFTER the provider session was created — the finalization path.
    const sharedSession = "mg_ape689_session_finalize";
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(moneygramSessionResponse(sharedSession))
      .mockResolvedValueOnce(moneygramSessionResponse(sharedSession))
      .mockResolvedValueOnce(moneygramSessionResponse("mg_ape689_session_finalize_retry"));

    const first = await postQuote({ counterpartyId, idempotencyKey: "ape689-op-key-4" });
    expect(first.status).toBe(200);

    // Same session id under a different key + amount: the finalization must
    // fail the new reservation instead of stranding it pending with no stored
    // response (which would 409 every retry until the abandonment window
    // passed and then re-drive the provider for the same key).
    const conflicted = await postQuote({
      counterpartyId,
      fiatAmount: "30",
      idempotencyKey: "ape689-op-key-5",
    });
    expect(conflicted.status).toBe(409);
    const rowsAfterConflict = await transferRows(counterpartyId);
    expect(rowsAfterConflict.results).toHaveLength(2);
    expect(rowsAfterConflict.results[1]).toMatchObject({
      status: "failed",
      provider_reference: null,
      idempotency_key: "ape689-op-key-5",
    });

    // The explicit retry under the same key claims the failed row in place
    // and converges: one more provider session, still one row per key.
    const retry = await postQuote({
      counterpartyId,
      fiatAmount: "30",
      idempotencyKey: "ape689-op-key-5",
    });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as QuoteResponseBody;
    expect(retryBody.data.quote.sessionId).toBe("mg_ape689_session_finalize_retry");

    expect(providerFetch).toHaveBeenCalledTimes(3);
    const rows = await transferRows(counterpartyId);
    expect(rows.results).toHaveLength(2);
    expect(rows.results[1]).toMatchObject({
      id: retryBody.data.transferId,
      provider_reference: "mg_ape689_session_finalize_retry",
      status: "pending",
      idempotency_key: "ape689-op-key-5",
    });
  });

  it("keeps unkeyed quote requests as fresh operations (public API compatibility)", async () => {
    await seedCachedKey({ permissions: ["payments:write", "wallets:read"] });
    const counterpartyId = await seedCounterparty({ externalId: "ape689_unkeyed_compat" });
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(moneygramSessionResponse("mg_ape689_session_u1"))
      .mockResolvedValueOnce(moneygramSessionResponse("mg_ape689_session_u2"));

    const first = await postQuote({ counterpartyId });
    expect(first.status).toBe(200);
    const second = await postQuote({ counterpartyId });
    expect(second.status).toBe(200);

    const firstBody = (await first.json()) as QuoteResponseBody;
    const secondBody = (await second.json()) as QuoteResponseBody;
    expect(secondBody.data.transferId).not.toBe(firstBody.data.transferId);
    expect(providerFetch).toHaveBeenCalledTimes(2);
    const rows = await transferRows(counterpartyId);
    expect(rows.results).toHaveLength(2);
    expect(rows.results.every((row) => row.idempotency_key === null)).toBe(true);
  });
});
