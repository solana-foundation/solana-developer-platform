import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { badRequest, providerUnavailable } from "@sdp/payments/errors";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import { bvnkOnrampRemittance } from "@sdp/payments/ramps/providers/bvnk/provider-data";
import type { BvnkLedgerWalletV2 } from "@sdp/payments/ramps/providers/bvnk/schemas";
import { bvnkVerifiedIndividualCustomer } from "@sdp/payments/ramps/providers/bvnk/test-fixtures";
import { withRpcReadContext } from "@sdp/rpc/read-context";
import * as solanaRpc from "@sdp/rpc/solana";
import { createRpcFromTransport } from "@sdp/rpc/solana";
import {
  BVNK_FUNDING_WALLET_STATUS,
  type CounterpartyProviderAccount,
  type MoneygramRampEvent,
  type PaymentRampQuote,
  type PaymentTransferStatus,
  type PaymentTransferType,
  type RampProviderId,
  SDP_RAMP_PROVIDER_STAGES,
} from "@sdp/types";
import type { Address } from "@solana/addresses";
import type { RpcTransport } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import { getDb } from "@/db";
import type { CounterpartyProviderAccountRow } from "@/db/repositories/counterparty-provider-account.repository";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import app from "@/index";
import { noopObservability } from "@/runtime/observability";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import {
  bvnkSeedCustomerReference,
  seedBvnkCustomerLink,
  seedBvnkFundingWallet,
  seedBvnkOnrampPayoutIssued,
  seedBvnkOnrampTransfer,
  TEST_BVNK_WALLET_ID,
} from "@/test/helpers/bvnk";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
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
  TEST_PRODUCTION_PROJECT_ID,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import { providerStages } from "@/test/helpers/provider-stages";
import { required } from "@/test/helpers/required";
import { seedRateLimit } from "@/test/mocks/kv";

vi.mock("@sdp/types", async (importOriginal) => {
  const { mockProviderStages } = await import("@/test/helpers/provider-stages");
  return mockProviderStages(await importOriginal<typeof import("@sdp/types")>());
});

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

async function seedActiveConnectionWallet(params: {
  walletId: string;
  publicKey: string;
}): Promise<void> {
  const credentialId = "pcred_payments_connection_balance";
  const connectionId = "cconn_payments_connection_balance";
  const walletId = params.walletId;
  const publicKey = params.publicKey;

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
  amount: string;
  providerData: Record<string, unknown>;
}): Promise<string> {
  const counterpartyId = await seedCounterparty({ id: `cpty_${params.id}` });
  const status = "pending" satisfies PaymentTransferStatus;
  const now = new Date().toISOString();
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers (
         id, organization_id, project_id, wallet_id, source_address, destination_address,
         token, amount, memo, type, direction, status, provider, provider_reference,
         delivery_mode, fiat_currency, fiat_amount, provider_data, signature, serialized_tx,
         initiated_by_key_id, created_at, updated_at, counterparty_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      params.id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_WALLET_ID,
      params.type === "offramp" ? TEST_SOLANA_ADDRESSES.wallet1 : null,
      params.type === "onramp" ? TEST_SOLANA_ADDRESSES.wallet2 : null,
      "USDC",
      params.amount,
      null,
      params.type,
      params.type === "onramp" ? "inbound" : "outbound",
      status,
      params.provider,
      params.providerReference,
      params.provider === "moneygram" ? "session_widget" : "hosted",
      "USD",
      "25",
      params.providerData,
      null,
      null,
      null,
      now,
      now,
      counterpartyId
    )
    .run();
  return counterpartyId;
}

