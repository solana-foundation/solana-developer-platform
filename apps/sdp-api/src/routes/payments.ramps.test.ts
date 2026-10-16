import { createHmac } from "node:crypto";
import { withRpcReadContext } from "@sdp/rpc/read-context";
import * as solanaRpc from "@sdp/rpc/solana";
import { createRpcFromTransport } from "@sdp/rpc/solana";
import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types";
import type { Address } from "@solana/addresses";
import type { RpcTransport } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp } from "@/app";
import { getDb } from "@/db";
import app from "@/index";
import { errorResponseSchema } from "@/openapi/schemas/base";
import { noopObservability } from "@/runtime/observability";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
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
      providers: expect.arrayContaining(["moonpay", "stripe"]),
    });
  });

  it("lists generated off-ramp currency provider support", async () => {
    const res = await app.request(
      "/v1/payments/ramps/offramp/currency?source=usdc.solana&dest=USD&provider=moonpay",
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
      providers: ["moonpay"],
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

  it("quotes MoonPay USDC on Solana in both directions", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "moonpay_usdc_quotes" });
    const hostedQuoteSchema = z.object({
      data: z.object({ quote: z.object({ hostedUrl: z.string() }) }),
    });
    const quoteUsdc = async ({
      direction,
      ...fields
    }:
      | { direction: "onramp"; destinationCustodyWalletId: string; fiatAmount: string }
      | {
          direction: "offramp";
          sourceCustodyWalletId: string;
          cryptoAmount: string;
        }): Promise<URL> => {
      const response = await app.request(
        `/v1/payments/ramps/${direction}/quote`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            provider: "moonpay",
            counterpartyId,
            assetRail: "usdc.solana",
            fiatCurrency: "USD",
            ...fields,
          }),
        },
        env
      );
      expect(response.status).toBe(200);
      return new URL(hostedQuoteSchema.parse(await response.json()).data.quote.hostedUrl);
    };

    const onrampUrl = await quoteUsdc({
      direction: "onramp",
      destinationCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      fiatAmount: "50",
    });
    expect(onrampUrl.searchParams.get("currencyCode")).toBe("usdc_sol");
    expect(onrampUrl.searchParams.get("baseCurrencyCode")).toBe("usd");
    assertMoonPaySignature(onrampUrl);

    const offrampUrl = await quoteUsdc({
      direction: "offramp",
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      cryptoAmount: "75.25",
    });
    expect(offrampUrl.searchParams.get("baseCurrencyCode")).toBe("usdc_sol");
    expect(offrampUrl.searchParams.get("quoteCurrencyCode")).toBe("usd");
    assertMoonPaySignature(offrampUrl);
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
          // MoonPay offers no USDG on Solana in either direction.
          assetRail: "usdg.solana",
          fiatCurrency: "USD",
          fiatAmount: "120.50",
        }),
      },
      env
    );

    expect(onrampRes.status).toBe(400);
    const onrampBody = errorResponseSchema.parse(await onrampRes.json());
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
          assetRail: "usdg.solana",
          fiatCurrency: "USD",
          cryptoAmount: "75.25",
        }),
      },
      env
    );

    expect(offrampRes.status).toBe(400);
    const offrampBody = errorResponseSchema.parse(await offrampRes.json());
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
      provider: "moonpay",
      providerReference: "moonpay_ref_cancel_1",
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
      provider: "moonpay",
      providerReference: "moonpay_ref_cancel_2",
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
      provider: "stripe",
      providerReference: "stripe_ref_cancel_excluded",
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
      provider: "moonpay",
      providerReference: "moonpay_ref_cancel_no_provider",
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
            provider: "moonpay",
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
