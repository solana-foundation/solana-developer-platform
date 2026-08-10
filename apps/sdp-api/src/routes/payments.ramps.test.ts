import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import * as tokenAccounts from "@/routes/payments/token-accounts";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  DEVNET_USDC_MINT,
  getAccountInfoMock,
  getSplTokenBalancesMock,
  installPaymentsRouteTestHooks,
  seedCounterparty,
  TEST_API_KEY,
  TEST_BVNK_API_BASE_URL,
  TEST_BVNK_HAWK_AUTH_ID,
  TEST_MOONPAY_API_KEY,
  TEST_MOONPAY_ONRAMP_URL,
  TEST_MOONPAY_SECRET_KEY,
  TEST_ORG,
  TEST_PROJECT,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";

const TEST_BVNK_OFFRAMP_WALLET_ID = "a:99887766554433:OffRmpW:1";

const MOONPAY_PARAM_BASE_CURRENCY_AMOUNT = "baseCurrencyAmount";

const MOONPAY_PARAM_EXTERNAL_CUSTOMER_ID = "externalCustomerId";

function assertMoonPaySignature(url: URL): void {
  const signature = url.searchParams.get("signature");
  expect(signature).toBeTruthy();

  const unsignedUrl = new URL(url.toString());
  unsignedUrl.searchParams.delete("signature");

  const expectedSignature = createHmac("sha256", TEST_MOONPAY_SECRET_KEY)
    .update(unsignedUrl.search)
    .digest("base64");
  expect(signature).toBe(expectedSignature);
}

