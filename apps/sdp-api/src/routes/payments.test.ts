import { createHmac } from "node:crypto";
import type { CachedApiKey } from "@sdp/types";
import type { Address, Signature } from "@solana/kit";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { hashString } from "@/lib/hash";
import * as tokenAccounts from "@/routes/payments/token-accounts";
import * as feePaymentAdapters from "@/services/adapters/fee-payment";
import * as solanaServices from "@/services/solana";
import * as solanaRpc from "@/services/solana/rpc";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVNamespaces, seedCachedApiKey } from "@/test/mocks/kv";

const createRpcMock = vi.spyOn(solanaRpc, "createRpc");
const getAccountInfoMock = vi.spyOn(solanaRpc, "getAccountInfo");
const getRecentBlockhashMock = vi.spyOn(solanaRpc, "getRecentBlockhash");
const confirmTransactionMock = vi.spyOn(solanaRpc, "confirmTransaction");
const sendAndConfirmTransactionMock = vi.spyOn(solanaRpc, "sendAndConfirmTransaction");
const getSignaturesForAddressMock = vi.spyOn(solanaRpc, "getSignaturesForAddress");
const getSplTokenBalancesMock = vi.spyOn(tokenAccounts, "getSplTokenBalances");
const getSplTokenAccountAddressesMock = vi.spyOn(tokenAccounts, "getSplTokenAccountAddresses");
const createFeePaymentAdapterMock = vi.spyOn(feePaymentAdapters, "createFeePaymentAdapter");
const createOrgSignerMock = vi.spyOn(solanaServices, "createOrgSigner");

const TEST_CONFIG_ID = "cust_cfg_payments_test";
const TEST_CUSTODY_WALLET_ID = "cwlt_payments_test";
const TEST_WALLET_ID = "wal_payments_test";
const TEST_ORG = {
  id: "org_payments_policy_test",
  name: "Payments Policy Test Org",
  slug: "payments-policy-test-org",
};
const TEST_PROJECT = {
  id: "prj_test_payments_policy",
  slug: "test-payments-policy-project",
};
const TEST_USER = {
  id: "usr_payments_policy_test",
  email: "payments-policy-test@example.com",
};
const TEST_API_KEY = {
  id: "key_payments_policy_test",
  raw: "sk_test_payments_policy",
  prefix: "sk_test_pay",
};
const TEST_KORA_FEE_PAYER = "4YhMUz8xDgHMPAevvfMpnJX9TJmw9DTNDA1sNWPRZG9q";
const TEST_CACHED_API_KEY: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
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
const LIGHTSPARK_GRID_API_BASE_URL = "https://api.lightspark.com/grid/2025-10-13";
const TEST_BVNK_HAWK_AUTH_ID = "bvnk_hawk_auth_id";
const TEST_BVNK_HAWK_SECRET_KEY = "bvnk_hawk_secret_key";
const TEST_BVNK_WALLET_ID = "a:24122329329347:HsdJVhW:1";
const TEST_BVNK_API_BASE_URL = "https://api.sandbox.bvnk.test";
const TEST_MAGICBLOCK_API_BASE_URL = "https://payments.magicblock.test";
const TEST_MAGICBLOCK_AUTH_TOKEN = "magicblock_auth_token";
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MOONPAY_PARAM_BASE_CURRENCY_AMOUNT = "baseCurrencyAmount";
const MOONPAY_PARAM_EXTERNAL_CUSTOMER_ID = "externalCustomerId";
const MOONPAY_PARAM_QUOTE_CURRENCY_CODE = "quoteCurrencyCode";
const MOONPAY_PARAM_REFUND_WALLET_ADDRESS = "refundWalletAddress";