// Today every ramp provider is `experimental`; these stages put only MoonPay in
// `beta`, so a `beta` deployment runs Ramps without BVNK or Lightspark.
const moonpayOnlyBetaApp = createApp({
  observability: noopObservability,
  rampProviderStages: { ...SDP_RAMP_PROVIDER_STAGES, moonpay: "beta" },
});
const betaEnv = () => ({ ...env, SDP_RELEASE_CHANNEL: "beta" });

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
      await getDb(env).prepare("SELECT COUNT(*)::int AS count FROM payment_transfers").first<{
        count: number;
      }>()
    ).toEqual({ count: 0 });
  });
  it("creates a hosted quote for an exact Connection wallet row", async () => {
    await seedActiveConnectionWallet({
      walletId: TEST_CONNECTION_WALLET_ID,
      publicKey: TEST_SOLANA_ADDRESSES.wallet2,
    });
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
      await getDb(env).prepare("SELECT custody_wallet_id FROM payment_transfers").first<{
        custody_wallet_id: string | null;
      }>()
    ).toEqual({ custody_wallet_id: TEST_CONNECTION_CUSTODY_WALLET_ID });
  });

  it("reads an active Connection wallet balance and preserves API-key wallet scope", async () => {
    await seedActiveConnectionWallet({
      walletId: TEST_CONNECTION_WALLET_ID,
      publicKey: TEST_SOLANA_ADDRESSES.wallet2,
    });
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

  it.each([100, 101])(
    "bounds every wallet RPC read to the requested confirmation slot (bank %s)",
    async (slot) => {
      const payloads: unknown[] = [];
      const transport: RpcTransport = async <T>(request: Parameters<RpcTransport>[0]) => {
        payloads.push(request.payload);
        return { jsonrpc: "2.0", id: 1, result: { context: { slot }, value: null } } as T;
      };
      const rpc = createRpcFromTransport(transport, { wrapTransport: withRpcReadContext });
      const clusterRpc = vi.spyOn(solanaRpc, "createClusterRpc").mockReturnValueOnce(rpc);
      // Exercise real kit transport and the route's context wrappers. Only the
      // balance decoding helpers are fixtures in this broader payments suite.
      getAccountInfoMock.mockImplementationOnce(
        async () =>
          (
            await rpc
              .getAccountInfo(TEST_SOLANA_ADDRESSES.wallet1 as Address, { encoding: "base64" })
              .send()
          ).value
      );
      getSplTokenBalancesMock.mockImplementationOnce(async () => {
        await rpc
          .getAccountInfo(TEST_SOLANA_ADDRESSES.wallet1 as Address, { encoding: "base64" })
          .send();
        return [];
      });
      const res = await app.request(
        `/v1/payments/wallets/${TEST_WALLET_ID}/balances?minimumSlot=101`,
        { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );
      const body = await res.json();
      expect(res.status).toBe(slot < 101 ? 503 : 200);
      if (slot < 101) expect(body).not.toHaveProperty("data.walletBalances");
      else expect(body).toHaveProperty("data.balanceReadContext.minimumSlot", 101);
      expect(clusterRpc).toHaveBeenCalledWith(env, "devnet", {
        requestTimeoutMs: 3_000,
        wrapTransport: withRpcReadContext,
      });
      expect(payloads).toHaveLength(2);
      for (const payload of payloads)
        expect(payload).toMatchObject({
          params: [TEST_SOLANA_ADDRESSES.wallet1, { commitment: "confirmed", minContextSlot: 101 }],
        });
    }
  );

  it.each(["both", "SOL", "SPL"])(
    "returns unavailable rather than invented balances when %s RPC reads fail",
    async (failure) => {
      if (failure !== "SPL") getAccountInfoMock.mockRejectedValueOnce(new Error("rpc unavailable"));
      if (failure !== "SOL")
        getSplTokenBalancesMock.mockRejectedValueOnce(new Error("rpc unavailable"));
      const res = await app.request(
        `/v1/payments/wallets/${TEST_WALLET_ID}/balances`,
        {
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(res.status).toBe(503);
      expect(await res.json()).not.toHaveProperty("data.walletBalances");
    }
  );

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

  it("refuses a quote for a provider not surfaced in the project's environment", async () => {
    await seedCachedKey({ projectId: TEST_PRODUCTION_PROJECT_ID, environment: "production" });
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
          provider: "moneygram",
          counterpartyId: "cpty_unsurfaced_quote",
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          assetRail: "usdc.solana",
          fiatCurrency: "USD",
          cryptoAmount: "25",
        }),
      },
      env
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "MoneyGram is not currently offered.",
        details: { reason: "provider_not_offered" },
      },
      meta: { requestId: expect.any(String) },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  describe("in a stable release channel", () => {
    beforeEach(() => {
      providerStages.rampStageOverride = { provider: "moonpay", stage: "stable" };
    });

    afterEach(() => {
      providerStages.rampStageOverride = null;
    });

    it("refuses a quote for an experimental provider through the shared provider gate", async () => {
      const counterpartyId = await seedCounterparty({ externalId: "stable_channel_quote" });
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
            provider: "lightspark",
            counterpartyId,
            destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
            assetRail: "usdc.solana",
            fiatCurrency: "USD",
            fiatAmount: "100.00",
          }),
        },
        { ...env, SDP_RELEASE_CHANNEL: "stable" }
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: {
          code: "FORBIDDEN",
          message: "Lightspark is not available in this release channel.",
          details: { reason: "provider_not_in_release_channel" },
        },
        meta: { requestId: expect.any(String) },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
      const transfers = await getDb(env)
        .prepare("SELECT id FROM payment_transfers WHERE counterparty_id = ?")
        .bind(counterpartyId)
        .all<{ id: string }>();
      expect(transfers.results).toEqual([]);
    });
  });

  describe("BVNK off-ramp quote (funding-wallet channel)", () => {
    const BVNK_OFFRAMP_CUSTOMER = "bvnk_offramp_test_customer";
    async function seedProvisionedOfframpCounterparty(externalId: string): Promise<string> {
      const counterpartyId = await seedCounterparty({ externalId });
      await seedBvnkCustomerLink(getDb(env), {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        counterpartyId,
        customerReference: BVNK_OFFRAMP_CUSTOMER,
        status: "VERIFIED",
      });
      return counterpartyId;
    }

    function bvnkOfframpQuoteRequest(counterpartyId: string, overrides?: Record<string, unknown>) {
      return app.request(
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
            ...overrides,
          }),
        },
        env
      );
    }

    function mockBvnkChannelQuote() {
      return {
        provider: "bvnk",
        id: "channel_offramp_test_1",
        status: "pending",
        deliveryMode: "manual_instructions",
        paymentInstructions: [
          {
            provider: "bvnk",
            kind: "crypto_deposit",
            fiatCurrency: "USD",
            cryptoCurrency: "USDC",
            destinationAddress: TEST_SOLANA_ADDRESSES.wallet2 as Address,
            network: "SOLANA",
            reference: "sdp_offramp_xfr_1",
            instructionsNotes:
              "Send USDC on SOLANA to the deposit address. BVNK converts it to USD and credits the counterparty's BVNK USD wallet.",
          },
        ],
      } satisfies PaymentRampQuote;
    }

    it("fails before prebooking when the funding wallet is not provisioned, and writes no transfer", async () => {
      const counterpartyId = await seedProvisionedOfframpCounterparty(
        "customer_offramp_no_funding_wallet"
      );
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const res = await bvnkOfframpQuoteRequest(counterpartyId);

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CONFLICT");
      expect(body.error.message).toContain("not provisioned for bvnk offramp");
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();

      const transfer = await getDb(env)
        .prepare("SELECT COUNT(*) AS count FROM payment_transfers WHERE counterparty_id = ?")
        .bind(counterpartyId)
        .first<{ count: number }>();
      expect(required(transfer).count).toBe(0);
    });
    it("opens the off-ramp channel on the funding wallet with an ORIGINATOR party and prebooks the transfer", async () => {
      const counterpartyId = await seedProvisionedOfframpCounterparty(
        "customer_offramp_provisioned"
      );
      await seedBvnkFundingWallet(getDb(env), {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        counterpartyId,
        providerCustomerReference: BVNK_OFFRAMP_CUSTOMER,
        walletId: TEST_BVNK_WALLET_ID,
        stage: "provisioned",
        metadata: {},
      });
      const getCustomerSpy = vi
        .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getCustomer")
        .mockResolvedValue(bvnkVerifiedIndividualCustomer({ reference: BVNK_OFFRAMP_CUSTOMER }));
      const channelSpy = vi
        .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createOfframpQuote")
        .mockResolvedValue(mockBvnkChannelQuote());

      const res = await bvnkOfframpQuoteRequest(counterpartyId);

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { transferId: string; quote: { id: string; deliveryMode: string } };
      };
      expect(body.data.transferId.startsWith("xfr_")).toBe(true);
      expect(body.data.quote.id).toBe("channel_offramp_test_1");
      expect(body.data.quote.deliveryMode).toBe("manual_instructions");

      const input = required(channelSpy.mock.calls[0])[1];
      expect(required(input).paymentTransferId).toBe(body.data.transferId);
      expect(required(input).bvnkFundingWalletId).toBe(TEST_BVNK_WALLET_ID);
      expect(required(input).externalCustomerId).toBe(BVNK_OFFRAMP_CUSTOMER);
      expect(required(required(required(input).bvnkCompliance).partyDetails[0]).type).toBe(
        "ORIGINATOR"
      );
      expect(required(required(required(input).bvnkCompliance).partyDetails[0]).firstName).toBe(
        "Ada"
      );

      const transfer = await getDb(env)
        .prepare(
          "SELECT status, provider_reference, provider_data FROM payment_transfers WHERE counterparty_id = ?"
        )
        .bind(counterpartyId)
        .first<{
          status: string;
          provider_reference: string | null;
          provider_data: Record<string, unknown>;
        }>();
      expect(required(transfer).status).toBe("awaiting_payment");
      expect(required(transfer).provider_reference).toBe("channel_offramp_test_1");
      expect(required(transfer).provider_data).toEqual({
        cryptoDeposit: { destinationAddress: TEST_SOLANA_ADDRESSES.wallet2, amount: "75.25" },
        bvnk: {
          channel: {
            id: "channel_offramp_test_1",
            walletId: TEST_BVNK_WALLET_ID,
            customerReference: BVNK_OFFRAMP_CUSTOMER,
          },
        },
      });

      getCustomerSpy.mockRestore();
      channelSpy.mockRestore();
    });
    it("rejects the off-ramp quote when the fresh BVNK customer status is no longer verified, patches the link, and writes no transfer", async () => {
      const counterpartyId = await seedProvisionedOfframpCounterparty(
        "customer_offramp_fresh_rejected"
      );
      await seedBvnkFundingWallet(getDb(env), {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        counterpartyId,
        providerCustomerReference: BVNK_OFFRAMP_CUSTOMER,
        walletId: TEST_BVNK_WALLET_ID,
        stage: "provisioned",
        metadata: {},
      });
      const getCustomerSpy = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getCustomer").mockResolvedValue({
        ...bvnkVerifiedIndividualCustomer({ reference: BVNK_OFFRAMP_CUSTOMER }),
        status: "REJECTED",
      });
      const channelSpy = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createOfframpQuote");

      const res = await bvnkOfframpQuoteRequest(counterpartyId);

      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: { code: string; details: { customerStatus: string } };
      };
      expect(body.error.code).toBe("CONFLICT");
      expect(body.error.details.customerStatus).toBe("REJECTED");
      expect(channelSpy).not.toHaveBeenCalled();
      const transfers = await getDb(env)
        .prepare("SELECT COUNT(*) AS count FROM payment_transfers WHERE counterparty_id = ?")
        .bind(counterpartyId)
        .first<{ count: number }>();
      expect(required(transfers).count).toBe(0);
      const link = await getDb(env)
        .prepare(
          "SELECT metadata->>'status' AS status FROM counterparty_provider_accounts WHERE counterparty_id = ? AND provider = 'bvnk' AND kind = 'customer_link'"
        )
        .bind(counterpartyId)
        .first<{ status: string }>();
      expect(required(link).status).toBe("REJECTED");

      getCustomerSpy.mockRestore();
      channelSpy.mockRestore();
    });
    it("keeps the prebooked transfer pending when the quote has no crypto deposit instruction", async () => {
      const counterpartyId = await seedProvisionedOfframpCounterparty(
        "customer_offramp_missing_instruction"
      );
      await seedBvnkFundingWallet(getDb(env), {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        counterpartyId,
        providerCustomerReference: BVNK_OFFRAMP_CUSTOMER,
        walletId: TEST_BVNK_WALLET_ID,
        stage: "provisioned",
        metadata: {},
      });
      vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getCustomer").mockResolvedValue(
        bvnkVerifiedIndividualCustomer({ reference: BVNK_OFFRAMP_CUSTOMER })
      );
      vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createOfframpQuote").mockResolvedValue({
        ...mockBvnkChannelQuote(),
        paymentInstructions: [],
      });
      const response = await bvnkOfframpQuoteRequest(counterpartyId);
      expect(response.status).toBe(500);
      const body = (await response.json()) as {
        error: {
          code: string;
          message: string;
        };
      };
      expect(body.error.code).toBe("INTERNAL_ERROR");
      const transfer = await getDb(env)
        .prepare(
          "SELECT status, provider_reference, provider_data FROM payment_transfers WHERE counterparty_id = ?"
        )
        .bind(counterpartyId)
        .first<{
          status: PaymentTransferStatus;
          provider_reference: string | null;
          provider_data: Record<string, unknown>;
        }>();
      expect(transfer).toMatchObject({ status: "pending", provider_reference: null });
      expect(required(transfer).provider_data).not.toHaveProperty("cryptoDeposit");
      expect(required(transfer).provider_data).not.toHaveProperty("bvnk.channel");
    });
    it("marks the prebooked transfer failed when the channel call errors", async () => {
      const counterpartyId = await seedProvisionedOfframpCounterparty(
        "customer_offramp_channel_error"
      );
      await seedBvnkFundingWallet(getDb(env), {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        counterpartyId,
        providerCustomerReference: BVNK_OFFRAMP_CUSTOMER,
        walletId: TEST_BVNK_WALLET_ID,
        stage: "provisioned",
        metadata: {},
      });
      const getCustomerSpy = vi
        .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getCustomer")
        .mockResolvedValue(bvnkVerifiedIndividualCustomer({ reference: BVNK_OFFRAMP_CUSTOMER }));
      const channelSpy = vi
        .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createOfframpQuote")
        .mockRejectedValue(new Error("channel exploded"));

      const res = await bvnkOfframpQuoteRequest(counterpartyId);

      expect(res.status).toBe(500);

      const transfer = await getDb(env)
        .prepare("SELECT status FROM payment_transfers WHERE counterparty_id = ?")
        .bind(counterpartyId)
        .first<{ status: string }>();
      expect(required(transfer).status).toBe("failed");

      getCustomerSpy.mockRestore();
      channelSpy.mockRestore();
    });
  });
  describe("BVNK on-ramp quote (rules-free prebook)", () => {
    const BVNK_QUOTE_CUSTOMER = "bvnk_quote_customer_1";
    async function seedVerifiedCounterparty(externalId: string): Promise<string> {
      const counterpartyId = await seedCounterparty({ externalId });
      await seedBvnkCustomerLink(getDb(env), {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        counterpartyId,
        customerReference: BVNK_QUOTE_CUSTOMER,
        status: "VERIFIED",
      });
      return counterpartyId;
    }

    function bvnkQuoteRequest(counterpartyId: string, overrides?: Record<string, unknown>) {
      return app.request(
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
            fiatCurrency: "USD",
            fiatAmount: "120.50",
            ...overrides,
          }),
        },
        env
      );
    }

    function mockBvnkWallet(): BvnkLedgerWalletV2 {
      return {
        id: TEST_BVNK_WALLET_ID,
        name: "USD Funding Wallet",
        status: "ACTIVE",
        paymentInstruments: [
          {
            type: "FIAT",
            accountHolderName: "Amelia Earhart",
            accountNumber: "900473221558",
            bankDetails: {
              bic: "LEADUS49XXX",
              name: "LEAD BANK",
              nid: { value: "021000021", type: "ROUTING_NUMBER" },
            },
            remittanceInformationPrefix: "BVNK-REF-1",
          },
        ],
      };
    }
    it("prebooks the transfer, gets the ledger wallet, and answers instructions carrying the SDP-ONRAMP reference without touching rules or the funding wallet", async () => {
      const counterpartyId = await seedVerifiedCounterparty("d1b_quote_provisioned");
      const fundingRow = await seedBvnkFundingWallet(getDb(env), {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        counterpartyId,
        providerCustomerReference: BVNK_QUOTE_CUSTOMER,
        walletId: TEST_BVNK_WALLET_ID,
        stage: "provisioned",
        metadata: {},
      });
      const walletSpy = vi
        .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getLedgerWalletV2")
        .mockResolvedValue(mockBvnkWallet());
      const payoutSpy = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createOnrampPayout");

      const res = await bvnkQuoteRequest(counterpartyId);

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          quote: {
            provider: string;
            deliveryMode: string;
            paymentInstructions: Array<{
              kind: string;
              onboardingStatus: string;
              fundingWalletId: string;
              bankAccount?: Record<string, unknown>;
            }>;
          };
          transferId: string;
        };
      };
      expect(body.data.transferId.startsWith("xfr_")).toBe(true);
      expect(body.data.quote.provider).toBe("bvnk");
      expect(body.data.quote.deliveryMode).toBe("manual_instructions");
      const instruction = body.data.quote.paymentInstructions[0];
      expect(instruction.kind).toBe("fiat_funding");
      expect(instruction.onboardingStatus).toBe("ready");
      expect(instruction.fundingWalletId).toBe(TEST_BVNK_WALLET_ID);
      expect(required(instruction.bankAccount).paymentReference).toBe(
        bvnkOnrampRemittance(body.data.transferId)
      );
      expect(required(instruction.bankAccount).routingNumber).toBe("021000021");
      expect(walletSpy).toHaveBeenCalledTimes(1);
      expect(walletSpy).toHaveBeenCalledWith(expect.anything(), {
        walletId: TEST_BVNK_WALLET_ID,
      });
      expect(payoutSpy).not.toHaveBeenCalled();

      const transfer = await getDb(env)
        .prepare(
          "SELECT status, provider_reference, delivery_mode, provider_data FROM payment_transfers WHERE id = ?"
        )
        .bind(body.data.transferId)
        .first<{
          status: string;
          provider_reference: string;
          delivery_mode: string;
          provider_data: Record<string, unknown>;
        }>();
      expect(transfer).toMatchObject({
        status: "awaiting_payment",
        provider_reference: body.data.transferId,
        delivery_mode: "manual_instructions",
      });
      expect(required(transfer).provider_data).toEqual({ bvnk: {} });
      const persisted = await getDb(env)
        .prepare(
          "SELECT provider_status, metadata FROM counterparty_provider_accounts WHERE id = ?"
        )
        .bind(fundingRow.id)
        .first<{ provider_status: string; metadata: Record<string, unknown> }>();
      expect(persisted).toEqual({
        provider_status: BVNK_FUNDING_WALLET_STATUS.provisioned,
        metadata: {},
      });

      walletSpy.mockRestore();

      payoutSpy.mockRestore();
    });
    it("fails the prebooked transfer when the ledger wallet read rejects", async () => {
      const counterpartyId = await seedVerifiedCounterparty("d1b_quote_wallet_fail");
      await seedBvnkFundingWallet(getDb(env), {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        counterpartyId,
        providerCustomerReference: BVNK_QUOTE_CUSTOMER,
        walletId: TEST_BVNK_WALLET_ID,
        stage: "provisioned",
        metadata: {},
      });
      const walletSpy = vi
        .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getLedgerWalletV2")
        .mockRejectedValue(new Error("BVNK ledger wallet read failed"));

      const res = await bvnkQuoteRequest(counterpartyId);

      expect(res.status).toBe(500);
      const failed = await getDb(env)
        .prepare(
          "SELECT status, error FROM payment_transfers WHERE counterparty_id = ? ORDER BY created_at DESC LIMIT 1"
        )
        .bind(counterpartyId)
        .first<{ status: string; error: string }>();
      expect(required(failed).status).toBe("failed");
      expect(required(failed).error).toContain("BVNK ledger wallet read failed");
      const funding = await getDb(env)
        .prepare(
          "SELECT provider_status, metadata FROM counterparty_provider_accounts WHERE counterparty_id = ? AND kind = 'funding_wallet'"
        )
        .bind(counterpartyId)
        .first<{ provider_status: string; metadata: Record<string, unknown> }>();
      expect(funding).toEqual({
        provider_status: BVNK_FUNDING_WALLET_STATUS.provisioned,
        metadata: {},
      });

      walletSpy.mockRestore();
    });
    it("answers counterpartyNotProvisioned while the funding wallet is provisioning", async () => {
      const counterpartyId = await seedVerifiedCounterparty("d1b_quote_provisioning");
      await seedBvnkFundingWallet(getDb(env), {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        counterpartyId,
        providerCustomerReference: BVNK_QUOTE_CUSTOMER,
        walletId: TEST_BVNK_WALLET_ID,
        stage: "claimed",
        metadata: {},
      });
      const walletSpy = vi
        .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getLedgerWalletV2")
        .mockResolvedValue(mockBvnkWallet());

      const res = await bvnkQuoteRequest(counterpartyId);

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CONFLICT");
      expect(body.error.message).toContain("not provisioned for bvnk onramp");
      expect(walletSpy).not.toHaveBeenCalled();

      walletSpy.mockRestore();
    });

    it("rejects a non-USD fiat currency before touching the funding wallet", async () => {
      const counterpartyId = await seedVerifiedCounterparty("d1b_quote_eur");

      const res = await bvnkQuoteRequest(counterpartyId, { fiatCurrency: "EUR" });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("USD only");
      const rows = await getDb(env)
        .prepare("SELECT COUNT(*)::int AS count FROM payment_transfers")
        .first<{ count: number }>();
      expect(rows).toEqual({ count: 0 });
    });
  });

  describe("BVNK on-ramp providerReference projection (A3)", () => {
    const A3_TRANSFER_ID = "xfr_a3_projection";
    const A3_ISSUED_TRANSFER_ID = "xfr_a3_projection_issued";
    const A3_PAYOUT_ID = "payout_a3_projection_1";

    it("omits providerReference before the payout exists and surfaces the payout uuid once the settlement lands", async () => {
      const counterpartyId = await seedCounterparty({ externalId: "a3_bvnk_projection" });
      await seedBvnkOnrampTransfer(getDb(env), {
        id: A3_TRANSFER_ID,
        status: "awaiting_payment",
        counterpartyId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        fiatAmount: "25.00",
        destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
      });

      const readTimestamps = async (transferId: string) =>
        getDb(env)
          .prepare("SELECT created_at, updated_at FROM payment_transfers WHERE id = ?")
          .bind(transferId)
          .first<{ created_at: string; updated_at: string }>();

      const fetchTransfer = async (transferId: string) => {
        const res = await app.request(
          `/v1/payments/transfers/${transferId}`,
          {
            headers: {
              Authorization: `Bearer ${TEST_API_KEY.raw}`,
            },
          },
          env
        );
        expect(res.status).toBe(200);
        return (await res.json()) as { data: { transfer: Record<string, unknown> } };
      };

      const before = await readTimestamps(A3_TRANSFER_ID);
      assert(!(before === null));
      const expectedBefore = {
        id: A3_TRANSFER_ID,
        organizationId: TEST_ORG.id,
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        providerWalletId: "wallet_bvnk_onramp_seed",
        projectId: TEST_PROJECT.id,
        type: "onramp",
        kind: "onramp",
        direction: "inbound",
        status: "awaiting_payment",
        signature: null,
        serializedTx: null,
        slot: null,
        blockTime: null,
        fee: null,
        error: null,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        counterpartyId,
        rampsMemo: {},
        token: "USDC",
        createdAt: before.created_at,
        updatedAt: before.updated_at,
        provider: "bvnk",
        deliveryMode: "manual_instructions",
        fiatCurrency: "USD",
        fiatAmount: "25.00",
      };
      expect((await fetchTransfer(A3_TRANSFER_ID)).data.transfer).toEqual(expectedBefore);

      const issued = await seedBvnkOnrampPayoutIssued(getDb(env), {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        name: "a3_bvnk_projection_issued",
        createdBy: TEST_USER.id,
        fundingWalletReference: TEST_BVNK_WALLET_ID,
        transferId: A3_ISSUED_TRANSFER_ID,
        destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
        payin: {
          id: "payin_a3_projection_issued",
          receivedAmount: "25.00",
          receivedCurrency: "USD",
          walletId: TEST_BVNK_WALLET_ID,
          customerId: bvnkSeedCustomerReference("a3_bvnk_projection_issued"),
        },
        claimedAt: "2026-09-18T00:00:00.000Z",
        intent: {
          amount: "24.9",
          currency: "USD",
          cryptoCurrency: "USDC",
          network: "SOLANA",
          address: TEST_SOLANA_ADDRESSES.wallet2,
        },
        environment: "sandbox",
        payoutId: A3_PAYOUT_ID,
      });
      assert(!(issued.counterparty_id === null));
      const settlement = issued.provider_data.settlement as Record<string, unknown>;

      const after = await readTimestamps(A3_ISSUED_TRANSFER_ID);
      assert(!(after === null));
      const fetched = await fetchTransfer(A3_ISSUED_TRANSFER_ID);
      expect(fetched.data.transfer).toEqual({
        ...expectedBefore,
        id: A3_ISSUED_TRANSFER_ID,
        custodyWalletId: null,
        counterpartyId: issued.counterparty_id,
        status: "settling",
        createdAt: after.created_at,
        updatedAt: after.updated_at,
        providerReference: A3_PAYOUT_ID,
        settlement,
      });
    });

    it("keeps the stored provider reference for non-BVNK providers", async () => {
      await seedRampTransfer({
        id: "xfr_a3_coinbase",
        provider: "coinbase",
        providerReference: "coinbase_order_a3",
        status: "pending",
      });

      const res = await app.request(
        "/v1/payments/transfers/xfr_a3_coinbase",
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { transfer: { providerReference: string } };
      };
      expect(body.data.transfer.providerReference).toBe("coinbase_order_a3");
    });
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
    expect(required(row).status).toBe("canceled");
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
    expect(required(row).status).toBe("settling");
  });
  it("refuses to cancel a transfer at a provider outside the release channel", async () => {
    await seedRampTransfer({
      id: "xfr_cancel_excluded",
      provider: "bvnk",
      providerReference: "bvnk_ref_cancel_excluded",
      status: "awaiting_payment",
    });

    const res = await moonpayOnlyBetaApp.request(
      "/v1/payments/ramps/transfers/cancel",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ transferId: "xfr_cancel_excluded" }),
      },
      betaEnv()
    );

    expect(res.status).toBe(403);
    const row = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind("xfr_cancel_excluded")
      .first<{ status: string }>();
    expect(required(row).status).toBe("awaiting_payment");
  });
  it("fails a ramp transfer with no provider instead of skipping the release channel gate", async () => {
    await seedRampTransfer({
      id: "xfr_cancel_no_provider",
      provider: "bvnk",
      providerReference: "bvnk_ref_cancel_no_provider",
      status: "awaiting_payment",
    });
    await getDb(env)
      .prepare("UPDATE payment_transfers SET provider = NULL WHERE id = ?")
      .bind("xfr_cancel_no_provider")
      .run();

    const res = await moonpayOnlyBetaApp.request(
      "/v1/payments/ramps/transfers/cancel",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ transferId: "xfr_cancel_no_provider" }),
      },
      betaEnv()
    );

    expect(res.status).toBe(500);
    const row = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind("xfr_cancel_no_provider")
      .first<{ status: string }>();
    expect(required(row).status).toBe("awaiting_payment");
  });
  it("cancels an awaiting BVNK on-ramp transfer after the custody-wallet authz without touching BVNK", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "d1b_cancel_onramp" });
    await seedBvnkOnrampTransfer(getDb(env), {
      id: "xfr_cancel_onramp",
      status: "awaiting_payment",
      counterpartyId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      fiatAmount: "25.00",
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
    });
    await seedBvnkFundingWallet(getDb(env), {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      counterpartyId,
      providerCustomerReference: "bvnk_cancel_onramp",
      walletId: TEST_BVNK_WALLET_ID,
      stage: "provisioned",
      metadata: {},
    });
    const payoutSpy = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createOnrampPayout");

    const res = await app.request(
      "/v1/payments/ramps/transfers/cancel",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ transferId: "xfr_cancel_onramp" }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { transfer: { status: string } } };
    expect(body.data.transfer.status).toBe("canceled");
    expect(payoutSpy).not.toHaveBeenCalled();
    const funding = await getDb(env)
      .prepare(
        "SELECT provider_status, metadata FROM counterparty_provider_accounts WHERE counterparty_id = ? AND kind = 'funding_wallet'"
      )
      .bind(counterpartyId)
      .first<{ provider_status: string; metadata: Record<string, unknown> }>();
    expect(funding).toEqual({
      provider_status: BVNK_FUNDING_WALLET_STATUS.provisioned,
      metadata: {},
    });

    payoutSpy.mockRestore();
  });

  it("denies canceling a BVNK on-ramp transfer outside the custody-wallet authz", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "d1b_cancel_authz" });
    await getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, 'Unbound wallet', 'transfer', 'active')`
      )
      .bind(
        "cwlt_not_bound_to_key",
        TEST_CONFIG_ID,
        "wallet_unbound_cancel",
        TEST_SOLANA_ADDRESSES.wallet2
      )
      .run();
    await seedCachedKey({
      walletBindings: [{ walletId: TEST_WALLET_ID, permissions: ["payments:write"] }],
    });
    await seedBvnkOnrampTransfer(getDb(env), {
      id: "xfr_cancel_authz",
      status: "awaiting_payment",
      counterpartyId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      fiatAmount: "25.00",
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
      custodyWalletId: "cwlt_not_bound_to_key",
    });

    const res = await app.request(
      "/v1/payments/ramps/transfers/cancel",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ transferId: "xfr_cancel_authz" }),
      },
      env
    );

    expect(res.status).toBe(403);
    const row = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind("xfr_cancel_authz")
      .first<{ status: string }>();
    expect(required(row).status).toBe("awaiting_payment");
  });
  describe("sandbox pay-in simulation", () => {
    let originalMuralSandboxApiKey: string | undefined;
    let originalMuralSandboxTransferApiKey: string | undefined;
    let originalCoinbaseApiKeyId: string | undefined;
    let originalCoinbaseApiKeySecret: string | undefined;

    beforeEach(() => {
      originalMuralSandboxApiKey = env.MURAL_PAY_SANDBOX_API_KEY;
      originalMuralSandboxTransferApiKey = env.MURAL_PAY_SANDBOX_TRANSFER_API_KEY;
      originalCoinbaseApiKeyId = env.COINBASE_CDP_API_KEY_ID;
      originalCoinbaseApiKeySecret = env.COINBASE_CDP_API_KEY_SECRET;
      env.MURAL_PAY_SANDBOX_API_KEY = "test-mural-simulation-api-key";
      env.MURAL_PAY_SANDBOX_TRANSFER_API_KEY = "test-mural-simulation-transfer-api-key";
      env.COINBASE_CDP_API_KEY_ID = "test-coinbase-simulation-api-key-id";
      env.COINBASE_CDP_API_KEY_SECRET = "test-coinbase-simulation-api-key-secret";
    });

    afterEach(() => {
      env.MURAL_PAY_SANDBOX_API_KEY = originalMuralSandboxApiKey;
      env.MURAL_PAY_SANDBOX_TRANSFER_API_KEY = originalMuralSandboxTransferApiKey;
      env.COINBASE_CDP_API_KEY_ID = originalCoinbaseApiKeyId;
      env.COINBASE_CDP_API_KEY_SECRET = originalCoinbaseApiKeySecret;
    });

    const SIMULATE_TRANSFER_ID = "xfr_123e4567-e89b-12d3-a456-426614174abc";
    const LIGHTSPARK_SIM_SEED = {
      provider: "lightspark",
      providerReference: "Quote:sim-1",
      fiatCurrency: "USD",
      fiatAmount: "250.00",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      providerData: {},
      type: "onramp",
      status: "awaiting_payment",
    } as const satisfies Omit<
      Parameters<typeof seedSimulatableTransfer>[0],
      "id" | "counterpartyId"
    >;

    async function seedSimulatableTransfer(input: {
      id: string;
      provider: RampProviderId;
      providerReference: string;
      fiatCurrency: string;
      fiatAmount: string;
      counterpartyId: string;
      providerData: Record<string, unknown>;
      organizationId: string;
      projectId: string;
      type: PaymentTransferType;
      status: PaymentTransferStatus;
    }): Promise<void> {
      const now = new Date().toISOString();
      const type = input.type;
      await getDb(env)
        .prepare(
          `INSERT INTO payment_transfers (
             id, organization_id, project_id, wallet_id, custody_wallet_id, source_address,
             destination_address, token, amount, memo, type, direction, status, provider,
             provider_reference, delivery_mode, fiat_currency, fiat_amount, counterparty_id,
             provider_data, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
        )
        .bind(
          input.id,
          input.organizationId,
          input.projectId,
          TEST_WALLET_ID,
          TEST_CUSTODY_WALLET_ID,
          type === "offramp" ? TEST_SOLANA_ADDRESSES.wallet2 : null,
          type === "onramp" ? TEST_SOLANA_ADDRESSES.wallet2 : null,
          "USDC",
          null,
          null,
          type,
          type === "onramp" ? "inbound" : "outbound",
          input.status,
          input.provider,
          input.providerReference,
          "manual_instructions",
          input.fiatCurrency,
          input.fiatAmount,
          input.counterpartyId,
          input.providerData,
          now,
          now
        )
        .run();
    }

    function readSimulationTransfer(transferId: string) {
      return getDb(env)
        .prepare("SELECT status, provider_data, updated_at FROM payment_transfers WHERE id = ?")
        .bind(transferId)
        .first<{
          status: PaymentTransferStatus;
          provider_data: { sandboxSimulation?: { requestedAt: string } };
          updated_at: string;
        }>();
    }

    async function seedBvnkSimulatableTransfer(): Promise<string> {
      const counterpartyId = await seedCounterparty({ externalId: "d1b_simulate_bvnk" });
      await seedBvnkFundingWallet(getDb(env), {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        counterpartyId,
        providerCustomerReference: "bvnk_simulate_1",
        walletId: TEST_BVNK_WALLET_ID,
        stage: "provisioned",
        metadata: {},
      });
      await seedBvnkOnrampTransfer(getDb(env), {
        id: SIMULATE_TRANSFER_ID,
        status: "awaiting_payment",
        counterpartyId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        fiatAmount: "120.50",
        destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
      });
      return counterpartyId;
    }

    function simulateRequest(transferId: string) {
      return app.request(
        "/v1/payments/ramps/sandbox/simulate",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ transferId }),
        },
        env
      );
    }

    it("claims the simulation slot, sends the SDP-ONRAMP remittance, and uses the transfer id as the idempotency key", async () => {
      await seedBvnkSimulatableTransfer();
      const simulateSpy = vi
        .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "simulatePayin")
        .mockResolvedValue({ accepted: true });

      const res = await simulateRequest(SIMULATE_TRANSFER_ID);

      expect(res.status).toBe(204);
      expect(simulateSpy).toHaveBeenCalledTimes(1);
      expect(simulateSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          walletId: TEST_BVNK_WALLET_ID,
          amount: 120.5,
          currency: "USD",
          remittanceInformation: bvnkOnrampRemittance(SIMULATE_TRANSFER_ID),
          idempotencyKey: SIMULATE_TRANSFER_ID,
        })
      );
      const transfer = await readSimulationTransfer(SIMULATE_TRANSFER_ID);
      expect(required(transfer).status).toBe("awaiting_payment");
      expect(required(required(transfer).provider_data.sandboxSimulation).requestedAt).toBeTruthy();

      simulateSpy.mockRestore();
    });

    it("refuses to simulate a transfer at a provider outside the release channel", async () => {
      await seedBvnkSimulatableTransfer();
      const simulateSpy = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "simulatePayin");

      const res = await moonpayOnlyBetaApp.request(
        "/v1/payments/ramps/sandbox/simulate",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ transferId: SIMULATE_TRANSFER_ID }),
        },
        betaEnv()
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: {
          code: "FORBIDDEN",
          message: "BVNK is not available in this release channel.",
          details: { reason: "provider_not_in_release_channel" },
        },
        meta: { requestId: expect.any(String) },
      });
      expect(simulateSpy).not.toHaveBeenCalled();
      simulateSpy.mockRestore();
    });

    it("derives the Lightspark payload from the transfer, claims the slot once, and answers 409 on repeat", async () => {
      const transferId = "xfr_lightspark_sim_1";
      const counterpartyId = await seedCounterparty({ providerData: {} });
      await seedSimulatableTransfer({
        ...LIGHTSPARK_SIM_SEED,
        id: transferId,
        counterpartyId,
      });
      const simulateSpy = vi
        .spyOn(RAMP_PROVIDER_CLIENTS.lightspark, "sandboxSend")
        .mockResolvedValue({ accepted: true });

      const first = await simulateRequest(transferId);
      const second = await simulateRequest(transferId);

      expect(first.status).toBe(204);
      expect(simulateSpy).toHaveBeenCalledTimes(1);
      expect(simulateSpy).toHaveBeenCalledWith(expect.anything(), {
        quoteId: "Quote:sim-1",
        currencyCode: "USD",
      });
      const transfer = await readSimulationTransfer(transferId);
      expect(required(required(transfer).provider_data.sandboxSimulation).requestedAt).toBeTruthy();

      expect(second.status).toBe(409);
      const body: { error: { message: string } } = await second.json();
      expect(body.error.message).toContain("already requested for this transfer");

      simulateSpy.mockRestore();
    });

    it("rejects an unavailable provider before calling it or claiming the simulation slot", async () => {
      const transferId = "xfr_lightspark_sim_unavailable";
      const counterpartyId = await seedCounterparty({ providerData: {} });
      await seedSimulatableTransfer({
        ...LIGHTSPARK_SIM_SEED,
        id: transferId,
        counterpartyId,
      });
      const before = await readSimulationTransfer(transferId);
      const originalLightsparkSandboxSecret = env.LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET;
      env.LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET = undefined;
      const simulateSpy = vi
        .spyOn(RAMP_PROVIDER_CLIENTS.lightspark, "sandboxSend")
        .mockResolvedValue({ accepted: true });

      try {
        const res = await simulateRequest(transferId);

        expect(res.status).toBe(503);
        const body: { error: { code: string; message: string } } = await res.json();
        expect(body.error).toMatchObject({
          code: "PROVIDER_NOT_CONFIGURED",
          message: "Lightspark is not configured for sandbox projects in this deployment.",
        });
        expect(simulateSpy).not.toHaveBeenCalled();
        const transfer = await readSimulationTransfer(transferId);
        expect(transfer).not.toBeNull();
        expect(required(transfer).provider_data).not.toHaveProperty("sandboxSimulation");
        expect(transfer).toEqual(before);
      } finally {
        env.LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET = originalLightsparkSandboxSecret;
        simulateSpy.mockRestore();
      }
    });

    it.each([
      {
        name: "releases the claim on a definitive provider rejection so a retry succeeds",
        transferId: "xfr_lightspark_sim_release",
        error: badRequest("Grid rejected the sandbox send", {
          provider: "lightspark",
          providerStatus: 400,
        }),
        firstStatus: 400,
        claimAfterFailure: false,
        secondStatus: 204,
        providerCalls: 2,
      },
      {
        name: "keeps the claim on an ambiguous provider failure so a retry gets 409",
        transferId: "xfr_lightspark_sim_ambiguous",
        error: providerUnavailable("Failed to reach the lightspark API", {
          provider: "lightspark",
        }),
        firstStatus: 503,
        claimAfterFailure: true,
        secondStatus: 409,
        providerCalls: 1,
      },
    ])(
      "$name",
      async ({
        transferId,
        error,
        firstStatus,
        claimAfterFailure,
        secondStatus,
        providerCalls,
      }) => {
        const counterpartyId = await seedCounterparty({ providerData: {} });
        await seedSimulatableTransfer({ ...LIGHTSPARK_SIM_SEED, id: transferId, counterpartyId });
        const simulateSpy = vi
          .spyOn(RAMP_PROVIDER_CLIENTS.lightspark, "sandboxSend")
          .mockRejectedValueOnce(error)
          .mockResolvedValueOnce({ accepted: true });

        try {
          const first = await simulateRequest(transferId);

          expect(first.status).toBe(firstStatus);
          const failed = await readSimulationTransfer(transferId);
          expect(required(failed).status).toBe("awaiting_payment");
          expect(required(failed).provider_data.sandboxSimulation !== undefined).toBe(
            claimAfterFailure
          );

          const second = await simulateRequest(transferId);

          expect(second.status).toBe(secondStatus);
          expect(simulateSpy).toHaveBeenCalledTimes(providerCalls);
          const settled = await readSimulationTransfer(transferId);
          expect(
            required(required(settled).provider_data.sandboxSimulation).requestedAt
          ).toBeTruthy();
        } finally {
          simulateSpy.mockRestore();
        }
      }
    );

    const REJECTED_BEFORE_CLAIM_CASES: {
      name: string;
      transferId: string;
      seed: Omit<Parameters<typeof seedSimulatableTransfer>[0], "id" | "counterpartyId">;
      counterpartyProviderData: Record<string, unknown>;
      status: number;
      message: string;
    }[] = [
      {
        name: "a transfer that is not awaiting payment",
        transferId: "xfr_sim_rejected_settling",
        seed: {
          ...LIGHTSPARK_SIM_SEED,
          providerReference: "Quote:sim-settling",
          status: "settling",
        },
        counterpartyProviderData: {},
        status: 409,
        message: "not awaiting payment",
      },
      {
        name: "an off-ramp transfer",
        transferId: "xfr_sim_rejected_offramp",
        seed: { ...LIGHTSPARK_SIM_SEED, providerReference: "Quote:sim-offramp", type: "offramp" },
        counterpartyProviderData: {},
        status: 400,
        message: "Only on-ramp transfers",
      },
      {
        name: "a provider without sandbox simulation",
        transferId: "xfr_sim_rejected_coinbase",
        seed: {
          ...LIGHTSPARK_SIM_SEED,
          provider: "coinbase",
          providerReference: "Quote:coinbase-sim-1",
        },
        counterpartyProviderData: {},
        status: 400,
        message: "not available for provider: coinbase",
      },
      {
        name: "an unsupported Mural currency",
        transferId: "xfr_sim_rejected_mural_eur",
        seed: {
          ...LIGHTSPARK_SIM_SEED,
          provider: "mural",
          providerReference: "Quote:mural-sim-eur",
          fiatCurrency: "EUR",
          fiatAmount: "1500.25",
          providerData: { mural: { accountId: "acct_sim_1" } },
        },
        counterpartyProviderData: {
          mural: { organization: { id: "org_test_sim_1", kycStatus: "approved" } },
        },
        status: 400,
        message: "does not support EUR",
      },
    ];

    it.each(REJECTED_BEFORE_CLAIM_CASES)(
      "rejects $name before calling the provider or claiming the simulation slot",
      async ({ transferId, seed, counterpartyProviderData, status, message }) => {
        const counterpartyId = await seedCounterparty({ providerData: counterpartyProviderData });
        await seedSimulatableTransfer({ ...seed, id: transferId, counterpartyId });
        const before = await readSimulationTransfer(transferId);
        const spies = [
          vi.spyOn(RAMP_PROVIDER_CLIENTS.lightspark, "sandboxSend").mockResolvedValue({}),
          vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "simulatePayin").mockResolvedValue({}),
          vi.spyOn(RAMP_PROVIDER_CLIENTS.mural, "simulatePayin").mockResolvedValue({}),
        ];

        try {
          const res = await simulateRequest(transferId);

          expect(res.status).toBe(status);
          const body: { error: { message: string } } = await res.json();
          expect(body.error.message).toContain(message);
          for (const spy of spies) {
            expect(spy).not.toHaveBeenCalled();
          }
          const after = await readSimulationTransfer(transferId);
          expect(required(after).provider_data).not.toHaveProperty("sandboxSimulation");
          expect(after).toEqual(before);
        } finally {
          for (const spy of spies) {
            spy.mockRestore();
          }
        }
      }
    );

    it("derives the Mural account, rail, and amount in cents from the transfer", async () => {
      const transferId = "xfr_mural_sim_1";
      const counterpartyId = await seedCounterparty({
        providerData: { mural: { organization: { id: "org_test_sim_1", kycStatus: "approved" } } },
      });
      await seedSimulatableTransfer({
        id: transferId,
        provider: "mural",
        providerReference: "Quote:mural-sim-1",
        fiatCurrency: "MXN",
        fiatAmount: "1500.25",
        counterpartyId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        providerData: { mural: { accountId: "acct_sim_1" } },
        type: "onramp",
        status: "awaiting_payment",
      });
      const simulateSpy = vi
        .spyOn(RAMP_PROVIDER_CLIENTS.mural, "simulatePayin")
        .mockResolvedValue({ accepted: true });

      const res = await simulateRequest(transferId);

      expect(res.status).toBe(204);
      expect(simulateSpy).toHaveBeenCalledTimes(1);
      expect(simulateSpy).toHaveBeenCalledWith(expect.anything(), {
        organizationId: "org_test_sim_1",
        destinationAccountId: "acct_sim_1",
        rail: "spei",
        amountValue: "150025",
        currencySymbol: "MXN",
      });

      simulateSpy.mockRestore();
    });

    it("hides another tenant's transfer without calling Lightspark or changing the row", async () => {
      const transferId = "xfr_lightspark_sim_other_tenant";
      const counterpartyId = await seedCounterparty({ providerData: {} });
      await getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind("org_test_other_sim", "Other Sim Tenant", "other-sim-tenant", "enterprise", "active")
        .run();
      await getDb(env)
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)`
        )
        .bind(
          "proj_other_sim",
          "org_test_other_sim",
          "Other Sim Project",
          "other-sim",
          TEST_USER.id
        )
        .run();
      await getDb(env)
        .prepare("UPDATE counterparties SET organization_id = ?, project_id = ? WHERE id = ?")
        .bind("org_test_other_sim", "proj_other_sim", counterpartyId)
        .run();
      await seedSimulatableTransfer({
        ...LIGHTSPARK_SIM_SEED,
        id: transferId,
        providerReference: "Quote:sim-other-tenant",
        counterpartyId,
        organizationId: "org_test_other_sim",
        projectId: "proj_other_sim",
      });
      const before = await getDb(env)
        .prepare("SELECT * FROM payment_transfers WHERE id = ?")
        .bind(transferId)
        .first<PaymentTransferRow>();
      const simulateSpy = vi
        .spyOn(RAMP_PROVIDER_CLIENTS.lightspark, "sandboxSend")
        .mockResolvedValue({ accepted: true });

      const res = await simulateRequest(transferId);

      expect(res.status).toBe(404);
      const body: { error: { code: string } } = await res.json();
      expect(body.error.code).toBe("NOT_FOUND");
      expect(simulateSpy).not.toHaveBeenCalled();
      const after = await getDb(env)
        .prepare("SELECT * FROM payment_transfers WHERE id = ?")
        .bind(transferId)
        .first<PaymentTransferRow>();
      expect(before).not.toBeNull();
      expect(after).toEqual(before);

      simulateSpy.mockRestore();
    });

    it("rejects extra keys in the simulation request body", async () => {
      const res = await app.request(
        "/v1/payments/ramps/sandbox/simulate",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ transferId: "xfr_x", provider: "bvnk" }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body: { error: { message: string } } = await res.json();
      expect(body.error.message).toContain('Unrecognized key: "provider"');
    });
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
      amount: "25",
      providerData: {},
    });
    await seedRampEventTransfer({
      id: "xfr_moneygram_advisory",
      provider: "moneygram",
      providerReference: "moneygram_session_advisory",
      type: "onramp",
      amount: "25",
      providerData: {},
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

    expect(coinbase.status).toBe(204);
    expect(moneygram.status).toBe(204);
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

  describe("MoneyGram custodial events", () => {
    const MG_DEPOSIT_WALLET = "8mSiNWTeu59yxhp2VPuWURbW4N1zF2oX96oVxdThMNS3";
    const MG_OTHER_WALLET = "8mSiNWTeu59yy4EzchXDwb8j3XoQsVmVdp4QMjEo6wvX";
    const sessionId = "mg_session_deposit_1";
    const transferId = "xfr_0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
    const activeStatus = "active" satisfies CounterpartyProviderAccount["status"];
    const pendingStatus = "pending" satisfies PaymentTransferStatus;
    const settlingStatus = "settling" satisfies PaymentTransferStatus;
    const confirmedStatus = "confirmed" satisfies PaymentTransferStatus;
    let counterpartyId: string;
    const deposit = {
      depositAddress: MG_DEPOSIT_WALLET,
      sendAmount: "25",
      depositMemo: "mg_memo_1",
    };
    const transactionEvent = {
      kind: "transaction_created",
      sessionId,
      transactionId: "mg_tx_created_1",
      mgiTransactionId: "mgi_tx_created_1",
    } satisfies MoneygramRampEvent;

    beforeEach(async () => {
      counterpartyId = await seedRampEventTransfer({
        id: transferId,
        provider: "moneygram",
        providerReference: sessionId,
        type: "offramp",
        amount: "25",
        providerData: {},
      });
      vi.spyOn(RAMP_PROVIDER_CLIENTS.moneygram, "getAwaitingDeposit").mockResolvedValue(deposit);
      vi.spyOn(RAMP_PROVIDER_CLIENTS.moneygram, "findOwnedTransaction").mockResolvedValue({
        profileId: "mg_profile_1",
        transactionType: "cash-out",
      });
    });

    afterEach(() => {
      vi.mocked(RAMP_PROVIDER_CLIENTS.moneygram.getAwaitingDeposit).mockRestore();
      vi.mocked(RAMP_PROVIDER_CLIENTS.moneygram.findOwnedTransaction).mockRestore();
    });

    async function postEvent(event: MoneygramRampEvent): Promise<Response> {
      return app.request(
        "/v1/payments/ramps/moneygram/events",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(event),
        },
        env
      );
    }

    async function readTransfer(id: string): Promise<PaymentTransferRow> {
      const row = await getDb(env)
        .prepare("SELECT * FROM payment_transfers WHERE id = ?")
        .bind(id)
        .first<PaymentTransferRow>();
      assert(!(row === null));
      return row;
    }

    async function pinDeposit(): Promise<void> {
      expect((await postEvent(transactionEvent)).status).toBe(204);
      expect((await postEvent({ kind: "deposit_address", sessionId })).status).toBe(204);
    }

    async function readMoneygramProviderAccounts(): Promise<CounterpartyProviderAccountRow[]> {
      const rows = await getDb(env)
        .prepare(
          `SELECT * FROM counterparty_provider_accounts
           WHERE counterparty_id = ? AND provider = 'moneygram'
           ORDER BY id`
        )
        .bind(counterpartyId)
        .all<CounterpartyProviderAccountRow>();
      return rows.results;
    }

    it("creates and lists one active MoneyGram customer_link on transaction_created", async () => {
      expect(await readMoneygramProviderAccounts()).toHaveLength(0);

      const response = await postEvent(transactionEvent);

      expect(response.status).toBe(204);
      expect(RAMP_PROVIDER_CLIENTS.moneygram.findOwnedTransaction).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ mode: "sandbox" }),
        {
          transactionId: transactionEvent.transactionId,
          customerIdentifier: counterpartyId,
        }
      );
      const transfer = await readTransfer(transferId);
      expect(transfer.counterparty_id).toBe(counterpartyId);
      expect(transfer.provider_data).toMatchObject({ moneygram: { customerId: "mg_profile_1" } });
      const rows = await readMoneygramProviderAccounts();
      expect(rows).toHaveLength(1);
      expect(rows).toMatchObject([
        {
          counterparty_id: counterpartyId,
          provider: "moneygram",
          kind: "customer_link",
          status: activeStatus,
          provider_customer_reference: "mg_profile_1",
        },
      ]);

      const listed = await app.request(
        `/v1/counterparties/${counterpartyId}/provider-accounts`,
        { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );

      expect(listed.status).toBe(200);
      const listedBody: { data: { accounts: CounterpartyProviderAccount[] } } = await listed.json();
      expect(listedBody).toMatchObject({
        data: {
          accounts: rows.map((row) => ({
            id: row.id,
            provider: "moneygram",
            kind: "customer_link",
            status: activeStatus,
            customerLink: {
              id: row.id,
              provider: "moneygram",
              providerCustomerReference: "mg_profile_1",
              status: activeStatus,
            },
          })),
        },
      });
    });

    it("verifies ownership for a second transfer and reuses the same MoneyGram customer_link", async () => {
      expect((await postEvent(transactionEvent)).status).toBe(204);
      expect(RAMP_PROVIDER_CLIENTS.moneygram.findOwnedTransaction).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ mode: "sandbox" }),
        {
          transactionId: transactionEvent.transactionId,
          customerIdentifier: counterpartyId,
        }
      );
      const links = await readMoneygramProviderAccounts();
      expect(links).toHaveLength(1);
      const [link] = links;
      expect(link).toMatchObject({
        kind: "customer_link",
        status: activeStatus,
        provider_customer_reference: "mg_profile_1",
      });
      await getDb(env)
        .prepare(
          `INSERT INTO payment_transfers (
             id, organization_id, project_id, wallet_id, counterparty_id, source_address,
             token, amount, type, direction, status, provider, provider_reference,
             delivery_mode, fiat_currency, fiat_amount, provider_data, created_at, updated_at
           ) SELECT ?, organization_id, project_id, wallet_id, counterparty_id, source_address,
                    token, amount, type, direction, ?, provider, ?,
                    'session_widget', fiat_currency, fiat_amount, '{}'::jsonb,
                    sdp_iso_now(), sdp_iso_now()
             FROM payment_transfers WHERE id = ?`
        )
        .bind(
          "xfr_1f2e3d4c-5b6a-4d7c-8f9e-0a1b2c3d4e5f",
          pendingStatus,
          "mg_session_deposit_2",
          transferId
        )
        .run();

      const response = await postEvent({
        kind: "transaction_created",
        sessionId: "mg_session_deposit_2",
        transactionId: "mg_tx_created_2",
      });

      expect(response.status).toBe(204);
      expect(RAMP_PROVIDER_CLIENTS.moneygram.findOwnedTransaction).toHaveBeenCalledTimes(2);
      expect(RAMP_PROVIDER_CLIENTS.moneygram.findOwnedTransaction).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ mode: "sandbox" }),
        {
          transactionId: "mg_tx_created_2",
          customerIdentifier: counterpartyId,
        }
      );
      const moneygram = {
        customerId: link.provider_customer_reference,
        transactionId: "mg_tx_created_2",
      };
      expect(await readTransfer("xfr_1f2e3d4c-5b6a-4d7c-8f9e-0a1b2c3d4e5f")).toMatchObject({
        counterparty_id: counterpartyId,
        status: pendingStatus,
        provider_data: { moneygram },
      });
      const updatedLinks = await readMoneygramProviderAccounts();
      expect(updatedLinks).toHaveLength(1);
      expect(updatedLinks).toMatchObject([
        { id: link.id, status: activeStatus, provider_customer_reference: "mg_profile_1" },
      ]);
    });

    it("rejects transaction_created without pinning a transaction or customer_link when ownership lookup fails", async () => {
      vi.mocked(RAMP_PROVIDER_CLIENTS.moneygram.findOwnedTransaction).mockRejectedValue(
        new Error("MoneyGram ownership lookup failed")
      );
      const before = await readTransfer(transferId);
      expect(before.provider_data).not.toHaveProperty("moneygram.transactionId");
      expect(await readMoneygramProviderAccounts()).toHaveLength(0);

      const response = await postEvent(transactionEvent);

      expect(response.ok).toBe(false);
      expect(RAMP_PROVIDER_CLIENTS.moneygram.findOwnedTransaction).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ mode: "sandbox" }),
        {
          transactionId: transactionEvent.transactionId,
          customerIdentifier: counterpartyId,
        }
      );
      const after = await readTransfer(transferId);
      expect(after).toEqual(before);
      expect(after.provider_data).not.toHaveProperty("moneygram.transactionId");
      expect(await readMoneygramProviderAccounts()).toHaveLength(0);
    });

    it("rejects an unowned transaction without pinning data or creating a customer_link", async () => {
      vi.mocked(RAMP_PROVIDER_CLIENTS.moneygram.findOwnedTransaction).mockResolvedValue(null);
      const before = await readTransfer(transferId);

      const response = await postEvent(transactionEvent);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { message: "MoneyGram transaction does not belong to this session." },
      });
      expect(await readTransfer(transferId)).toEqual(before);
      expect(before.provider_data).not.toHaveProperty("moneygram.transactionId");
      expect(before.provider_data).not.toHaveProperty("moneygram.customerId");
      expect(await readMoneygramProviderAccounts()).toHaveLength(0);
    });

    it("rejects cash-in ownership for an off-ramp without pinning data or creating a customer_link", async () => {
      vi.mocked(RAMP_PROVIDER_CLIENTS.moneygram.findOwnedTransaction).mockResolvedValue({
        profileId: "mg_profile_1",
        transactionType: "cash-in",
      });
      const before = await readTransfer(transferId);

      const response = await postEvent(transactionEvent);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { message: "MoneyGram transaction direction does not match this transfer." },
      });
      expect(await readTransfer(transferId)).toEqual(before);
      expect(await readMoneygramProviderAccounts()).toHaveLength(0);
    });

    it("keeps one unchanged MoneyGram customer_link when transaction_created is replayed", async () => {
      expect((await postEvent(transactionEvent)).status).toBe(204);
      const before = await readMoneygramProviderAccounts();
      expect(before).toHaveLength(1);
      expect(before).toMatchObject([
        { kind: "customer_link", provider_customer_reference: "mg_profile_1" },
      ]);

      const response = await postEvent(transactionEvent);

      expect(response.status).toBe(204);
      const after = await readMoneygramProviderAccounts();
      expect(after).toHaveLength(1);
      expect(after).toEqual(before);
    });

    it("keeps the existing MoneyGram customer_link unchanged when transaction_created conflicts", async () => {
      expect((await postEvent(transactionEvent)).status).toBe(204);
      const before = await readMoneygramProviderAccounts();
      expect(before).toHaveLength(1);
      expect(before).toMatchObject([
        { kind: "customer_link", provider_customer_reference: "mg_profile_1" },
      ]);

      const response = await postEvent({ ...transactionEvent, transactionId: "mg_tx_created_2" });

      expect(response.status).toBe(409);
      const after = await readMoneygramProviderAccounts();
      expect(after).toHaveLength(1);
      expect(after).toEqual(before);
    });

    it("pins transaction_created identifiers without advancing a pending off-ramp", async () => {
      const response = await postEvent(transactionEvent);

      expect(response.status).toBe(204);
      const moneygram = {
        customerId: "mg_profile_1",
        transactionId: "mg_tx_created_1",
        mgiTransactionId: "mgi_tx_created_1",
      };
      expect(await readTransfer(transferId)).toMatchObject({
        status: pendingStatus,
        provider_data: { moneygram },
      });
    });

    it("replays transaction_created with the same id without changing the row", async () => {
      expect((await postEvent(transactionEvent)).status).toBe(204);
      const before = await readTransfer(transferId);

      const response = await postEvent(transactionEvent);

      expect(response.status).toBe(204);
      expect(await readTransfer(transferId)).toEqual(before);
    });

    it("rejects a different transaction id for an already bound session", async () => {
      expect((await postEvent(transactionEvent)).status).toBe(204);
      const before = await readTransfer(transferId);

      const response = await postEvent({ ...transactionEvent, transactionId: "mg_tx_created_2" });

      expect(response.status).toBe(409);
      expect(await readTransfer(transferId)).toEqual(before);
    });

    it("pins transaction_created identifiers on an on-ramp", async () => {
      const onrampCounterpartyId = await seedRampEventTransfer({
        id: "xfr_2f3e4d5c-6b7a-4e8d-9f0e-1a2b3c4d5e6f",
        provider: "moneygram",
        providerReference: "mg_session_onramp_created_1",
        type: "onramp",
        amount: "25",
        providerData: {},
      });
      vi.mocked(RAMP_PROVIDER_CLIENTS.moneygram.findOwnedTransaction).mockResolvedValue({
        profileId: "mg_profile_1",
        transactionType: "cash-in",
      });

      const response = await postEvent({
        ...transactionEvent,
        sessionId: "mg_session_onramp_created_1",
      });

      expect(response.status).toBe(204);
      expect(RAMP_PROVIDER_CLIENTS.moneygram.findOwnedTransaction).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ mode: "sandbox" }),
        {
          transactionId: transactionEvent.transactionId,
          customerIdentifier: onrampCounterpartyId,
        }
      );
      const moneygram = {
        customerId: "mg_profile_1",
        transactionId: "mg_tx_created_1",
        mgiTransactionId: "mgi_tx_created_1",
      };
      expect(await readTransfer("xfr_2f3e4d5c-6b7a-4e8d-9f0e-1a2b3c4d5e6f")).toMatchObject({
        status: pendingStatus,
        provider_data: { moneygram },
      });
    });

    it("pins deposit_address from the provider using the committed transaction id", async () => {
      expect((await postEvent(transactionEvent)).status).toBe(204);

      const response = await postEvent({ kind: "deposit_address", sessionId });

      expect(response.status).toBe(204);
      expect(RAMP_PROVIDER_CLIENTS.moneygram.getAwaitingDeposit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ mode: "sandbox" }),
        "mg_tx_created_1"
      );
      const moneygram = {
        customerId: "mg_profile_1",
        transactionId: "mg_tx_created_1",
        mgiTransactionId: "mgi_tx_created_1",
      };
      const row = await readTransfer(transferId);
      expect(row).toMatchObject({
        destination_address: MG_DEPOSIT_WALLET,
        memo: "mg_memo_1",
        status: pendingStatus,
        provider_data: { moneygram },
      });
    });

    it("rejects deposit_address before transaction_created without calling MoneyGram", async () => {
      const before = await readTransfer(transferId);

      const response = await postEvent({ kind: "deposit_address", sessionId });

      expect(response.status).toBe(409);
      expect(RAMP_PROVIDER_CLIENTS.moneygram.getAwaitingDeposit).not.toHaveBeenCalled();
      expect(await readTransfer(transferId)).toEqual(before);
    });

    it("rejects a provider deposit amount that differs from the quoted amount", async () => {
      expect((await postEvent(transactionEvent)).status).toBe(204);
      vi.mocked(RAMP_PROVIDER_CLIENTS.moneygram.getAwaitingDeposit).mockResolvedValue({
        ...deposit,
        sendAmount: "24",
      });
      const before = await readTransfer(transferId);

      const response = await postEvent({ kind: "deposit_address", sessionId });

      expect(response.status).toBe(409);
      const row = await readTransfer(transferId);
      expect(row).toEqual(before);
      expect(row.destination_address).toBeNull();
      expect(row.memo).toBeNull();
    });

    it("replays deposit_address without calling MoneyGram again", async () => {
      expect((await postEvent(transactionEvent)).status).toBe(204);
      await getDb(env)
        .prepare("UPDATE payment_transfers SET destination_address = ?, memo = ? WHERE id = ?")
        .bind(MG_DEPOSIT_WALLET, "mg_memo_1", transferId)
        .run();
      const before = await readTransfer(transferId);

      const response = await postEvent({ kind: "deposit_address", sessionId });

      expect(response.status).toBe(204);
      expect(RAMP_PROVIDER_CLIENTS.moneygram.getAwaitingDeposit).not.toHaveBeenCalled();
      expect(await readTransfer(transferId)).toEqual(before);
    });

    it("rejects deposit_address on an on-ramp", async () => {
      await seedRampEventTransfer({
        id: "xfr_3f4e5d6c-7b8a-4f9e-8a1f-2b3c4d5e6f7a",
        provider: "moneygram",
        providerReference: "mg_session_onramp_deposit_1",
        type: "onramp",
        amount: "25",
        providerData: {},
      });
      vi.mocked(RAMP_PROVIDER_CLIENTS.moneygram.findOwnedTransaction).mockResolvedValue({
        profileId: "mg_profile_1",
        transactionType: "cash-in",
      });
      expect(
        (await postEvent({ ...transactionEvent, sessionId: "mg_session_onramp_deposit_1" })).status
      ).toBe(204);
      const before = await readTransfer("xfr_3f4e5d6c-7b8a-4f9e-8a1f-2b3c4d5e6f7a");

      const response = await postEvent({
        kind: "deposit_address",
        sessionId: "mg_session_onramp_deposit_1",
      });

      expect(response.status).toBe(400);
      expect(RAMP_PROVIDER_CLIENTS.moneygram.getAwaitingDeposit).not.toHaveBeenCalled();
      expect(await readTransfer("xfr_3f4e5d6c-7b8a-4f9e-8a1f-2b3c4d5e6f7a")).toEqual(before);
    });

    it("rejects signed without a pinned deposit address and keeps the ramp pending", async () => {
      expect((await postEvent(transactionEvent)).status).toBe(204);
      const before = await readTransfer(transferId);

      const response = await postEvent({
        kind: "signed",
        sessionId,
        cryptoTransferId: "xfr_mg_deposit_leg",
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { message: "MoneyGram deposit address has not been recorded for this session." },
      });
      expect(await readTransfer(transferId)).toEqual(before);
      expect(before.status).toBe(pendingStatus);
      expect(before.destination_address).toBeNull();
    });

    it.each([
      {
        name: "rejects a crypto leg sent to a different deposit address",
        destination: MG_OTHER_WALLET,
        responseStatus: 400,
        status: pendingStatus,
      },
      {
        name: "starts settlement for a signed crypto leg sent to the pinned deposit address",
        destination: MG_DEPOSIT_WALLET,
        responseStatus: 204,
        status: settlingStatus,
      },
    ] satisfies {
      name: string;
      destination: string;
      responseStatus: number;
      status: PaymentTransferStatus;
    }[])("$name", async ({ destination, responseStatus, status }) => {
      await pinDeposit();
      const now = new Date().toISOString();
      await getDb(env)
        .prepare(
          `INSERT INTO payment_transfers (
             id, organization_id, project_id, wallet_id, source_address, destination_address,
             token, amount, type, direction, status, signature, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          "xfr_mg_deposit_leg",
          TEST_ORG.id,
          TEST_PROJECT.id,
          TEST_WALLET_ID,
          TEST_SOLANA_ADDRESSES.wallet1,
          destination,
          "USDC",
          "25",
          "transfer",
          "outbound",
          confirmedStatus,
          "sig_mg_deposit_1",
          now,
          now
        )
        .run();

      const response = await postEvent({
        kind: "signed",
        sessionId,
        cryptoTransferId: "xfr_mg_deposit_leg",
      });

      expect(response.status).toBe(responseStatus);
      const row = await readTransfer(transferId);
      expect(row.status).toBe(status);
      expect(row.destination_address).toBe(MG_DEPOSIT_WALLET);
      expect(row.memo).toBe("mg_memo_1");
      if (responseStatus === 204) {
        expect(row.provider_data.moneygram).toMatchObject({
          cryptoTransferId: "xfr_mg_deposit_leg",
          solanaTxSignature: "sig_mg_deposit_1",
        });
      } else {
        expect(await response.json()).toMatchObject({
          error: { message: "Crypto transfer was not sent to the MoneyGram deposit address." },
        });
        expect(row.provider_data.moneygram).not.toHaveProperty("cryptoTransferId");
      }
    });
  });

  it("rejects a MoneyGram crypto leg whose amount does not match the Clerk", async () => {
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
      providerData: {
        moneygram: {
          transactionId: "mg_tx_amount_guard",
        },
      },
    });
    const depositWallet = "8mSiNWTeu59yxhp2VPuWURbW4N1zF2oX96oVxdThMNS3";
    await getDb(env)
      .prepare("UPDATE payment_transfers SET destination_address = ? WHERE id = ?")
      .bind(depositWallet, "xfr_moneygram_amount_guard")
      .run();
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
        depositWallet,
        "USDC",
        "24",
        "transfer",
        "outbound",
        "confirmed" satisfies PaymentTransferStatus,
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
    expect(await response.json()).toMatchObject({
      error: { message: "Crypto transfer amount does not match the off-ramp amount." },
    });
    const transfer = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind("xfr_moneygram_amount_guard")
      .first<{ status: PaymentTransferStatus }>();
    expect(transfer).toMatchObject({ status: "pending" satisfies PaymentTransferStatus });
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

  describe("Clerk-caller environment resolution", () => {
    async function seedClerkAuth(): Promise<void> {
      await getDb(env).batch([
        getDb(env)
          .prepare(
            `INSERT INTO organization_members (id, organization_id, user_id, role, status)
             VALUES (?, ?, ?, 'member', 'active')`
          )
          .bind("om_ramps_environment", TEST_ORG.id, TEST_USER.id),
      ]);
    }

    async function simulateAsClerk(projectId: string, body: Record<string, unknown>) {
      return app.request(
        "/v1/payments/ramps/sandbox/simulate",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${await signSeededClerkMember(env, getDb(env), TEST_USER.id, TEST_ORG.id)}`,
            "x-project-id": projectId,
          },
          body: JSON.stringify(body),
        },
        env
      );
    }

    const NONEXISTENT_MURAL_SIMULATE_BODY = {
      transferId: "xfr_does_not_exist",
    };

    it("refuses the sandbox simulator from a production-project Clerk", async () => {
      await seedClerkAuth();

      const res = await simulateAsClerk(
        TEST_PRODUCTION_PROJECT_ID,
        NONEXISTENT_MURAL_SIMULATE_BODY
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("only available in sandbox mode");
    });

    it("still lets sandbox-project Clerks past the environment guard", async () => {
      await seedClerkAuth();

      const res = await simulateAsClerk(TEST_PROJECT.id, NONEXISTENT_MURAL_SIMULATE_BODY);

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("ramp session and destination binding", () => {
    const MG_DEPOSIT_WALLET = "8mSiNWTeu59yxhp2VPuWURbW4N1zF2oX96oVxdThMNS3";
    const MONEYGRAM_WIDGET_URL = "https://playground.xramps.moneygram.com/widget?intent=transfer";

    function moneygramSessionJwt(expSeconds: number): string {
      const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
      return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ exp: expSeconds })}.sig`;
    }

    function moneygramSessionResponse(params: {
      sessionId: string;
      widgetUrl: string;
      expSeconds: number;
    }): Response {
      return new Response(
        JSON.stringify({
          sessionToken: moneygramSessionJwt(params.expSeconds),
          sessionId: params.sessionId,
          widgetUrl: params.widgetUrl,
          walletType: "custodial",
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
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        moneygramSessionResponse({
          sessionId: "mg_sess_bind_1",
          expSeconds,
          widgetUrl: MONEYGRAM_WIDGET_URL,
        })
      );

      const res = await createMoneygramOnrampQuote(counterpartyId, "25");

      expect(res.status).toBe(200);
      const body: {
        data: { quote: { sessionId: string; widgetUrl: string; expiresAt: string } };
      } = await res.json();
      expect(body.data.quote.sessionId).toBe("mg_sess_bind_1");
      const widgetUrl = new URL(body.data.quote.widgetUrl);
      expect(widgetUrl.origin).toBe("https://playground.xramps.moneygram.com");
      expect(widgetUrl.searchParams.get("mode")).toBe("on-ramp");
      expect(body.data.quote.expiresAt).toBe(new Date(expSeconds * 1000).toISOString());

      const row = await getDb(env)
        .prepare(
          `SELECT id, provider_data FROM payment_transfers
           WHERE provider = 'moneygram' AND provider_reference = 'mg_sess_bind_1'`
        )
        .first<{ id: string; provider_data: { rampQuote: { expiresAt: string } } }>();
      expect(row).toMatchObject({
        provider_data: { rampQuote: { expiresAt: new Date(expSeconds * 1000).toISOString() } },
      });
      assert(!(row === null));
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://playground.xramps.moneygram.com/api/v1/sessions",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            customerIdentifier: counterpartyId,
            walletAddress: TEST_SOLANA_ADDRESSES.wallet1,
            walletTransactionId: row.id.slice(4),
            chain: "solana",
          }),
        })
      );
      fetchSpy.mockRestore();
    });

    it("binds the MoneyGram off-ramp session to the created transfer UUID", async () => {
      const counterpartyId = await seedCounterparty({ externalId: "mg_bind_offramp_1" });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        moneygramSessionResponse({
          sessionId: "mg_session_offramp_bind_1",
          expSeconds: Math.floor(Date.now() / 1000) + 3600,
          widgetUrl: MONEYGRAM_WIDGET_URL,
        })
      );

      const response = await app.request(
        "/v1/payments/ramps/offramp/quote",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
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

      expect(response.status).toBe(200);
      const row = await getDb(env)
        .prepare(
          `SELECT id FROM payment_transfers
           WHERE provider = 'moneygram' AND provider_reference = 'mg_session_offramp_bind_1'`
        )
        .first<{ id: string }>();
      assert(!(row === null));
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://playground.xramps.moneygram.com/api/v1/sessions",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            customerIdentifier: counterpartyId,
            walletAddress: TEST_SOLANA_ADDRESSES.wallet1,
            walletTransactionId: row.id.slice(4),
            chain: "solana",
          }),
        })
      );
      fetchSpy.mockRestore();
    });

    it("fails closed when MoneyGram returns an untrusted widget URL", async () => {
      const counterpartyId = await seedCounterparty({ externalId: "moneygram_bad_widget" });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        moneygramSessionResponse({
          sessionId: "mg_sess_hostile_1",
          expSeconds: Math.floor(Date.now() / 1000) + 3600,
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
      expect(row).toBeNull();
      fetchSpy.mockRestore();
    });

    it("replays a session quote idempotently but fails closed on input mutation", async () => {
      const counterpartyId = await seedCounterparty({ externalId: "moneygram_bind_reuse" });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          moneygramSessionResponse({
            sessionId: "mg_sess_reuse_1",
            expSeconds: Math.floor(Date.now() / 1000) + 3600,
            widgetUrl: MONEYGRAM_WIDGET_URL,
          })
        )
        .mockResolvedValueOnce(
          moneygramSessionResponse({
            sessionId: "mg_sess_reuse_1",
            expSeconds: Math.floor(Date.now() / 1000) + 3600,
            widgetUrl: MONEYGRAM_WIDGET_URL,
          })
        )
        .mockResolvedValueOnce(
          moneygramSessionResponse({
            sessionId: "mg_sess_reuse_1",
            expSeconds: Math.floor(Date.now() / 1000) + 3600,
            widgetUrl: MONEYGRAM_WIDGET_URL,
          })
        );

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
        .bind("org_test_other_tenant", "Other Tenant", "other-tenant", "enterprise", "active")
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
          "org_test_other_tenant",
          "wallet_other_tenant",
          MG_DEPOSIT_WALLET,
          "mg_sess_foreign_1",
          {},
          now,
          now
        )
        .run();
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        moneygramSessionResponse({
          sessionId: "mg_sess_foreign_1",
          expSeconds: Math.floor(Date.now() / 1000) + 3600,
          widgetUrl: MONEYGRAM_WIDGET_URL,
        })
      );

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
        providerData: {
          rampQuote: { expiresAt: "2020-01-01T00:00:00.000Z" },
          moneygram: {
            transactionId: "mg_tx_expired_1",
          },
        },
        amount: "25",
      });

      await getDb(env)
        .prepare("UPDATE payment_transfers SET destination_address = ? WHERE id = ?")
        .bind(MG_DEPOSIT_WALLET, "xfr_moneygram_expired_session")
        .run();

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
      const gridBody = JSON.parse(String(required(fetchSpy.mock.calls[0][1]).body)) as {
        destination: { accountId: string };
      };
      expect(gridBody.destination.accountId).toBe("ExternalAccount:swift");

      const transfer = await getDb(env)
        .prepare("SELECT provider_data FROM payment_transfers WHERE id = ?")
        .bind(body.data.transferId)
        .first<{ provider_data: unknown }>();
      assert(transfer);
      const providerData =
        typeof transfer.provider_data === "string"
          ? (JSON.parse(transfer.provider_data) as Record<string, unknown>)
          : (transfer.provider_data as Record<string, unknown>);
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
      const gridBody = JSON.parse(String(required(fetchSpy.mock.calls[0][1]).body)) as {
        destination: { accountId: string };
      };
      expect(gridBody.destination.accountId).toBe("ExternalAccount:single");
      fetchSpy.mockRestore();
    });
  });
});