async function seedRampEventTransfer(params: {
  id: string;
  provider: "coinbase" | "moneygram";
  providerReference: string;
  type: "onramp" | "offramp";
  amount?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers (
         id, organization_id, project_id, wallet_id, source_address, destination_address,
         token, amount, memo, type, direction, status, provider, provider_reference,
         delivery_mode, fiat_currency, fiat_amount, provider_data, signature, serialized_tx,
         initiated_by_key_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)`
    )
    .bind(
      params.id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_WALLET_ID,
      params.type === "offramp" ? TEST_SOLANA_ADDRESSES.wallet1 : null,
      params.type === "onramp" ? TEST_SOLANA_ADDRESSES.wallet2 : null,
      "USDC",
      params.amount ?? "25",
      null,
      params.type,
      params.type === "onramp" ? "inbound" : "outbound",
      "pending",
      params.provider,
      params.providerReference,
      "hosted",
      "USD",
      "25",
      {},
      null,
      null,
      null,
      now,
      now
    )
    .run();
}

describe("Payments routes — ramps", () => {
  installPaymentsRouteTestHooks();

  it("falls back to a zero SOL balance when RPC balance lookups fail", async () => {
    getAccountInfoMock.mockRejectedValueOnce(new Error("rpc unavailable"));
    getSplTokenBalancesMock.mockRejectedValueOnce(new Error("rpc unavailable"));

    const res = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/balances`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        walletBalances: {
          walletId: string;
          address: string;
          balances: Array<{
            token: string;
            mint: string;
            amount: string;
            uiAmount: string;
            decimals: number;
          }>;
        };
      };
    };

    expect(body.data.walletBalances).toMatchObject({
      walletId: TEST_WALLET_ID,
      address: TEST_SOLANA_ADDRESSES.wallet1,
      balances: [
        {
          token: "SOL",
          mint: tokenAccounts.SOL_MINT,
          amount: "0",
          uiAmount: "0",
          decimals: 9,
        },
      ],
    });
  });

  it("keeps SPL balances when only the SOL lookup fails", async () => {
    getAccountInfoMock.mockRejectedValueOnce(new Error("rpc unavailable"));
    getSplTokenBalancesMock.mockResolvedValueOnce([
      {
        token: "USDC",
        mint: "usdc_mint_test",
        amount: "1250000",
        uiAmount: "1.25",
        decimals: 6,
      },
    ]);

    const res = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/balances`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        walletBalances: {
          balances: Array<{
            token: string;
            mint: string;
            amount: string;
            uiAmount: string;
            decimals: number;
          }>;
        };
      };
    };

    expect(body.data.walletBalances.balances).toMatchObject([
      {
        token: "SOL",
        mint: tokenAccounts.SOL_MINT,
        amount: "0",
        uiAmount: "0",
        decimals: 9,
      },
      {
        token: "USDC",
        mint: "usdc_mint_test",
        amount: "1250000",
        uiAmount: "1.25",
        decimals: 6,
        usdPrice: 1,
        usdValue: 1.25,
      },
    ]);
  });

  it("keeps the SOL balance when only the SPL lookup fails", async () => {
    getSplTokenBalancesMock.mockRejectedValueOnce(new Error("rpc unavailable"));

    const res = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/balances`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        walletBalances: {
          balances: Array<{
            token: string;
            mint: string;
            amount: string;
            uiAmount: string;
            decimals: number;
          }>;
        };
      };
    };

    expect(body.data.walletBalances.balances).toMatchObject([
      {
        token: "SOL",
        mint: tokenAccounts.SOL_MINT,
        amount: "4200000000",
        uiAmount: "4.2",
        decimals: 9,
      },
    ]);
  });

  it("lists generated on-ramp currency provider support", async () => {
    const res = await app.request(
      "/v1/payments/ramps/onramp/currency?source=USD&dest=usdc.solana",
      {
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        currencies: { sources: string[]; destinations: string[] };
        pairs: Array<{ source: string; dest: string; providers: string[] }>;
        supportHash: string;
      };
    };

    expect(body.data.currencies.sources).toContain("USD");
    expect(body.data.currencies.destinations).toContain("usdc.solana");
    expect(body.data.supportHash.length).toBeGreaterThan(0);
    expect(body.data.pairs).toContainEqual({
      source: "USD",
      dest: "usdc.solana",
      providers: expect.arrayContaining(["lightspark", "bvnk"]),
    });
  });

  it("lists generated off-ramp currency provider support", async () => {
    const res = await app.request(
      "/v1/payments/ramps/offramp/currency?source=usdc.solana&dest=USD&provider=bvnk",
      {
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        currencies: { sources: string[]; destinations: string[] };
        pairs: Array<{ source: string; dest: string; providers: string[] }>;
      };
    };

    expect(body.data.currencies.sources).toContain("usdc.solana");
    expect(body.data.currencies.destinations).toContain("USD");
    expect(body.data.pairs).toContainEqual({
      source: "usdc.solana",
      dest: "USD",
      providers: ["bvnk"],
    });
  });

  it("creates a hosted MoonPay on-ramp quote URL", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "moonpay_user_123" });

    const res = await app.request(
      "/v1/payments/ramps/onramp/quote",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "moonpay",
          counterpartyId,
          destinationWallet: TEST_WALLET_ID,
          cryptoToken: "SOL",
          fiatCurrency: "USD",
          fiatAmount: "120.50",
          redirectUrl: "https://example.com/onramp-done",
          rampsMemo: { invoice: "INV-123", po: "PO-9" },
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        quote: {
          id: string;
          provider: string;
          status: string;
          deliveryMode: string;
          hostedUrl: string;
        };
      };
    };

    expect(body.data.quote.id.startsWith("ramp_quote_")).toBe(true);
    expect(body.data.quote.provider).toBe("moonpay");
    expect(body.data.quote.status).toBe("pending");
    expect(body.data.quote.deliveryMode).toBe("hosted");

    const hostedUrl = new URL(body.data.quote.hostedUrl);
    expect(hostedUrl.origin).toBe(TEST_MOONPAY_ONRAMP_URL);
    expect(hostedUrl.searchParams.get("apiKey")).toBe(TEST_MOONPAY_API_KEY);
    expect(hostedUrl.searchParams.get("baseCurrencyCode")).toBe("usd");
    expect(hostedUrl.searchParams.get(MOONPAY_PARAM_BASE_CURRENCY_AMOUNT)).toBe("120.50");
    expect(hostedUrl.searchParams.get("currencyCode")).toBe("sol");
    expect(hostedUrl.searchParams.get("walletAddress")).toBe(TEST_SOLANA_ADDRESSES.wallet1);
    expect(hostedUrl.searchParams.get("redirectURL")).toBe("https://example.com/onramp-done");
    expect(hostedUrl.searchParams.get(MOONPAY_PARAM_EXTERNAL_CUSTOMER_ID)).toBe("moonpay_user_123");
    expect(hostedUrl.searchParams.get("externalTransactionId")).toBe(body.data.quote.id);
    assertMoonPaySignature(hostedUrl);

    const transfersRes = await app.request(
      `/v1/payments/transfers?provider=moonpay&providerReference=${body.data.quote.id}`,
      {
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );
    expect(transfersRes.status).toBe(200);
    const transfersBody = (await transfersRes.json()) as {
      data: [{ id: string; rampsMemo: Record<string, string> }];
    };
    expect(transfersBody.data).toHaveLength(1);
    expect(transfersBody.data[0].rampsMemo).toEqual({ invoice: "INV-123", po: "PO-9" });

    const transferRes = await app.request(
      `/v1/payments/transfers/${transfersBody.data[0].id}`,
      {
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );
    expect(transferRes.status).toBe(200);
    const transferBody = (await transferRes.json()) as {
      data: { transfer: { rampsMemo: Record<string, string> } };
    };
    expect(transferBody.data.transfer.rampsMemo).toEqual({ invoice: "INV-123", po: "PO-9" });
  });

  it("rejects a ramp quote memo with more than 20 fields", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "moonpay_memo_limit" });
    const rampsMemo = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`key_${index}`, `value_${index}`])
    );

    const res = await app.request(
      "/v1/payments/ramps/onramp/quote",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "moonpay",
          counterpartyId,
          destinationWallet: TEST_WALLET_ID,
          cryptoToken: "SOL",
          fiatCurrency: "USD",
          fiatAmount: "120.50",
          rampsMemo,
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { details: { errors: { rampsMemo: string[] } } };
    };
    expect(body.error.details.errors.rampsMemo).toContain(
      "rampsMemo must contain at most 20 key-value pairs"
    );
  });

  it("rejects quotes for corridors the support matrix does not list the provider on", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "moonpay_user_123" });

    const onrampRes = await app.request(
      "/v1/payments/ramps/onramp/quote",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "moonpay",
          counterpartyId,
          destinationWallet: TEST_WALLET_ID,
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          fiatAmount: "120.50",
        }),
      },
      env
    );

    expect(onrampRes.status).toBe(400);
    const onrampBody = (await onrampRes.json()) as { error: { code: string } };
    expect(onrampBody.error.code).toBe("UNSUPPORTED_CORRIDOR");

    const offrampRes = await app.request(
      "/v1/payments/ramps/offramp/quote",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "moonpay",
          counterpartyId,
          sourceWallet: TEST_WALLET_ID,
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          cryptoAmount: "75.25",
        }),
      },
      env
    );

    expect(offrampRes.status).toBe(400);
    const offrampBody = (await offrampRes.json()) as { error: { code: string } };
    expect(offrampBody.error.code).toBe("UNSUPPORTED_CORRIDOR");
  });

  it("creates a BVNK off-ramp channel quote with crypto-deposit instructions", async () => {
    const depositAddress = TEST_SOLANA_ADDRESSES.wallet3;
    const counterpartyId = await seedCounterparty({
      externalId: "customer_456",
      identity: { firstName: "Test", lastName: "User", address: { countryCode: "US" } },
      providerData: {
        bvnk: {
          customer: { customerReference: "customer_456", status: "VERIFIED" },
          offramp: {
            wallets: { USD: { id: TEST_BVNK_OFFRAMP_WALLET_ID, status: "ACTIVE" } },
            beneficiaries: {
              "USD:abc123": {
                key: "USD:abc123",
                fiatCurrency: "USD",
                accountType: "ACH",
                createdAt: "2026-06-01T00:00:00.000Z",
              },
            },
          },
        },
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          uuid: "bvnk_channel_uuid_123",
          reference: "bvnk_channel_reference",
          status: "OPEN",
          alternatives: [
            { network: "ETHEREUM", address: "0xdeadbeef", uri: "ethereum:0xdeadbeef" },
            { network: "SOLANA", address: depositAddress, uri: `solana:${depositAddress}` },
          ],
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      )
    );

    const res = await app.request(
      "/v1/payments/ramps/offramp/quote",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "bvnk",
          counterpartyId,
          sourceWallet: TEST_WALLET_ID,
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          cryptoAmount: "75.25",
          rampsMemo: { invoice: "INV-123", po: "PO-9" },
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        quote: {
          id: string;
          provider: string;
          status: string;
          deliveryMode: string;
          paymentInstructions: {
            kind: string;
            destinationAddress: string;
            network: string;
            cryptoCurrency: string;
            fiatCurrency: string;
          }[];
        };
      };
    };

    expect(body.data.quote.provider).toBe("bvnk");
    expect(body.data.quote.deliveryMode).toBe("manual_instructions");
    expect(body.data.quote.id).toBe("bvnk_channel_uuid_123");
    expect(body.data.quote.status).toBe("pending");
    const instruction = body.data.quote.paymentInstructions[0];
    expect(instruction?.kind).toBe("crypto_deposit");
    expect(instruction?.destinationAddress).toBe(depositAddress);
    expect(instruction?.network).toBe("SOLANA");
    expect(instruction?.cryptoCurrency).toBe("USDC");
    expect(instruction?.fiatCurrency).toBe("USD");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const channelUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(channelUrl).toBe(`${TEST_BVNK_API_BASE_URL}/api/v2/channel`);
    const channelHeaders = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(channelHeaders.Authorization).toContain(`Hawk id="${TEST_BVNK_HAWK_AUTH_ID}"`);

    const channelPayload = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
      walletId: string;
      payCurrency: string;
      displayCurrency: string;
      customerId: string;
      complianceDetails: { partyDetails: Record<string, unknown>[] };
    };
    expect(channelPayload.walletId).toBe(TEST_BVNK_OFFRAMP_WALLET_ID);
    expect(channelPayload.payCurrency).toBe("USDC");
    expect(channelPayload.displayCurrency).toBe("USD");
    expect(channelPayload.customerId).toBe("customer_456");
    expect(channelPayload.complianceDetails.partyDetails).toHaveLength(1);

    const transfersRes = await app.request(
      `/v1/payments/transfers?provider=bvnk&providerReference=${body.data.quote.id}`,
      {
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );
    expect(transfersRes.status).toBe(200);
    const transfersBody = (await transfersRes.json()) as {
      data: [{ rampsMemo: Record<string, string>; token: string }];
    };
    expect(transfersBody.data[0].rampsMemo).toEqual({ invoice: "INV-123", po: "PO-9" });
    expect(transfersBody.data[0].token).toBe(DEVNET_USDC_MINT);
    fetchSpy.mockRestore();
  });

  it("rejects a BVNK off-ramp quote until the payout beneficiary is provisioned", async () => {
    const counterpartyId = await seedCounterparty({
      externalId: "customer_456",
      identity: { firstName: "Test", lastName: "User", address: { countryCode: "US" } },
      providerData: {
        bvnk: {
          customer: { customerReference: "customer_456", status: "VERIFIED" },
          offramp: { wallets: { USD: { id: TEST_BVNK_OFFRAMP_WALLET_ID, status: "ACTIVE" } } },
        },
      },
    });

    const res = await app.request(
      "/v1/payments/ramps/offramp/quote",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "bvnk",
          counterpartyId,
          sourceWallet: TEST_WALLET_ID,
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          cryptoAmount: "75.25",
        }),
      },
      env
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
  });

  async function seedRampTransfer(input: {
    id: string;
    provider: string;
    providerReference: string;
    status: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers
           (id, organization_id, project_id, wallet_id, token, amount, type, direction, status, provider, provider_reference, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        "USDC",
        null,
        "offramp",
        "outbound",
        input.status,
        input.provider,
        input.providerReference,
        now,
        now
      )
      .run();
  }

  it("cancels a pending ramp transfer and marks the row canceled", async () => {
    await seedRampTransfer({
      id: "xfr_cancel_pending",
      provider: "bvnk",
      providerReference: "bvnk_ref_cancel_1",
      status: "awaiting_payment",
    });

    const res = await app.request(
      "/v1/payments/ramps/transfers/cancel",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ provider: "bvnk", providerReference: "bvnk_ref_cancel_1" }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { transfer: { id: string; status: string } } };
    expect(body.data.transfer.status).toBe("canceled");

    const row = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind("xfr_cancel_pending")
      .first<{ status: string }>();
    expect(row?.status).toBe("canceled");
  });

  it("refuses to cancel a ramp transfer that is already settling", async () => {
    await seedRampTransfer({
      id: "xfr_cancel_settling",
      provider: "bvnk",
      providerReference: "bvnk_ref_cancel_2",
      status: "settling",
    });

    const res = await app.request(
      "/v1/payments/ramps/transfers/cancel",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ provider: "bvnk", providerReference: "bvnk_ref_cancel_2" }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");

    const row = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind("xfr_cancel_settling")
      .first<{ status: string }>();
    expect(row?.status).toBe("settling");
  });

  it("keeps browser ramp terminal callbacks advisory", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    await seedRampEventTransfer({
      id: "xfr_coinbase_advisory",
      provider: "coinbase",
      providerReference: "coinbase_order_advisory",
      type: "onramp",
    });
    await seedRampEventTransfer({
      id: "xfr_moneygram_advisory",
      provider: "moneygram",
      providerReference: "moneygram_session_advisory",
      type: "onramp",
    });

    const coinbase = await app.request(
      "/v1/payments/ramps/coinbase/events",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "committed", orderId: "coinbase_order_advisory" }),
      },
      env
    );
    const moneygram = await app.request(
      "/v1/payments/ramps/moneygram/events",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "onramp_completed",
          sessionId: "moneygram_session_advisory",
          transactionId: "moneygram_transaction_advisory",
          status: "COMPLETED",
          amount: 25,
        }),
      },
      env
    );

    expect(coinbase.status).toBe(200);
    expect(moneygram.status).toBe(200);
    const rows = await getDb(env)
      .prepare(
        `SELECT id, status, provider_data
         FROM payment_transfers
         WHERE id IN ('xfr_coinbase_advisory', 'xfr_moneygram_advisory')
         ORDER BY id`
      )
      .all<{ id: string; status: string; provider_data: Record<string, unknown> }>();
    expect(rows.results).toHaveLength(2);
    for (const row of rows.results) {
      expect(row.status).toBe("pending");
      expect(row.provider_data).toMatchObject({ clientEvent: { advisory: true } });
    }
  });

  it("rejects a MoneyGram crypto leg whose amount does not match the session", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    await seedRampEventTransfer({
      id: "xfr_moneygram_amount_guard",
      provider: "moneygram",
      providerReference: "moneygram_session_amount_guard",
      type: "offramp",
      amount: "25",
    });
    const now = new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id, organization_id, project_id, wallet_id, source_address, destination_address,
           token, amount, type, direction, status, signature, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "xfr_moneygram_wrong_amount_leg",
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        TEST_SOLANA_ADDRESSES.wallet1,
        TEST_SOLANA_ADDRESSES.wallet2,
        "USDC",
        "24",
        "transfer",
        "outbound",
        "confirmed",
        "moneygram-wrong-amount-signature",
        now,
        now
      )
      .run();

    const response = await app.request(
      "/v1/payments/ramps/moneygram/events",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "signed",
          sessionId: "moneygram_session_amount_guard",
          cryptoTransferId: "xfr_moneygram_wrong_amount_leg",
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    const transfer = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind("xfr_moneygram_amount_guard")
      .first<{ status: string }>();
    expect(transfer?.status).toBe("pending");
  });
});
