import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import * as tokenAccounts from "@/routes/payments/token-accounts";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  getAccountInfoMock,
  getSplTokenBalancesMock,
  installPaymentsRouteTestHooks,
  seedCachedKey,
  seedCounterparty,
  TEST_API_KEY,
  TEST_CONFIG_ID,
  TEST_CUSTODY_WALLET_ID,
  TEST_MOONPAY_API_KEY,
  TEST_MOONPAY_OFFRAMP_URL,
  TEST_MOONPAY_ONRAMP_URL,
  TEST_MOONPAY_SECRET_KEY,
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import { seedRateLimit } from "@/test/mocks/kv";

const TEST_BVNK_OFFRAMP_WALLET_ID = "a:99887766554433:OffRmpW:1";
const TEST_CONNECTION_WALLET_ID = "privy_payments_connection_wallet";
const TEST_CONNECTION_CUSTODY_WALLET_ID = "cwlt_payments_connection_balance";

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

async function seedActiveConnectionWallet(params?: {
  walletId?: string;
  publicKey?: string;
}): Promise<void> {
  const credentialId = "pcred_payments_connection_balance";
  const connectionId = "cconn_payments_connection_balance";
  const walletId = params?.walletId ?? TEST_CONNECTION_WALLET_ID;
  const publicKey = params?.publicKey ?? TEST_SOLANA_ADDRESSES.wallet2;

  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO provider_credentials (
           id, organization_id, project_id, provider, label, scope, source,
           storage_backend, encrypted_secret_payload, status, credential_version, created_by
         ) VALUES (?, ?, ?, 'privy', 'Payments Connection', 'project', 'stored',
                   'encrypted_db', 'not-read', 'active', 1, ?)`
      )
      .bind(credentialId, TEST_ORG.id, TEST_PROJECT.id, TEST_USER.id),
    getDb(env)
      .prepare(
        `INSERT INTO custody_connections (
           id, organization_id, project_id, provider, scope,
           provider_credential_id, provider_credential_scope_key, status, created_by
         ) VALUES (?, ?, ?, 'privy', 'project', ?, ?, 'pending', ?)`
      )
      .bind(
        connectionId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        credentialId,
        TEST_PROJECT.id,
        TEST_USER.id
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (
           id, custody_connection_id, wallet_id, public_key, label, purpose, status
         ) VALUES (?, ?, ?, ?, 'Connection balance wallet', 'transfer', 'active')`
      )
      .bind(TEST_CONNECTION_CUSTODY_WALLET_ID, connectionId, walletId, publicKey),
    getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET default_custody_wallet_id = ?,
             provider_account_fingerprint = 'sha256:payments-connection-balance',
             status = 'active',
             last_check_status = 'success',
             last_check_at = sdp_iso_now(),
             activated_at = sdp_iso_now(),
             updated_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind(TEST_CONNECTION_CUSTODY_WALLET_ID, connectionId),
  ]);
}