let originalMoonPaySandboxApiKey: string | undefined;
let originalMoonPaySandboxSecretKey: string | undefined;
let originalMoonPayApiKey: string | undefined;
let originalMoonPaySecretKey: string | undefined;
let originalMoonPayOnrampUrl: string | undefined;
let originalMoonPayOfframpUrl: string | undefined;
let originalLightsparkGridSandboxClientId: string | undefined;
let originalLightsparkGridSandboxClientSecret: string | undefined;
let originalLightsparkGridClientId: string | undefined;
let originalLightsparkGridClientSecret: string | undefined;
let originalBvnkSandboxHawkAuthId: string | undefined;
let originalBvnkSandboxHawkSecretKey: string | undefined;
let originalBvnkSandboxWalletId: string | undefined;
let originalBvnkHawkAuthId: string | undefined;
let originalBvnkHawkSecretKey: string | undefined;
let originalBvnkWalletId: string | undefined;
let originalBvnkApiBaseUrl: string | undefined;
let originalMagicBlockApiBaseUrl: string | undefined;
let originalMagicBlockAuthToken: string | undefined;

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

  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER.id, TEST_USER.email, 1, "active"),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_PROJECT.id,
        TEST_ORG.id,
        "Test Project",
        TEST_PROJECT.slug,
        "sandbox",
        "active",
        TEST_USER.id
      ),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        "Payments Test Key",
        TEST_API_KEY.prefix,
        keyHash,
        "api_admin",
        JSON.stringify(["*"]),
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_CONFIG_ID,
        TEST_ORG.id,
        null,
        "local",
        "test-config",
        "sdp-custody-encryption-v1",
        TEST_WALLET_ID,
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_scope_defaults
           (id, organization_id, project_id, default_custody_config_id)
         VALUES (?, ?, ?, ?)`
      )
      .bind(`csd_${TEST_CONFIG_ID}`, TEST_ORG.id, null, TEST_CONFIG_ID),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
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

function buildMagicBlockTestTransactionBase64(params?: {
  source?: string;
  destination?: string;
  additionalSigner?: string;
}): string {
  const source = address(params?.source ?? TEST_SOLANA_ADDRESSES.wallet1);
  const destination = address(params?.destination ?? TEST_SOLANA_ADDRESSES.wallet2);
  const instructions = [
    getTransferSolInstruction({
      source: createNoopSigner(source),
      destination,
      amount: 1n,
    }),
  ];

  if (params?.additionalSigner) {
    instructions.push(
      getTransferSolInstruction({
        source: createNoopSigner(address(params.additionalSigner)),
        destination: source,
        amount: 1n,
      })
    );
  }

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(source, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N" as Parameters<
            typeof setTransactionMessageLifetimeUsingBlockhash
          >[0]["blockhash"],
          lastValidBlockHeight: 1000n,
        },
        m
      ),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );

  return getBase64EncodedWireTransaction(compileTransaction(message));
}

async function updateSeededWalletPublicKey(publicKey: string): Promise<void> {
  await getDb(env)
    .prepare("UPDATE custody_wallets SET public_key = ? WHERE wallet_id = ?")
    .bind(publicKey, TEST_WALLET_ID)
    .run();
}

async function seedCachedKey(override: Partial<CachedApiKey>): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, {
    ...TEST_CACHED_API_KEY,
    ...override,
  });
}

async function seedWalletPolicy(params: {
  destinationAllowlist: string[];
  maxTransferAmount?: string;
  maxDailyAmount?: string;
}): Promise<void> {
  const now = new Date().toISOString();

  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO payment_wallet_policies
           (id, custody_wallet_id, policy_type, policy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
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
    getDb(env)
      .prepare(
        `INSERT INTO payment_wallet_policies
           (id, custody_wallet_id, policy_type, policy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
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
    vi.clearAllMocks();

    createRpcMock.mockReturnValue({} as ReturnType<typeof solanaRpc.createRpc>);
    getAccountInfoMock.mockResolvedValue({
      lamports: 4200000000n,
      owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    } as Awaited<ReturnType<typeof solanaRpc.getAccountInfo>>);
    getRecentBlockhashMock.mockResolvedValue({
      blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N" as Awaited<
        ReturnType<typeof solanaRpc.getRecentBlockhash>
      >["blockhash"],
      lastValidBlockHeight: 1000n,
    });
    confirmTransactionMock.mockResolvedValue({
      signature:
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Awaited<
          ReturnType<typeof solanaRpc.confirmTransaction>
        >["signature"],
      slot: 100n,
      confirmationStatus: "confirmed",
      err: null,
    });
    sendAndConfirmTransactionMock.mockResolvedValue({
      signature:
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Awaited<
          ReturnType<typeof solanaRpc.sendAndConfirmTransaction>
        >["signature"],
      slot: 100n,
      confirmationStatus: "confirmed",
      err: null,
    });
    getSignaturesForAddressMock.mockResolvedValue([]);
    getSplTokenBalancesMock.mockResolvedValue([]);
    getSplTokenAccountAddressesMock.mockResolvedValue([]);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
      signAsFeePayer: vi.fn(),
      signAndSend: vi
        .fn()
        .mockResolvedValue(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        ),
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    createOrgSignerMock.mockResolvedValue(
      createNoopSigner(address("8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ"))
    );

    originalMoonPaySandboxApiKey = env.MOONPAY_SANDBOX_API_KEY;
    originalMoonPaySandboxSecretKey = env.MOONPAY_SANDBOX_SECRET_KEY;
    originalMoonPayApiKey = env.MOONPAY_API_KEY;
    originalMoonPaySecretKey = env.MOONPAY_SECRET_KEY;
    originalMoonPayOnrampUrl = env.MOONPAY_ONRAMP_URL;
    originalMoonPayOfframpUrl = env.MOONPAY_OFFRAMP_URL;
    originalLightsparkGridSandboxClientId = env.LIGHTSPARK_GRID_SANDBOX_CLIENT_ID;
    originalLightsparkGridSandboxClientSecret = env.LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET;
    originalLightsparkGridClientId = env.LIGHTSPARK_GRID_CLIENT_ID;
    originalLightsparkGridClientSecret = env.LIGHTSPARK_GRID_CLIENT_SECRET;
    originalBvnkSandboxHawkAuthId = env.BVNK_SANDBOX_HAWK_AUTH_ID;
    originalBvnkSandboxHawkSecretKey = env.BVNK_SANDBOX_HAWK_SECRET_KEY;
    originalBvnkSandboxWalletId = env.BVNK_SANDBOX_WALLET_ID;
    originalBvnkHawkAuthId = env.BVNK_HAWK_AUTH_ID;
    originalBvnkHawkSecretKey = env.BVNK_HAWK_SECRET_KEY;
    originalBvnkWalletId = env.BVNK_WALLET_ID;
    originalBvnkApiBaseUrl = env.BVNK_API_BASE_URL;
    originalMagicBlockApiBaseUrl = env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL;
    originalMagicBlockAuthToken = env.MAGICBLOCK_PRIVATE_PAYMENTS_AUTH_TOKEN;

    env.MOONPAY_SANDBOX_API_KEY = TEST_MOONPAY_API_KEY;
    env.MOONPAY_SANDBOX_SECRET_KEY = TEST_MOONPAY_SECRET_KEY;
    env.MOONPAY_API_KEY = undefined;
    env.MOONPAY_SECRET_KEY = undefined;
    env.MOONPAY_ONRAMP_URL = TEST_MOONPAY_ONRAMP_URL;
    env.MOONPAY_OFFRAMP_URL = TEST_MOONPAY_OFFRAMP_URL;
    env.LIGHTSPARK_GRID_SANDBOX_CLIENT_ID = TEST_LIGHTSPARK_GRID_CLIENT_ID;
    env.LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET = TEST_LIGHTSPARK_GRID_CLIENT_SECRET;
    env.LIGHTSPARK_GRID_CLIENT_ID = undefined;
    env.LIGHTSPARK_GRID_CLIENT_SECRET = undefined;
    env.BVNK_SANDBOX_HAWK_AUTH_ID = TEST_BVNK_HAWK_AUTH_ID;
    env.BVNK_SANDBOX_HAWK_SECRET_KEY = TEST_BVNK_HAWK_SECRET_KEY;
    env.BVNK_SANDBOX_WALLET_ID = TEST_BVNK_WALLET_ID;
    env.BVNK_HAWK_AUTH_ID = undefined;
    env.BVNK_HAWK_SECRET_KEY = undefined;
    env.BVNK_WALLET_ID = undefined;
    env.BVNK_API_BASE_URL = TEST_BVNK_API_BASE_URL;
    env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = undefined;
    env.MAGICBLOCK_PRIVATE_PAYMENTS_AUTH_TOKEN = undefined;

    await seedTestDatabase(env);
    await seedAuthAndWallet();
  });

  afterEach(async () => {
    env.MOONPAY_SANDBOX_API_KEY = originalMoonPaySandboxApiKey;
    env.MOONPAY_SANDBOX_SECRET_KEY = originalMoonPaySandboxSecretKey;
    env.MOONPAY_API_KEY = originalMoonPayApiKey;
    env.MOONPAY_SECRET_KEY = originalMoonPaySecretKey;
    env.MOONPAY_ONRAMP_URL = originalMoonPayOnrampUrl;
    env.MOONPAY_OFFRAMP_URL = originalMoonPayOfframpUrl;
    env.LIGHTSPARK_GRID_SANDBOX_CLIENT_ID = originalLightsparkGridSandboxClientId;
    env.LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET = originalLightsparkGridSandboxClientSecret;
    env.LIGHTSPARK_GRID_CLIENT_ID = originalLightsparkGridClientId;
    env.LIGHTSPARK_GRID_CLIENT_SECRET = originalLightsparkGridClientSecret;
    env.BVNK_SANDBOX_HAWK_AUTH_ID = originalBvnkSandboxHawkAuthId;
    env.BVNK_SANDBOX_HAWK_SECRET_KEY = originalBvnkSandboxHawkSecretKey;
    env.BVNK_SANDBOX_WALLET_ID = originalBvnkSandboxWalletId;
    env.BVNK_HAWK_AUTH_ID = originalBvnkHawkAuthId;
    env.BVNK_HAWK_SECRET_KEY = originalBvnkHawkSecretKey;
    env.BVNK_WALLET_ID = originalBvnkWalletId;
    env.BVNK_API_BASE_URL = originalBvnkApiBaseUrl;
    env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = originalMagicBlockApiBaseUrl;
    env.MAGICBLOCK_PRIVATE_PAYMENTS_AUTH_TOKEN = originalMagicBlockAuthToken;

    await clearTestDatabase(env);
    await clearKVNamespaces(env);
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

  it("creates a signed MoonPay on-ramp session URL", async () => {
    const res = await app.request(
      "/v1/payments/ramps/onramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "1.1.1.1",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "moonpay",
          destinationWallet: TEST_WALLET_ID,
          cryptoToken: "USDC",
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
          provider: "moonpay",
          sourceWallet: TEST_WALLET_ID,
          cryptoToken: "USDC",
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
    expect(redirect.searchParams.get(MOONPAY_PARAM_REFUND_WALLET_ADDRESS)).toBe(
      TEST_SOLANA_ADDRESSES.wallet1
    );
    expect(redirect.searchParams.get("redirectURL")).toBe("https://example.com/offramp-done");
    expect(redirect.searchParams.get(MOONPAY_PARAM_EXTERNAL_CUSTOMER_ID)).toBe("kyc_ref_456");
    assertMoonPaySignature(redirect);
  });

  it("blocks MoonPay off-ramp when the wallet policy maxTransferAmount is exceeded", async () => {
    await seedWalletPolicy({
      destinationAllowlist: [],
      maxTransferAmount: "50.00",
    });

    const res = await app.request(
      "/v1/payments/ramps/offramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "moonpay",
          sourceWallet: TEST_WALLET_ID,
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          cryptoAmount: "75.25",
        }),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("does not apply outbound wallet policy checks to MoonPay on-ramp", async () => {
    await seedWalletPolicy({
      destinationAllowlist: [],
      maxTransferAmount: "10.00",
    });

    const res = await app.request(
      "/v1/payments/ramps/onramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "moonpay",
          destinationWallet: TEST_WALLET_ID,
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          fiatAmount: "25.00",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
  });

  it("checks wallet bindings when a custody wallet public key is used for MoonPay off-ramp", async () => {
    await seedCachedKey({
      walletBindings: [{ walletId: "wal_other_wallet", permissions: ["payments:write"] }],
    });

    const res = await app.request(
      "/v1/payments/ramps/offramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "moonpay",
          sourceWallet: TEST_SOLANA_ADDRESSES.wallet1,
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          cryptoAmount: "25.00",
        }),
      },
      env
    );

    expect(res.status).toBe(403);
  });

  it("returns bad request when MoonPay on-ramp amount is below the minimum", async () => {
    const res = await app.request(
      "/v1/payments/ramps/onramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "moonpay",
          destinationWallet: TEST_WALLET_ID,
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          fiatAmount: "10.00",
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("at least 20 USD");
  });

  it("creates a Lightspark on-ramp quote through the execute endpoint", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "ExternalAccount:acc_destination_123",
                accountInfo: {
                  accountType: "SOLANA_WALLET",
                  address: TEST_SOLANA_ADDRESSES.wallet1,
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
            id: "Quote:ls_onramp_123",
            quoteStatus: "PENDING",
            paymentInstructions: [
              {
                accountOrWalletInfo: {
                  accountType: "USD_ACCOUNT",
                  paymentRails: ["ACH"],
                  accountNumber: "1234567890",
                  routingNumber: "021000021",
                  reference: "ref_123",
                },
              },
            ],
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
          destinationWallet: TEST_WALLET_ID,
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          fiatAmount: "12.34",
          kycReference: "Customer:cus_123",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        ramp: {
          id: string;
          provider: string;
          status: string;
          paymentInstructions: Array<{
            provider: "lightspark";
            accountOrWalletInfo: { paymentRails: string[] };
          }>;
          reference: string;
        };
      };
    };

    expect(body.data.ramp.id.startsWith("ramp_")).toBe(true);
    expect(body.data.ramp.provider).toBe("lightspark");
    expect(body.data.ramp.status).toBe("pending");
    expect(body.data.ramp.reference).toBe("Quote:ls_onramp_123");
    expect(body.data.ramp.paymentInstructions[0]?.provider).toBe("lightspark");
    expect(body.data.ramp.paymentInstructions[0]?.accountOrWalletInfo.paymentRails[0]).toBe("ACH");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const requestUrl = fetchSpy.mock.calls[1]?.[0];
    const requestInit = fetchSpy.mock.calls[1]?.[1];
    expect(String(requestUrl)).toBe(`${LIGHTSPARK_GRID_API_BASE_URL}/quotes`);
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
    expect(payload.destination.currency).toBe("USDC");
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

  it("resolves SDP wallet ids for Lightspark on-ramp destinations", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "ExternalAccount:acc_wallet_123",
                accountInfo: {
                  accountType: "SOLANA_WALLET",
                  address: TEST_SOLANA_ADDRESSES.wallet1,
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
            id: "Quote:ls_onramp_wallet_123",
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
          destinationWallet: TEST_WALLET_ID,
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
    expect(body.data.ramp.reference).toBe("Quote:ls_onramp_wallet_123");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const quotePayload = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)) as {
      destination: { accountId: string };
    };
    expect(quotePayload.destination.accountId).toBe("ExternalAccount:acc_wallet_123");
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
    expect(createUrl).toBe(`${LIGHTSPARK_GRID_API_BASE_URL}/customers/external-accounts`);
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
    expect(quoteCallUrl).toBe(`${LIGHTSPARK_GRID_API_BASE_URL}/quotes`);
    expect(executeCallUrl).toBe(
      `${LIGHTSPARK_GRID_API_BASE_URL}/quotes/Quote%3Als_offramp_123/execute`
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
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          fiatAmount: "120.50",
          kycReference: "customer_123",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        ramp: {
          id: string;
          provider: string;
          status: string;
          redirectUrl: string;
          reference: string;
        };
      };
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
    expect(headers.Authorization).toMatch(/^Hawk /);

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
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          cryptoAmount: "75.25",
          kycReference: "customer_456",
          bvnkCompliance: {
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
    expect(acceptUrl).toBe(
      `${TEST_BVNK_API_BASE_URL}/api/v1/pay/estimate/estimate_bvnk_123/accept`
    );
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
    expect(estimatePayload.complianceDetails.requesterIpAddress).toBeUndefined();
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
    expect(acceptPayload.complianceDetails.requesterIpAddress).toBeUndefined();
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
          "x-forwarded-for": "1.1.1.1",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "bvnk",
          sourceWallet: TEST_WALLET_ID,
          cryptoToken: "USDC",
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
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          fiatAmount: "10.00",
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Invalid request body");
  });

  it("returns bad request when on-ramp amount is zero", async () => {
    const res = await app.request(
      "/v1/payments/ramps/onramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "moonpay",
          destinationWallet: TEST_WALLET_ID,
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          fiatAmount: "0",
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: { errors?: Record<string, string[]> } };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Invalid request body");
    expect(body.error.details?.errors?.fiatAmount).toContain("Amount must be greater than zero");
  });

  it("returns forbidden when MoonPay is not configured in the environment", async () => {
    env.MOONPAY_SANDBOX_API_KEY = undefined;

    const res = await app.request(
      "/v1/payments/ramps/onramp/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "moonpay",
          destinationWallet: TEST_WALLET_ID,
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          fiatAmount: "20",
        }),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("MoonPay is not configured");
  });

  it("returns forbidden when Lightspark is not configured in the environment", async () => {
    env.LIGHTSPARK_GRID_SANDBOX_CLIENT_ID = undefined;

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

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("Lightspark is not configured");
  });

  it("returns forbidden when BVNK is not configured in the environment", async () => {
    env.BVNK_SANDBOX_HAWK_AUTH_ID = undefined;
    env.BVNK_SANDBOX_HAWK_SECRET_KEY = undefined;

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
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          fiatAmount: "10",
          kycReference: "customer_123",
        }),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
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

    const transfers = await getDb(env).prepare("SELECT id FROM payment_transfers").all<{
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

    const transfers = await getDb(env).prepare("SELECT id FROM payment_transfers").all<{
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
        "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"
      );

      const row = await getDb(env)
        .prepare("SELECT status, serialized_tx FROM payment_transfers WHERE id = ?")
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

    it("prepares a MagicBlock private SPL transfer that settles to base balance", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      env.MAGICBLOCK_PRIVATE_PAYMENTS_AUTH_TOKEN = TEST_MAGICBLOCK_AUTH_TOKEN;
      createRpcMock.mockReturnValueOnce({
        getTokenSupply: () => ({
          send: async () => ({ value: { decimals: 6 } }),
        }),
      } as unknown as ReturnType<typeof solanaRpc.createRpc>);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "transfer",
            version: "v0",
            transactionBase64: "AQID",
            sendTo: "base",
            recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
            lastValidBlockHeight: 123456,
            instructionCount: 4,
            requiredSigners: [TEST_SOLANA_ADDRESSES.wallet1],
            validator: TEST_SOLANA_ADDRESSES.wallet3,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );

      try {
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
              token: DEVNET_USDC_MINT,
              amount: "1.25",
              memo: "Invoice #1042",
              privateTransfer: {
                provider: "magicblock",
                magicBlock: {
                  initIfMissing: true,
                  initAtasIfMissing: true,
                  minDelayMs: "0",
                  maxDelayMs: "1000",
                  split: 2,
                },
              },
            }),
          },
          env
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          data: {
            transfer: { id: string; status: string; type: string };
            preparedTransaction: {
              serialized: string;
              blockhash: string;
              lastValidBlockHeight: string;
            };
            privateTransfer: {
              provider: string;
              magicBlock: {
                kind: string;
                version: string;
                instructionCount: number;
                requiredSigners: string[];
                validator?: string;
              };
            };
          };
        };

        expect(body.data.transfer.status).toBe("pending");
        expect(body.data.transfer.type).toBe("transfer_confidential");
        expect(body.data.preparedTransaction).toMatchObject({
          serialized: "AQID",
          blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
          lastValidBlockHeight: "123456",
        });
        expect(body.data.privateTransfer).toMatchObject({
          provider: "magicblock",
          magicBlock: {
            kind: "transfer",
            version: "v0",
            instructionCount: 4,
            requiredSigners: [TEST_SOLANA_ADDRESSES.wallet1],
            validator: TEST_SOLANA_ADDRESSES.wallet3,
          },
        });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0] ?? [];
        expect(String(url)).toBe(`${TEST_MAGICBLOCK_API_BASE_URL}/v1/spl/transfer`);
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          `Bearer ${TEST_MAGICBLOCK_AUTH_TOKEN}`
        );
        const providerPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(providerPayload).toMatchObject({
          from: TEST_SOLANA_ADDRESSES.wallet1,
          to: TEST_SOLANA_ADDRESSES.wallet2,
          cluster: "devnet",
          mint: DEVNET_USDC_MINT,
          amount: 1_250_000,
          visibility: "private",
          fromBalance: "base",
          toBalance: "base",
          memo: "Invoice #1042",
          initIfMissing: true,
          initAtasIfMissing: true,
          minDelayMs: "0",
          maxDelayMs: "1000",
          split: 2,
        });

        const row = await getDb(env)
          .prepare("SELECT status, type, serialized_tx FROM payment_transfers WHERE id = ?")
          .bind(body.data.transfer.id)
          .first<{ status: string; type: string; serialized_tx: string | null }>();
        expect(row).toMatchObject({
          status: "pending",
          type: "transfer_confidential",
          serialized_tx: "AQID",
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("rejects unsupported MagicBlock balance routing options", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      try {
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
              token: DEVNET_USDC_MINT,
              amount: "1",
              privateTransfer: {
                provider: "magicblock",
                magicBlock: {
                  sourceBalance: "base",
                  settlement: "shielded",
                },
              },
            }),
          },
          env
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("BAD_REQUEST");
        expect(body.error.message).toBe("Invalid request body");
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("rejects simulated MagicBlock private transfers before calling the provider", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      try {
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
              token: DEVNET_USDC_MINT,
              amount: "1",
              options: { simulate: true },
              privateTransfer: {
                provider: "magicblock",
                magicBlock: {},
              },
            }),
          },
          env
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("BAD_REQUEST");
        expect(body.error.message).toContain("Simulation is not supported");
        expect(fetchSpy).not.toHaveBeenCalled();

        const transfers = await getDb(env).prepare("SELECT id FROM payment_transfers").all<{
          id: string;
        }>();
        expect(transfers.results).toHaveLength(0);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("executes a MagicBlock private transfer that settles to base balance", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      createRpcMock.mockReturnValueOnce({
        getTokenSupply: () => ({
          send: async () => ({ value: { decimals: 6 } }),
        }),
      } as unknown as ReturnType<typeof solanaRpc.createRpc>);
      createOrgSignerMock.mockResolvedValueOnce(sourceSigner);
      const signAndSendMock = vi
        .fn()
        .mockResolvedValue(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        );
      createFeePaymentAdapterMock.mockReturnValueOnce({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "transfer",
            version: "v0",
            transactionBase64: buildMagicBlockTestTransactionBase64({
              source: sourceSigner.address,
            }),
            sendTo: "base",
            recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
            lastValidBlockHeight: 123456,
            instructionCount: 3,
            requiredSigners: [sourceSigner.address, sourceSigner.address],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );

      try {
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
              token: DEVNET_USDC_MINT,
              amount: "1",
              privateTransfer: {
                provider: "magicblock",
                magicBlock: {
                  split: 2,
                  minDelayMs: "0",
                  maxDelayMs: "1000",
                },
              },
            }),
          },
          env
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          data: {
            transfer: { status: string; signature: string | null; type: string };
            privateTransfer: { magicBlock: { kind: string; version: string } };
          };
        };
        expect(body.data.transfer).toMatchObject({
          status: "confirmed",
          signature:
            "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy",
          type: "transfer_confidential",
        });
        expect(body.data.privateTransfer.magicBlock).toMatchObject({
          kind: "transfer",
          version: "v0",
        });
        expect(signAndSendMock).toHaveBeenCalledTimes(1);
        expect(sendAndConfirmTransactionMock).not.toHaveBeenCalled();
        const [, init] = fetchSpy.mock.calls[0] ?? [];
        const providerPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(providerPayload).toMatchObject({
          from: sourceSigner.address,
          visibility: "private",
          fromBalance: "base",
          toBalance: "base",
          split: 2,
          minDelayMs: "0",
          maxDelayMs: "1000",
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("rejects MagicBlock execution responses routed outside base balance", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      createRpcMock.mockReturnValueOnce({
        getTokenSupply: () => ({
          send: async () => ({ value: { decimals: 6 } }),
        }),
      } as unknown as ReturnType<typeof solanaRpc.createRpc>);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "transfer",
            version: "v0",
            transactionBase64: buildMagicBlockTestTransactionBase64({
              source: sourceSigner.address,
            }),
            sendTo: "ephemeral",
            recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
            lastValidBlockHeight: 123456,
            instructionCount: 3,
            requiredSigners: [sourceSigner.address],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );

      try {
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
              token: DEVNET_USDC_MINT,
              amount: "1",
              privateTransfer: {
                provider: "magicblock",
                magicBlock: {},
              },
            }),
          },
          env
        );

        expect(res.status).toBe(503);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("PROVIDER_UNAVAILABLE");
        expect(body.error.message).toBe(
          "MagicBlock returned a non-base submission target, which this SDP route does not support."
        );
        const [, init] = fetchSpy.mock.calls[0] ?? [];
        const providerPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(providerPayload).toMatchObject({
          from: sourceSigner.address,
          to: TEST_SOLANA_ADDRESSES.wallet2,
          visibility: "private",
          fromBalance: "base",
          toBalance: "base",
        });
      } finally {
        fetchSpy.mockRestore();
      }
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

      const transfers = await getDb(env).prepare("SELECT id FROM payment_transfers").all<{
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

      const transfers = await getDb(env).prepare("SELECT id FROM payment_transfers").all<{
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
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers
           (id, organization_id, project_id, wallet_id, source_address, destination_address, token, amount, memo, type, direction, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "xfr_existing_daily_limit",
        TEST_ORG.id,
        TEST_PROJECT.id,
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

    const transfers = await getDb(env)
      .prepare("SELECT id FROM payment_transfers ORDER BY id ASC")
      .all<{
        id: string;
      }>();
    expect(transfers.results).toHaveLength(1);
    expect(transfers.results[0]?.id).toBe("xfr_existing_daily_limit");
  });

  it("blocks create transfer with zero amount before creating a transfer record", async () => {
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
          amount: "0",
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: { errors?: Record<string, string[]> } };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Invalid request body");
    expect(body.error.details?.errors?.amount).toContain("Amount must be greater than zero");

    const transfers = await getDb(env).prepare("SELECT id FROM payment_transfers").all<{
      id: string;
    }>();
    expect(transfers.results).toHaveLength(0);
  });

  async function seedTransfer(params: {
    id: string;
    status: string;
    signature?: string | null;
    walletId?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers
           (id, organization_id, project_id, wallet_id, source_address, destination_address, token, amount, memo, type, direction, status, signature, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        params.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
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

      const row = await getDb(env)
        .prepare("SELECT status, signature FROM payment_transfers WHERE id = ?")
        .bind(body.data.transfer.id)
        .first<{ status: string; signature: string | null }>();
      expect(row?.status).toBe("confirmed");
      expect(row?.signature).toBeTruthy();
    });

    it("marks the transfer as failed when execution throws and returns 502", async () => {
      createFeePaymentAdapterMock.mockReturnValueOnce({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        signAsFeePayer: vi.fn(),
        signAndSend: vi.fn().mockRejectedValue(new Error("RPC connection refused")),
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

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

      const transfers = await getDb(env)
        .prepare("SELECT status, error FROM payment_transfers")
        .all<{
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
      const confirmedSig =
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy";

      await seedTransfer({ id: "xfr_confirmed_1", status: "confirmed", signature: confirmedSig });
      await seedTransfer({ id: "xfr_pending_1", status: "pending" });

      getSignaturesForAddressMock.mockResolvedValueOnce([
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

    it("surfaces observed inbound transfers for wallet history even without a DB record", async () => {
      const observedSig =
        "3o9XWnJ7CyD6be8xXh8hFXRrM9rPzGQhE1mQ4Z8VjYkU7LZtP4R3WnV5uA2sD1fG6hJ7kL8mN9pQ1rS2tU3v";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              blockTime: 1700000100,
              slot: 101,
              meta: {
                err: null,
                fee: 5000,
                preTokenBalances: [
                  {
                    accountIndex: 0,
                    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                    owner: TEST_SOLANA_ADDRESSES.wallet2,
                    uiTokenAmount: {
                      amount: "10000000",
                      decimals: 6,
                      uiAmountString: "10",
                    },
                  },
                  {
                    accountIndex: 1,
                    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                    owner: TEST_SOLANA_ADDRESSES.wallet1,
                    uiTokenAmount: {
                      amount: "0",
                      decimals: 6,
                      uiAmountString: "0",
                    },
                  },
                ],
                postTokenBalances: [
                  {
                    accountIndex: 0,
                    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                    owner: TEST_SOLANA_ADDRESSES.wallet2,
                    uiTokenAmount: {
                      amount: "0",
                      decimals: 6,
                      uiAmountString: "0",
                    },
                  },
                  {
                    accountIndex: 1,
                    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                    owner: TEST_SOLANA_ADDRESSES.wallet1,
                    uiTokenAmount: {
                      amount: "10000000",
                      decimals: 6,
                      uiAmountString: "10",
                    },
                  },
                ],
              },
              transaction: {
                message: {
                  accountKeys: [
                    "SrcTokenAcct111111111111111111111111111111",
                    "DstTokenAcct111111111111111111111111111111",
                  ],
                  instructions: [
                    {
                      program: "spl-token",
                      parsed: {
                        type: "transferChecked",
                        info: {
                          source: "SrcTokenAcct111111111111111111111111111111",
                          destination: "DstTokenAcct111111111111111111111111111111",
                          mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                          tokenAmount: {
                            amount: "10000000",
                            decimals: 6,
                            uiAmountString: "10",
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      );

      getSignaturesForAddressMock.mockResolvedValueOnce([
        {
          signature: observedSig as unknown as Signature,
          slot: 101n,
          blockTime: 1700000100n,
          err: null,
        },
      ]);

      try {
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
          data: Array<{
            id: string;
            amount: string;
            direction: string;
            signature: string | null;
            status: string;
            token: string;
          }>;
          meta: { total: number };
        };
        expect(body.meta.total).toBe(1);
        expect(body.data).toHaveLength(1);
        expect(body.data[0]).toMatchObject({
          amount: "10",
          direction: "inbound",
          signature: observedSig,
          status: "confirmed",
          token: "USDC",
        });
        expect(body.data[0]?.id).toMatch(/^xfr_observed_/);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("discovers observed custom token deposits from owned token account history", async () => {
      const observedSig =
        "5o9XWnJ7CyD6be8xXh8hFXRrM9rPzGQhE1mQ4Z8VjYkU7LZtP4R3WnV5uA2sD1fG6hJ7kL8mN9pQ1rS2tU3w";
      const customMint = "CustomMint1111111111111111111111111111111";
      const destinationTokenAccount = "DstTokenAcct111111111111111111111111111111";
      const sourceTokenAccount = "SrcTokenAcct111111111111111111111111111111";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              blockTime: 1700000200,
              slot: 102,
              meta: {
                err: null,
                fee: 5000,
                preTokenBalances: [
                  {
                    accountIndex: 0,
                    mint: customMint,
                    owner: TEST_SOLANA_ADDRESSES.wallet2,
                    uiTokenAmount: {
                      amount: "25000000",
                      decimals: 6,
                      uiAmountString: "25",
                    },
                  },
                  {
                    accountIndex: 1,
                    mint: customMint,
                    owner: TEST_SOLANA_ADDRESSES.wallet1,
                    uiTokenAmount: {
                      amount: "0",
                      decimals: 6,
                      uiAmountString: "0",
                    },
                  },
                ],
                postTokenBalances: [
                  {
                    accountIndex: 0,
                    mint: customMint,
                    owner: TEST_SOLANA_ADDRESSES.wallet2,
                    uiTokenAmount: {
                      amount: "0",
                      decimals: 6,
                      uiAmountString: "0",
                    },
                  },
                  {
                    accountIndex: 1,
                    mint: customMint,
                    owner: TEST_SOLANA_ADDRESSES.wallet1,
                    uiTokenAmount: {
                      amount: "25000000",
                      decimals: 6,
                      uiAmountString: "25",
                    },
                  },
                ],
              },
              transaction: {
                message: {
                  accountKeys: [sourceTokenAccount, destinationTokenAccount],
                  instructions: [
                    {
                      program: "spl-token",
                      parsed: {
                        type: "transferChecked",
                        info: {
                          source: sourceTokenAccount,
                          destination: destinationTokenAccount,
                          mint: customMint,
                          tokenAmount: {
                            amount: "25000000",
                            decimals: 6,
                            uiAmountString: "25",
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      );

      getSplTokenAccountAddressesMock.mockResolvedValueOnce([
        destinationTokenAccount as unknown as Address,
      ]);
      getSignaturesForAddressMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          signature: observedSig as unknown as Signature,
          slot: 102n,
          blockTime: 1700000200n,
          err: null,
        },
      ]);

      try {
        const res = await app.request(
          `/v1/payments/transfers?wallet=${TEST_WALLET_ID}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
          },
          env
        );

        expect(res.status).toBe(200);
        expect(getSignaturesForAddressMock).toHaveBeenNthCalledWith(
          1,
          expect.anything(),
          TEST_SOLANA_ADDRESSES.wallet1,
          expect.objectContaining({ commitment: "confirmed" })
        );
        expect(getSignaturesForAddressMock).toHaveBeenNthCalledWith(
          2,
          expect.anything(),
          destinationTokenAccount,
          expect.objectContaining({ commitment: "confirmed" })
        );

        const body = (await res.json()) as {
          data: Array<{
            amount: string;
            direction: string;
            signature: string | null;
            status: string;
            token: string;
          }>;
          meta: { total: number };
        };
        expect(body.meta.total).toBe(1);
        expect(body.data).toHaveLength(1);
        expect(body.data[0]).toMatchObject({
          amount: "25",
          direction: "inbound",
          signature: observedSig,
          status: "confirmed",
          token: customMint,
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("surfaces observed token mints into owned token accounts", async () => {
      const observedSig =
        "4o9XWnJ7CyD6be8xXh8hFXRrM9rPzGQhE1mQ4Z8VjYkU7LZtP4R3WnV5uA2sD1fG6hJ7kL8mN9pQ1rS2tU3m";
      const customMint = "MintedToken111111111111111111111111111111";
      const destinationTokenAccount = "MintDstTokenAcct11111111111111111111111111";
      const mintAuthority = "MintAuthority11111111111111111111111111111";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              blockTime: 1700000300,
              slot: 103,
              meta: {
                err: null,
                fee: 5000,
                preTokenBalances: [],
                postTokenBalances: [
                  {
                    accountIndex: 2,
                    mint: customMint,
                    owner: TEST_SOLANA_ADDRESSES.wallet1,
                    uiTokenAmount: {
                      amount: "500000000",
                      decimals: 6,
                      uiAmountString: "500",
                    },
                  },
                ],
              },
              transaction: {
                message: {
                  accountKeys: [mintAuthority, customMint, destinationTokenAccount],
                  instructions: [
                    {
                      program: "spl-token",
                      parsed: {
                        type: "mintTo",
                        info: {
                          account: destinationTokenAccount,
                          amount: "500000000",
                          mint: customMint,
                          mintAuthority,
                        },
                      },
                    },
                  ],
                },
              },
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      );

      getSplTokenAccountAddressesMock.mockResolvedValueOnce([
        destinationTokenAccount as unknown as Address,
      ]);
      getSignaturesForAddressMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          signature: observedSig as unknown as Signature,
          slot: 103n,
          blockTime: 1700000300n,
          err: null,
        },
      ]);

      try {
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
          data: Array<{
            amount: string;
            destination: string;
            direction: string;
            signature: string | null;
            source: string;
            status: string;
            token: string;
          }>;
          meta: { total: number };
        };
        expect(body.meta.total).toBe(1);
        expect(body.data).toHaveLength(1);
        expect(body.data[0]).toMatchObject({
          amount: "500",
          destination: TEST_SOLANA_ADDRESSES.wallet1,
          direction: "inbound",
          signature: observedSig,
          source: mintAuthority,
          status: "confirmed",
          token: customMint,
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("returns all transfers via DB-only path when no wallet filter is provided", async () => {
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
      expect(getSignaturesForAddressMock).not.toHaveBeenCalled();
    });

    it("filters by status when status query param is provided", async () => {
      await seedTransfer({ id: "xfr_status_confirmed", status: "confirmed" });
      await seedTransfer({ id: "xfr_status_pending", status: "pending" });

      const res = await app.request(
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

    it("returns bad request for invalid transfer status query param", async () => {
      const res = await app.request(
        "/v1/payments/transfers?status=settled",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; message: string; details?: { errors?: Record<string, string[]> } };
      };
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toContain("Invalid query parameters");
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
