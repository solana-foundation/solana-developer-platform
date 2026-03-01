import { createHmac } from "node:crypto";
import app from "@/index";
import { hashString } from "@/lib/hash";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/d1";
import { clearKVNamespaces, seedCachedApiKey } from "@/test/mocks/kv";
import type { CachedApiKey } from "@sdp/types";
import type { Signature } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/solana/rpc", async () => {
  const actual =
    await vi.importActual<typeof import("@/services/solana/rpc")>("@/services/solana/rpc");
  return {
    ...actual,
    createRpc: vi.fn().mockReturnValue({}),
    getRecentBlockhash: vi.fn().mockResolvedValue({
      // biome-ignore lint/nursery/noSecrets: Test blockhash, not a secret.
      blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
      lastValidBlockHeight: 1000n,
    }),
    confirmTransaction: vi.fn().mockResolvedValue({
      signature:
        // biome-ignore lint/nursery/noSecrets: Test transaction signature, not a secret.
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy",
      slot: 100n,
      confirmationStatus: "confirmed",
      err: null,
    }),
    getSignaturesForAddress: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("@/services/adapters/fee-payment", async () => {
  const actual = await vi.importActual<typeof import("@/services/adapters/fee-payment")>(
    "@/services/adapters/fee-payment"
  );
  return {
    ...actual,
    createFeePaymentAdapter: vi.fn().mockReturnValue({
      providerId: "mock",
      // biome-ignore lint/nursery/noSecrets: Test Solana address used as mock fee payer, not a secret.
      getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
      signAsFeePayer: vi.fn(),
      signAndSend: vi.fn().mockResolvedValue(
        // biome-ignore lint/nursery/noSecrets: Test transaction signature, not a secret.
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
      ),
    }),
  };
});

vi.mock("@/services/solana", async () => {
  const actual = await vi.importActual<typeof import("@/services/solana")>("@/services/solana");
  const { address, createNoopSigner } = await import("@solana/kit");
  return {
    ...actual,
    createOrgSigner: vi.fn().mockResolvedValue(
      // biome-ignore lint/nursery/noSecrets: Test Solana address, not a secret.
      createNoopSigner(address("8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ"))
    ),
  };
});

const TEST_CONFIG_ID = "cust_cfg_payments_test";
const TEST_CUSTODY_WALLET_ID = "cwlt_payments_test";
const TEST_WALLET_ID = "wal_payments_test";
const TEST_ORG = {
  id: "org_payments_policy_test",
  name: "Payments Policy Test Org",
  slug: "payments-policy-test-org",
};
const TEST_USER = {
  id: "usr_payments_policy_test",
  email: "payments-policy-test@example.com",
};
const TEST_API_KEY = {
  id: "key_payments_policy_test",
  // biome-ignore lint/nursery/noSecrets: Test fixture, not a real secret.
  raw: "sk_test_paymentspolicy12345678901234567890",
  prefix: "sk_test_pay",
};
const TEST_CACHED_API_KEY: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: null,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

const TEST_MOONPAY_API_KEY = "pk_test_moonpay";
const TEST_MOONPAY_SECRET_KEY = "moonpay_secret_key";
const TEST_MOONPAY_ONRAMP_URL = "https://buy-sandbox.moonpay.com";
const TEST_MOONPAY_OFFRAMP_URL = "https://sell-sandbox.moonpay.com";
const TEST_LIGHTSPARK_GRID_CLIENT_ID = "lightspark_token_id";
const TEST_LIGHTSPARK_GRID_CLIENT_SECRET = "lightspark_client_secret";
const TEST_LIGHTSPARK_GRID_API_BASE_URL = "https://api.lightspark.test/grid/2025-10-13";
const TEST_BVNK_API_TOKEN = "bvnk_bearer_token";
const TEST_BVNK_HAWK_AUTH_ID = "bvnk_hawk_auth_id";
const TEST_BVNK_HAWK_SECRET_KEY = "bvnk_hawk_secret_key";
const TEST_BVNK_WALLET_ID = "a:24122329329347:HsdJVhW:1";
const TEST_BVNK_API_BASE_URL = "https://api.sandbox.bvnk.test";
// biome-ignore lint/nursery/noSecrets: Query parameter key used for test assertions.
const MOONPAY_PARAM_BASE_CURRENCY_AMOUNT = "baseCurrencyAmount";
// biome-ignore lint/nursery/noSecrets: Query parameter key used for test assertions.
const MOONPAY_PARAM_EXTERNAL_CUSTOMER_ID = "externalCustomerId";
// biome-ignore lint/nursery/noSecrets: Query parameter key used for test assertions.
const MOONPAY_PARAM_QUOTE_CURRENCY_CODE = "quoteCurrencyCode";
// biome-ignore lint/nursery/noSecrets: Query parameter key used for test assertions.
const MOONPAY_PARAM_REFUND_WALLET_ADDRESS = "refundWalletAddress";

let originalMoonPayApiKey: string | undefined;
let originalMoonPaySecretKey: string | undefined;
let originalMoonPayOnrampUrl: string | undefined;
let originalMoonPayOfframpUrl: string | undefined;
let originalLightsparkGridClientId: string | undefined;
let originalLightsparkGridClientSecret: string | undefined;
let originalLightsparkGridApiBaseUrl: string | undefined;
let originalBvnkApiToken: string | undefined;
let originalBvnkHawkAuthId: string | undefined;
let originalBvnkHawkSecretKey: string | undefined;
let originalBvnkWalletId: string | undefined;
let originalBvnkApiBaseUrl: string | undefined;

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

function lightsparkBasicAuthHeader(): string {
  const credentials = `${TEST_LIGHTSPARK_GRID_CLIENT_ID}:${TEST_LIGHTSPARK_GRID_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
}

async function seedAuthAndWallet(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);

  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)"
    ).bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "free", "active"),
    env.DB.prepare(
      "INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)"
    ).bind(TEST_USER.id, TEST_USER.email, 1, "active"),
    env.DB.prepare(
      `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, environment, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      TEST_API_KEY.id,
      TEST_ORG.id,
      null,
      TEST_USER.id,
      "Payments Test Key",
      TEST_API_KEY.prefix,
      keyHash,
      "api_admin",
      JSON.stringify(["*"]),
      "sandbox",
      "active"
    ),
    env.DB.prepare(
      `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      TEST_CONFIG_ID,
      TEST_ORG.id,
      null,
      "local",
      "test-config",
      "sdp-custody-encryption-v1",
      TEST_WALLET_ID,
      "active"
    ),
    env.DB.prepare(
      `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      TEST_CUSTODY_WALLET_ID,
      TEST_CONFIG_ID,
      TEST_WALLET_ID,
      TEST_SOLANA_ADDRESSES.wallet1,
      "Payments Wallet",
      "transfer",
      "active"
    ),
  ]);
}