async function seedRampEventTransfer(params: {
  id: string;
  provider: "coinbase" | "moneygram";
  providerReference: string;
  type: "onramp" | "offramp";
  amount?: string;
  providerData?: Record<string, unknown>;
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
      params.providerData ?? {},
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

  it("rejects an ambiguous Provider wallet ID before creating a hosted quote", async () => {
    const counterpartyId = await seedCounterparty({
      externalId: "ambiguous_ramp_wallet",
    });
    await seedActiveConnectionWallet({ walletId: TEST_WALLET_ID });

    const response = await app.request(
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
        }),
      },
      env
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "CONFLICT" } });
    expect(
      await getDb(env)
        .prepare("SELECT COUNT(*)::int AS count FROM payment_transfers")
        .first<{ count: number }>()
    ).toEqual({ count: 0 });
  });

  it("rejects cross-owner address ambiguity after resolving a Provider wallet ID", async () => {
    const counterpartyId = await seedCounterparty({
      externalId: "ambiguous_ramp_wallet_address",
    });
    await seedActiveConnectionWallet({ publicKey: TEST_SOLANA_ADDRESSES.wallet1 });

    const response = await app.request(
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
        }),
      },
      env
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "CONFLICT" } });
    expect(
      await getDb(env)
        .prepare("SELECT COUNT(*)::int AS count FROM payment_transfers")
        .first<{ count: number }>()
    ).toEqual({ count: 0 });
  });

  it("creates a hosted quote for an exact Connection wallet row", async () => {
    await seedActiveConnectionWallet();
    const counterpartyId = await seedCounterparty({ externalId: "connection_ramp_wallet" });

    const response = await app.request(
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
          destinationWallet: TEST_CONNECTION_WALLET_ID,
          cryptoToken: "SOL",
          fiatCurrency: "USD",
          fiatAmount: "120.50",
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(
      await getDb(env)
        .prepare("SELECT custody_wallet_id FROM payment_transfers")
        .first<{ custody_wallet_id: string | null }>()
    ).toEqual({ custody_wallet_id: TEST_CONNECTION_CUSTODY_WALLET_ID });
  });

  it("reads an active Connection wallet balance and preserves API-key wallet scope", async () => {
    await seedActiveConnectionWallet();
    await seedCachedKey({
      walletBindings: [{ walletId: TEST_CONNECTION_WALLET_ID, permissions: ["wallets:read"] }],
    });

    const res = await app.request(
      `/v1/payments/wallets/${TEST_CONNECTION_WALLET_ID}/balances`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        walletBalances: {
          walletId: TEST_CONNECTION_WALLET_ID,
          address: TEST_SOLANA_ADDRESSES.wallet2,
        },
      },
    });
    expect(getAccountInfoMock).toHaveBeenCalledWith(
      expect.anything(),
      TEST_SOLANA_ADDRESSES.wallet2
    );

    await seedCachedKey({
      walletBindings: [{ walletId: TEST_WALLET_ID, permissions: ["wallets:read"] }],
    });
    const forbiddenRes = await app.request(
      `/v1/payments/wallets/${TEST_CONNECTION_WALLET_ID}/balances`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(forbiddenRes.status).toBe(403);
  });

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
        transferId: string;
      };
    };

    expect(body.data.quote.id).toBe(body.data.transferId);
    expect(body.data.transferId.startsWith("xfr_")).toBe(true);
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
    expect(hostedUrl.searchParams.get("lockAmount")).toBe("true");
    expect(hostedUrl.searchParams.get(MOONPAY_PARAM_EXTERNAL_CUSTOMER_ID)).toBe(counterpartyId);
    expect(hostedUrl.searchParams.get("externalTransactionId")).toBe(body.data.transferId);
    assertMoonPaySignature(hostedUrl);

    const transfersRes = await app.request(
      `/v1/payments/transfers/${body.data.transferId}`,
      {
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );
    expect(transfersRes.status).toBe(200);
    const transfersBody = (await transfersRes.json()) as {
      data: {
        transfer: {
          id: string;
          providerReference?: string;
          rampsMemo: Record<string, string>;
        };
      };
    };
    expect(transfersBody.data.transfer.id).toBe(body.data.transferId);
    expect(transfersBody.data.transfer.providerReference).toBeUndefined();
    expect(transfersBody.data.transfer.rampsMemo).toEqual({ invoice: "INV-123", po: "PO-9" });
    expect(
      await getDb(env)
        .prepare("SELECT custody_wallet_id FROM payment_transfers WHERE id = ?")
        .bind(transfersBody.data.transfer.id)
        .first<{ custody_wallet_id: string | null }>()
    ).toEqual({ custody_wallet_id: TEST_CUSTODY_WALLET_ID });
  });

  it("creates a hosted MoonPay off-ramp quote with the transfer id", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "moonpay_offramp_quote" });

    const response = await app.request(
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
          cryptoToken: "SOL",
          fiatCurrency: "USD",
          cryptoAmount: "75.25",
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        quote: {
          id: string;
          provider: string;
          status: string;
          deliveryMode: string;
          hostedUrl: string;
        };
        transferId: string;
      };
    };
    expect(body.data.quote.id).toBe(body.data.transferId);
    expect(body.data.transferId.startsWith("xfr_")).toBe(true);

    const hostedUrl = new URL(body.data.quote.hostedUrl);
    expect(hostedUrl.origin).toBe(TEST_MOONPAY_OFFRAMP_URL);
    expect(hostedUrl.searchParams.get(MOONPAY_PARAM_EXTERNAL_CUSTOMER_ID)).toBe(counterpartyId);
    expect(hostedUrl.searchParams.get("externalTransactionId")).toBe(body.data.transferId);
    expect(hostedUrl.searchParams.get("lockAmount")).toBe("true");
    assertMoonPaySignature(hostedUrl);

    const transfer = await getDb(env)
      .prepare(
        `SELECT id, custody_wallet_id, provider_reference
         FROM payment_transfers
         WHERE id = ? AND organization_id = ? AND project_id = ?`
      )
      .bind(body.data.transferId, TEST_ORG.id, TEST_PROJECT.id)
      .first<{
        id: string;
        custody_wallet_id: string | null;
        provider_reference: string | null;
      }>();
    expect(transfer).toEqual({
      id: body.data.transferId,
      custody_wallet_id: TEST_CUSTODY_WALLET_ID,
      provider_reference: null,
    });
  });

  it("dry-runs an on-ramp quote with zero writes", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "moonpay_onramp_dry_run" });

    const response = await app.request(
      "/v1/payments/ramps/onramp/quote",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Dry-Run": "true",
        },
        body: JSON.stringify({
          provider: "moonpay",
          counterpartyId,
          destinationWallet: TEST_WALLET_ID,
          cryptoToken: "SOL",
          fiatCurrency: "USD",
          fiatAmount: "120.50",
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { decision: "allow", criteria: [] },
    });

    const [transferCount, operationCount] = await Promise.all([
      getDb(env)
        .prepare("SELECT COUNT(*)::int AS count FROM payment_transfers")
        .first<{ count: number }>(),
      getDb(env)
        .prepare("SELECT COUNT(*)::int AS count FROM wallet_operations")
        .first<{ count: number }>(),
    ]);
    expect(transferCount).toEqual({ count: 0 });
    expect(operationCount).toEqual({ count: 0 });
  });

  it("dry-runs an off-ramp quote with zero writes", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "moonpay_offramp_dry_run" });

    const response = await app.request(
      "/v1/payments/ramps/offramp/quote",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Dry-Run": "true",
        },
        body: JSON.stringify({
          provider: "moonpay",
          counterpartyId,
          sourceWallet: TEST_WALLET_ID,
          cryptoToken: "SOL",
          fiatCurrency: "USD",
          cryptoAmount: "75.25",
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { decision: "allow", criteria: [] },
    });

    const [transferCount, operationCount] = await Promise.all([
      getDb(env)
        .prepare("SELECT COUNT(*)::int AS count FROM payment_transfers")
        .first<{ count: number }>(),
      getDb(env)
        .prepare("SELECT COUNT(*)::int AS count FROM wallet_operations")
        .first<{ count: number }>(),
    ]);
    expect(transferCount).toEqual({ count: 0 });
    expect(operationCount).toEqual({ count: 0 });
  });

  it("stops a denied ramp quote before provider and transfer side effects", async () => {
    await getDb(env)
      .prepare("UPDATE custody_configs SET project_id = ? WHERE id = ?")
      .bind(TEST_PROJECT.id, TEST_CONFIG_ID)
      .run();
    const policyResponse = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          defaultAction: "allow",
          rules: [{ id: "deny-ramp-quotes", kind: "always", action: "deny" }],
        }),
      },
      env
    );
    expect(policyResponse.status).toBe(200);
    const counterpartyId = await seedCounterparty({ externalId: "moonpay_denied_quote" });

    const response = await app.request(
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
        }),
      },
      env
    );

    expect(response.status).toBe(403);
    const transferCount = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS count FROM payment_transfers")
      .first<{ count: number }>();
    expect(transferCount).toEqual({ count: 0 });
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
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("rampsMemo must contain at most 20 key-value pairs");
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

  it("fails loudly when a BVNK off-ramp quote has no customer-link row", async () => {
    const counterpartyId = await seedCounterparty({
      externalId: "customer_456",
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
    const fetchSpy = vi.spyOn(globalThis, "fetch");

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

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toContain("not provisioned for bvnk offramp");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects a BVNK off-ramp quote until the payout beneficiary is provisioned", async () => {
    const counterpartyId = await seedCounterparty({
      externalId: "customer_456",
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
        body: JSON.stringify({ transferId: "xfr_cancel_pending" }),
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
        body: JSON.stringify({ transferId: "xfr_cancel_settling" }),
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

  describe("metered quotas", () => {
    it("429s an estimate once the actor's metered quota is exhausted", async () => {
      await seedRateLimit(
        env,
        `metered:ramp-estimate:org:${TEST_ORG.id}:key:${TEST_API_KEY.id}`,
        30
      );

      const res = await app.request(
        "/v1/payments/ramps/onramp/estimate",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            fiatCurrency: "USD",
            assetRail: "usdc.solana",
            fiatAmount: "100",
          }),
        },
        env
      );

      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("RATE_LIMITED");
    });

    it("429s a quote once the org-wide metered quota is exhausted", async () => {
      await seedRateLimit(env, `metered:ramp-quote:org:${TEST_ORG.id}`, 60);

      const res = await app.request(
        "/v1/payments/ramps/onramp/quote",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            provider: "bvnk",
            cryptoToken: "USDC",
            fiatCurrency: "EUR",
            fiatAmount: "100",
            counterpartyId: "cpty_quota_test",
            destinationWallet: TEST_WALLET_ID,
          }),
        },
        env
      );

      expect(res.status).toBe(429);
    });
  });

  describe("session-caller environment resolution", () => {
    const SESSION_ID = "ses_ramps_environment";
    const PRODUCTION_PROJECT_ID = "prj_payments_test_prod";

    /**
     * Dashboard (session) callers resolve their environment from the
     * membership-verified x-project-id project; this seeds the org member, a
     * production sibling of the hooks' sandbox project, and a session.
     */
    async function seedSessionAuth(): Promise<void> {
      await getDb(env).batch([
        getDb(env)
          .prepare(
            `INSERT INTO organization_members (id, organization_id, user_id, role, status)
             VALUES (?, ?, ?, 'member', 'active')`
          )
          .bind("om_ramps_environment", TEST_ORG.id, TEST_USER.id),
        getDb(env)
          .prepare(
            `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
             VALUES (?, ?, ?, ?, 'production', 'active', ?)`
          )
          .bind(
            PRODUCTION_PROJECT_ID,
            TEST_ORG.id,
            "Production Project",
            "payments-test-project-prod",
            TEST_USER.id
          ),
        getDb(env)
          .prepare(
            `INSERT INTO project_members (id, project_id, user_id, role) VALUES (?, ?, ?, 'admin')`
          )
          .bind("pm_ramps_environment_sandbox", TEST_PROJECT.id, TEST_USER.id),
        getDb(env)
          .prepare(
            `INSERT INTO project_members (id, project_id, user_id, role) VALUES (?, ?, ?, 'admin')`
          )
          .bind("pm_ramps_environment_production", PRODUCTION_PROJECT_ID, TEST_USER.id),
        getDb(env)
          .prepare(
            `INSERT INTO sessions (id, user_id, organization_id, auth_method, expires_at)
             VALUES (?, ?, ?, 'session', ?)`
          )
          .bind(SESSION_ID, TEST_USER.id, TEST_ORG.id, "2099-01-01T00:00:00.000Z"),
      ]);
    }

    function simulateAsSession(projectId: string, body: Record<string, unknown>) {
      return app.request(
        "/v1/payments/ramps/sandbox/simulate",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `sdp_session=${SESSION_ID}`,
            "x-project-id": projectId,
          },
          body: JSON.stringify(body),
        },
        env
      );
    }

    // A schema-valid, nonexistent-counterparty mural payload: the mural branch
    // resolves the counterparty from the DB before ever making a provider
    // call, so it distinguishes "blocked by the environment guard" (403,
    // before the payload is inspected) from "past the guard" (404, from the
    // in-process DB lookup) without a network mock.
    const NONEXISTENT_MURAL_SIMULATE_BODY = {
      provider: "mural",
      payload: { counterpartyId: "cpty_does_not_exist", amount: 100, fiatCurrency: "USD" },
    };

    it("refuses the sandbox simulator from a production-project session", async () => {
      await seedSessionAuth();

      // Session callers used to hardcode to sandbox, so a production-project
      // session could run sandbox simulations inside production tenant scope.
      // The guard now sees the real project environment.
      const res = await simulateAsSession(PRODUCTION_PROJECT_ID, NONEXISTENT_MURAL_SIMULATE_BODY);

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("only available in sandbox mode");
    });

    it("still lets sandbox-project sessions past the environment guard", async () => {
      await seedSessionAuth();

      // A nonexistent counterparty is rejected downstream of the guard, so a
      // 404 (rather than 403) proves the request got PAST the environment
      // guard — sandbox sessions are unchanged.
      const res = await simulateAsSession(TEST_PROJECT.id, NONEXISTENT_MURAL_SIMULATE_BODY);

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("ramp session and destination binding", () => {
    const MONEYGRAM_WIDGET_URL = "https://playground.xramps.moneygram.com/widget?intent=transfer";

    function moneygramSessionJwt(expSeconds: number): string {
      const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
      return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ exp: expSeconds })}.sig`;
    }

    function moneygramSessionResponse(params: {
      sessionId: string;
      widgetUrl?: string;
      expSeconds?: number;
    }): Response {
      return new Response(
        JSON.stringify({
          sessionToken: moneygramSessionJwt(
            params.expSeconds ?? Math.floor(Date.now() / 1000) + 3600
          ),
          sessionId: params.sessionId,
          widgetUrl: params.widgetUrl ?? MONEYGRAM_WIDGET_URL,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    async function createMoneygramOnrampQuote(
      counterpartyId: string,
      fiatAmount: string
    ): Promise<Response> {
      return app.request(
        "/v1/payments/ramps/onramp/quote",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            provider: "moneygram",
            counterpartyId,
            destinationWallet: TEST_WALLET_ID,
            cryptoToken: "USDC",
            fiatCurrency: "USD",
            fiatAmount,
          }),
        },
        env
      );
    }

    it("creates a MoneyGram session quote bound to the session expiry", async () => {
      const counterpartyId = await seedCounterparty({ externalId: "moneygram_bind_happy" });
      const expSeconds = Math.floor(Date.now() / 1000) + 3600;
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          moneygramSessionResponse({ sessionId: "mg_sess_bind_1", expSeconds })
        );

      const res = await createMoneygramOnrampQuote(counterpartyId, "25");

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { quote: { sessionId: string; widgetUrl: string; expiresAt?: string } };
      };
      expect(body.data.quote.sessionId).toBe("mg_sess_bind_1");
      const widgetUrl = new URL(body.data.quote.widgetUrl);
      expect(widgetUrl.origin).toBe("https://playground.xramps.moneygram.com");
      expect(widgetUrl.searchParams.get("mode")).toBe("on-ramp");
      expect(body.data.quote.expiresAt).toBe(new Date(expSeconds * 1000).toISOString());

      const row = await getDb(env)
        .prepare(
          `SELECT provider_data FROM payment_transfers
           WHERE provider = 'moneygram' AND provider_reference = 'mg_sess_bind_1'`
        )
        .first<{ provider_data: { rampQuote?: { expiresAt?: string } } }>();
      expect(row?.provider_data.rampQuote?.expiresAt).toBe(
        new Date(expSeconds * 1000).toISOString()
      );
      fetchSpy.mockRestore();
    });

    it("fails closed when MoneyGram returns an untrusted widget URL", async () => {
      const counterpartyId = await seedCounterparty({ externalId: "moneygram_bad_widget" });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        moneygramSessionResponse({
          sessionId: "mg_sess_hostile_1",
          widgetUrl: "http://playground.xramps.moneygram.com/widget",
        })
      );

      const res = await createMoneygramOnrampQuote(counterpartyId, "25");

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("untrusted widget URL");

      const row = await getDb(env)
        .prepare(
          `SELECT id FROM payment_transfers
           WHERE provider = 'moneygram' AND provider_reference = 'mg_sess_hostile_1'`
        )
        .first<{ id: string }>();
      expect(row ?? null).toBeNull();
      fetchSpy.mockRestore();
    });

    it("replays a session quote idempotently but fails closed on input mutation", async () => {
      const counterpartyId = await seedCounterparty({ externalId: "moneygram_bind_reuse" });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(moneygramSessionResponse({ sessionId: "mg_sess_reuse_1" }))
        .mockResolvedValueOnce(moneygramSessionResponse({ sessionId: "mg_sess_reuse_1" }))
        .mockResolvedValueOnce(moneygramSessionResponse({ sessionId: "mg_sess_reuse_1" }));

      const created = await createMoneygramOnrampQuote(counterpartyId, "25");
      expect(created.status).toBe(200);

      const replayed = await createMoneygramOnrampQuote(counterpartyId, "25");
      expect(replayed.status).toBe(200);

      const mutated = await createMoneygramOnrampQuote(counterpartyId, "26");
      expect(mutated.status).toBe(409);
      const body = (await mutated.json()) as { error: { message: string } };
      expect(body.error.message).toContain("already bound");
      fetchSpy.mockRestore();
    });

    it("fails closed when the provider reference is already bound to another tenant", async () => {
      const counterpartyId = await seedCounterparty({ externalId: "moneygram_cross_tenant" });
      const now = new Date().toISOString();
      await getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind("org_other_tenant", "Other Tenant", "other-tenant", "enterprise", "active")
        .run();
      await getDb(env)
        .prepare(
          `INSERT INTO payment_transfers (
             id, organization_id, project_id, wallet_id, source_address, destination_address,
             token, amount, memo, type, direction, status, provider, provider_reference,
             delivery_mode, provider_data, created_at, updated_at
           ) VALUES (?, ?, NULL, ?, NULL, ?, 'USDC', NULL, NULL, 'onramp', 'inbound', 'pending',
                     'moneygram', ?, 'session_widget', ?::jsonb, ?, ?)`
        )
        .bind(
          "xfr_moneygram_foreign_tenant",
          "org_other_tenant",
          "wallet_other_tenant",
          TEST_SOLANA_ADDRESSES.wallet2,
          "mg_sess_foreign_1",
          {},
          now,
          now
        )
        .run();
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(moneygramSessionResponse({ sessionId: "mg_sess_foreign_1" }));

      const res = await createMoneygramOnrampQuote(counterpartyId, "25");

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("already bound");
      fetchSpy.mockRestore();
    });

    it("rejects a MoneyGram signed event after the bound session expired", async () => {
      await seedRampEventTransfer({
        id: "xfr_moneygram_expired_session",
        provider: "moneygram",
        providerReference: "moneygram_session_expired",
        type: "offramp",
        providerData: { rampQuote: { expiresAt: "2020-01-01T00:00:00.000Z" } },
      });

      const res = await app.request(
        "/v1/payments/ramps/moneygram/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            kind: "signed",
            sessionId: "moneygram_session_expired",
            cryptoTransferId: "xfr_any_leg",
          }),
        },
        env
      );

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("expired");
    });
  });

  describe("lightspark offramp quote account selection", () => {
    /**
     * Inserts one counterparty provider-account row with explicit values.
     *
     * @param input - Row values for the fixture.
     * @returns The inserted row id.
     */
    async function seedLightsparkProviderAccount(input: {
      id: string;
      counterpartyId: string;
      providerCustomerReference: string;
      externalAccountReference: string | null;
      fiatCurrency: string | null;
      destinationCountry: string | null;
      paymentRail: string | null;
      providerStatus: string | null;
    }): Promise<string> {
      await getDb(env)
        .prepare(
          `INSERT INTO counterparty_provider_accounts (
             id, organization_id, project_id, counterparty_id, provider,
             provider_customer_reference, kind, external_account_reference, fiat_currency,
             destination_country, payment_rail, provider_status, status, metadata
           ) VALUES (?, ?, ?, ?, 'lightspark', ?, ?, ?, ?, ?, ?, ?, 'active', '{}')`
        )
        .bind(
          input.id,
          TEST_ORG.id,
          TEST_PROJECT.id,
          input.counterpartyId,
          input.providerCustomerReference,
          input.fiatCurrency === null ? "customer_link" : "payout_account",
          input.externalAccountReference,
          input.fiatCurrency,
          input.destinationCountry,
          input.paymentRail,
          input.providerStatus
        )
        .run();
      return input.id;
    }

    /**
     * Seeds a lightspark counterparty with a Grid customer link and payout accounts.
     *
     * @param accounts - Corridor account fixtures to insert for the counterparty.
     * @returns The counterparty id.
     */
    async function seedLightsparkCounterparty(
      accounts: readonly {
        id: string;
        externalAccountReference: string;
        paymentRail: string;
      }[]
    ): Promise<string> {
      const counterpartyId = await seedCounterparty({
        providerData: { lightspark: { purposeOfPayment: "SELF" } },
      });
      await seedLightsparkProviderAccount({
        id: `${counterpartyId}_customer_link`,
        counterpartyId,
        providerCustomerReference: "Customer:cus_quote_test",
        externalAccountReference: null,
        fiatCurrency: null,
        destinationCountry: null,
        paymentRail: null,
        providerStatus: null,
      });
      for (const account of accounts) {
        await seedLightsparkProviderAccount({
          id: account.id,
          counterpartyId,
          providerCustomerReference: "Customer:cus_quote_test",
          externalAccountReference: account.externalAccountReference,
          fiatCurrency: "USD",
          destinationCountry: "MY",
          paymentRail: account.paymentRail,
          providerStatus: "ACTIVE",
        });
      }
      return counterpartyId;
    }

    /**
     * Mocks the Grid quote endpoint with a valid locked-sending quote.
     *
     * @returns The installed fetch spy.
     */
    function mockGridQuote() {
      const quotePage = JSON.stringify({
        id: "Quote:qt_selection_test",
        quoteStatus: "CREATED",
        exchangeRate: 4.2,
        totalSendingAmount: 25000000,
        sendingCurrency: { code: "USDC", decimals: 6 },
        totalReceivingAmount: 105,
        receivingCurrency: { code: "USD", decimals: 2 },
        feesIncluded: 0,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      return vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(
          new Response(quotePage, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        )
      );
    }

    const quoteRequest = (body: Record<string, unknown>) =>
      app.request(
        "/v1/payments/ramps/offramp/quote",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            provider: "lightspark",
            sourceWallet: TEST_WALLET_ID,
            cryptoToken: "USDC",
            cryptoAmount: "25",
            fiatCurrency: "USD",
            destinationCountry: "MY",
            ...body,
          }),
        },
        env
      );

    it("resolves an explicit providerAccountId and records it on the transfer", async () => {
      const counterpartyId = await seedLightsparkCounterparty([
        {
          id: "cpa_quote_ach",
          externalAccountReference: "ExternalAccount:ach",
          paymentRail: "ACH",
        },
        {
          id: "cpa_quote_swift",
          externalAccountReference: "ExternalAccount:swift",
          paymentRail: "SWIFT",
        },
      ]);
      const fetchSpy = mockGridQuote();

      const res = await quoteRequest({ counterpartyId, providerAccountId: "cpa_quote_swift" });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { quote: { id: string }; transferId: string } };
      expect(body.data.quote.id).toBe("Quote:qt_selection_test");
      const gridBody = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as {
        destination: { accountId: string };
      };
      expect(gridBody.destination.accountId).toBe("ExternalAccount:swift");

      const transfer = await getDb(env)
        .prepare("SELECT provider_data FROM payment_transfers WHERE id = ?")
        .bind(body.data.transferId)
        .first<{ provider_data: unknown }>();
      expect(transfer).not.toBeNull();
      const providerData =
        typeof transfer?.provider_data === "string"
          ? (JSON.parse(transfer.provider_data) as Record<string, unknown>)
          : (transfer?.provider_data as Record<string, unknown>);
      expect(providerData.payoutProviderAccountId).toBe("cpa_quote_swift");
      fetchSpy.mockRestore();
    });

    it("rejects a providerAccountId owned by another counterparty", async () => {
      const counterpartyId = await seedLightsparkCounterparty([
        {
          id: "cpa_quote_own",
          externalAccountReference: "ExternalAccount:own",
          paymentRail: "ACH",
        },
      ]);
      const otherCounterpartyId = await seedCounterparty({
        providerData: { lightspark: { purposeOfPayment: "SELF" } },
      });
      await seedLightsparkProviderAccount({
        id: "cpa_quote_foreign",
        counterpartyId: otherCounterpartyId,
        providerCustomerReference: "Customer:cus_other",
        externalAccountReference: "ExternalAccount:foreign",
        fiatCurrency: "USD",
        destinationCountry: "MY",
        paymentRail: "SWIFT",
        providerStatus: "ACTIVE",
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const res = await quoteRequest({ counterpartyId, providerAccountId: "cpa_quote_foreign" });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toContain("providerAccountId");
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("rejects an explicitly selected account that is pending or provider-inactive", async () => {
      const counterpartyId = await seedLightsparkCounterparty([
        {
          id: "cpa_quote_active",
          externalAccountReference: "ExternalAccount:active",
          paymentRail: "SWIFT",
        },
      ]);
      await seedLightsparkProviderAccount({
        id: "cpa_quote_pending",
        counterpartyId,
        providerCustomerReference: "Customer:cus_quote_test",
        externalAccountReference: null,
        fiatCurrency: "USD",
        destinationCountry: "MY",
        paymentRail: "ACH",
        providerStatus: null,
      });
      await seedLightsparkProviderAccount({
        id: "cpa_quote_created",
        counterpartyId,
        providerCustomerReference: "Customer:cus_quote_test",
        externalAccountReference: "ExternalAccount:created",
        fiatCurrency: "USD",
        destinationCountry: "MY",
        paymentRail: "ACH",
        providerStatus: "CREATED",
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      for (const providerAccountId of ["cpa_quote_pending", "cpa_quote_created"]) {
        const res = await quoteRequest({ counterpartyId, providerAccountId });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("BAD_REQUEST");
        expect(body.error.message).toContain("providerAccountId");
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("rejects an ambiguous corridor when no providerAccountId is given", async () => {
      const counterpartyId = await seedLightsparkCounterparty([
        {
          id: "cpa_quote_multi_a",
          externalAccountReference: "ExternalAccount:multi_a",
          paymentRail: "ACH",
        },
        {
          id: "cpa_quote_multi_b",
          externalAccountReference: "ExternalAccount:multi_b",
          paymentRail: "SWIFT",
        },
      ]);
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const res = await quoteRequest({ counterpartyId });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("explicit external-account selection is required");
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("keeps implicit resolution for a single-account corridor", async () => {
      const counterpartyId = await seedLightsparkCounterparty([
        {
          id: "cpa_quote_single",
          externalAccountReference: "ExternalAccount:single",
          paymentRail: "SWIFT",
        },
      ]);
      const fetchSpy = mockGridQuote();

      const res = await quoteRequest({ counterpartyId });

      expect(res.status).toBe(200);
      const gridBody = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as {
        destination: { accountId: string };
      };
      expect(gridBody.destination.accountId).toBe("ExternalAccount:single");
      fetchSpy.mockRestore();
    });
  });
});
