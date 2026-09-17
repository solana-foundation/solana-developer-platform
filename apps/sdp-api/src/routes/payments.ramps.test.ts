import { createHmac } from "node:crypto";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import { buildBvnkOfframpWalletName } from "@sdp/payments/ramps/providers/bvnk/provider-data";
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

/** The BVNK ledger wallet id bound to a counterparty's settlement wallet row. */
const TEST_BVNK_SETTLEMENT_WALLET_ID = "a:99887766554433:OffRmpW:1";

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

/**
 * Seeds the per-(counterparty, fiat) virtual settlement wallet row the BVNK
 * off-ramp quote requires active.
 */
async function seedBvnkSettlementWallet(
  counterpartyId: string,
  overrides?: {
    id?: string;
    externalAccountReference?: string;
    providerStatus?: string;
    status?: string;
  }
): Promise<string> {
  const rowId = overrides?.id ?? "cpa_settlement_wallet_usd";
  await getDb(env)
    .prepare(
      `INSERT INTO counterparty_provider_accounts (
         id, organization_id, project_id, counterparty_id, provider,
         provider_customer_reference, kind, external_account_reference, fiat_currency,
         provider_status, status, metadata
       ) VALUES (?, ?, ?, ?, 'bvnk', '', 'virtual_settlement_wallet', ?, 'USD', ?, ?, ?)`
    )
    .bind(
      rowId,
      TEST_ORG.id,
      TEST_PROJECT.id,
      counterpartyId,
      overrides?.externalAccountReference ?? TEST_BVNK_SETTLEMENT_WALLET_ID,
      overrides?.providerStatus ?? "ACTIVE",
      overrides?.status ?? "active",
      "{}"
    )
    .run();
  return rowId;
}