async function seedWalletPolicy(params: {
  destinationAllowlist: string[];
  maxTransferAmount?: string;
  maxDailyAmount?: string;
}): Promise<void> {
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO payment_wallet_policies
           (id, custody_wallet_id, policy_type, policy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      "pwp_allowlist_test",
      TEST_CUSTODY_WALLET_ID,
      "destination_allowlist",
      JSON.stringify({
        version: 1,
        destinationAllowlist: params.destinationAllowlist,
      }),
      now,
      now
    ),
    env.DB.prepare(
      `INSERT INTO payment_wallet_policies
           (id, custody_wallet_id, policy_type, policy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      "pwp_limits_test",
      TEST_CUSTODY_WALLET_ID,
      "transfer_limits",
      JSON.stringify({
        version: 1,
        maxTransferAmount: params.maxTransferAmount ?? null,
        maxDailyAmount: params.maxDailyAmount ?? null,
      }),
      now,
      now
    ),
  ]);
}

describe("Payments routes", () => {
  beforeEach(async () => {
    originalMoonPayApiKey = env.MOONPAY_API_KEY;
    originalMoonPaySecretKey = env.MOONPAY_SECRET_KEY;
    originalMoonPayOnrampUrl = env.MOONPAY_ONRAMP_URL;
    originalMoonPayOfframpUrl = env.MOONPAY_OFFRAMP_URL;
    originalLightsparkGridClientId = env.LIGHTSPARK_GRID_CLIENT_ID;
    originalLightsparkGridClientSecret = env.LIGHTSPARK_GRID_CLIENT_SECRET;
    originalLightsparkGridApiBaseUrl = env.LIGHTSPARK_GRID_API_BASE_URL;
    originalBvnkApiToken = env.BVNK_API_TOKEN;
    originalBvnkHawkAuthId = env.BVNK_HAWK_AUTH_ID;
    originalBvnkHawkSecretKey = env.BVNK_HAWK_SECRET_KEY;
    originalBvnkWalletId = env.BVNK_WALLET_ID;
    originalBvnkApiBaseUrl = env.BVNK_API_BASE_URL;

    env.MOONPAY_API_KEY = TEST_MOONPAY_API_KEY;
    env.MOONPAY_SECRET_KEY = TEST_MOONPAY_SECRET_KEY;
    env.MOONPAY_ONRAMP_URL = TEST_MOONPAY_ONRAMP_URL;
    env.MOONPAY_OFFRAMP_URL = TEST_MOONPAY_OFFRAMP_URL;
    env.LIGHTSPARK_GRID_CLIENT_ID = TEST_LIGHTSPARK_GRID_CLIENT_ID;
    env.LIGHTSPARK_GRID_CLIENT_SECRET = TEST_LIGHTSPARK_GRID_CLIENT_SECRET;
    env.LIGHTSPARK_GRID_API_BASE_URL = TEST_LIGHTSPARK_GRID_API_BASE_URL;
    env.BVNK_API_TOKEN = TEST_BVNK_API_TOKEN;
    env.BVNK_HAWK_AUTH_ID = undefined;
    env.BVNK_HAWK_SECRET_KEY = undefined;
    env.BVNK_WALLET_ID = TEST_BVNK_WALLET_ID;
    env.BVNK_API_BASE_URL = TEST_BVNK_API_BASE_URL;

    await seedTestDatabase(env);
    await seedAuthAndWallet();
  });

  afterEach(async () => {
    env.MOONPAY_API_KEY = originalMoonPayApiKey;
    env.MOONPAY_SECRET_KEY = originalMoonPaySecretKey;
    env.MOONPAY_ONRAMP_URL = originalMoonPayOnrampUrl;
    env.MOONPAY_OFFRAMP_URL = originalMoonPayOfframpUrl;
    env.LIGHTSPARK_GRID_CLIENT_ID = originalLightsparkGridClientId;
    env.LIGHTSPARK_GRID_CLIENT_SECRET = originalLightsparkGridClientSecret;
    env.LIGHTSPARK_GRID_API_BASE_URL = originalLightsparkGridApiBaseUrl;
    env.BVNK_API_TOKEN = originalBvnkApiToken;
    env.BVNK_HAWK_AUTH_ID = originalBvnkHawkAuthId;
    env.BVNK_HAWK_SECRET_KEY = originalBvnkHawkSecretKey;
    env.BVNK_WALLET_ID = originalBvnkWalletId;
    env.BVNK_API_BASE_URL = originalBvnkApiBaseUrl;

    await clearTestDatabase(env);
    await clearKVNamespaces(env);
  });

  it("creates a signed MoonPay on-ramp session URL", async () => {
    const res = await app.request(
      "/v1/payments/ramps/onramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          destinationWallet: TEST_WALLET_ID,
          cryptoToken: "USDC_SOL",
          fiatCurrency: "USD",
          fiatAmount: "120.50",
          kycReference: "kyc_ref_123",
          redirectUrl: "https://example.com/onramp-done",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { ramp: { id: string; status: string; redirectUrl: string } };
    };

    expect(body.data.ramp.id.startsWith("ramp_")).toBe(true);
    expect(body.data.ramp.status).toBe("pending");

    const redirect = new URL(body.data.ramp.redirectUrl);
    expect(redirect.origin).toBe(TEST_MOONPAY_ONRAMP_URL);
    expect(redirect.searchParams.get("apiKey")).toBe(TEST_MOONPAY_API_KEY);
    expect(redirect.searchParams.get("baseCurrencyCode")).toBe("usd");
    expect(redirect.searchParams.get(MOONPAY_PARAM_BASE_CURRENCY_AMOUNT)).toBe("120.50");
    expect(redirect.searchParams.get("currencyCode")).toBe("usdc_sol");
    expect(redirect.searchParams.get("walletAddress")).toBe(TEST_SOLANA_ADDRESSES.wallet1);
    expect(redirect.searchParams.get("redirectURL")).toBe("https://example.com/onramp-done");
    expect(redirect.searchParams.get(MOONPAY_PARAM_EXTERNAL_CUSTOMER_ID)).toBe("kyc_ref_123");
    assertMoonPaySignature(redirect);
  });

  it("creates a signed MoonPay off-ramp session URL", async () => {
    const res = await app.request(
      "/v1/payments/ramps/offramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          sourceWallet: TEST_WALLET_ID,
          cryptoToken: "USDC_SOL",
          fiatCurrency: "USD",
          cryptoAmount: "75.25",
          kycReference: "kyc_ref_456",
          redirectUrl: "https://example.com/offramp-done",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { ramp: { id: string; status: string; redirectUrl: string; reference: string } };
    };

    expect(body.data.ramp.id.startsWith("ramp_")).toBe(true);
    expect(body.data.ramp.status).toBe("pending");
    expect(body.data.ramp.reference.startsWith("sdp_offramp_")).toBe(true);

    const redirect = new URL(body.data.ramp.redirectUrl);
    expect(redirect.origin).toBe(TEST_MOONPAY_OFFRAMP_URL);
    expect(redirect.searchParams.get("apiKey")).toBe(TEST_MOONPAY_API_KEY);
    expect(redirect.searchParams.get("baseCurrencyCode")).toBe("usdc_sol");
    expect(redirect.searchParams.get(MOONPAY_PARAM_BASE_CURRENCY_AMOUNT)).toBe("75.25");
    expect(redirect.searchParams.get(MOONPAY_PARAM_QUOTE_CURRENCY_CODE)).toBe("usd");
    expect(redirect.searchParams.get("walletAddress")).toBe(TEST_SOLANA_ADDRESSES.wallet1);
    expect(redirect.searchParams.get(MOONPAY_PARAM_REFUND_WALLET_ADDRESS)).toBe(
      TEST_SOLANA_ADDRESSES.wallet1
    );
    expect(redirect.searchParams.get("redirectURL")).toBe("https://example.com/offramp-done");
    expect(redirect.searchParams.get(MOONPAY_PARAM_EXTERNAL_CUSTOMER_ID)).toBe("kyc_ref_456");
    assertMoonPaySignature(redirect);
  });

  it("creates a Lightspark on-ramp quote through the execute endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "Quote:ls_onramp_123",
          quoteStatus: "PENDING",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const res = await app.request(
      "/v1/payments/ramps/onramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "lightspark",
          destinationWallet: "ExternalAccount:acc_destination_123",
          cryptoToken: "BTC",
          fiatCurrency: "USD",
          fiatAmount: "12.34",
          kycReference: "Customer:cus_123",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { ramp: { id: string; provider: string; status: string; reference: string } };
    };

    expect(body.data.ramp.id.startsWith("ramp_")).toBe(true);
    expect(body.data.ramp.provider).toBe("lightspark");
    expect(body.data.ramp.status).toBe("pending");
    expect(body.data.ramp.reference).toBe("Quote:ls_onramp_123");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const requestUrl = fetchSpy.mock.calls[0]?.[0];
    const requestInit = fetchSpy.mock.calls[0]?.[1];
    expect(String(requestUrl)).toBe(`${TEST_LIGHTSPARK_GRID_API_BASE_URL}/quotes`);
    expect(requestInit?.method).toBe("POST");

    const headers = requestInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(lightsparkBasicAuthHeader());

    const payload = JSON.parse(String(requestInit?.body)) as {
      lockedCurrencyAmount: number;
      source: { sourceType: string; customerId: string; currency: string };
      destination: { destinationType: string; accountId: string; currency: string };
    };
    expect(payload.lockedCurrencyAmount).toBe(1234);
    expect(payload.source.sourceType).toBe("REALTIME_FUNDING");
    expect(payload.source.customerId).toBe("Customer:cus_123");
    expect(payload.source.currency).toBe("USD");
    expect(payload.destination.destinationType).toBe("ACCOUNT");
    expect(payload.destination.accountId).toBe("ExternalAccount:acc_destination_123");
    expect(payload.destination.currency).toBe("BTC");
    fetchSpy.mockRestore();
  });

  it("reuses an existing Lightspark external account for Solana wallet on-ramp destinations", async () => {
    const destinationSolanaWallet = TEST_SOLANA_ADDRESSES.wallet2;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "ExternalAccount:acc_existing_123",
                accountInfo: {
                  accountType: "SOLANA_WALLET",
                  address: destinationSolanaWallet,
                },
              },
            ],
            hasMore: false,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "Quote:ls_onramp_existing_123",
            quoteStatus: "PENDING",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );

    const res = await app.request(
      "/v1/payments/ramps/onramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "lightspark",
          destinationWallet: destinationSolanaWallet,
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          fiatAmount: "5.00",
          kycReference: "Customer:cus_123",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { ramp: { provider: string; reference: string } };
    };
    expect(body.data.ramp.provider).toBe("lightspark");
    expect(body.data.ramp.reference).toBe("Quote:ls_onramp_existing_123");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const listUrl = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(listUrl.pathname).toBe("/grid/2025-10-13/customers/external-accounts");
    expect(listUrl.searchParams.get("customerId")).toBe("Customer:cus_123");
    expect(listUrl.searchParams.get("currency")).toBe("USDC");
    expect(listUrl.searchParams.get("limit")).toBe("100");

    const quotePayload = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)) as {
      destination: { accountId: string };
    };
    expect(quotePayload.destination.accountId).toBe("ExternalAccount:acc_existing_123");
    fetchSpy.mockRestore();
  });

  it("creates a Lightspark external account when Solana wallet destination is not found", async () => {
    const destinationSolanaWallet = TEST_SOLANA_ADDRESSES.wallet3;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [],
            hasMore: false,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "ExternalAccount:acc_created_123",
            accountInfo: {
              accountType: "SOLANA_WALLET",
              address: destinationSolanaWallet,
            },
          }),
          {
            status: 201,
            headers: { "Content-Type": "application/json" },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "Quote:ls_onramp_created_123",
            quoteStatus: "PENDING",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );

    const res = await app.request(
      "/v1/payments/ramps/onramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "lightspark",
          destinationWallet: destinationSolanaWallet,
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          fiatAmount: "5.00",
          kycReference: "Customer:cus_123",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { ramp: { provider: string; reference: string } };
    };
    expect(body.data.ramp.provider).toBe("lightspark");
    expect(body.data.ramp.reference).toBe("Quote:ls_onramp_created_123");

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const createUrl = String(fetchSpy.mock.calls[1]?.[0]);
    expect(createUrl).toBe(`${TEST_LIGHTSPARK_GRID_API_BASE_URL}/customers/external-accounts`);
    const createPayload = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)) as {
      customerId: string;
      currency: string;
      accountInfo: { accountType: string; address: string };
    };
    expect(createPayload.customerId).toBe("Customer:cus_123");
    expect(createPayload.currency).toBe("USDC");
    expect(createPayload.accountInfo.accountType).toBe("SOLANA_WALLET");
    expect(createPayload.accountInfo.address).toBe(destinationSolanaWallet);

    const quotePayload = JSON.parse(String(fetchSpy.mock.calls[2]?.[1]?.body)) as {
      destination: { accountId: string };
    };
    expect(quotePayload.destination.accountId).toBe("ExternalAccount:acc_created_123");
    fetchSpy.mockRestore();
  });

  it("creates and executes a Lightspark off-ramp quote through the execute endpoint", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "Quote:ls_offramp_123",
            quoteStatus: "PENDING",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "Quote:ls_offramp_123",
            quoteStatus: "COMPLETED",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );

    const res = await app.request(
      "/v1/payments/ramps/offramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "lightspark",
          sourceWallet: "InternalAccount:acc_source_123",
          cryptoToken: "BTC",
          fiatCurrency: "USD",
          cryptoAmount: "0.015",
          kycReference: "ExternalAccount:acc_destination_456",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { ramp: { id: string; provider: string; status: string; reference: string } };
    };

    expect(body.data.ramp.id.startsWith("ramp_")).toBe(true);
    expect(body.data.ramp.provider).toBe("lightspark");
    expect(body.data.ramp.status).toBe("completed");
    expect(body.data.ramp.reference).toBe("Quote:ls_offramp_123");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const quoteCallUrl = String(fetchSpy.mock.calls[0]?.[0]);
    const executeCallUrl = String(fetchSpy.mock.calls[1]?.[0]);
    expect(quoteCallUrl).toBe(`${TEST_LIGHTSPARK_GRID_API_BASE_URL}/quotes`);
    expect(executeCallUrl).toBe(
      `${TEST_LIGHTSPARK_GRID_API_BASE_URL}/quotes/Quote%3Als_offramp_123/execute`
    );

    const quoteCallPayload = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
      lockedCurrencyAmount: number;
      source: { sourceType: string; accountId: string; currency: string };
      destination: { destinationType: string; accountId: string; currency: string };
    };
    expect(quoteCallPayload.lockedCurrencyAmount).toBe(1500000);
    expect(quoteCallPayload.source.sourceType).toBe("ACCOUNT");
    expect(quoteCallPayload.source.accountId).toBe("InternalAccount:acc_source_123");
    expect(quoteCallPayload.source.currency).toBe("BTC");
    expect(quoteCallPayload.destination.destinationType).toBe("ACCOUNT");
    expect(quoteCallPayload.destination.accountId).toBe("ExternalAccount:acc_destination_456");
    expect(quoteCallPayload.destination.currency).toBe("USD");
    fetchSpy.mockRestore();
  });

  it("creates a BVNK on-ramp payment through the execute endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          uuid: "bvnk_onramp_uuid_123",
          status: "PENDING",
          redirectUrl: "https://checkout.bvnk.test/pay/abc123",
          reference: "bvnk_reference_onramp",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const res = await app.request(
      "/v1/payments/ramps/onramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "bvnk",
          destinationWallet: TEST_WALLET_ID,
          cryptoToken: "USDC_SOLANA",
          fiatCurrency: "USD",
          fiatAmount: "120.50",
          kycReference: "customer_123",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { ramp: { id: string; provider: string; status: string; redirectUrl: string; reference: string } };
    };

    expect(body.data.ramp.id.startsWith("ramp_")).toBe(true);
    expect(body.data.ramp.provider).toBe("bvnk");
    expect(body.data.ramp.status).toBe("pending");
    expect(body.data.ramp.redirectUrl).toBe("https://checkout.bvnk.test/pay/abc123");
    expect(body.data.ramp.reference).toBe("bvnk_onramp_uuid_123");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const requestUrl = String(fetchSpy.mock.calls[0]?.[0]);
    const requestInit = fetchSpy.mock.calls[0]?.[1];
    expect(requestUrl).toBe(`${TEST_BVNK_API_BASE_URL}/api/v1/pay/summary`);

    const headers = requestInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TEST_BVNK_API_TOKEN}`);

    const payload = JSON.parse(String(requestInit?.body)) as {
      walletId: string;
      amount: number;
      currency: string;
      type: string;
      customerId: string;
      payOutDetails: { code: string; currency: string; address: string; network: string };
      complianceDetails: { partyDetails: unknown[] };
    };
    expect(payload.walletId).toBe(TEST_BVNK_WALLET_ID);
    expect(payload.amount).toBe(120.5);
    expect(payload.currency).toBe("USD");
    expect(payload.type).toBe("IN");
    expect(payload.customerId).toBe("customer_123");
    expect(payload.payOutDetails.code).toBe("crypto");
    expect(payload.payOutDetails.currency).toBe("USDC");
    expect(payload.payOutDetails.address).toBe(TEST_SOLANA_ADDRESSES.wallet1);
    expect(payload.payOutDetails.network).toBe("SOLANA");
    expect(Array.isArray(payload.complianceDetails.partyDetails)).toBe(true);
    fetchSpy.mockRestore();
  });

  it("creates and accepts a BVNK off-ramp estimate through the execute endpoint", async () => {
    env.BVNK_API_TOKEN = undefined;
    env.BVNK_HAWK_AUTH_ID = TEST_BVNK_HAWK_AUTH_ID;
    env.BVNK_HAWK_SECRET_KEY = TEST_BVNK_HAWK_SECRET_KEY;

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            externalId: "estimate_bvnk_123",
          }),
          {
            status: 201,
            headers: { "Content-Type": "application/json" },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uuid: "bvnk_offramp_uuid_123",
            status: "PROCESSING",
            reference: "bvnk_offramp_reference",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );

    const res = await app.request(
      "/v1/payments/ramps/offramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "bvnk",
          sourceWallet: TEST_WALLET_ID,
          cryptoToken: "USDC_SOLANA",
          fiatCurrency: "USD",
          cryptoAmount: "75.25",
          kycReference: "customer_456",
          bvnkCompliance: {
            requesterIpAddress: "1.1.1.1",
            partyDetails: [
              {
                type: "BENEFICIARY",
                entityType: "INDIVIDUAL",
                relationshipType: "THIRD_PARTY",
                firstName: "Test",
                lastName: "User",
                dateOfBirth: "1990-01-01",
                countryCode: "US",
              },
            ],
          },
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { ramp: { id: string; provider: string; status: string; reference: string } };
    };

    expect(body.data.ramp.id.startsWith("ramp_")).toBe(true);
    expect(body.data.ramp.provider).toBe("bvnk");
    expect(body.data.ramp.status).toBe("processing");
    expect(body.data.ramp.reference).toBe("bvnk_offramp_uuid_123");

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const estimateUrl = String(fetchSpy.mock.calls[0]?.[0]);
    const acceptUrl = String(fetchSpy.mock.calls[1]?.[0]);
    expect(estimateUrl).toBe(`${TEST_BVNK_API_BASE_URL}/api/v1/pay/estimate`);
    expect(acceptUrl).toBe(`${TEST_BVNK_API_BASE_URL}/api/v1/pay/estimate/estimate_bvnk_123/accept`);
    const estimateHeaders = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const acceptHeaders = fetchSpy.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(estimateHeaders.Authorization).toContain(`Hawk id="${TEST_BVNK_HAWK_AUTH_ID}"`);
    expect(acceptHeaders.Authorization).toContain(`Hawk id="${TEST_BVNK_HAWK_AUTH_ID}"`);

    const estimatePayload = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
      walletId: string;
      walletCurrency: string;
      paidCurrency: string;
      paidRequiredAmount: number;
      network: string;
      complianceDetails: { requesterIpAddress?: string; partyDetails: Record<string, unknown>[] };
    };
    expect(estimatePayload.walletId).toBe(TEST_BVNK_WALLET_ID);
    expect(estimatePayload.walletCurrency).toBe("USD");
    expect(estimatePayload.paidCurrency).toBe("USDC");
    expect(estimatePayload.paidRequiredAmount).toBe(75.25);
    expect(estimatePayload.network).toBe("SOLANA");
    expect(estimatePayload.complianceDetails.requesterIpAddress).toBe("1.1.1.1");
    expect(estimatePayload.complianceDetails.partyDetails).toHaveLength(1);

    const acceptPayload = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)) as {
      customerId: string;
      payOutDetails: { currency: string; address: string; network: string };
      complianceDetails: { requesterIpAddress?: string; partyDetails: Record<string, unknown>[] };
    };
    expect(acceptPayload.customerId).toBe("customer_456");
    expect(acceptPayload.payOutDetails.currency).toBe("USDC");
    expect(acceptPayload.payOutDetails.address).toBe(TEST_SOLANA_ADDRESSES.wallet1);
    expect(acceptPayload.payOutDetails.network).toBe("SOLANA");
    expect(acceptPayload.complianceDetails.requesterIpAddress).toBe("1.1.1.1");
    expect(acceptPayload.complianceDetails.partyDetails).toHaveLength(1);
    fetchSpy.mockRestore();
  });

  it("returns bad request when BVNK off-ramp is missing compliance party details", async () => {
    const res = await app.request(
      "/v1/payments/ramps/offramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "bvnk",
          sourceWallet: TEST_WALLET_ID,
          cryptoToken: "USDC_SOLANA",
          fiatCurrency: "USD",
          cryptoAmount: "75.25",
          kycReference: "customer_456",
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("bvnkCompliance.partyDetails is required");
  });

  it("returns bad request when provider is not supported", async () => {
    const res = await app.request(
      "/v1/payments/ramps/onramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "unsupported_provider",
          destinationWallet: TEST_WALLET_ID,
          cryptoToken: "USDC_SOL",
          fiatCurrency: "USD",
          fiatAmount: "10.00",
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Unsupported ramp provider");
  });

  it("returns internal error when MoonPay credentials are not configured", async () => {
    env.MOONPAY_API_KEY = undefined;

    const res = await app.request(
      "/v1/payments/ramps/onramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          destinationWallet: TEST_WALLET_ID,
          cryptoToken: "usdc_sol",
          fiatCurrency: "USD",
          fiatAmount: "10",
        }),
      },
      env
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toContain("MoonPay is not configured");
  });

  it("returns internal error when Lightspark credentials are not configured", async () => {
    env.LIGHTSPARK_GRID_CLIENT_ID = undefined;

    const res = await app.request(
      "/v1/payments/ramps/onramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "lightspark",
          destinationWallet: "ExternalAccount:acc_destination_123",
          cryptoToken: "BTC",
          fiatCurrency: "USD",
          fiatAmount: "10",
          kycReference: "Customer:cus_123",
        }),
      },
      env
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toContain("Lightspark is not configured");
  });

  it("returns internal error when BVNK credentials are not configured", async () => {
    env.BVNK_API_TOKEN = undefined;

    const res = await app.request(
      "/v1/payments/ramps/onramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "bvnk",
          destinationWallet: TEST_WALLET_ID,
          cryptoToken: "USDC_SOLANA",
          fiatCurrency: "USD",
          fiatAmount: "10",
          kycReference: "customer_123",
        }),
      },
      env
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toContain("BVNK is not configured");
  });

  it("blocks prepare transfer when destination is outside allowlist", async () => {
    await seedWalletPolicy({
      destinationAllowlist: [TEST_SOLANA_ADDRESSES.wallet2],
    });

    const res = await app.request(
      "/v1/payments/transfers/prepare",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet3,
          token: "SOL",
          amount: "1",
        }),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");

    const transfers = await env.DB.prepare("SELECT id FROM payment_transfers").all<{
      id: string;
    }>();
    expect(transfers.results).toHaveLength(0);
  });

  it("blocks prepare transfer when amount exceeds maxTransferAmount", async () => {
    await seedWalletPolicy({
      destinationAllowlist: [],
      maxTransferAmount: "1.5",
    });

    const res = await app.request(
      "/v1/payments/transfers/prepare",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "SOL",
          amount: "2.0",
        }),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");

    const transfers = await env.DB.prepare("SELECT id FROM payment_transfers").all<{
      id: string;
    }>();
    expect(transfers.results).toHaveLength(0);
  });

  describe("prepare transfer — happy path", () => {
    it("creates a pending SOL transfer with no wallet policy", async () => {
      const res = await app.request(
        "/v1/payments/transfers/prepare",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            source: TEST_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: "SOL",
            amount: "1",
          }),
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          transfer: { id: string; status: string };
          preparedTransaction: { serialized: string; blockhash: string };
        };
      };
      expect(body.data.transfer.status).toBe("pending");
      expect(body.data.transfer.id).toMatch(/^xfr_/);
      expect(body.data.preparedTransaction.serialized).toBeTruthy();
      expect(body.data.preparedTransaction.blockhash).toBe(
        // biome-ignore lint/nursery/noSecrets: Test blockhash, not a secret.
        "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"
      );

      const row = await env.DB.prepare(
        "SELECT status, serialized_tx FROM payment_transfers WHERE id = ?"
      )
        .bind(body.data.transfer.id)
        .first<{ status: string; serialized_tx: string | null }>();
      expect(row?.status).toBe("pending");
      expect(row?.serialized_tx).toBeTruthy();
    });

    it("creates a pending SOL transfer when destination is on the allowlist", async () => {
      await seedWalletPolicy({
        destinationAllowlist: [TEST_SOLANA_ADDRESSES.wallet2],
      });

      const res = await app.request(
        "/v1/payments/transfers/prepare",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            source: TEST_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: "SOL",
            amount: "1",
          }),
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          transfer: { id: string; status: string };
          preparedTransaction: { serialized: string };
        };
      };
      expect(body.data.transfer.status).toBe("pending");
      expect(body.data.transfer.id).toMatch(/^xfr_/);
      expect(body.data.preparedTransaction.serialized).toBeTruthy();
    });

    it("returns 400 when required field amount is missing", async () => {
      const res = await app.request(
        "/v1/payments/transfers/prepare",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            source: TEST_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: "SOL",
            // amount omitted
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("BAD_REQUEST");

      const transfers = await env.DB.prepare("SELECT id FROM payment_transfers").all<{
        id: string;
      }>();
      expect(transfers.results).toHaveLength(0);
    });

    it("returns 400 when destination address is too short", async () => {
      const res = await app.request(
        "/v1/payments/transfers/prepare",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            source: TEST_WALLET_ID,
            destination: "bad",
            token: "SOL",
            amount: "1",
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("BAD_REQUEST");
    });

    it("returns 404 when source wallet does not exist", async () => {
      const res = await app.request(
        "/v1/payments/transfers/prepare",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            source: "wal_nonexistent_wallet",
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: "SOL",
            amount: "1",
          }),
        },
        env
      );

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");

      const transfers = await env.DB.prepare("SELECT id FROM payment_transfers").all<{
        id: string;
      }>();
      expect(transfers.results).toHaveLength(0);
    });
  });

  it("blocks create transfer when projected daily total exceeds maxDailyAmount", async () => {
    await seedWalletPolicy({
      destinationAllowlist: [],
      maxDailyAmount: "2.0",
    });

    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO payment_transfers
           (id, organization_id, project_id, wallet_id, source_address, destination_address, token, amount, memo, type, direction, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        "xfr_existing_daily_limit",
        TEST_ORG.id,
        null,
        TEST_WALLET_ID,
        TEST_SOLANA_ADDRESSES.wallet1,
        TEST_SOLANA_ADDRESSES.wallet2,
        "SOL",
        "1.4",
        null,
        "transfer",
        "outbound",
        "confirmed",
        now,
        now
      )
      .run();

    const res = await app.request(
      "/v1/payments/transfers",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet3,
          token: "SOL",
          amount: "0.7",
        }),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");

    const transfers = await env.DB.prepare("SELECT id FROM payment_transfers ORDER BY id ASC").all<{
      id: string;
    }>();
    expect(transfers.results).toHaveLength(1);
    expect(transfers.results[0]?.id).toBe("xfr_existing_daily_limit");
  });

  async function seedTransfer(params: {
    id: string;
    status: string;
    signature?: string | null;
    walletId?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO payment_transfers
           (id, organization_id, project_id, wallet_id, source_address, destination_address, token, amount, memo, type, direction, status, signature, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        params.id,
        TEST_ORG.id,
        null,
        params.walletId ?? TEST_WALLET_ID,
        TEST_SOLANA_ADDRESSES.wallet1,
        TEST_SOLANA_ADDRESSES.wallet2,
        "SOL",
        "1",
        null,
        "transfer",
        "outbound",
        params.status,
        params.signature ?? null,
        now,
        now
      )
      .run();
  }

  describe("execute transfer — happy path", () => {
    it("executes a SOL transfer and returns a confirmed transfer record", async () => {
      const res = await app.request(
        "/v1/payments/transfers",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            source: TEST_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: "SOL",
            amount: "1",
          }),
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          transfer: { id: string; status: string; signature: string | null };
        };
      };
      expect(body.data.transfer.status).toBe("confirmed");
      expect(body.data.transfer.id).toMatch(/^xfr_/);
      expect(body.data.transfer.signature).toBeTruthy();

      const row = await env.DB.prepare(
        "SELECT status, signature FROM payment_transfers WHERE id = ?"
      )
        .bind(body.data.transfer.id)
        .first<{ status: string; signature: string | null }>();
      expect(row?.status).toBe("confirmed");
      expect(row?.signature).toBeTruthy();
    });

    it("marks the transfer as failed when execution throws and returns 502", async () => {
      const { createFeePaymentAdapter } = await import("@/services/adapters/fee-payment");
      vi.mocked(createFeePaymentAdapter).mockReturnValueOnce({
        providerId: "mock",
        // biome-ignore lint/nursery/noSecrets: Test Solana address used as mock fee payer, not a secret.
        getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        signAsFeePayer: vi.fn(),
        signAndSend: vi.fn().mockRejectedValue(new Error("RPC connection refused")),
      });

      const res = await app.request(
        "/v1/payments/transfers",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            source: TEST_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: "SOL",
            amount: "1",
          }),
        },
        env
      );

      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("SOLANA_RPC_ERROR");

      const transfers = await env.DB.prepare("SELECT status, error FROM payment_transfers").all<{
        status: string;
        error: string | null;
      }>();
      expect(transfers.results).toHaveLength(1);
      expect(transfers.results[0]?.status).toBe("failed");
      expect(transfers.results[0]?.error).toBeTruthy();
    });
  });

  describe("list transfers", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("returns confirmed + pending transfers when wallet filter is provided", async () => {
      const { getSignaturesForAddress } = await import("@/services/solana/rpc");
      const confirmedSig =
        // biome-ignore lint/nursery/noSecrets: Test transaction signature, not a secret.
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy";

      await seedTransfer({ id: "xfr_confirmed_1", status: "confirmed", signature: confirmedSig });
      await seedTransfer({ id: "xfr_pending_1", status: "pending" });

      vi.mocked(getSignaturesForAddress).mockResolvedValueOnce([
        {
          signature: confirmedSig as unknown as Signature,
          slot: 100n,
          blockTime: 1700000000n,
          err: null,
        },
      ]);

      const res = await app.request(
        `/v1/payments/transfers?wallet=${TEST_WALLET_ID}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ id: string; status: string }>;
        meta: { total: number };
      };
      expect(body.meta.total).toBe(2);
      expect(body.data).toHaveLength(2);
      const statuses = body.data.map((t) => t.status).sort();
      expect(statuses).toEqual(["confirmed", "pending"]);
    });

    it("returns all transfers via DB-only path when no wallet filter is provided", async () => {
      const { getSignaturesForAddress } = await import("@/services/solana/rpc");

      await seedTransfer({ id: "xfr_db_1", status: "confirmed" });
      await seedTransfer({ id: "xfr_db_2", status: "pending" });
      await seedTransfer({ id: "xfr_db_3", status: "failed" });

      const res = await app.request(
        "/v1/payments/transfers",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ id: string }>;
        meta: { total: number };
      };
      expect(body.data).toHaveLength(3);
      expect(body.meta.total).toBe(3);
      expect(vi.mocked(getSignaturesForAddress)).not.toHaveBeenCalled();
    });

    it("filters by status when status query param is provided", async () => {
      await seedTransfer({ id: "xfr_status_confirmed", status: "confirmed" });
      await seedTransfer({ id: "xfr_status_pending", status: "pending" });

      const res = await app.request(
        // biome-ignore lint/nursery/noSecrets: Test URL query param, not a secret.
        "/v1/payments/transfers?status=confirmed",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ id: string; status: string }>;
        meta: { total: number };
      };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.status).toBe("confirmed");
    });

    it("returns a single transfer by ID", async () => {
      await seedTransfer({ id: "xfr_single_1", status: "confirmed" });

      const res = await app.request(
        "/v1/payments/transfers/xfr_single_1",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { transfer: { id: string; status: string } };
      };
      expect(body.data.transfer.id).toBe("xfr_single_1");
      expect(body.data.transfer.status).toBe("confirmed");
    });
  });
});
