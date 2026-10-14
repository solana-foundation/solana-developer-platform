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
import { seedDefaultProjects } from "@/test/helpers/projects";
import { providerStages } from "@/test/helpers/provider-stages";
import { required } from "@/test/helpers/required";
import { installStripeTestEnv } from "@/test/helpers/stripe-env";
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

async function seedCoinbaseOnrampTransfer(params: {
  id: string;
  providerReference: string;
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
      null,
      TEST_SOLANA_ADDRESSES.wallet2,
      "USDC",
      params.amount,
      null,
      "onramp",
      "inbound",
      status,
      "coinbase",
      params.providerReference,
      "hosted",
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
// `beta`, so a `beta` deployment runs Ramps with MoonPay alone.
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

  it("refuses ramp quotes from a key without counterparties:read", async () => {
    await seedCachedKey({ permissions: ["payments:write", "wallets:read"] });

    for (const direction of ["onramp", "offramp"]) {
      const response = await app.request(
        `/v1/payments/ramps/${direction}/quote`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ provider: "moonpay", counterpartyId: "cpty_quote_permissions" }),
        },
        env
      );

      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INSUFFICIENT_PERMISSIONS");
    }
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
      providers: expect.arrayContaining(["bvnk", "stripe"]),
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
            provider: "stripe",
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
          message: "Stripe is not available in this release channel.",
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
    custodyWalletId?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers
           (id, organization_id, project_id, wallet_id, custody_wallet_id, token, amount, type, direction, status, provider, provider_reference, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        input.custodyWalletId ?? null,
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
  describe("cancel wallet scope, for every provider", () => {
    const cancelRampTransfer = (transferId: string) =>
      app.request(
        "/v1/payments/ramps/transfers/cancel",
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
    const transferStatus = async (transferId: string) =>
      required(
        await getDb(env)
          .prepare("SELECT status FROM payment_transfers WHERE id = ?")
          .bind(transferId)
          .first<{ status: string }>()
      ).status;
    const scopeKeyToTestWallet = () =>
      seedCachedKey({
        walletBindings: [{ walletId: TEST_WALLET_ID, permissions: ["payments:write"] }],
      });

    it("denies a wallet-scoped key canceling MoonPay and Stripe transfers in another wallet", async () => {
      await getDb(env)
        .prepare(
          `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, label, purpose, status)
           VALUES (?, ?, ?, ?, 'Sibling wallet', 'transfer', 'active')`
        )
        .bind(
          "cwlt_cancel_sibling",
          TEST_CONFIG_ID,
          "wallet_cancel_sibling",
          TEST_SOLANA_ADDRESSES.wallet2
        )
        .run();
      await scopeKeyToTestWallet();

      for (const provider of ["moonpay", "stripe"]) {
        const transferId = `xfr_cancel_sibling_${provider}`;
        await seedRampTransfer({
          id: transferId,
          provider,
          providerReference: `${provider}_ref_cancel_sibling`,
          status: "awaiting_payment",
          custodyWalletId: "cwlt_cancel_sibling",
        });

        const res = await cancelRampTransfer(transferId);

        expect(res.status).toBe(403);
        expect(await transferStatus(transferId)).toBe("awaiting_payment");
      }
    });

    it("lets a wallet-scoped key cancel a transfer in its own wallet", async () => {
      await scopeKeyToTestWallet();
      await seedRampTransfer({
        id: "xfr_cancel_own_wallet",
        provider: "moonpay",
        providerReference: "moonpay_ref_cancel_own_wallet",
        status: "awaiting_payment",
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
      });

      const res = await cancelRampTransfer("xfr_cancel_own_wallet");

      expect(res.status).toBe(200);
      expect(await transferStatus("xfr_cancel_own_wallet")).toBe("canceled");
    });

    it("denies a wallet-scoped key canceling a transfer bound to no wallet", async () => {
      await scopeKeyToTestWallet();
      await seedRampTransfer({
        id: "xfr_cancel_unbound_scoped",
        provider: "moonpay",
        providerReference: "moonpay_ref_cancel_unbound_scoped",
        status: "awaiting_payment",
      });

      const res = await cancelRampTransfer("xfr_cancel_unbound_scoped");

      expect(res.status).toBe(403);
      expect(await transferStatus("xfr_cancel_unbound_scoped")).toBe("awaiting_payment");
    });

    it("lets a key without wallet scope cancel a transfer bound to no wallet", async () => {
      await seedRampTransfer({
        id: "xfr_cancel_unbound_unscoped",
        provider: "moonpay",
        providerReference: "moonpay_ref_cancel_unbound_unscoped",
        status: "awaiting_payment",
      });

      const res = await cancelRampTransfer("xfr_cancel_unbound_unscoped");

      expect(res.status).toBe(200);
      expect(await transferStatus("xfr_cancel_unbound_unscoped")).toBe("canceled");
    });
  });

  describe("sandbox pay-in simulation", () => {
    let originalCoinbaseApiKeyId: string | undefined;
    let originalCoinbaseApiKeySecret: string | undefined;

    beforeEach(() => {
      originalCoinbaseApiKeyId = env.COINBASE_CDP_API_KEY_ID;
      originalCoinbaseApiKeySecret = env.COINBASE_CDP_API_KEY_SECRET;
      env.COINBASE_CDP_API_KEY_ID = "test-coinbase-simulation-api-key-id";
      env.COINBASE_CDP_API_KEY_SECRET = "test-coinbase-simulation-api-key-secret";
    });

    afterEach(() => {
      env.COINBASE_CDP_API_KEY_ID = originalCoinbaseApiKeyId;
      env.COINBASE_CDP_API_KEY_SECRET = originalCoinbaseApiKeySecret;
    });

    const SIMULATE_TRANSFER_ID = "xfr_123e4567-e89b-12d3-a456-426614174abc";
    const GENERIC_SIM_SEED = {
      provider: "bvnk",
      providerReference: "bvnk_sim_reference",
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

    async function seedBvnkSimulatableTransfer(
      transferId: string = SIMULATE_TRANSFER_ID
    ): Promise<string> {
      const counterpartyId = await seedCounterparty({ externalId: `d1b_simulate_${transferId}` });
      await seedBvnkFundingWallet(getDb(env), {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        counterpartyId,
        providerCustomerReference: `bvnk_simulate_${transferId}`,
        walletId: TEST_BVNK_WALLET_ID,
        stage: "provisioned",
        metadata: {},
      });
      await seedBvnkOnrampTransfer(getDb(env), {
        id: transferId,
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

    it("claims the simulation slot once and answers 409 on repeat", async () => {
      await seedBvnkSimulatableTransfer();
      const simulateSpy = vi
        .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "simulatePayin")
        .mockResolvedValue({ accepted: true });

      const first = await simulateRequest(SIMULATE_TRANSFER_ID);
      const second = await simulateRequest(SIMULATE_TRANSFER_ID);

      expect(first.status).toBe(204);
      expect(simulateSpy).toHaveBeenCalledTimes(1);
      const transfer = await readSimulationTransfer(SIMULATE_TRANSFER_ID);
      expect(required(required(transfer).provider_data.sandboxSimulation).requestedAt).toBeTruthy();

      expect(second.status).toBe(409);
      const body: { error: { message: string } } = await second.json();
      expect(body.error.message).toContain("already requested for this transfer");

      simulateSpy.mockRestore();
    });

    it("rejects an unavailable provider before calling it or claiming the simulation slot", async () => {
      await seedBvnkSimulatableTransfer();
      const before = await readSimulationTransfer(SIMULATE_TRANSFER_ID);
      const originalBvnkSandboxSecret = env.BVNK_SANDBOX_HAWK_SECRET_KEY;
      env.BVNK_SANDBOX_HAWK_SECRET_KEY = undefined;
      const simulateSpy = vi
        .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "simulatePayin")
        .mockResolvedValue({ accepted: true });

      try {
        const res = await simulateRequest(SIMULATE_TRANSFER_ID);

        expect(res.status).toBe(503);
        const body: { error: { code: string; message: string } } = await res.json();
        expect(body.error).toMatchObject({
          code: "PROVIDER_NOT_CONFIGURED",
          message: "BVNK is not configured for sandbox projects in this deployment.",
        });
        expect(simulateSpy).not.toHaveBeenCalled();
        const transfer = await readSimulationTransfer(SIMULATE_TRANSFER_ID);
        expect(transfer).not.toBeNull();
        expect(required(transfer).provider_data).not.toHaveProperty("sandboxSimulation");
        expect(transfer).toEqual(before);
      } finally {
        env.BVNK_SANDBOX_HAWK_SECRET_KEY = originalBvnkSandboxSecret;
        simulateSpy.mockRestore();
      }
    });

    it.each([
      {
        name: "releases the claim on a definitive provider rejection so a retry succeeds",
        transferId: "xfr_123e4567-e89b-12d3-a456-426614174abd",
        error: badRequest("BVNK rejected the sandbox pay-in", {
          provider: "bvnk",
          providerStatus: 400,
        }),
        firstStatus: 400,
        claimAfterFailure: false,
        secondStatus: 204,
        providerCalls: 2,
      },
      {
        name: "keeps the claim on an ambiguous provider failure so a retry gets 409",
        transferId: "xfr_123e4567-e89b-12d3-a456-426614174abe",
        error: providerUnavailable("Failed to reach the bvnk API", {
          provider: "bvnk",
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
        await seedBvnkSimulatableTransfer(transferId);
        const simulateSpy = vi
          .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "simulatePayin")
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
          ...GENERIC_SIM_SEED,
          providerReference: "bvnk_sim_settling",
          status: "settling",
        },
        counterpartyProviderData: {},
        status: 409,
        message: "not awaiting payment",
      },
      {
        name: "an off-ramp transfer",
        transferId: "xfr_sim_rejected_offramp",
        seed: { ...GENERIC_SIM_SEED, providerReference: "bvnk_sim_offramp", type: "offramp" },
        counterpartyProviderData: {},
        status: 400,
        message: "Only on-ramp transfers",
      },
      {
        name: "a provider without sandbox simulation",
        transferId: "xfr_sim_rejected_coinbase",
        seed: {
          ...GENERIC_SIM_SEED,
          provider: "coinbase",
          providerReference: "Quote:coinbase-sim-1",
        },
        counterpartyProviderData: {},
        status: 400,
        message: "not available for provider: coinbase",
      },
    ];

    it.each(REJECTED_BEFORE_CLAIM_CASES)(
      "rejects $name before calling the provider or claiming the simulation slot",
      async ({ transferId, seed, counterpartyProviderData, status, message }) => {
        const counterpartyId = await seedCounterparty({ providerData: counterpartyProviderData });
        await seedSimulatableTransfer({ ...seed, id: transferId, counterpartyId });
        const before = await readSimulationTransfer(transferId);
        const spies = [vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "simulatePayin").mockResolvedValue({})];

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

    it("hides another tenant's transfer without calling the provider or changing the row", async () => {
      const transferId = "xfr_sim_other_tenant";
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
        ...GENERIC_SIM_SEED,
        id: transferId,
        providerReference: "bvnk_sim_other_tenant",
        counterpartyId,
        organizationId: "org_test_other_sim",
        projectId: "proj_other_sim",
      });
      const before = await getDb(env)
        .prepare("SELECT * FROM payment_transfers WHERE id = ?")
        .bind(transferId)
        .first<PaymentTransferRow>();
      const simulateSpy = vi
        .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "simulatePayin")
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
    await seedCoinbaseOnrampTransfer({
      id: "xfr_coinbase_advisory",
      providerReference: "coinbase_order_advisory",
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

    expect(coinbase.status).toBe(204);
    const rows = await getDb(env)
      .prepare(
        `SELECT id, status, provider_data
         FROM payment_transfers
         WHERE id = 'xfr_coinbase_advisory'`
      )
      .all<{ id: string; status: string; provider_data: Record<string, unknown> }>();
    expect(rows.results).toHaveLength(1);
    for (const row of rows.results) {
      expect(row.status).toBe("pending");
      expect(row.provider_data).toMatchObject({ clientEvent: { advisory: true } });
    }
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

    const NONEXISTENT_SIMULATE_BODY = {
      transferId: "xfr_does_not_exist",
    };

    it("refuses the sandbox simulator from a production-project Clerk", async () => {
      await seedClerkAuth();

      const res = await simulateAsClerk(TEST_PRODUCTION_PROJECT_ID, NONEXISTENT_SIMULATE_BODY);

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("only available in sandbox mode");
    });

    it("still lets sandbox-project Clerks past the environment guard", async () => {
      await seedClerkAuth();

      const res = await simulateAsClerk(TEST_PROJECT.id, NONEXISTENT_SIMULATE_BODY);

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("ramp session and destination binding", () => {
    installStripeTestEnv();

    /** Answers a session create the way Stripe does, echoing the request's locked terms. */
    function stripeSessionResponse(sessionId: string) {
      return async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (!(init?.body instanceof URLSearchParams)) {
          throw new Error("Expected the Stripe session request to send a form body");
        }
        const form = init.body;
        return new Response(
          JSON.stringify({
            id: sessionId,
            client_secret: `${sessionId}_secret`,
            status: "initialized",
            transaction_details: {
              destination_currencies: form.getAll("destination_currencies[]"),
              destination_networks: form.getAll("destination_networks[]"),
              lock_wallet_address: form.get("lock_wallet_address") === "true",
              source_amount: form.get("source_amount"),
              source_currency: form.get("source_currency"),
              wallet_addresses: { solana: form.get("wallet_addresses[solana]") },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };
    }

    async function createStripeOnrampQuote(
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
            provider: "stripe",
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

    it("replays a session quote idempotently but fails closed on input mutation", async () => {
      const counterpartyId = await seedCounterparty({ externalId: "stripe_bind_reuse" });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementationOnce(stripeSessionResponse("cos_bind_reuse_1"))
        .mockImplementationOnce(stripeSessionResponse("cos_bind_reuse_1"))
        .mockImplementationOnce(stripeSessionResponse("cos_bind_reuse_1"));

      const created = await createStripeOnrampQuote(counterpartyId, "25");
      expect(created.status).toBe(200);

      const replayed = await createStripeOnrampQuote(counterpartyId, "25");
      expect(replayed.status).toBe(200);

      const mutated = await createStripeOnrampQuote(counterpartyId, "26");
      expect(mutated.status).toBe(409);
      const body = (await mutated.json()) as { error: { message: string } };
      expect(body.error.message).toContain("already bound");
      fetchSpy.mockRestore();
    });

    it("fails closed when the provider reference is already bound to another tenant", async () => {
      const counterpartyId = await seedCounterparty({ externalId: "stripe_cross_tenant" });
      const now = new Date().toISOString();
      await getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind("org_test_other_tenant", "Other Tenant", "other-tenant", "enterprise", "active")
        .run();
      const otherTenantProjects = await seedDefaultProjects(getDb(env), {
        organizationId: "org_test_other_tenant",
        createdBy: TEST_USER.id,
        members: [],
      });
      await getDb(env)
        .prepare(
          `INSERT INTO payment_transfers (
             id, organization_id, project_id, wallet_id, source_address, destination_address,
             token, amount, memo, type, direction, status, provider, provider_reference,
             delivery_mode, provider_data, created_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, ?, 'USDC', NULL, NULL, 'onramp', 'inbound', 'pending',
                     'stripe', ?, 'session_widget', ?::jsonb, ?, ?)`
        )
        .bind(
          "xfr_stripe_foreign_tenant",
          "org_test_other_tenant",
          otherTenantProjects.sandbox.id,
          "wallet_other_tenant",
          TEST_SOLANA_ADDRESSES.wallet2,
          "cos_foreign_1",
          {},
          now,
          now
        )
        .run();
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementationOnce(stripeSessionResponse("cos_foreign_1"));

      const res = await createStripeOnrampQuote(counterpartyId, "25");

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("already bound");
      fetchSpy.mockRestore();
    });
  });
});