/** Seeds the customer_link row whose reference is the BVNK contact id. */
async function seedBvnkCustomerLink(
  counterpartyId: string,
  contactId: string,
  rowId = "cpa_contact"
): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO counterparty_provider_accounts (
         id, organization_id, project_id, counterparty_id, provider,
         provider_customer_reference, kind, metadata
       ) VALUES (?, ?, ?, ?, 'bvnk', ?, 'customer_link', ?)`
    )
    .bind(rowId, TEST_ORG.id, TEST_PROJECT.id, counterpartyId, contactId, "{}")
    .run();
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

  it("rejects the retired symbol-shaped onramp quote request", async () => {
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
          counterpartyId: "cpty_asset_rail_validation",
          destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          fiatAmount: "100.00",
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('Unrecognized key: "cryptoToken"');
  });

  it("rejects the retired symbol-shaped onramp estimate request", async () => {
    const response = await app.request(
      "/v1/payments/ramps/onramp/estimate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          fiatAmount: "100.00",
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('Unrecognized key: "cryptoToken"');
  });

  it("rejects the retired symbol-shaped offramp estimate request", async () => {
    const response = await app.request(
      "/v1/payments/ramps/offramp/estimate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          cryptoAmount: "100.00",
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('Unrecognized key: "cryptoToken"');
  });

  it("rejects the retired symbol-shaped offramp quote request", async () => {
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
          counterpartyId: "cpty_asset_rail_validation",
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          cryptoAmount: "75.25",
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('Unrecognized key: "cryptoToken"');
  });

  it("rejects the retired destinationWallet key on the onramp quote endpoint", async () => {
    const counterpartyId = await seedCounterparty({
      externalId: "retired_destination_wallet_key",
    });

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
          assetRail: "sol.solana",
          fiatCurrency: "USD",
          fiatAmount: "120.50",
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('Unrecognized key: "destinationWallet"');
  });

  it("rejects a provider walletId value passed as destinationCustodyWalletId", async () => {
    const counterpartyId = await seedCounterparty({
      externalId: "provider_walletid_as_custody_id",
    });

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
          destinationCustodyWalletId: TEST_WALLET_ID,
          assetRail: "sol.solana",
          fiatCurrency: "USD",
          fiatAmount: "120.50",
        }),
      },
      env
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
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
          destinationCustodyWalletId: TEST_CONNECTION_CUSTODY_WALLET_ID,
          assetRail: "sol.solana",
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
          destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          assetRail: "sol.solana",
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
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          assetRail: "sol.solana",
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
          destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          assetRail: "sol.solana",
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
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          assetRail: "sol.solana",
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
          destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          assetRail: "sol.solana",
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
          destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          assetRail: "sol.solana",
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
          destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          assetRail: "usdc.solana",
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
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          assetRail: "usdc.solana",
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

  it("rejects a BVNK off-ramp quote before any provider call when the counterparty has no customer link or settlement wallet", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "customer_456" });
    const createQuote = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createOfframpQuote");

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
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          assetRail: "usdc.solana",
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
    expect(createQuote).not.toHaveBeenCalled();
    createQuote.mockRestore();
  });

  it("passes the BVNK contact id, counterparty id, and settlement wallet to the off-ramp quote", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "customer_contact_quote" });
    // The customer_link row's reference is the BVNK contact id in the Direct model.
    const contactId = "contact_offramp_quote_1";
    await seedBvnkCustomerLink(counterpartyId, contactId, "cpa_contact_quote");
    const settlementRowId = await seedBvnkSettlementWallet(counterpartyId, {
      id: "cpa_settlement_quote",
    });
    const createQuote = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createOfframpQuote")
      .mockResolvedValue({
        provider: "bvnk",
        // The quote id is the BVNK channel uuid; the route CASes it onto the
        // transfer's provider_reference once the quote succeeds.
        id: "019f0ce4-98ab-7424-a968-fc323266b8ed",
        status: "pending",
        deliveryMode: "manual_instructions",
        paymentInstructions: [
          {
            provider: "bvnk",
            kind: "crypto_deposit",
            fiatCurrency: "USD",
            cryptoCurrency: "USDC",
            destinationAddress: "H8j6ZdeUt1D3GexMhUs6mSrncK7r4KkspKuLVhpsA7V6",
            network: "SOLANA",
            reference: "sdp_offramp_quote_test",
            instructionsNotes:
              "Send USDC on SOLANA to the deposit address. BVNK converts it to USD and credits the counterparty's USD balance.",
          },
        ],
      } as unknown as Awaited<ReturnType<typeof RAMP_PROVIDER_CLIENTS.bvnk.createOfframpQuote>>);

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
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          assetRail: "usdc.solana",
          fiatCurrency: "USD",
          cryptoAmount: "75.25",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    expect(createQuote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        fiatCurrency: "USD",
        paymentTransferId: expect.any(String),
        bvnkOfframpWalletId: TEST_BVNK_SETTLEMENT_WALLET_ID,
        externalCustomerId: counterpartyId,
        contactId,
      })
    );
    // The claimed transfer carries the settlement-wallet claim and the channel
    // uuid CAS'd onto provider_reference.
    const transfer = await getDb(env)
      .prepare(
        "SELECT status, provider_reference, provider_data FROM payment_transfers WHERE counterparty_id = ? AND type = 'offramp'"
      )
      .bind(counterpartyId)
      .first<{
        status: string;
        provider_reference: string | null;
        provider_data: { bvnk?: { settlementWalletAccountId?: string } };
      }>();
    expect(transfer?.status).toBe("awaiting_payment");
    expect(transfer?.provider_reference).toBe("019f0ce4-98ab-7424-a968-fc323266b8ed");
    expect(transfer?.provider_data.bvnk?.settlementWalletAccountId).toBe(settlementRowId);
    createQuote.mockRestore();
  });

  it("claims the awaiting_payment transfer before the off-ramp quote is requested", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "customer_claim_first" });
    await seedBvnkCustomerLink(counterpartyId, "contact_claim_first_1", "cpa_contact_claim_first");
    const settlementRowId = await seedBvnkSettlementWallet(counterpartyId, {
      id: "cpa_settlement_claim_first",
    });
    // The provider quote is only reachable once the transfer row already
    // exists awaiting_payment with the settlement-wallet claim stamped — a
    // crash between the claim and the quote leaves a recoverable row, never
    // an orphaned BVNK channel.
    const createQuote = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createOfframpQuote")
      .mockImplementation(async (_ctx, input) => {
        const atCallTime = await getDb(env)
          .prepare("SELECT status, provider_data FROM payment_transfers WHERE id = ?")
          .bind(input.paymentTransferId)
          .first<{
            status: string;
            provider_data: { bvnk?: { settlementWalletAccountId?: string } };
          }>();
        expect(atCallTime?.status).toBe("awaiting_payment");
        expect(atCallTime?.provider_data.bvnk?.settlementWalletAccountId).toBe(settlementRowId);
        return {
          provider: "bvnk",
          id: "019f0ce4-98ab-7424-a968-fc323266b8ed",
          status: "pending",
          deliveryMode: "manual_instructions",
          paymentInstructions: [],
        } as unknown as Awaited<ReturnType<typeof RAMP_PROVIDER_CLIENTS.bvnk.createOfframpQuote>>;
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
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          assetRail: "usdc.solana",
          fiatCurrency: "USD",
          cryptoAmount: "75.25",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    createQuote.mockRestore();
  });

  it("allows concurrent off-ramp quotes for the same counterparty on separate channels", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "customer_concurrent_offramp" });
    await seedBvnkCustomerLink(counterpartyId, "contact_concurrent_1", "cpa_contact_concurrent");
    const settlementRowId = await seedBvnkSettlementWallet(counterpartyId, {
      id: "cpa_settlement_concurrent",
    });
    let channelSeq = 0;
    const createQuote = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createOfframpQuote")
      .mockImplementation(async () => {
        channelSeq += 1;
        return {
          provider: "bvnk",
          // Each quote gets its own BVNK channel uuid.
          id: `019f0ce4-98ab-7424-a968-fc323266b8e${channelSeq}`,
          status: "pending",
          deliveryMode: "manual_instructions",
          paymentInstructions: [],
        } as unknown as Awaited<ReturnType<typeof RAMP_PROVIDER_CLIENTS.bvnk.createOfframpQuote>>;
      });
    const body = JSON.stringify({
      provider: "bvnk",
      counterpartyId,
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      assetRail: "usdc.solana",
      fiatCurrency: "USD",
      cryptoAmount: "75.25",
    });

    const first = await app.request(
      "/v1/payments/ramps/offramp/quote",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body,
      },
      env
    );
    const second = await app.request(
      "/v1/payments/ramps/offramp/quote",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body,
      },
      env
    );

    // Unlike on-ramp (one payment rule in flight per funding wallet), the
    // off-ramp corridor allows a channel per transfer without a 409.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const transfers = await getDb(env)
      .prepare(
        "SELECT provider_reference, provider_data FROM payment_transfers WHERE counterparty_id = ? AND type = 'offramp' ORDER BY created_at"
      )
      .bind(counterpartyId)
      .all<{
        provider_reference: string | null;
        provider_data: { bvnk?: { settlementWalletAccountId?: string } };
      }>();
    expect(transfers.results.length).toBe(2);
    const references = transfers.results.map((row) => row.provider_reference);
    expect(references[0]).not.toBe(references[1]);
    for (const row of transfers.results) {
      expect(row.provider_data.bvnk?.settlementWalletAccountId).toBe(settlementRowId);
    }
    createQuote.mockRestore();
  });

  it("ignores another counterparty's BVNK contact link when quoting off-ramp", async () => {
    const linkedCounterpartyId = await seedCounterparty({ externalId: "customer_contact_owner" });
    const counterpartyId = await seedCounterparty({ externalId: "customer_contact_unrelated" });
    // The quoting counterparty IS settled (its settlement wallet is active)
    // but has no customer link of its own; the contact id must come from its
    // own row, never from another counterparty's.
    await seedBvnkSettlementWallet(counterpartyId, { id: "cpa_settlement_unrelated" });
    await seedBvnkCustomerLink(linkedCounterpartyId, "contact_owner_1", "cpa_contact_owner");
    const createQuote = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createOfframpQuote");

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
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          assetRail: "usdc.solana",
          fiatCurrency: "USD",
          cryptoAmount: "75.25",
        }),
      },
      env
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
    expect(createQuote).not.toHaveBeenCalled();
    createQuote.mockRestore();
  });

  it("rejects a BVNK off-ramp quote until the settlement wallet is active", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "customer_settlement_pending" });
    const contactId = "contact_settlement_pending_1";
    await seedBvnkCustomerLink(counterpartyId, contactId, "cpa_contact_settlement_pending");
    // The settlement wallet row exists and is bound, but the wallet-status
    // webhook has not flipped it active yet: quoting fails closed.
    await seedBvnkSettlementWallet(counterpartyId, {
      id: "cpa_settlement_pending",
      providerStatus: "PENDING",
      status: "pending",
    });
    const createQuote = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createOfframpQuote");

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
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          assetRail: "usdc.solana",
          fiatCurrency: "USD",
          cryptoAmount: "75.25",
        }),
      },
      env
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
    expect(createQuote).not.toHaveBeenCalled();
    const transfer = await getDb(env)
      .prepare("SELECT id FROM payment_transfers WHERE counterparty_id = ? AND type = 'offramp'")
      .bind(counterpartyId)
      .first<{ id: string }>();
    expect(transfer).toBeNull();
    createQuote.mockRestore();
  });

  it("rejects a BVNK on-ramp quote with fiat outside the sandbox set before any BVNK call", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "customer_gbp_onramp" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

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
          counterpartyId,
          destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          assetRail: "usdc.solana",
          fiatCurrency: "GBP",
          fiatAmount: "100.00",
        }),
      },
      env
    );

    // BVNK only surfaces USD/EUR corridors (BVNK_SANDBOX_FIAT_CURRENCIES), so
    // any other fiat is refused before the provider is ever reached.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNSUPPORTED_CORRIDOR");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects a BVNK off-ramp quote with fiat outside the sandbox set before any BVNK call", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "customer_gbp_offramp" });
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
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          assetRail: "usdc.solana",
          fiatCurrency: "GBP",
          cryptoAmount: "75.25",
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNSUPPORTED_CORRIDOR");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns unsupported for BVNK on-ramp requirements with fiat outside the sandbox set", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "customer_gbp_req_onramp" });

    const res = await app.request(
      `/v1/counterparties/${counterpartyId}/requirements`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "bvnk",
          direction: "onramp",
          assetRail: "usdc.solana",
          destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          fiatCurrency: "GBP",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      provider: "bvnk",
      direction: "onramp",
      status: "unsupported",
    });
  });

  it("returns unsupported for BVNK off-ramp requirements with fiat outside the sandbox set", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "customer_gbp_req_offramp" });

    const res = await app.request(
      `/v1/counterparties/${counterpartyId}/requirements`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "bvnk",
          direction: "offramp",
          assetRail: "usdc.solana",
          fiatCurrency: "GBP",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      provider: "bvnk",
      direction: "offramp",
      status: "unsupported",
    });
  });

  it("returns collect with the contact identity fields for BVNK off-ramp requirements without any provider rows", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "customer_req_offramp_collect" });
    const res = await app.request(
      `/v1/counterparties/${counterpartyId}/requirements?provider=bvnk&direction=offramp&assetRail=usdc.solana&fiatCurrency=USD`,
      { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );

    expect(res.status).toBe(200);
    // Off-ramp requirements are exactly the shared contact collect step; there
    // is no bank-field collect anymore (withdraw-to-bank is deferred).
    expect((await res.json()).data).toMatchObject({
      provider: "bvnk",
      direction: "offramp",
      status: "collect",
      fields: expect.arrayContaining([
        expect.objectContaining({ key: "firstName", required: true }),
        expect.objectContaining({ key: "lastName", required: true }),
      ]),
    });
  });

  it("returns provisioning for BVNK off-ramp requirements until the settlement wallet is active", async () => {
    const counterpartyId = await seedCounterparty({
      externalId: "customer_req_offramp_provisioning",
    });
    await seedBvnkCustomerLink(
      counterpartyId,
      "contact_req_provisioning_1",
      "cpa_contact_req_provisioning"
    );
    await seedBvnkSettlementWallet(counterpartyId, {
      id: "cpa_settlement_req_provisioning",
      providerStatus: "PENDING",
      status: "pending",
    });

    const res = await app.request(
      `/v1/counterparties/${counterpartyId}/requirements?provider=bvnk&direction=offramp&assetRail=usdc.solana&fiatCurrency=USD`,
      { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      provider: "bvnk",
      direction: "offramp",
      status: "provisioning",
    });
  });

  it("returns ready for BVNK off-ramp requirements once the settlement wallet is active", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "customer_req_offramp_ready" });
    await seedBvnkCustomerLink(counterpartyId, "contact_req_ready_1", "cpa_contact_req_ready");
    await seedBvnkSettlementWallet(counterpartyId, { id: "cpa_settlement_req_ready" });

    const res = await app.request(
      `/v1/counterparties/${counterpartyId}/requirements?provider=bvnk&direction=offramp&assetRail=usdc.solana&fiatCurrency=USD`,
      { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      provider: "bvnk",
      direction: "offramp",
      status: "ready",
    });
  });

  it("advances BVNK off-ramp requirements from collect to provisioning, creating the settlement wallet", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "customer_advance_offramp" });
    // Identity collect: no customer link exists, so the advance creates the
    // BVNK contact first, then provisions the settlement wallet.
    const listContacts = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "listContactsV3")
      .mockResolvedValue([] as never);
    const createContact = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createContactV3")
      .mockResolvedValue({
        id: "contact_advance_offramp_1",
        type: "INDIVIDUAL",
        firstName: "Ada",
        lastName: "Lovelace",
        description: counterpartyId,
      } as never);
    const listProfiles = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "listLedgerWalletProfilesV2")
      .mockResolvedValue({
        content: [{ id: "profile_settlement_usd", currencies: ["USD"] }],
      } as never);
    const createWallet = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createLedgerWalletV2")
      .mockResolvedValue({
        id: TEST_BVNK_SETTLEMENT_WALLET_ID,
        name: buildBvnkOfframpWalletName(counterpartyId, "USD"),
        status: "PENDING",
        paymentInstruments: [],
      } as never);

    const res = await app.request(
      `/v1/counterparties/${counterpartyId}/requirements`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "bvnk",
          direction: "offramp",
          assetRail: "usdc.solana",
          fiatCurrency: "USD",
          collectedData: { firstName: "Ada", lastName: "Lovelace" },
        }),
      },
      env
    );

    // The wallet was created but the status webhook has not flipped it active.
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      provider: "bvnk",
      direction: "offramp",
      status: "provisioning",
    });
    expect(createContact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ description: counterpartyId })
    );
    expect(createWallet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        currency: "USD",
        name: buildBvnkOfframpWalletName(counterpartyId, "USD"),
        profileId: "profile_settlement_usd",
        idempotencyKey: expect.any(String),
      })
    );
    const link = await getDb(env)
      .prepare(
        "SELECT provider_customer_reference, status FROM counterparty_provider_accounts WHERE counterparty_id = ? AND kind = 'customer_link'"
      )
      .bind(counterpartyId)
      .first<{ provider_customer_reference: string | null; status: string }>();
    expect(link?.provider_customer_reference).toBe("contact_advance_offramp_1");
    expect(link?.status).toBe("active");
    const walletRow = await getDb(env)
      .prepare(
        "SELECT external_account_reference, provider_status, status FROM counterparty_provider_accounts WHERE counterparty_id = ? AND kind = 'virtual_settlement_wallet'"
      )
      .bind(counterpartyId)
      .first<{
        external_account_reference: string | null;
        provider_status: string | null;
        status: string;
      }>();
    expect(walletRow?.external_account_reference).toBe(TEST_BVNK_SETTLEMENT_WALLET_ID);
    expect(walletRow?.provider_status).toBe("PENDING");
    listContacts.mockRestore();
    createContact.mockRestore();
    listProfiles.mockRestore();
    createWallet.mockRestore();
  });

  it("returns ready when advancing BVNK off-ramp requirements with an active settlement wallet", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "customer_advance_offramp_ready" });
    await seedBvnkCustomerLink(
      counterpartyId,
      "contact_advance_ready_1",
      "cpa_contact_advance_ready"
    );
    await seedBvnkSettlementWallet(counterpartyId, { id: "cpa_settlement_advance_ready" });
    const createWallet = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createLedgerWalletV2");

    const res = await app.request(
      `/v1/counterparties/${counterpartyId}/requirements`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "bvnk",
          direction: "offramp",
          assetRail: "usdc.solana",
          fiatCurrency: "USD",
          collectedData: { firstName: "Ada", lastName: "Lovelace" },
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      provider: "bvnk",
      direction: "offramp",
      status: "ready",
    });
    expect(createWallet).not.toHaveBeenCalled();
    createWallet.mockRestore();
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
            assetRail: "usdc.solana",
            fiatCurrency: "EUR",
            fiatAmount: "100",
            counterpartyId: "cpty_quota_test",
            destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          }),
        },
        env
      );

      expect(res.status).toBe(429);
    });
  });

  describe("session-caller environment resolution", () => {
    const SESSION_ID = "ses_ramps_environment";
    const PRODUCTION_PROJECT_ID = `${TEST_PROJECT.id}_production`;

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
            destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            assetRail: "usdc.solana",
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
            sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            assetRail: "usdc.solana",
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
