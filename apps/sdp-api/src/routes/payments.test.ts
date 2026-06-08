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
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import * as subscriptionsSdk from "@solana/subscriptions";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import * as repositories from "@/db/repositories";
import app from "@/index";
import { hashString } from "@/lib/hash";
import * as tokenAccounts from "@/routes/payments/token-accounts";
import { createKVStoreSet } from "@/runtime/factory";
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
const fetchMaybePlanMock = vi.spyOn(subscriptionsSdk, "fetchMaybePlan");
const fetchMaybeSubscriptionAuthorityMock = vi.spyOn(
  subscriptionsSdk,
  "fetchMaybeSubscriptionAuthority"
);
const fetchMaybeSubscriptionDelegationMock = vi.spyOn(
  subscriptionsSdk,
  "fetchMaybeSubscriptionDelegation"
);

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
const TEST_MAGICBLOCK_SPONSOR_FEE_PAYER = "CrankS2fXgMGvQJ3VBrZmRfGrfogDY6pq5YcgkPEpSNf";
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MOCK_SIGNATURE_TAIL =
  "hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy";
const MOCK_SIGNATURE_PREFIXES = "456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
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
let originalRecurringPaymentsEnabled: string | undefined;

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
  feePayer?: string;
  source?: string;
  destination?: string;
  additionalSigner?: string;
}): string {
  const feePayer = address(params?.feePayer ?? params?.source ?? TEST_SOLANA_ADDRESSES.wallet1);
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
    (m) => setTransactionMessageFeePayer(feePayer, m),
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

async function clearRateLimits(): Promise<void> {
  const rateLimits = createKVStoreSet(env).rateLimits;
  const keys = await rateLimits.list();
  for (const key of keys.keys) {
    await rateLimits.delete(key.name);
  }
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

async function seedCounterparty(params?: {
  id?: string;
  externalId?: string | null;
  identity?: Record<string, unknown>;
}): Promise<string> {
  const id = params?.id ?? `counterparty_${crypto.randomUUID()}`;
  await getDb(env)
    .prepare(
      `INSERT INTO counterparties (
         id,
         organization_id,
         project_id,
         external_id,
         entity_type,
         display_name,
         email,
         identity,
         provider_data,
         status,
         created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
    )
    .bind(
      id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      params?.externalId ?? null,
      "individual",
      "MoonPay Test Counterparty",
      "moonpay-counterparty@example.com",
      params?.identity ?? {},
      {},
      TEST_USER.id
    )
    .run();

  return id;
}

function mockTokenSupplyDecimalsOnce(decimals = 6): void {
  createRpcMock.mockReturnValueOnce({
    getTokenSupply: () => ({
      send: async () => ({ value: { decimals } }),
    }),
  } as unknown as ReturnType<typeof solanaRpc.createRpc>);
}

function mockRecurringTokenRpc(decimals = 6): void {
  createRpcMock.mockReturnValue({
    getBlockTime: () => ({
      send: async () => 1_700_000_000n,
    }),
    getTokenAccountsByOwner: () => ({
      send: async () => ({
        value: [
          {
            pubkey: TEST_SOLANA_ADDRESSES.wallet3,
            account: {
              data: {
                parsed: {
                  info: {
                    mint: DEVNET_USDC_MINT,
                    tokenAmount: {
                      amount: "1000000000",
                      decimals,
                      uiAmountString: "1000",
                    },
                  },
                },
              },
            },
          },
        ],
      }),
    }),
    getTokenSupply: () => ({
      send: async () => ({ value: { decimals } }),
    }),
  } as unknown as ReturnType<typeof solanaRpc.createRpc>);
}

function mockRecurringActivationAccounts(): void {
  fetchMaybePlanMock
    .mockResolvedValueOnce({
      exists: false,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    } as Awaited<ReturnType<typeof subscriptionsSdk.fetchMaybePlan>>)
    .mockResolvedValueOnce({
      exists: true,
      address: TEST_SOLANA_ADDRESSES.wallet2,
      data: {
        status: subscriptionsSdk.PlanStatus.Active,
        data: { terms: { createdAt: 1_700_000_000n } },
      },
    } as Awaited<ReturnType<typeof subscriptionsSdk.fetchMaybePlan>>);
  fetchMaybeSubscriptionAuthorityMock.mockResolvedValueOnce({
    exists: false,
    address: TEST_SOLANA_ADDRESSES.wallet2,
  } as Awaited<ReturnType<typeof subscriptionsSdk.fetchMaybeSubscriptionAuthority>>);
  fetchMaybeSubscriptionDelegationMock
    .mockResolvedValueOnce({
      exists: false,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    } as Awaited<ReturnType<typeof subscriptionsSdk.fetchMaybeSubscriptionDelegation>>)
    .mockResolvedValueOnce({
      exists: true,
      address: TEST_SOLANA_ADDRESSES.wallet2,
      data: {
        terms: { amount: 500000n, periodHours: 24n, createdAt: 1_700_000_000n },
        amountPulledInPeriod: 0n,
        currentPeriodStartTs: 1_700_000_000n,
        expiresAtTs: 0n,
      },
    } as Awaited<ReturnType<typeof subscriptionsSdk.fetchMaybeSubscriptionDelegation>>);
}

function mockRecurringCollectionAccounts(): void {
  fetchMaybePlanMock.mockResolvedValueOnce({
    exists: true,
    address: TEST_SOLANA_ADDRESSES.wallet2,
    data: {
      status: subscriptionsSdk.PlanStatus.Active,
      data: { terms: { createdAt: 1_700_000_000n } },
    },
  } as Awaited<ReturnType<typeof subscriptionsSdk.fetchMaybePlan>>);
  const activeDelegation = {
    exists: true,
    address: TEST_SOLANA_ADDRESSES.wallet2,
    data: {
      header: {
        discriminator: subscriptionsSdk.AccountDiscriminator.SubscriptionDelegation,
        version: 1,
        bump: 255,
        delegator: TEST_SOLANA_ADDRESSES.wallet1,
        delegatee: TEST_SOLANA_ADDRESSES.wallet2,
        payer: TEST_SOLANA_ADDRESSES.wallet1,
        initId: 0n,
      },
      terms: { amount: 500000n, periodHours: 24n, createdAt: 1_700_000_000n },
      amountPulledInPeriod: 0n,
      currentPeriodStartTs: 1_700_000_000n,
      expiresAtTs: 0n,
    },
  } as Awaited<ReturnType<typeof subscriptionsSdk.fetchMaybeSubscriptionDelegation>>;
  fetchMaybeSubscriptionDelegationMock
    .mockResolvedValueOnce(activeDelegation)
    .mockResolvedValueOnce(activeDelegation);
}

function mockRecurringLifecycleSubscriptionState(input: {
  planPda: string;
  subscriptionPda: string;
  expiresAtTs: bigint;
  times?: number;
}): void {
  for (let index = 0; index < (input.times ?? 1); index += 1) {
    fetchMaybeSubscriptionDelegationMock.mockResolvedValueOnce({
      exists: true,
      address: address(input.subscriptionPda),
      data: {
        header: {
          discriminator: subscriptionsSdk.AccountDiscriminator.SubscriptionDelegation,
          version: 1,
          bump: 255,
          delegator: TEST_SOLANA_ADDRESSES.wallet1,
          delegatee: address(input.planPda),
          payer: TEST_SOLANA_ADDRESSES.wallet1,
          initId: 0n,
        },
        terms: { amount: 500000n, periodHours: 24n, createdAt: 1_700_000_000n },
        amountPulledInPeriod: 0n,
        currentPeriodStartTs: 1_700_000_000n,
        expiresAtTs: input.expiresAtTs,
      },
    } as Awaited<ReturnType<typeof subscriptionsSdk.fetchMaybeSubscriptionDelegation>>);
  }
}

function expectPreparedSubscriptionTransaction(
  preparedTransaction: {
    serialized: string;
    blockhash: string;
    lastValidBlockHeight: string;
    requiredSigners: string[];
  },
  expectedSigners: string[]
): void {
  expect(preparedTransaction.serialized).toBeTruthy();
  expect(preparedTransaction.blockhash).toBe("EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N");
  expect(preparedTransaction.lastValidBlockHeight).toBe("1000");
  for (const signer of expectedSigners) {
    expect(preparedTransaction.requiredSigners).toContain(signer);
  }

  const transaction = getTransactionDecoder().decode(
    Buffer.from(preparedTransaction.serialized, "base64")
  );
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);

  expect(message.staticAccounts.length).toBeGreaterThan(0);
  for (const signer of expectedSigners) {
    expect(Object.keys(transaction.signatures)).toContain(signer);
  }
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
    let feePaymentSignatureIndex = 0;
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
      signAsFeePayer: vi.fn(),
      signAndSend: vi.fn(async () => {
        const prefix =
          MOCK_SIGNATURE_PREFIXES[feePaymentSignatureIndex % MOCK_SIGNATURE_PREFIXES.length] ?? "4";
        feePaymentSignatureIndex += 1;
        return `${prefix}${MOCK_SIGNATURE_TAIL}` as Signature;
      }),
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
    originalRecurringPaymentsEnabled = env.PAYMENTS_RECURRING_ENABLED;

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
    env.PAYMENTS_RECURRING_ENABLED = undefined;

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
    env.PAYMENTS_RECURRING_ENABLED = originalRecurringPaymentsEnabled;

    await clearTestDatabase(env);
    await clearKVNamespaces(env);
  });

  it("gates recurring subscription endpoints behind PAYMENTS_RECURRING_ENABLED", async () => {
    const res = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ownerWalletId: TEST_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "10.00",
          periodHours: 24,
        }),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Recurring payments are not enabled");
  });

  it("does not apply today's daily wallet-policy usage to recurring payment setup", async () => {
    env.PAYMENTS_RECURRING_ENABLED = "true";
    await seedWalletPolicy({
      destinationAllowlist: [],
      maxDailyAmount: "1.0",
    });
    const counterpartyId = await seedCounterparty({ id: "cp_recurring_daily_setup" });
    const account = await repositories
      .createCounterpartyAccountsRepository(env)
      .createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        counterpartyId,
        accountKind: "crypto_wallet",
        label: "Recipient wallet",
        details: {
          network: "solana",
          address: TEST_SOLANA_ADDRESSES.wallet2,
        },
      });
    expect(account).not.toBeNull();
    const counterpartyAccountId = account?.id ?? "";
    expect(counterpartyAccountId).toBeTruthy();

    const now = new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers
           (id, organization_id, project_id, wallet_id, source_address, destination_address, token, amount, memo, type, direction, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "xfr_existing_recurring_daily_limit",
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        TEST_SOLANA_ADDRESSES.wallet1,
        TEST_SOLANA_ADDRESSES.wallet2,
        DEVNET_USDC_MINT,
        "0.90",
        null,
        "transfer",
        "outbound",
        "confirmed",
        now,
        now
      )
      .run();

    const res = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "0.50",
          periodHours: 24,
        }),
      },
      env
    );

    expect(res.status).toBe(201);
  });

  it("executes the outbound recurring payment backend flow through SDP API routes", async () => {
    env.PAYMENTS_RECURRING_ENABLED = "true";
    mockRecurringTokenRpc();
    mockRecurringActivationAccounts();
    const authHeaders = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
    };
    const jsonHeaders = {
      ...authHeaders,
      "Content-Type": "application/json",
    };
    const counterpartyRes = await app.request(
      "/v1/counterparties",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          externalId: "recurring_payment_counterparty_001",
          entityType: "individual",
          displayName: "Recurring Payment Counterparty",
          email: "recurring-payment-counterparty@example.com",
        }),
      },
      env
    );
    expect(counterpartyRes.status).toBe(201);
    const counterpartyBody = (await counterpartyRes.json()) as {
      data: { counterparty: { id: string } };
    };
    const counterpartyId = counterpartyBody.data.counterparty.id;

    const accountRes = await app.request(
      `/v1/counterparties/${counterpartyId}/accounts`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          accountKind: "crypto_wallet",
          label: "Recipient wallet",
          details: {
            network: "solana",
            address: TEST_SOLANA_ADDRESSES.wallet2,
          },
        }),
      },
      env
    );
    expect(accountRes.status).toBe(201);
    const accountBody = (await accountRes.json()) as {
      data: { account: { id: string; accountKind: string } };
    };
    expect(accountBody.data.account.accountKind).toBe("crypto_wallet");
    const counterpartyAccountId = accountBody.data.account.id;

    const archivedAccountRes = await app.request(
      `/v1/counterparties/${counterpartyId}/accounts`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          accountKind: "crypto_wallet",
          label: "Archived recipient wallet",
          details: {
            network: "solana",
            address: TEST_SOLANA_ADDRESSES.wallet3,
          },
        }),
      },
      env
    );
    expect(archivedAccountRes.status).toBe(201);
    const archivedAccountBody = (await archivedAccountRes.json()) as {
      data: { account: { id: string } };
    };
    const archivedCounterpartyAccountId = archivedAccountBody.data.account.id;
    const deleteArchivedAccountRes = await app.request(
      `/v1/counterparties/${counterpartyId}/accounts/${archivedCounterpartyAccountId}`,
      {
        method: "DELETE",
        headers: authHeaders,
      },
      env
    );
    expect(deleteArchivedAccountRes.status).toBe(204);
    const archivedRecurringPaymentRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId: archivedCounterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "0.50",
          periodHours: 24,
        }),
      },
      env
    );
    expect(archivedRecurringPaymentRes.status).toBe(404);
    await clearRateLimits();

    const pastFirstCollectionRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "0.50",
          periodHours: 24,
          firstCollectionAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      },
      env
    );
    expect(pastFirstCollectionRes.status).toBe(400);
    await clearRateLimits();

    const createRecurringRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "0.50",
          periodHours: 24,
          metadataUri: "https://sdp.dev/recurring.json",
        }),
      },
      env
    );
    expect(createRecurringRes.status).toBe(201);
    const createRecurringBody = (await createRecurringRes.json()) as {
      data: {
        recurringPayment: {
          id: string;
          status: string;
          destinationAddress: string;
          planPda: string | null;
        };
      };
    };
    const recurringPaymentId = createRecurringBody.data.recurringPayment.id;
    expect(createRecurringBody.data.recurringPayment).toMatchObject({
      status: "pending_activation",
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
      planPda: null,
    });

    await seedCachedKey({
      walletBindings: [
        { walletId: "wal_other_wallet", permissions: ["payments:read", "payments:write"] },
      ],
    });

    const unauthorizedGetRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}`,
      {
        method: "GET",
        headers: authHeaders,
      },
      env
    );
    expect(unauthorizedGetRes.status).toBe(403);

    const scopedListRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "GET",
        headers: authHeaders,
      },
      env
    );
    expect(scopedListRes.status).toBe(200);
    const scopedListBody = (await scopedListRes.json()) as {
      data: { recurringPayments: Array<{ id: string }>; total: number };
    };
    expect(scopedListBody.data.recurringPayments).toEqual([]);
    expect(scopedListBody.data.total).toBe(0);

    const unauthorizedActivateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(unauthorizedActivateRes.status).toBe(403);

    await seedCachedKey({
      walletBindings: [{ walletId: TEST_WALLET_ID, permissions: ["payments:write"] }],
    });

    const writeOnlyListRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "GET",
        headers: authHeaders,
      },
      env
    );
    expect(writeOnlyListRes.status).toBe(200);
    const writeOnlyListBody = (await writeOnlyListRes.json()) as {
      data: { recurringPayments: Array<{ id: string }>; total: number };
    };
    expect(writeOnlyListBody.data.recurringPayments).toEqual([]);
    expect(writeOnlyListBody.data.total).toBe(0);

    await seedCachedKey({
      walletBindings: [
        { walletId: TEST_WALLET_ID, permissions: ["payments:read", "payments:write"] },
      ],
    });

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: {
        recurringPayment: {
          status: string;
          planId: string | null;
          subscriptionId: string | null;
          planPda: string | null;
          subscriptionPda: string | null;
          nextCollectionDueAt: string | null;
        };
      };
    };
    expect(activateBody.data.recurringPayment.status).toBe("active");
    const firstCollectionAt = activateBody.data.recurringPayment.nextCollectionDueAt ?? "";
    expect(firstCollectionAt).toBeTruthy();
    expect(new Date(firstCollectionAt).getTime()).toBeLessThanOrEqual(Date.now());
    expect(activateBody.data.recurringPayment.planId).toBeTruthy();
    expect(activateBody.data.recurringPayment.subscriptionId).toBeTruthy();
    const recurringSubscriptionId = activateBody.data.recurringPayment.subscriptionId ?? "";
    const recurringPlanPda = activateBody.data.recurringPayment.planPda ?? "";
    const recurringSubscriptionPda = activateBody.data.recurringPayment.subscriptionPda ?? "";
    expect(recurringSubscriptionId).toBeTruthy();
    expect(recurringPlanPda).toBeTruthy();
    expect(recurringSubscriptionPda).toBeTruthy();
    const [expectedSourceTokenAccount] = await findAssociatedTokenPda({
      owner: address(TEST_SOLANA_ADDRESSES.wallet1),
      tokenProgram: address(SPL_TOKEN_PROGRAM_ID),
      mint: address(DEVNET_USDC_MINT),
    });
    const activatedSubscription = await repositories
      .createPaymentSubscriptionsRepository(env)
      .getSubscriptionById({
        subscriptionId: recurringSubscriptionId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      });
    expect(activatedSubscription?.subscriber_token_account).toBe(
      String(expectedSourceTokenAccount)
    );
    expect(activatedSubscription?.next_collection_due_at).toBe(firstCollectionAt);
    expect(new Date(activatedSubscription?.current_period_start_at ?? "").getTime()).toBe(
      new Date(firstCollectionAt).getTime() - 24 * 60 * 60 * 1000
    );

    const managedSubscriptionPauseRes = await app.request(
      `/v1/payments/subscriptions/${recurringSubscriptionId}`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ status: "paused" }),
      },
      env
    );
    expect(managedSubscriptionPauseRes.status).toBe(400);
    const managedSubscriptionPauseBody = (await managedSubscriptionPauseRes.json()) as {
      error: { message: string };
    };
    expect(managedSubscriptionPauseBody.error.message).toContain(
      "recurring payment lifecycle endpoints"
    );
    await clearRateLimits();

    const pausedManagedAt = new Date().toISOString();
    await repositories.createPaymentRecurringPaymentsRepository(env).updateRecurringPayment({
      recurringPaymentId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "paused",
      updatedAt: pausedManagedAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).updateSubscription({
      subscriptionId: recurringSubscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "paused",
      updatedAt: pausedManagedAt,
    });
    const pausedManagedSubscriptionResumeRes = await app.request(
      `/v1/payments/subscriptions/${recurringSubscriptionId}`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ status: "active" }),
      },
      env
    );
    expect(pausedManagedSubscriptionResumeRes.status).toBe(400);
    const pausedManagedSubscriptionResumeBody =
      (await pausedManagedSubscriptionResumeRes.json()) as {
        error: { message: string };
      };
    expect(pausedManagedSubscriptionResumeBody.error.message).toContain(
      "recurring payment lifecycle endpoints"
    );
    await repositories.createPaymentRecurringPaymentsRepository(env).updateRecurringPayment({
      recurringPaymentId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      updatedAt: new Date().toISOString(),
    });
    await repositories.createPaymentSubscriptionsRepository(env).updateSubscription({
      subscriptionId: recurringSubscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      updatedAt: new Date().toISOString(),
    });
    await clearRateLimits();

    const staleUnsignedAttemptUpdatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await repositories.createPaymentSubscriptionsRepository(env).createCollectionAttempt({
      id: "psca_stale_unsigned_retry",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      subscriptionId: recurringSubscriptionId,
      recurringPaymentId,
      transferId: null,
      token: DEVNET_USDC_MINT,
      amount: "0.50",
      dueAt: firstCollectionAt,
      attemptedAt: staleUnsignedAttemptUpdatedAt,
      status: "processing",
      signature: null,
      error: null,
      metadata: { source: "recurring_payments" },
      createdAt: staleUnsignedAttemptUpdatedAt,
      updatedAt: staleUnsignedAttemptUpdatedAt,
    });
    const dueWithStaleUnsignedAttempt = await repositories
      .createPaymentRecurringPaymentsRepository(env)
      .listDueRecurringPayments({
        now: new Date().toISOString(),
        retryAfter: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        limit: 10,
      });
    expect(dueWithStaleUnsignedAttempt.map((payment) => payment.id)).toContain(recurringPaymentId);

    const originalCreatePostgresPaymentsRepository = repositories.createPostgresPaymentsRepository;
    const createPostgresPaymentsRepositorySpy = vi
      .spyOn(repositories, "createPostgresPaymentsRepository")
      .mockImplementation((db) => ({
        ...originalCreatePostgresPaymentsRepository(db),
        createTransfer: vi.fn().mockResolvedValue(null),
      }));
    try {
      const failedCollectRes = await app.request(
        `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
        {
          method: "POST",
          headers: jsonHeaders,
          body: "{}",
        },
        env
      );
      expect(failedCollectRes.status).toBe(500);
    } finally {
      createPostgresPaymentsRepositorySpy.mockRestore();
    }

    createOrgSignerMock.mockRejectedValueOnce(new Error("simulated signer resolution failure"));
    const failedSignerCollectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(failedSignerCollectRes.status).toBe(500);

    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE wallet_id = ?")
      .bind(TEST_WALLET_ID)
      .run();
    const missingWalletCollectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(missingWalletCollectRes.status).toBe(404);
    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'active' WHERE wallet_id = ?")
      .bind(TEST_WALLET_ID)
      .run();

    await clearRateLimits();
    await seedWalletPolicy({
      destinationAllowlist: [],
      maxTransferAmount: "0.01",
    });
    const originalCreatePaymentSubscriptionsRepositoryForFailedMarker =
      repositories.createPaymentSubscriptionsRepository;
    let failedAttemptMarkerWriteFailures = 0;
    const failedAttemptMarkerSpy = vi
      .spyOn(repositories, "createPaymentSubscriptionsRepository")
      .mockImplementation((repoEnv) => {
        const repo = originalCreatePaymentSubscriptionsRepositoryForFailedMarker(repoEnv);

        return {
          ...repo,
          createCollectionAttempt: vi.fn(async (input) => {
            if (
              failedAttemptMarkerWriteFailures < 2 &&
              input.status === "failed" &&
              input.error === "Transfer amount exceeds wallet policy maxTransferAmount"
            ) {
              failedAttemptMarkerWriteFailures += 1;
              throw new Error("simulated failed-attempt marker write failure");
            }

            return repo.createCollectionAttempt(input);
          }),
        };
      });
    try {
      const failedMarkerRes = await app.request(
        `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
        {
          method: "POST",
          headers: jsonHeaders,
          body: "{}",
        },
        env
      );
      expect(failedMarkerRes.status).toBe(500);
      const failedMarkerBody = (await failedMarkerRes.json()) as {
        error: {
          code: string;
          message: string;
          details?: { originalError?: string; pausedForReconciliation?: boolean };
        };
      };
      expect(failedMarkerBody.error.code).toBe("INTERNAL_ERROR");
      expect(failedMarkerBody.error.message).toContain(
        "Recurring collection failed and retry backoff could not be recorded"
      );
      expect(failedMarkerBody.error.message).toContain(
        "Transfer amount exceeds wallet policy maxTransferAmount"
      );
      expect(failedMarkerBody.error.details?.originalError).toBe(
        "Transfer amount exceeds wallet policy maxTransferAmount"
      );
      expect(failedMarkerBody.error.details?.pausedForReconciliation).toBe(true);
    } finally {
      failedAttemptMarkerSpy.mockRestore();
      await getDb(env)
        .prepare("DELETE FROM payment_wallet_policies WHERE id IN (?, ?)")
        .bind("pwp_allowlist_test", "pwp_limits_test")
        .run();
    }
    expect(failedAttemptMarkerWriteFailures).toBe(2);
    const pausedAfterFailedMarker = await repositories
      .createPaymentRecurringPaymentsRepository(env)
      .getRecurringPaymentById({
        recurringPaymentId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      });
    const pausedSubscriptionAfterFailedMarker = await repositories
      .createPaymentSubscriptionsRepository(env)
      .getSubscriptionById({
        subscriptionId: recurringSubscriptionId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      });
    expect(pausedAfterFailedMarker?.status).toBe("paused");
    expect(pausedSubscriptionAfterFailedMarker?.status).toBe("paused");

    const restoredAfterFailedMarkerAt = new Date().toISOString();
    await repositories.createPaymentRecurringPaymentsRepository(env).updateRecurringPayment({
      recurringPaymentId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      nextCollectionDueAt: firstCollectionAt,
      updatedAt: restoredAfterFailedMarkerAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).updateSubscription({
      subscriptionId: recurringSubscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      nextCollectionDueAt: firstCollectionAt,
      updatedAt: restoredAfterFailedMarkerAt,
    });
    await clearRateLimits();

    const failedAttemptsRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collection-attempts?status=failed`,
      {
        method: "GET",
        headers: authHeaders,
      },
      env
    );
    expect(failedAttemptsRes.status).toBe(200);
    const failedAttemptsBody = (await failedAttemptsRes.json()) as {
      data: {
        collectionAttempts: Array<{
          recurringPaymentId: string | null;
          status: string;
          transferId: string | null;
          error: string | null;
        }>;
      };
    };
    expect(failedAttemptsBody.data.collectionAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recurringPaymentId,
          status: "failed",
          transferId: null,
          error: expect.stringContaining("expired before transfer submission"),
        }),
        expect.objectContaining({
          recurringPaymentId,
          status: "failed",
          transferId: null,
          error: "Failed to create payment transfer record",
        }),
        expect.objectContaining({
          recurringPaymentId,
          status: "failed",
          transferId: null,
          error: "simulated signer resolution failure",
        }),
        expect.objectContaining({
          recurringPaymentId,
          status: "failed",
          transferId: null,
          error: "Wallet not found. Provision wallets through /v1/wallets",
        }),
      ])
    );

    const originalCreatePostgresPaymentSubscriptionsRepositoryForClaimFailure =
      repositories.createPostgresPaymentSubscriptionsRepository;
    let failProcessingAttemptClaim = true;
    const processingAttemptClaimRepoSpy = vi
      .spyOn(repositories, "createPostgresPaymentSubscriptionsRepository")
      .mockImplementation((db) => {
        const repo = originalCreatePostgresPaymentSubscriptionsRepositoryForClaimFailure(db);

        return {
          ...repo,
          createCollectionAttempt: vi.fn(async (input) => {
            if (failProcessingAttemptClaim && input.status === "processing") {
              failProcessingAttemptClaim = false;
              throw new Error("simulated processing-attempt claim failure");
            }

            return repo.createCollectionAttempt(input);
          }),
        };
      });
    try {
      const failedClaimRes = await app.request(
        `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
        {
          method: "POST",
          headers: jsonHeaders,
          body: "{}",
        },
        env
      );
      expect(failedClaimRes.status).toBe(500);
    } finally {
      processingAttemptClaimRepoSpy.mockRestore();
    }
    expect(failProcessingAttemptClaim).toBe(false);

    const failedClaimAttemptsRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collection-attempts?status=failed`,
      {
        method: "GET",
        headers: authHeaders,
      },
      env
    );
    expect(failedClaimAttemptsRes.status).toBe(200);
    const failedClaimAttemptsBody = (await failedClaimAttemptsRes.json()) as {
      data: {
        collectionAttempts: Array<{
          recurringPaymentId: string | null;
          status: string;
          transferId: string | null;
          error: string | null;
        }>;
      };
    };
    expect(failedClaimAttemptsBody.data.collectionAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recurringPaymentId,
          status: "failed",
          transferId: null,
          error: "simulated processing-attempt claim failure",
        }),
      ])
    );

    mockRecurringCollectionAccounts();
    const blockhashExpiredFeePaymentAdapter = {
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
      signAsFeePayer: vi.fn(),
      signAndSend: vi.fn().mockRejectedValue(new Error("Blockhash not found")),
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>;
    createFeePaymentAdapterMock
      .mockReturnValueOnce(blockhashExpiredFeePaymentAdapter)
      .mockReturnValueOnce(blockhashExpiredFeePaymentAdapter);
    const blockhashExpiredRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(blockhashExpiredRes.status).toBe(502);

    const blockhashFailedAttemptsRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collection-attempts?status=failed`,
      {
        method: "GET",
        headers: authHeaders,
      },
      env
    );
    expect(blockhashFailedAttemptsRes.status).toBe(200);
    const blockhashFailedAttemptsBody = (await blockhashFailedAttemptsRes.json()) as {
      data: {
        collectionAttempts: Array<{
          recurringPaymentId: string | null;
          status: string;
          transferId: string | null;
          error: string | null;
          metadata: Record<string, unknown>;
        }>;
      };
    };
    expect(blockhashFailedAttemptsBody.data.collectionAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recurringPaymentId,
          status: "failed",
          transferId: expect.any(String),
          error: "Recurring payment transaction blockhash expired before submission",
          metadata: expect.objectContaining({
            retryImmediately: true,
            retryReason: "blockhash_expired",
          }),
        }),
      ])
    );

    mockRecurringCollectionAccounts();
    const failingCollectionFeePaymentAdapter = {
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
      signAsFeePayer: vi.fn(),
      signAndSend: vi.fn().mockRejectedValue(new Error("simulated collection submission failure")),
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>;
    createFeePaymentAdapterMock
      .mockReturnValueOnce(failingCollectionFeePaymentAdapter)
      .mockReturnValueOnce(failingCollectionFeePaymentAdapter);
    let failFailedTransferCleanup = true;
    const failedTransferCleanupRepoSpy = vi
      .spyOn(repositories, "createPostgresPaymentsRepository")
      .mockImplementation((db) => {
        const repo = originalCreatePostgresPaymentsRepository(db);

        return {
          ...repo,
          updateTransfer: vi.fn(async (input) => {
            if (failFailedTransferCleanup && input.status === "failed") {
              failFailedTransferCleanup = false;
              throw new Error("simulated failed-transfer cleanup write failure");
            }

            return repo.updateTransfer(input);
          }),
        };
      });
    try {
      const failedSubmissionRes = await app.request(
        `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
        {
          method: "POST",
          headers: jsonHeaders,
          body: "{}",
        },
        env
      );
      expect(failedSubmissionRes.status).toBe(500);
    } finally {
      failedTransferCleanupRepoSpy.mockRestore();
    }
    expect(failFailedTransferCleanup).toBe(false);

    const failedSubmissionAttemptsRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collection-attempts?status=failed`,
      {
        method: "GET",
        headers: authHeaders,
      },
      env
    );
    expect(failedSubmissionAttemptsRes.status).toBe(200);
    const failedSubmissionAttemptsBody = (await failedSubmissionAttemptsRes.json()) as {
      data: {
        collectionAttempts: Array<{
          status: string;
          transferId: string | null;
          error: string | null;
        }>;
      };
    };
    const failedSubmissionAttempt =
      failedSubmissionAttemptsBody.data.collectionAttempts.find(
        (attempt) => attempt.error === "simulated collection submission failure"
      ) ?? null;
    expect(failedSubmissionAttempt).toMatchObject({
      status: "failed",
      transferId: expect.any(String),
    });
    const failedSubmissionTransfer = await repositories
      .createPaymentsRepository(env)
      .getTransferById({
        transferId: failedSubmissionAttempt?.transferId ?? "",
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      });
    expect(failedSubmissionTransfer).toMatchObject({
      status: "failed",
      error: "simulated collection submission failure",
    });

    const staleFailedAttemptUpdatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const staleFailedAttemptTransferId = "ptr_stale_failed_attempt_transfer";
    await repositories.createPaymentsRepository(env).createTransfer({
      id: staleFailedAttemptTransferId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      walletId: TEST_WALLET_ID,
      counterpartyId,
      sourceAddress: TEST_SOLANA_ADDRESSES.wallet1,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
      token: DEVNET_USDC_MINT,
      amount: "0.50",
      memo: null,
      type: "transfer",
      direction: "outbound",
      status: "processing",
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: { source: "recurring_payments" },
      serializedTx: null,
      initiatedByKeyId: TEST_API_KEY.id,
      createdAt: staleFailedAttemptUpdatedAt,
      updatedAt: staleFailedAttemptUpdatedAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).createCollectionAttempt({
      id: "psca_stale_failed_attempt_transfer",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      subscriptionId: recurringSubscriptionId,
      recurringPaymentId,
      transferId: staleFailedAttemptTransferId,
      token: DEVNET_USDC_MINT,
      amount: "0.50",
      dueAt: firstCollectionAt,
      attemptedAt: staleFailedAttemptUpdatedAt,
      status: "failed",
      signature: null,
      error: "simulated cleanup marker without transfer cleanup",
      metadata: { source: "recurring_payments" },
      createdAt: staleFailedAttemptUpdatedAt,
      updatedAt: staleFailedAttemptUpdatedAt,
    });
    const expiredStaleFailedAttemptRecords = await repositories
      .createPaymentSubscriptionsRepository(env)
      .expireStaleUnsignedProcessingAttempts({
        olderThan: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
        limit: 10,
      });
    expect(expiredStaleFailedAttemptRecords).toBeGreaterThanOrEqual(1);
    const staleFailedAttemptTransferAfter = await repositories
      .createPaymentsRepository(env)
      .getTransferById({
        transferId: staleFailedAttemptTransferId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      });
    expect(staleFailedAttemptTransferAfter).toMatchObject({
      status: "failed",
      error: expect.stringContaining("failed attempt"),
    });

    const staleUnsignedLinkedAttemptDueAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const staleUnsignedLinkedTransferId = "ptr_stale_unsigned_linked_transfer";
    await repositories.createPaymentsRepository(env).createTransfer({
      id: staleUnsignedLinkedTransferId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      walletId: TEST_WALLET_ID,
      counterpartyId,
      sourceAddress: TEST_SOLANA_ADDRESSES.wallet1,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
      token: DEVNET_USDC_MINT,
      amount: "0.50",
      memo: null,
      type: "transfer",
      direction: "outbound",
      status: "processing",
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: { source: "recurring_payments" },
      serializedTx: null,
      initiatedByKeyId: TEST_API_KEY.id,
      createdAt: staleUnsignedLinkedAttemptDueAt,
      updatedAt: staleUnsignedLinkedAttemptDueAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).createCollectionAttempt({
      id: "psca_stale_unsigned_linked_transfer",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      subscriptionId: recurringSubscriptionId,
      recurringPaymentId,
      transferId: staleUnsignedLinkedTransferId,
      token: DEVNET_USDC_MINT,
      amount: "0.50",
      dueAt: staleUnsignedLinkedAttemptDueAt,
      attemptedAt: staleUnsignedLinkedAttemptDueAt,
      status: "processing",
      signature: null,
      error: null,
      metadata: { source: "recurring_payments" },
      createdAt: staleUnsignedLinkedAttemptDueAt,
      updatedAt: staleUnsignedLinkedAttemptDueAt,
    });
    const expiredUnsignedLinkedRecords = await repositories
      .createPaymentSubscriptionsRepository(env)
      .expireStaleUnsignedProcessingAttempts({
        olderThan: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
        limit: 10,
      });
    expect(expiredUnsignedLinkedRecords).toBeGreaterThanOrEqual(1);
    const staleUnsignedLinkedTransferAfter = await repositories
      .createPaymentsRepository(env)
      .getTransferById({
        transferId: staleUnsignedLinkedTransferId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      });
    expect(staleUnsignedLinkedTransferAfter).toMatchObject({
      status: "failed",
      error: expect.stringContaining("expired before submission"),
    });
    const staleUnsignedLinkedAttemptAfter = await repositories
      .createPaymentSubscriptionsRepository(env)
      .getCollectionAttemptByRecurringDue({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        recurringPaymentId,
        dueAt: staleUnsignedLinkedAttemptDueAt,
      });
    expect(staleUnsignedLinkedAttemptAfter).toBeNull();

    const transferSignatureOnlyDueAt = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const transferSignatureOnlyTransferId = "ptr_transfer_signature_only_recovery";
    await repositories.createPaymentsRepository(env).createTransfer({
      id: transferSignatureOnlyTransferId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      walletId: TEST_WALLET_ID,
      counterpartyId,
      sourceAddress: TEST_SOLANA_ADDRESSES.wallet1,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
      token: DEVNET_USDC_MINT,
      amount: "0.50",
      memo: null,
      type: "transfer",
      direction: "outbound",
      status: "processing",
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: { source: "recurring_payments" },
      serializedTx: null,
      initiatedByKeyId: TEST_API_KEY.id,
      createdAt: transferSignatureOnlyDueAt,
      updatedAt: transferSignatureOnlyDueAt,
    });
    await repositories.createPaymentsRepository(env).updateTransfer({
      transferId: transferSignatureOnlyTransferId,
      signature: `z${MOCK_SIGNATURE_TAIL}`,
      updatedAt: new Date().toISOString(),
    });
    await repositories.createPaymentSubscriptionsRepository(env).createCollectionAttempt({
      id: "psca_transfer_signature_only_recovery",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      subscriptionId: recurringSubscriptionId,
      recurringPaymentId,
      transferId: transferSignatureOnlyTransferId,
      token: DEVNET_USDC_MINT,
      amount: "0.50",
      dueAt: transferSignatureOnlyDueAt,
      attemptedAt: transferSignatureOnlyDueAt,
      status: "processing",
      signature: null,
      error: null,
      metadata: { source: "recurring_payments" },
      createdAt: transferSignatureOnlyDueAt,
      updatedAt: transferSignatureOnlyDueAt,
    });
    const submittedRecoveries = await repositories
      .createPaymentSubscriptionsRepository(env)
      .listSubmittedRecurringCollectionAttempts({ limit: 10 });
    expect(submittedRecoveries.map((attempt) => attempt.id)).toContain(
      "psca_transfer_signature_only_recovery"
    );
    await repositories.createPaymentSubscriptionsRepository(env).updateCollectionAttempt({
      attemptId: "psca_transfer_signature_only_recovery",
      status: "failed",
      error: "cleared transfer-signature-only recovery fixture",
      attemptedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await repositories.createPaymentsRepository(env).updateTransfer({
      transferId: transferSignatureOnlyTransferId,
      status: "failed",
      error: "cleared transfer-signature-only recovery fixture",
      updatedAt: new Date().toISOString(),
    });

    const staleSubmittedUnsignedUpdatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const staleSubmittedUnsignedTransferId = "ptr_stale_submitted_unsigned_recovery";
    await repositories.createPaymentsRepository(env).createTransfer({
      id: staleSubmittedUnsignedTransferId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      walletId: TEST_WALLET_ID,
      counterpartyId,
      sourceAddress: TEST_SOLANA_ADDRESSES.wallet1,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
      token: DEVNET_USDC_MINT,
      amount: "0.50",
      memo: null,
      type: "transfer",
      direction: "outbound",
      status: "processing",
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: { source: "recurring_payments" },
      serializedTx: "stale-submitted-unsigned-transaction",
      initiatedByKeyId: TEST_API_KEY.id,
      createdAt: staleSubmittedUnsignedUpdatedAt,
      updatedAt: staleSubmittedUnsignedUpdatedAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).createCollectionAttempt({
      id: "psca_stale_submitted_unsigned_recovery",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      subscriptionId: recurringSubscriptionId,
      recurringPaymentId,
      transferId: staleSubmittedUnsignedTransferId,
      token: DEVNET_USDC_MINT,
      amount: "0.50",
      dueAt: firstCollectionAt,
      attemptedAt: staleSubmittedUnsignedUpdatedAt,
      status: "processing",
      signature: null,
      error: null,
      metadata: { source: "recurring_payments" },
      createdAt: staleSubmittedUnsignedUpdatedAt,
      updatedAt: staleSubmittedUnsignedUpdatedAt,
    });
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_operation_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           operation,
           status,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, 'collect', 'submitted', NULL, ?, ?)`
      )
      .bind(
        "prlo_stale_submitted_unsigned_recovery",
        TEST_ORG.id,
        TEST_PROJECT.id,
        recurringPaymentId,
        staleSubmittedUnsignedUpdatedAt,
        staleSubmittedUnsignedUpdatedAt
      )
      .run();
    await repositories
      .createPaymentSubscriptionsRepository(env)
      .expireStaleUnsignedProcessingAttempts({
        olderThan: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
        limit: 10,
      });
    const staleSubmittedUnsignedRows = await getDb(env)
      .prepare(
        `SELECT a.status AS attempt_status,
                t.status AS transfer_status,
                op.status AS operation_status
           FROM payment_subscription_collection_attempts a
           JOIN payment_transfers t ON t.id = a.transfer_id
           JOIN payment_recurring_operation_attempts op
             ON op.recurring_payment_id = a.recurring_payment_id
            AND op.operation = 'collect'
          WHERE a.id = ?
            AND op.id = ?`
      )
      .bind("psca_stale_submitted_unsigned_recovery", "prlo_stale_submitted_unsigned_recovery")
      .first<{
        attempt_status: string;
        transfer_status: string;
        operation_status: string;
      }>();
    expect(staleSubmittedUnsignedRows).toMatchObject({
      attempt_status: "failed",
      transfer_status: "failed",
      operation_status: "failed",
    });

    const operationSignatureOnlyUpdatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const operationSignatureOnlyTransferId = "ptr_operation_signature_only_recovery";
    await repositories.createPaymentsRepository(env).createTransfer({
      id: operationSignatureOnlyTransferId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      walletId: TEST_WALLET_ID,
      counterpartyId,
      sourceAddress: TEST_SOLANA_ADDRESSES.wallet1,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
      token: DEVNET_USDC_MINT,
      amount: "0.50",
      memo: null,
      type: "transfer",
      direction: "outbound",
      status: "processing",
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: { source: "recurring_payments" },
      serializedTx: "operation-signature-only-transaction",
      initiatedByKeyId: TEST_API_KEY.id,
      createdAt: operationSignatureOnlyUpdatedAt,
      updatedAt: operationSignatureOnlyUpdatedAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).createCollectionAttempt({
      id: "psca_operation_signature_only_recovery",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      subscriptionId: recurringSubscriptionId,
      recurringPaymentId,
      transferId: operationSignatureOnlyTransferId,
      token: DEVNET_USDC_MINT,
      amount: "0.50",
      dueAt: firstCollectionAt,
      attemptedAt: operationSignatureOnlyUpdatedAt,
      status: "processing",
      signature: null,
      error: null,
      metadata: { source: "recurring_payments" },
      createdAt: operationSignatureOnlyUpdatedAt,
      updatedAt: operationSignatureOnlyUpdatedAt,
    });
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_operation_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           operation,
           status,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, 'collect', 'submitted', ?, ?, ?)`
      )
      .bind(
        "prlo_operation_signature_only_recovery",
        TEST_ORG.id,
        TEST_PROJECT.id,
        recurringPaymentId,
        `5${MOCK_SIGNATURE_TAIL}`,
        operationSignatureOnlyUpdatedAt,
        operationSignatureOnlyUpdatedAt
      )
      .run();
    await repositories
      .createPaymentSubscriptionsRepository(env)
      .expireStaleUnsignedProcessingAttempts({
        olderThan: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
        limit: 10,
      });
    const operationSignatureOnlyAttempt = await getDb(env)
      .prepare("SELECT status FROM payment_subscription_collection_attempts WHERE id = ?")
      .bind("psca_operation_signature_only_recovery")
      .first<{ status: string }>();
    expect(operationSignatureOnlyAttempt?.status).toBe("processing");
    const operationSignatureRecoveries = await repositories
      .createPaymentSubscriptionsRepository(env)
      .listSubmittedRecurringCollectionAttempts({ limit: 10 });
    expect(operationSignatureRecoveries.map((attempt) => attempt.id)).toContain(
      "psca_operation_signature_only_recovery"
    );
    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_operation_attempts
            SET status = 'failed',
                error = 'cleared operation-signature-only recovery fixture',
                updated_at = ?
          WHERE id = ?`
      )
      .bind(new Date().toISOString(), "prlo_operation_signature_only_recovery")
      .run();
    await repositories.createPaymentSubscriptionsRepository(env).updateCollectionAttempt({
      attemptId: "psca_operation_signature_only_recovery",
      status: "failed",
      error: "cleared operation-signature-only recovery fixture",
      attemptedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await repositories.createPaymentsRepository(env).updateTransfer({
      transferId: operationSignatureOnlyTransferId,
      status: "failed",
      error: "cleared operation-signature-only recovery fixture",
      updatedAt: new Date().toISOString(),
    });

    const staleLinkedAttemptUpdatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const staleLinkedTransferId = "ptr_stale_linked_cancel_race";
    const staleLinkedTransfer = await repositories.createPaymentsRepository(env).createTransfer({
      id: staleLinkedTransferId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      walletId: TEST_WALLET_ID,
      counterpartyId,
      sourceAddress: TEST_SOLANA_ADDRESSES.wallet1,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
      token: DEVNET_USDC_MINT,
      amount: "0.50",
      memo: null,
      type: "transfer",
      direction: "outbound",
      status: "processing",
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: { source: "recurring_payments" },
      serializedTx: "stale-unsigned-transaction",
      initiatedByKeyId: TEST_API_KEY.id,
      createdAt: staleLinkedAttemptUpdatedAt,
      updatedAt: staleLinkedAttemptUpdatedAt,
    });
    expect(staleLinkedTransfer?.id).toBe(staleLinkedTransferId);
    await repositories.createPaymentSubscriptionsRepository(env).createCollectionAttempt({
      id: "psca_stale_linked_cancel_race",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      subscriptionId: recurringSubscriptionId,
      recurringPaymentId,
      transferId: staleLinkedTransferId,
      token: DEVNET_USDC_MINT,
      amount: "0.50",
      dueAt: firstCollectionAt,
      attemptedAt: staleLinkedAttemptUpdatedAt,
      status: "processing",
      signature: null,
      error: null,
      metadata: { source: "recurring_payments" },
      createdAt: staleLinkedAttemptUpdatedAt,
      updatedAt: staleLinkedAttemptUpdatedAt,
    });
    await repositories.createPaymentRecurringPaymentsRepository(env).updateRecurringPayment({
      recurringPaymentId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "canceling",
      updatedAt: staleLinkedAttemptUpdatedAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).updateSubscription({
      subscriptionId: recurringSubscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "canceling",
      updatedAt: staleLinkedAttemptUpdatedAt,
    });
    await clearRateLimits();

    const staleLinkedCollectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(staleLinkedCollectRes.status).toBe(409);
    const staleLinkedAttemptsRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collection-attempts?status=failed`,
      {
        method: "GET",
        headers: authHeaders,
      },
      env
    );
    expect(staleLinkedAttemptsRes.status).toBe(200);
    const staleLinkedAttemptsBody = (await staleLinkedAttemptsRes.json()) as {
      data: {
        collectionAttempts: Array<{
          status: string;
          transferId: string | null;
          error: string | null;
        }>;
      };
    };
    expect(staleLinkedAttemptsBody.data.collectionAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          transferId: staleLinkedTransferId,
          error: expect.stringContaining("linked transfer but no submission signature"),
        }),
      ])
    );
    const staleLinkedTransferAfter = await repositories
      .createPaymentsRepository(env)
      .getTransferById({
        transferId: staleLinkedTransferId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      });
    expect(staleLinkedTransferAfter).toMatchObject({
      status: "failed",
      error: expect.stringContaining("linked transfer but no submission signature"),
    });
    const cancelingRecurringPayment = await repositories
      .createPaymentRecurringPaymentsRepository(env)
      .getRecurringPaymentById({
        recurringPaymentId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      });
    const cancelingSubscription = await repositories
      .createPaymentSubscriptionsRepository(env)
      .getSubscriptionById({
        subscriptionId: recurringSubscriptionId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      });
    expect(cancelingRecurringPayment?.status).toBe("canceling");
    expect(cancelingSubscription?.status).toBe("canceling");

    const restoredActiveAt = new Date().toISOString();
    await repositories.createPaymentRecurringPaymentsRepository(env).updateRecurringPayment({
      recurringPaymentId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      nextCollectionDueAt: firstCollectionAt,
      updatedAt: restoredActiveAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).updateSubscription({
      subscriptionId: recurringSubscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      nextCollectionDueAt: firstCollectionAt,
      updatedAt: restoredActiveAt,
    });
    await clearRateLimits();

    const blockingCollectionAttemptAt = new Date().toISOString();
    await repositories.createPaymentSubscriptionsRepository(env).createCollectionAttempt({
      id: "psca_processing_cancel_block",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      subscriptionId: recurringSubscriptionId,
      recurringPaymentId,
      transferId: null,
      token: DEVNET_USDC_MINT,
      amount: "0.50",
      dueAt: firstCollectionAt,
      attemptedAt: blockingCollectionAttemptAt,
      status: "processing",
      signature: null,
      error: null,
      metadata: { source: "recurring_payments" },
      createdAt: blockingCollectionAttemptAt,
      updatedAt: blockingCollectionAttemptAt,
    });
    const cancelDuringProcessingCollectionRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/cancel`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(cancelDuringProcessingCollectionRes.status).toBe(409);
    const cancelDuringProcessingCollectionBody =
      (await cancelDuringProcessingCollectionRes.json()) as { error: { message: string } };
    expect(cancelDuringProcessingCollectionBody.error.message).toContain(
      "collection is already in progress"
    );
    await repositories.createPaymentSubscriptionsRepository(env).updateCollectionAttempt({
      attemptId: "psca_processing_cancel_block",
      status: "failed",
      error: "cleared for cancel test",
      attemptedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await clearRateLimits();

    const blockingCollectOperationAttemptAt = new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_operation_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           operation,
           status,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, 'collect', 'processing', ?, ?)`
      )
      .bind(
        "prlo_processing_collect_cancel_block",
        TEST_ORG.id,
        TEST_PROJECT.id,
        recurringPaymentId,
        blockingCollectOperationAttemptAt,
        blockingCollectOperationAttemptAt
      )
      .run();
    const cancelDuringCollectOperationRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/cancel`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(cancelDuringCollectOperationRes.status).toBe(409);
    const cancelDuringCollectOperationBody = (await cancelDuringCollectOperationRes.json()) as {
      error: { message: string };
    };
    expect(cancelDuringCollectOperationBody.error.message).toContain(
      "collection is already in progress"
    );
    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_operation_attempts
            SET status = 'failed',
                error = 'cleared for cancel test',
                updated_at = ?
          WHERE id = ?`
      )
      .bind(new Date().toISOString(), "prlo_processing_collect_cancel_block")
      .run();
    await clearRateLimits();

    const duplicateLifecycleClaimAt = new Date().toISOString();
    await repositories.createPaymentRecurringPaymentsRepository(env).updateRecurringPayment({
      recurringPaymentId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "canceling",
      updatedAt: duplicateLifecycleClaimAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).updateSubscription({
      subscriptionId: recurringSubscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "canceling",
      updatedAt: duplicateLifecycleClaimAt,
    });
    const duplicateCancelClaimRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/cancel`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(duplicateCancelClaimRes.status).toBe(409);
    const duplicateCancelClaimBody = (await duplicateCancelClaimRes.json()) as {
      error: { message: string };
    };
    expect(duplicateCancelClaimBody.error.message).toContain("already in progress");

    const restoredAfterDuplicateClaimAt = new Date().toISOString();
    await repositories.createPaymentRecurringPaymentsRepository(env).updateRecurringPayment({
      recurringPaymentId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      nextCollectionDueAt: firstCollectionAt,
      updatedAt: restoredAfterDuplicateClaimAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).updateSubscription({
      subscriptionId: recurringSubscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      nextCollectionDueAt: firstCollectionAt,
      updatedAt: restoredAfterDuplicateClaimAt,
    });
    await clearRateLimits();

    mockRecurringLifecycleSubscriptionState({
      planPda: recurringPlanPda,
      subscriptionPda: recurringSubscriptionPda,
      expiresAtTs: 1_800_000_000n,
    });
    const canceledOnChainCollectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(canceledOnChainCollectRes.status).toBe(400);
    const canceledOnChainPayment = await repositories
      .createPaymentRecurringPaymentsRepository(env)
      .getRecurringPaymentById({
        recurringPaymentId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      });
    const canceledOnChainSubscription = await repositories
      .createPaymentSubscriptionsRepository(env)
      .getSubscriptionById({
        subscriptionId: recurringSubscriptionId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      });
    expect(canceledOnChainPayment?.status).toBe("canceled");
    expect(canceledOnChainSubscription?.status).toBe("canceled");
    expect(canceledOnChainSubscription?.canceled_at).toBeTruthy();

    const restoredAfterChainReconcileAt = new Date().toISOString();
    await repositories.createPaymentRecurringPaymentsRepository(env).updateRecurringPayment({
      recurringPaymentId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      nextCollectionDueAt: firstCollectionAt,
      updatedAt: restoredAfterChainReconcileAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).updateSubscription({
      subscriptionId: recurringSubscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      nextCollectionDueAt: firstCollectionAt,
      canceledAt: null,
      updatedAt: restoredAfterChainReconcileAt,
    });
    await clearRateLimits();

    mockRecurringCollectionAccounts();
    const originalCreatePostgresRecurringPaymentsRepository =
      repositories.createPostgresPaymentRecurringPaymentsRepository;
    const originalCreatePaymentSubscriptionsRepository =
      repositories.createPaymentSubscriptionsRepository;
    let failFinalRecurringPaymentUpdate = true;
    let failAttemptRecoveryMarker = true;
    const recurringRepoSpy = vi
      .spyOn(repositories, "createPostgresPaymentRecurringPaymentsRepository")
      .mockImplementation((db) => {
        const repo = originalCreatePostgresRecurringPaymentsRepository(db);

        return {
          ...repo,
          updateRecurringPayment: vi.fn(async (input) => {
            if (
              failFinalRecurringPaymentUpdate &&
              input.recurringPaymentId === recurringPaymentId &&
              input.nextCollectionDueAt !== undefined
            ) {
              failFinalRecurringPaymentUpdate = false;
              throw new Error("simulated recurring payment finalization failure");
            }

            return repo.updateRecurringPayment(input);
          }),
        };
      });
    const subscriptionsRepoSpy = vi
      .spyOn(repositories, "createPaymentSubscriptionsRepository")
      .mockImplementation((repoEnv) => {
        const repo = originalCreatePaymentSubscriptionsRepository(repoEnv);

        return {
          ...repo,
          updateCollectionAttempt: vi.fn(async (input) => {
            if (
              failAttemptRecoveryMarker &&
              input.status === "processing" &&
              input.signature !== undefined
            ) {
              failAttemptRecoveryMarker = false;
              throw new Error("simulated collection attempt recovery marker failure");
            }

            return repo.updateCollectionAttempt(input);
          }),
        };
      });
    let recoveredFinalizeBody!: {
      data: {
        recurringPayment: { nextCollectionDueAt: string | null };
        collectionAttempt: { status: string; recurringPaymentId: string | null };
        transfer: { status: string; signature: string | null; blockTime: string | null };
      };
    };
    try {
      const recoveredFinalizeRes = await app.request(
        `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
        {
          method: "POST",
          headers: jsonHeaders,
          body: "{}",
        },
        env
      );
      expect(recoveredFinalizeRes.status).toBe(200);
      recoveredFinalizeBody = (await recoveredFinalizeRes.json()) as typeof recoveredFinalizeBody;
    } finally {
      recurringRepoSpy.mockRestore();
      subscriptionsRepoSpy.mockRestore();
    }
    expect(failFinalRecurringPaymentUpdate).toBe(false);
    expect(failAttemptRecoveryMarker).toBe(false);
    expect(recoveredFinalizeBody.data.collectionAttempt).toMatchObject({
      status: "confirmed",
      recurringPaymentId,
    });
    expect(recoveredFinalizeBody.data.transfer).toMatchObject({
      status: "confirmed",
      signature: expect.any(String),
      blockTime: "2023-11-14T22:13:20.000Z",
    });
    expect(
      new Date(recoveredFinalizeBody.data.recurringPayment.nextCollectionDueAt ?? "").getTime()
    ).toBe(new Date(firstCollectionAt).getTime() + 24 * 60 * 60 * 1000);
    const confirmedCollectOperationAttempt = await getDb(env)
      .prepare(
        `SELECT status
           FROM payment_recurring_operation_attempts
          WHERE recurring_payment_id = ?
            AND operation = 'collect'
          ORDER BY updated_at DESC
          LIMIT 1`
      )
      .bind(recurringPaymentId)
      .first<{ status: string }>();
    expect(confirmedCollectOperationAttempt?.status).toBe("confirmed");

    const signedRaceDueAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const signedRacePeriodStartAt = new Date(
      new Date(signedRaceDueAt).getTime() - 24 * 60 * 60 * 1000
    ).toISOString();
    await repositories.createPaymentRecurringPaymentsRepository(env).updateRecurringPayment({
      recurringPaymentId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      nextCollectionDueAt: signedRaceDueAt,
      updatedAt: signedRaceDueAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).updateSubscription({
      subscriptionId: recurringSubscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      currentPeriodStartAt: signedRacePeriodStartAt,
      nextCollectionDueAt: signedRaceDueAt,
      updatedAt: signedRaceDueAt,
    });
    mockRecurringCollectionAccounts();
    const signedRaceUpdatedAt = new Date().toISOString();
    const signedRaceFeePaymentAdapter = {
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
      signAsFeePayer: vi.fn(),
      signAndSend: vi.fn(async () => {
        await repositories.createPaymentRecurringPaymentsRepository(env).updateRecurringPayment({
          recurringPaymentId,
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT.id,
          status: "canceling",
          updatedAt: signedRaceUpdatedAt,
        });
        await repositories.createPaymentSubscriptionsRepository(env).updateSubscription({
          subscriptionId: recurringSubscriptionId,
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT.id,
          status: "canceling",
          updatedAt: signedRaceUpdatedAt,
        });

        return `5${MOCK_SIGNATURE_TAIL}` as Signature;
      }),
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>;
    createFeePaymentAdapterMock
      .mockReturnValueOnce(signedRaceFeePaymentAdapter)
      .mockReturnValueOnce(signedRaceFeePaymentAdapter);
    await clearRateLimits();

    const signedRaceCollectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(signedRaceCollectRes.status).toBe(200);
    const signedRaceCollectBody = (await signedRaceCollectRes.json()) as {
      data: {
        recurringPayment: { status: string; nextCollectionDueAt: string | null };
        collectionAttempt: { status: string; recurringPaymentId: string | null };
        transfer: { status: string; signature: string | null };
      };
    };
    expect(signedRaceCollectBody.data.recurringPayment).toMatchObject({
      status: "canceling",
      nextCollectionDueAt: signedRaceDueAt,
    });
    expect(signedRaceCollectBody.data.collectionAttempt).toMatchObject({
      status: "confirmed",
      recurringPaymentId,
    });
    expect(signedRaceCollectBody.data.transfer).toMatchObject({
      status: "confirmed",
      signature: `5${MOCK_SIGNATURE_TAIL}`,
    });
    expect(signedRaceFeePaymentAdapter.signAndSend).toHaveBeenCalledTimes(1);
    const signedRaceCollectOperationAttempt = await getDb(env)
      .prepare(
        `SELECT status
           FROM payment_recurring_operation_attempts
          WHERE recurring_payment_id = ?
            AND operation = 'collect'
          ORDER BY updated_at DESC
          LIMIT 1`
      )
      .bind(recurringPaymentId)
      .first<{ status: string }>();
    expect(signedRaceCollectOperationAttempt?.status).toBe("confirmed");

    const overdueCollectionAt = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const overduePeriodStartAt = new Date(
      new Date(overdueCollectionAt).getTime() - 24 * 60 * 60 * 1000
    ).toISOString();
    await repositories.createPaymentRecurringPaymentsRepository(env).updateRecurringPayment({
      recurringPaymentId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      nextCollectionDueAt: overdueCollectionAt,
      updatedAt: overdueCollectionAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).updateSubscription({
      subscriptionId: recurringSubscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      currentPeriodStartAt: overduePeriodStartAt,
      nextCollectionDueAt: overdueCollectionAt,
      updatedAt: overdueCollectionAt,
    });
    await clearRateLimits();
    mockRecurringCollectionAccounts();

    const overdueCollectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(overdueCollectRes.status).toBe(200);
    const overdueCollectBody = (await overdueCollectRes.json()) as {
      data: { recurringPayment: { nextCollectionDueAt: string | null } };
    };
    const overdueNextDueAt = new Date(
      overdueCollectBody.data.recurringPayment.nextCollectionDueAt ?? ""
    ).getTime();
    expect(overdueNextDueAt).toBeGreaterThan(Date.now());
    expect(overdueNextDueAt).toBeGreaterThan(
      new Date(overdueCollectionAt).getTime() + 24 * 60 * 60 * 1000
    );

    const earlyCollectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(earlyCollectRes.status).toBe(400);
    const earlyCollectBody = (await earlyCollectRes.json()) as { error: { message: string } };
    expect(earlyCollectBody.error.message).toContain("not due");

    const lifecycleGuardUpdatedAt = new Date().toISOString();
    await repositories.createPaymentRecurringPaymentsRepository(env).updateRecurringPayment({
      recurringPaymentId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      nextCollectionDueAt: overdueCollectBody.data.recurringPayment.nextCollectionDueAt ?? null,
      updatedAt: lifecycleGuardUpdatedAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).updateSubscription({
      subscriptionId: recurringSubscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      nextCollectionDueAt: overdueCollectBody.data.recurringPayment.nextCollectionDueAt ?? null,
      canceledAt: null,
      updatedAt: lifecycleGuardUpdatedAt,
    });
    const feePaymentCallsBeforeLifecycleGuard = createFeePaymentAdapterMock.mock.calls.length;
    mockRecurringLifecycleSubscriptionState({
      planPda: recurringPlanPda,
      subscriptionPda: recurringSubscriptionPda,
      expiresAtTs: 0n,
    });
    createOrgSignerMock.mockImplementationOnce(async () => {
      await getDb(env)
        .prepare(
          `UPDATE payment_recurring_operation_attempts
              SET status = 'failed',
                  error = 'simulated stale lifecycle claim',
                  updated_at = ?
            WHERE recurring_payment_id = ?
              AND operation = 'cancel'
              AND status = 'processing'`
        )
        .bind(new Date().toISOString(), recurringPaymentId)
        .run();

      return createNoopSigner(address(TEST_SOLANA_ADDRESSES.wallet1));
    });
    await clearRateLimits();
    const lifecycleGuardRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/cancel`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(lifecycleGuardRes.status).toBe(409);
    expect(createFeePaymentAdapterMock.mock.calls.length).toBe(feePaymentCallsBeforeLifecycleGuard);
    const lifecycleGuardAttempt = await getDb(env)
      .prepare(
        `SELECT status, error
           FROM payment_recurring_operation_attempts
          WHERE recurring_payment_id = ?
            AND operation = 'cancel'
          ORDER BY updated_at DESC
          LIMIT 1`
      )
      .bind(recurringPaymentId)
      .first<{ status: string; error: string | null }>();
    expect(lifecycleGuardAttempt).toMatchObject({
      status: "failed",
      error: "Recurring payment lifecycle state changed before on-chain submission",
    });

    const restoredAfterLifecycleGuardAt = new Date().toISOString();
    await repositories.createPaymentRecurringPaymentsRepository(env).updateRecurringPayment({
      recurringPaymentId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      updatedAt: restoredAfterLifecycleGuardAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).updateSubscription({
      subscriptionId: recurringSubscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "active",
      canceledAt: null,
      updatedAt: restoredAfterLifecycleGuardAt,
    });

    let failCancelLifecycleUpdate = true;
    const cancelLifecycleRepoSpy = vi
      .spyOn(repositories, "createPostgresPaymentRecurringPaymentsRepository")
      .mockImplementation((db) => {
        const repo = originalCreatePostgresRecurringPaymentsRepository(db);

        return {
          ...repo,
          updateRecurringPayment: vi.fn(async (input) => {
            if (
              failCancelLifecycleUpdate &&
              input.recurringPaymentId === recurringPaymentId &&
              input.status === "canceled"
            ) {
              failCancelLifecycleUpdate = false;
              throw new Error("simulated cancel lifecycle DB failure");
            }

            return repo.updateRecurringPayment(input);
          }),
        };
      });
    mockRecurringLifecycleSubscriptionState({
      planPda: recurringPlanPda,
      subscriptionPda: recurringSubscriptionPda,
      expiresAtTs: 0n,
      times: 2,
    });
    try {
      const recoveredCancelRes = await app.request(
        `/v1/payments/recurring-payments/${recurringPaymentId}/cancel`,
        {
          method: "POST",
          headers: jsonHeaders,
          body: "{}",
        },
        env
      );
      expect(recoveredCancelRes.status).toBe(200);
      const recoveredCancelBody = (await recoveredCancelRes.json()) as {
        data: { recurringPayment: { status: string } };
      };
      expect(recoveredCancelBody.data.recurringPayment.status).toBe("canceled");
    } finally {
      cancelLifecycleRepoSpy.mockRestore();
    }
    const canceledSubscription = await repositories
      .createPaymentSubscriptionsRepository(env)
      .getSubscriptionById({
        subscriptionId: recurringSubscriptionId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      });
    const canceledAt = canceledSubscription?.canceled_at ?? "";
    expect(canceledAt).toBeTruthy();

    const staleCancelRecoveryAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await repositories.createPaymentRecurringPaymentsRepository(env).updateRecurringPayment({
      recurringPaymentId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "canceling",
      updatedAt: staleCancelRecoveryAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).updateSubscription({
      subscriptionId: recurringSubscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "canceling",
      canceledAt: null,
      updatedAt: staleCancelRecoveryAt,
    });
    const feePaymentCallsBeforeStaleCancelRecovery = createFeePaymentAdapterMock.mock.calls.length;
    const signerCallsBeforeStaleCancelRecovery = createOrgSignerMock.mock.calls.length;
    mockRecurringLifecycleSubscriptionState({
      planPda: recurringPlanPda,
      subscriptionPda: recurringSubscriptionPda,
      expiresAtTs: 1_800_000_000n,
    });
    await clearRateLimits();
    const staleCancelRecoveryRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/cancel`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(staleCancelRecoveryRes.status).toBe(200);
    const staleCancelRecoveryBody = (await staleCancelRecoveryRes.json()) as {
      data: { recurringPayment: { status: string } };
    };
    expect(staleCancelRecoveryBody.data.recurringPayment.status).toBe("canceled");
    expect(createFeePaymentAdapterMock.mock.calls.length).toBe(
      feePaymentCallsBeforeStaleCancelRecovery
    );
    expect(createOrgSignerMock.mock.calls.length).toBe(signerCallsBeforeStaleCancelRecovery);
    const staleCancelAttempt = await getDb(env)
      .prepare(
        `SELECT status
           FROM payment_recurring_operation_attempts
          WHERE recurring_payment_id = ?
            AND operation = 'cancel'
          ORDER BY updated_at DESC
          LIMIT 1`
      )
      .bind(recurringPaymentId)
      .first<{ status: string }>();
    expect(staleCancelAttempt?.status).toBe("confirmed");

    const submittedCancelRecoveryAt = new Date().toISOString();
    await repositories.createPaymentRecurringPaymentsRepository(env).updateRecurringPayment({
      recurringPaymentId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "canceling",
      updatedAt: submittedCancelRecoveryAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).updateSubscription({
      subscriptionId: recurringSubscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "canceling",
      updatedAt: submittedCancelRecoveryAt,
    });
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_operation_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           operation,
           status,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, 'cancel', 'submitted', ?, ?, ?)`
      )
      .bind(
        "prlo_submitted_cancel_recovery",
        TEST_ORG.id,
        TEST_PROJECT.id,
        recurringPaymentId,
        `4${MOCK_SIGNATURE_TAIL}`,
        submittedCancelRecoveryAt,
        submittedCancelRecoveryAt
      )
      .run();
    const feePaymentCallsBeforeSubmittedCancelRecovery =
      createFeePaymentAdapterMock.mock.calls.length;
    const signerCallsBeforeSubmittedCancelRecovery = createOrgSignerMock.mock.calls.length;
    mockRecurringLifecycleSubscriptionState({
      planPda: recurringPlanPda,
      subscriptionPda: recurringSubscriptionPda,
      expiresAtTs: 1_800_000_000n,
    });
    await clearRateLimits();
    const submittedCancelRecoveryRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/cancel`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(submittedCancelRecoveryRes.status).toBe(200);
    const submittedCancelRecoveryBody = (await submittedCancelRecoveryRes.json()) as {
      data: { recurringPayment: { status: string } };
    };
    expect(submittedCancelRecoveryBody.data.recurringPayment.status).toBe("canceled");
    expect(createFeePaymentAdapterMock.mock.calls.length).toBe(
      feePaymentCallsBeforeSubmittedCancelRecovery
    );
    expect(createOrgSignerMock.mock.calls.length).toBe(signerCallsBeforeSubmittedCancelRecovery);
    const submittedCancelAttempt = await getDb(env)
      .prepare("SELECT status FROM payment_recurring_operation_attempts WHERE id = ?")
      .bind("prlo_submitted_cancel_recovery")
      .first<{ status: string }>();
    expect(submittedCancelAttempt?.status).toBe("confirmed");

    const staleSubmittedCancelAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await repositories.createPaymentRecurringPaymentsRepository(env).updateRecurringPayment({
      recurringPaymentId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "canceling",
      updatedAt: staleSubmittedCancelAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).updateSubscription({
      subscriptionId: recurringSubscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "canceling",
      canceledAt: null,
      updatedAt: staleSubmittedCancelAt,
    });
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_operation_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           operation,
           status,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, 'cancel', 'submitted', ?, ?, ?)`
      )
      .bind(
        "prlo_stale_submitted_cancel_expired",
        TEST_ORG.id,
        TEST_PROJECT.id,
        recurringPaymentId,
        `6${MOCK_SIGNATURE_TAIL}`,
        staleSubmittedCancelAt,
        staleSubmittedCancelAt
      )
      .run();
    const feePaymentCallsBeforeStaleSubmittedCancel = createFeePaymentAdapterMock.mock.calls.length;
    const signerCallsBeforeStaleSubmittedCancel = createOrgSignerMock.mock.calls.length;
    mockRecurringLifecycleSubscriptionState({
      planPda: recurringPlanPda,
      subscriptionPda: recurringSubscriptionPda,
      expiresAtTs: 0n,
      times: 2,
    });
    await clearRateLimits();
    const staleSubmittedCancelRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/cancel`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(staleSubmittedCancelRes.status).toBe(200);
    const staleSubmittedCancelBody = (await staleSubmittedCancelRes.json()) as {
      data: { recurringPayment: { status: string } };
    };
    expect(staleSubmittedCancelBody.data.recurringPayment.status).toBe("canceled");
    expect(createFeePaymentAdapterMock.mock.calls.length).toBeGreaterThan(
      feePaymentCallsBeforeStaleSubmittedCancel
    );
    expect(createOrgSignerMock.mock.calls.length).toBeGreaterThan(
      signerCallsBeforeStaleSubmittedCancel
    );
    const staleSubmittedCancelAttempts = await getDb(env)
      .prepare(
        `SELECT id, status
           FROM payment_recurring_operation_attempts
          WHERE recurring_payment_id = ?
            AND operation = 'cancel'
            AND id IN (?, ?)
          ORDER BY created_at ASC`
      )
      .bind(
        recurringPaymentId,
        "prlo_stale_submitted_cancel_expired",
        "prlo_submitted_cancel_recovery"
      )
      .all<{ id: string; status: string }>();
    expect(staleSubmittedCancelAttempts.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "prlo_stale_submitted_cancel_expired",
          status: "failed",
        }),
      ])
    );
    const latestStaleSubmittedCancelAttempt = await getDb(env)
      .prepare(
        `SELECT status
           FROM payment_recurring_operation_attempts
          WHERE recurring_payment_id = ?
            AND operation = 'cancel'
          ORDER BY updated_at DESC
          LIMIT 1`
      )
      .bind(recurringPaymentId)
      .first<{ status: string }>();
    expect(latestStaleSubmittedCancelAttempt?.status).toBe("confirmed");

    const repeatedCancelRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/cancel`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(repeatedCancelRes.status).toBe(200);
    const repeatedCancelBody = (await repeatedCancelRes.json()) as {
      data: { recurringPayment: { status: string } };
    };
    expect(repeatedCancelBody.data.recurringPayment.status).toBe("canceled");

    const signerCallsBeforeExpiredResume = createOrgSignerMock.mock.calls.length;
    const feeAdapterCallsBeforeExpiredResume = createFeePaymentAdapterMock.mock.calls.length;
    mockRecurringLifecycleSubscriptionState({
      planPda: recurringPlanPda,
      subscriptionPda: recurringSubscriptionPda,
      expiresAtTs: 1_700_000_000n,
    });
    const expiredResumeRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/resume`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(expiredResumeRes.status).toBe(400);
    const expiredResumeBody = (await expiredResumeRes.json()) as {
      error: { message: string };
    };
    expect(expiredResumeBody.error.message).toContain("already canceled on-chain");
    const expiredResumePayment = await repositories
      .createPaymentRecurringPaymentsRepository(env)
      .getRecurringPaymentById({
        recurringPaymentId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      });
    expect(expiredResumePayment?.status).toBe("canceled");
    expect(createOrgSignerMock.mock.calls.length).toBe(signerCallsBeforeExpiredResume);
    expect(createFeePaymentAdapterMock.mock.calls.length).toBe(feeAdapterCallsBeforeExpiredResume);

    const staleResumeDueAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const staleResumePeriodStartAt = new Date(
      new Date(staleResumeDueAt).getTime() - 24 * 60 * 60 * 1000
    ).toISOString();
    await repositories.createPaymentRecurringPaymentsRepository(env).updateRecurringPayment({
      recurringPaymentId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      nextCollectionDueAt: staleResumeDueAt,
      updatedAt: staleResumeDueAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).updateSubscription({
      subscriptionId: recurringSubscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      currentPeriodStartAt: staleResumePeriodStartAt,
      nextCollectionDueAt: staleResumeDueAt,
      updatedAt: staleResumeDueAt,
    });

    let failResumeLifecycleUpdate = true;
    const resumeLifecycleRepoSpy = vi
      .spyOn(repositories, "createPostgresPaymentRecurringPaymentsRepository")
      .mockImplementation((db) => {
        const repo = originalCreatePostgresRecurringPaymentsRepository(db);

        return {
          ...repo,
          updateRecurringPayment: vi.fn(async (input) => {
            if (
              failResumeLifecycleUpdate &&
              input.recurringPaymentId === recurringPaymentId &&
              input.status === "active"
            ) {
              failResumeLifecycleUpdate = false;
              throw new Error("simulated resume lifecycle DB failure");
            }

            return repo.updateRecurringPayment(input);
          }),
        };
      });
    mockRecurringLifecycleSubscriptionState({
      planPda: recurringPlanPda,
      subscriptionPda: recurringSubscriptionPda,
      expiresAtTs: 1_800_000_000n,
      times: 2,
    });
    let resumedDueAt = "";
    try {
      const recoveredResumeRes = await app.request(
        `/v1/payments/recurring-payments/${recurringPaymentId}/resume`,
        {
          method: "POST",
          headers: jsonHeaders,
          body: "{}",
        },
        env
      );
      expect(recoveredResumeRes.status).toBe(200);
      const recoveredResumeBody = (await recoveredResumeRes.json()) as {
        data: { recurringPayment: { status: string; nextCollectionDueAt: string | null } };
      };
      expect(recoveredResumeBody.data.recurringPayment.status).toBe("active");
      resumedDueAt = recoveredResumeBody.data.recurringPayment.nextCollectionDueAt ?? "";
      expect(new Date(resumedDueAt).getTime()).toBeGreaterThan(Date.now());
      expect(new Date(resumedDueAt).getTime()).toBeGreaterThan(
        new Date(staleResumeDueAt).getTime()
      );
    } finally {
      resumeLifecycleRepoSpy.mockRestore();
    }
    const resumedSubscription = await repositories
      .createPaymentSubscriptionsRepository(env)
      .getSubscriptionById({
        subscriptionId: recurringSubscriptionId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
      });
    expect(resumedSubscription?.next_collection_due_at).toBe(resumedDueAt);
    expect(resumedSubscription?.canceled_at).toBeNull();

    const repeatedResumeRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/resume`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(repeatedResumeRes.status).toBe(200);
    const repeatedResumeBody = (await repeatedResumeRes.json()) as {
      data: { recurringPayment: { status: string; nextCollectionDueAt: string | null } };
    };
    expect(repeatedResumeBody.data.recurringPayment.status).toBe("active");
    expect(repeatedResumeBody.data.recurringPayment.nextCollectionDueAt).toBe(resumedDueAt);

    const pausedUpdatedAt = new Date().toISOString();
    await repositories.createPaymentRecurringPaymentsRepository(env).updateRecurringPayment({
      recurringPaymentId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "paused",
      updatedAt: pausedUpdatedAt,
    });
    await repositories.createPaymentSubscriptionsRepository(env).updateSubscription({
      subscriptionId: recurringSubscriptionId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "paused",
      updatedAt: pausedUpdatedAt,
    });
    await clearRateLimits();

    mockRecurringLifecycleSubscriptionState({
      planPda: recurringPlanPda,
      subscriptionPda: recurringSubscriptionPda,
      expiresAtTs: 0n,
      times: 2,
    });
    const pausedCancelRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/cancel`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
      env
    );
    expect(pausedCancelRes.status).toBe(200);
    const pausedCancelBody = (await pausedCancelRes.json()) as {
      data: { recurringPayment: { status: string } };
    };
    expect(pausedCancelBody.data.recurringPayment.status).toBe("canceled");
  });

  it("exercises the recurring subscription lifecycle through SDP API routes", async () => {
    env.PAYMENTS_RECURRING_ENABLED = "true";
    const authHeaders = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
    };
    const jsonHeaders = {
      ...authHeaders,
      "Content-Type": "application/json",
    };
    const subscriberTokenAccount = TEST_SOLANA_ADDRESSES.wallet3;
    const currentPeriodStartAt = new Date().toISOString();
    const nextCollectionDueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const dueBefore = new Date(new Date(nextCollectionDueAt).getTime() + 60_000).toISOString();

    const counterpartyRes = await app.request(
      "/v1/counterparties",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          externalId: "subscription_counterparty_001",
          entityType: "individual",
          displayName: "Subscription API Counterparty",
          email: "subscription-counterparty@example.com",
        }),
      },
      env
    );

    expect(counterpartyRes.status).toBe(201);
    const counterpartyBody = (await counterpartyRes.json()) as {
      data: { counterparty: { id: string; status: string } };
    };
    const counterpartyId = counterpartyBody.data.counterparty.id;
    expect(counterpartyBody.data.counterparty.status).toBe("active");

    const activePlanCreateRes = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          ownerWalletId: TEST_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 720,
          status: "active",
        }),
      },
      env
    );
    expect(activePlanCreateRes.status).toBe(201);
    await clearRateLimits();

    const planRes = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          ownerWalletId: TEST_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 720,
          destinationAddress: TEST_SOLANA_ADDRESSES.wallet3,
          metadataUri: "https://sdp.dev/plan.json",
        }),
      },
      env
    );

    expect(planRes.status).toBe(201);
    const planBody = (await planRes.json()) as {
      data: {
        subscriptionPlan: {
          id: string;
          ownerWalletId: string;
          ownerAddress: string;
          amount: string;
          periodHours: number;
          programPlanId: string;
          planPda: string | null;
          status: string;
          metadataUri: string | null;
        };
      };
    };
    const planId = planBody.data.subscriptionPlan.id;
    expect(planBody.data.subscriptionPlan).toMatchObject({
      ownerWalletId: TEST_WALLET_ID,
      ownerAddress: TEST_SOLANA_ADDRESSES.wallet1,
      amount: "25.00",
      periodHours: 720,
      status: "draft",
      metadataUri: "https://sdp.dev/plan.json",
    });
    expect(planBody.data.subscriptionPlan.programPlanId).toMatch(/^\d+$/);

    const draftPlansRes = await app.request(
      "/v1/payments/subscription-plans?status=draft",
      {
        headers: authHeaders,
      },
      env
    );

    expect(draftPlansRes.status).toBe(200);
    const draftPlansBody = (await draftPlansRes.json()) as {
      data: { subscriptionPlans: Array<{ id: string }>; total: number };
    };
    expect(draftPlansBody.data.subscriptionPlans.map((plan) => plan.id)).toContain(planId);
    expect(draftPlansBody.data.total).toBe(1);

    const updatePlanRes = await app.request(
      `/v1/payments/subscription-plans/${planId}`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({
          metadataUri: "https://sdp.dev/plan-active.json",
          pullerWalletId: TEST_WALLET_ID,
          status: "active",
        }),
      },
      env
    );

    expect(updatePlanRes.status).toBe(200);
    const updatePlanBody = (await updatePlanRes.json()) as {
      data: {
        subscriptionPlan: {
          id: string;
          pullerWalletId: string | null;
          pullerAddress: string | null;
          metadataUri: string | null;
          status: string;
        };
      };
    };
    expect(updatePlanBody.data.subscriptionPlan).toMatchObject({
      id: planId,
      pullerWalletId: TEST_WALLET_ID,
      pullerAddress: TEST_SOLANA_ADDRESSES.wallet1,
      metadataUri: "https://sdp.dev/plan-active.json",
      status: "active",
    });

    const getPlanRes = await app.request(
      `/v1/payments/subscription-plans/${planId}`,
      {
        headers: authHeaders,
      },
      env
    );

    expect(getPlanRes.status).toBe(200);
    const getPlanBody = (await getPlanRes.json()) as {
      data: { subscriptionPlan: { id: string; status: string } };
    };
    expect(getPlanBody.data.subscriptionPlan).toMatchObject({
      id: planId,
      status: "active",
    });

    mockTokenSupplyDecimalsOnce();
    const preparePlanRes = await app.request(
      `/v1/payments/subscription-plans/${planId}/prepare-create`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          destinations: [TEST_SOLANA_ADDRESSES.wallet3],
          endTs: "1770000000",
          metadataUri: "https://sdp.dev/plan-chain.json",
          pullers: [TEST_SOLANA_ADDRESSES.wallet1],
        }),
      },
      env
    );

    expect(preparePlanRes.status).toBe(200);
    const preparePlanBody = (await preparePlanRes.json()) as {
      data: {
        planPda: string;
        subscriptionPlan: { id: string; planPda: string | null };
        preparedTransaction: {
          serialized: string;
          blockhash: string;
          lastValidBlockHeight: string;
          requiredSigners: string[];
        };
      };
    };
    expect(preparePlanBody.data.planPda).toBeTruthy();
    expect(preparePlanBody.data.subscriptionPlan.id).toBe(planId);
    expect(preparePlanBody.data.subscriptionPlan.planPda).toBe(preparePlanBody.data.planPda);
    expectPreparedSubscriptionTransaction(preparePlanBody.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet1,
      "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
    ]);

    const activePlansRes = await app.request(
      "/v1/payments/subscription-plans?status=active",
      {
        headers: authHeaders,
      },
      env
    );

    expect(activePlansRes.status).toBe(200);
    const activePlansBody = (await activePlansRes.json()) as {
      data: { subscriptionPlans: Array<{ id: string; planPda: string | null }>; total: number };
    };
    expect(activePlansBody.data.subscriptionPlans).toContainEqual(
      expect.objectContaining({ id: planId, planPda: preparePlanBody.data.planPda })
    );

    const activeWithoutProofRes = await app.request(
      "/v1/payments/subscriptions",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          planId,
          counterpartyId,
          subscriberAddress: TEST_SOLANA_ADDRESSES.wallet2,
          status: "active",
        }),
      },
      env
    );
    expect(activeWithoutProofRes.status).toBe(400);

    const compatibilityCounterpartyRes = await app.request(
      "/v1/counterparties",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          externalId: "subscription_counterparty_compat_001",
          entityType: "individual",
          displayName: "Subscription Compatibility Counterparty",
          email: "subscription-compat@example.com",
        }),
      },
      env
    );
    expect(compatibilityCounterpartyRes.status).toBe(201);
    const compatibilityCounterpartyBody = (await compatibilityCounterpartyRes.json()) as {
      data: { counterparty: { id: string } };
    };

    const pastNextCollectionAt = new Date(Date.now() - 60_000).toISOString();
    const activeWithPastDueRes = await app.request(
      "/v1/payments/subscriptions",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          planId,
          counterpartyId: compatibilityCounterpartyBody.data.counterparty.id,
          subscriberAddress: TEST_SOLANA_ADDRESSES.wallet2,
          subscriberTokenAccount,
          subscriptionPda: TEST_SOLANA_ADDRESSES.wallet1,
          subscriptionAuthorityAddress: TEST_SOLANA_ADDRESSES.wallet3,
          authorizationSignature: "sig_subscription_authorization_test",
          currentPeriodStartAt,
          nextCollectionDueAt: pastNextCollectionAt,
          status: "active",
        }),
      },
      env
    );
    expect(activeWithPastDueRes.status).toBe(201);
    const activeWithPastDueBody = (await activeWithPastDueRes.json()) as {
      data: { subscription: { id: string; nextCollectionDueAt: string | null } };
    };
    const compatibilitySubscriptionId = activeWithPastDueBody.data.subscription.id;
    expect(activeWithPastDueBody.data.subscription.nextCollectionDueAt).toBe(pastNextCollectionAt);

    const terminalCounterpartyId = await seedCounterparty({
      id: "cp_subscription_terminal_create_compat",
    });
    const terminalCreateRes = await app.request(
      "/v1/payments/subscriptions",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          planId,
          counterpartyId: terminalCounterpartyId,
          subscriberAddress: TEST_SOLANA_ADDRESSES.wallet2,
          status: "canceled",
        }),
      },
      env
    );
    expect(terminalCreateRes.status).toBe(201);
    const terminalCreateBody = (await terminalCreateRes.json()) as {
      data: { subscription: { status: string } };
    };
    expect(terminalCreateBody.data.subscription.status).toBe("canceled");
    await clearRateLimits();

    const subscriptionRes = await app.request(
      "/v1/payments/subscriptions",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          planId,
          counterpartyId,
          subscriberAddress: TEST_SOLANA_ADDRESSES.wallet2,
        }),
      },
      env
    );

    expect(subscriptionRes.status).toBe(201);
    const subscriptionBody = (await subscriptionRes.json()) as {
      data: {
        subscription: {
          id: string;
          planId: string;
          counterpartyId: string;
          subscriberAddress: string;
          subscriberTokenAccount: string | null;
          subscriptionPda: string | null;
          subscriptionAuthorityAddress: string | null;
          status: string;
          nextCollectionDueAt: string | null;
        };
      };
    };
    const subscriptionId = subscriptionBody.data.subscription.id;
    expect(subscriptionBody.data.subscription).toMatchObject({
      planId,
      counterpartyId,
      subscriberAddress: TEST_SOLANA_ADDRESSES.wallet2,
      subscriberTokenAccount: null,
      subscriptionPda: null,
      subscriptionAuthorityAddress: null,
      status: "pending_authorization",
    });
    expect(subscriptionBody.data.subscription.nextCollectionDueAt).toBeNull();

    await seedCachedKey({
      walletBindings: [
        { walletId: "wal_other_wallet", permissions: ["payments:read", "payments:write"] },
      ],
    });

    const scopedSubscriptionsRes = await app.request(
      `/v1/payments/subscriptions?planId=${planId}`,
      {
        headers: authHeaders,
      },
      env
    );
    expect(scopedSubscriptionsRes.status).toBe(200);
    const scopedSubscriptionsBody = (await scopedSubscriptionsRes.json()) as {
      data: { subscriptions: Array<{ id: string }>; total: number };
    };
    expect(scopedSubscriptionsBody.data.subscriptions).toEqual([]);
    expect(scopedSubscriptionsBody.data.total).toBe(0);

    const scopedGetSubscriptionRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}`,
      {
        headers: authHeaders,
      },
      env
    );
    expect(scopedGetSubscriptionRes.status).toBe(403);

    const scopedPatchSubscriptionRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({
          nextCollectionDueAt,
        }),
      },
      env
    );
    expect(scopedPatchSubscriptionRes.status).toBe(403);

    await clearRateLimits();
    await seedCachedKey({
      walletBindings: [
        { walletId: TEST_WALLET_ID, permissions: ["payments:read", "payments:write"] },
      ],
    });

    const listSubscriptionsRes = await app.request(
      `/v1/payments/subscriptions?planId=${planId}&counterpartyId=${counterpartyId}&status=pending_authorization`,
      {
        headers: authHeaders,
      },
      env
    );

    expect(listSubscriptionsRes.status).toBe(200);
    const listSubscriptionsBody = (await listSubscriptionsRes.json()) as {
      data: { subscriptions: Array<{ id: string }>; total: number };
    };
    expect(listSubscriptionsBody.data.subscriptions.map((subscription) => subscription.id)).toEqual(
      [subscriptionId]
    );
    expect(listSubscriptionsBody.data.total).toBe(1);

    const getSubscriptionRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}`,
      {
        headers: authHeaders,
      },
      env
    );

    expect(getSubscriptionRes.status).toBe(200);
    const getSubscriptionBody = (await getSubscriptionRes.json()) as {
      data: { subscription: { id: string; status: string } };
    };
    expect(getSubscriptionBody.data.subscription).toMatchObject({
      id: subscriptionId,
      status: "pending_authorization",
    });

    mockTokenSupplyDecimalsOnce();
    const prepareAuthorizationRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/prepare-authorization`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          expectedSubscriptionAuthorityInitId: "0",
          subscriberTokenAccount,
          expectedPlanCreatedAt: "1700000000",
        }),
      },
      env
    );

    expect(prepareAuthorizationRes.status).toBe(200);
    const prepareAuthorizationBody = (await prepareAuthorizationRes.json()) as {
      data: {
        subscriptionAuthorityAddress: string;
        subscriptionPda: string;
        subscription: {
          id: string;
          subscriberTokenAccount: string | null;
          subscriptionAuthorityAddress: string | null;
          subscriptionPda: string | null;
        };
        preparedTransaction: {
          serialized: string;
          blockhash: string;
          lastValidBlockHeight: string;
          requiredSigners: string[];
        };
      };
    };
    expect(prepareAuthorizationBody.data.subscription).toMatchObject({
      id: subscriptionId,
      subscriberTokenAccount,
      subscriptionAuthorityAddress: prepareAuthorizationBody.data.subscriptionAuthorityAddress,
      subscriptionPda: prepareAuthorizationBody.data.subscriptionPda,
    });
    expectPreparedSubscriptionTransaction(prepareAuthorizationBody.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet2,
      "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
    ]);

    const activateSubscriptionRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({
          authorizationSignature: "sig_subscription_authorization_test",
          currentPeriodStartAt,
          nextCollectionDueAt,
          status: "active",
        }),
      },
      env
    );

    expect(activateSubscriptionRes.status).toBe(200);
    const activateSubscriptionBody = (await activateSubscriptionRes.json()) as {
      data: {
        subscription: {
          id: string;
          authorizationSignature: string | null;
          currentPeriodStartAt: string | null;
          nextCollectionDueAt: string | null;
          status: string;
        };
      };
    };
    expect(activateSubscriptionBody.data.subscription).toMatchObject({
      id: subscriptionId,
      authorizationSignature: "sig_subscription_authorization_test",
      currentPeriodStartAt,
      nextCollectionDueAt,
      status: "active",
    });

    const pastDuePatchRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({
          nextCollectionDueAt: pastNextCollectionAt,
        }),
      },
      env
    );
    expect(pastDuePatchRes.status).toBe(200);
    const pastDuePatchBody = (await pastDuePatchRes.json()) as {
      data: { subscription: { nextCollectionDueAt: string | null } };
    };
    expect(pastDuePatchBody.data.subscription.nextCollectionDueAt).toBe(pastNextCollectionAt);
    await clearRateLimits();

    const dueSubscriptionsRes = await app.request(
      `/v1/payments/subscriptions?status=active&dueBefore=${encodeURIComponent(dueBefore)}`,
      {
        headers: authHeaders,
      },
      env
    );

    expect(dueSubscriptionsRes.status).toBe(200);
    const dueSubscriptionsBody = (await dueSubscriptionsRes.json()) as {
      data: { subscriptions: Array<{ id: string }>; total: number };
    };
    const dueSubscriptionIds = dueSubscriptionsBody.data.subscriptions.map(
      (subscription) => subscription.id
    );
    expect(dueSubscriptionIds).toHaveLength(2);
    expect(dueSubscriptionIds).toEqual(
      expect.arrayContaining([subscriptionId, compatibilitySubscriptionId])
    );
    expect(dueSubscriptionsBody.data.total).toBe(2);

    const prepareCancelRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/prepare-cancel`,
      {
        method: "POST",
        headers: authHeaders,
      },
      env
    );

    expect(prepareCancelRes.status).toBe(200);
    const prepareCancelBody = (await prepareCancelRes.json()) as {
      data: {
        subscription: { id: string };
        preparedTransaction: {
          serialized: string;
          blockhash: string;
          lastValidBlockHeight: string;
          requiredSigners: string[];
        };
      };
    };
    expect(prepareCancelBody.data.subscription.id).toBe(subscriptionId);
    expectPreparedSubscriptionTransaction(prepareCancelBody.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet2,
      "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
    ]);

    const prepareResumeRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/prepare-resume`,
      {
        method: "POST",
        headers: authHeaders,
      },
      env
    );

    expect(prepareResumeRes.status).toBe(200);
    const prepareResumeBody = (await prepareResumeRes.json()) as {
      data: {
        subscription: { id: string };
        preparedTransaction: {
          serialized: string;
          blockhash: string;
          lastValidBlockHeight: string;
          requiredSigners: string[];
        };
      };
    };
    expect(prepareResumeBody.data.subscription.id).toBe(subscriptionId);
    expectPreparedSubscriptionTransaction(prepareResumeBody.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet2,
      "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
    ]);

    mockTokenSupplyDecimalsOnce();
    const prepareCollectionRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/prepare-collection`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          amount: "10.50",
          receiverTokenAccount: TEST_SOLANA_ADDRESSES.wallet3,
        }),
      },
      env
    );

    expect(prepareCollectionRes.status).toBe(200);
    const prepareCollectionBody = (await prepareCollectionRes.json()) as {
      data: {
        subscription: { id: string };
        preparedTransaction: {
          serialized: string;
          blockhash: string;
          lastValidBlockHeight: string;
          requiredSigners: string[];
        };
      };
    };
    expect(prepareCollectionBody.data.subscription.id).toBe(subscriptionId);
    expectPreparedSubscriptionTransaction(prepareCollectionBody.data.preparedTransaction, [
      TEST_SOLANA_ADDRESSES.wallet1,
      "7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv",
    ]);

    const confirmedAttemptRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/collection-attempts`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          amount: "10.50",
          dueAt: nextCollectionDueAt,
          signature: "sig_collection_attempt_test",
          status: "confirmed",
        }),
      },
      env
    );
    expect(confirmedAttemptRes.status).toBe(400);

    const attemptRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/collection-attempts`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          amount: "10.50",
          dueAt: nextCollectionDueAt,
          metadata: { source: "api-lifecycle-test" },
        }),
      },
      env
    );

    expect(attemptRes.status).toBe(201);
    const attemptBody = (await attemptRes.json()) as {
      data: {
        collectionAttempt: {
          id: string;
          subscriptionId: string;
          amount: string;
          token: string;
          status: string;
          signature: string | null;
          metadata: Record<string, unknown>;
        };
      };
    };
    expect(attemptBody.data.collectionAttempt).toMatchObject({
      subscriptionId,
      amount: "10.50",
      token: DEVNET_USDC_MINT,
      status: "pending",
      signature: null,
      metadata: { source: "api-lifecycle-test" },
    });

    const attemptsRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/collection-attempts?status=pending`,
      {
        headers: authHeaders,
      },
      env
    );

    expect(attemptsRes.status).toBe(200);
    const attemptsBody = (await attemptsRes.json()) as {
      data: {
        collectionAttempts: Array<{ id: string; subscriptionId: string; status: string }>;
        total: number;
      };
    };
    expect(attemptsBody.data.collectionAttempts).toEqual([
      expect.objectContaining({
        id: attemptBody.data.collectionAttempt.id,
        subscriptionId,
        status: "pending",
      }),
    ]);
    expect(attemptsBody.data.total).toBe(1);

    const pastSubscriptionDueAt = new Date(Date.now() - 60_000).toISOString();
    const pastDueUpdateRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({
          nextCollectionDueAt: pastSubscriptionDueAt,
        }),
      },
      env
    );
    expect(pastDueUpdateRes.status).toBe(200);
    const pastDueUpdateBody = (await pastDueUpdateRes.json()) as {
      data: { subscription: { nextCollectionDueAt: string | null } };
    };
    expect(pastDueUpdateBody.data.subscription.nextCollectionDueAt).toBe(pastSubscriptionDueAt);

    const cancelSubscriptionRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({
          status: "canceled",
        }),
      },
      env
    );
    expect(cancelSubscriptionRes.status).toBe(200);
    const cancelSubscriptionBody = (await cancelSubscriptionRes.json()) as {
      data: { subscription: { status: string } };
    };
    expect(cancelSubscriptionBody.data.subscription.status).toBe("canceled");

    const backdatedCanceledAtRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({
          canceledAt: "2026-02-03T00:00:00.000Z",
        }),
      },
      env
    );
    expect(backdatedCanceledAtRes.status).toBe(400);

    const clearCanceledAtRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({
          canceledAt: null,
        }),
      },
      env
    );
    expect(clearCanceledAtRes.status).toBe(400);
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
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          fiatAmount: "120.50",
          redirectUrl: "https://example.com/onramp-done",
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
    expect(hostedUrl.searchParams.get("currencyCode")).toBe("usdc_sol");
    expect(hostedUrl.searchParams.get("walletAddress")).toBe(TEST_SOLANA_ADDRESSES.wallet1);
    expect(hostedUrl.searchParams.get("redirectURL")).toBe("https://example.com/onramp-done");
    expect(hostedUrl.searchParams.get(MOONPAY_PARAM_EXTERNAL_CUSTOMER_ID)).toBe("moonpay_user_123");
    expect(hostedUrl.searchParams.get("externalTransactionId")).toBe(body.data.quote.id);
    assertMoonPaySignature(hostedUrl);
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

  it("onboards a BVNK customer and provisions the on-ramp rule through execute", async () => {
    const counterpartyId = await seedCounterparty({
      externalId: "bvnk_user_123",
      identity: {
        firstName: "Zach",
        lastName: "Khong",
        dateOfBirth: "1990-01-01",
        address: {
          line1: "Ave Street",
          city: "NYC",
          postalCode: "10001",
          countryCode: "US",
          subdivisionCode: "NY",
        },
        compliance: {
          taxIdentification: { number: "123-45-6789", residenceCountryCode: "US" },
          nationality: "US",
          birthCountryCode: "US",
          cdd: {
            employmentStatus: "SALARIED",
            sourceOfFunds: "SALARY",
            pepStatus: "NOT_PEP",
            intendedUseOfAccount: "TRANSFERS_OWN_WALLET",
            expectedMonthlyVolume: { amount: "1000", currency: "USD" },
            estimatedYearlyIncome: "INCOME_0_TO_50K",
            employmentIndustrySector: "INFORMATION",
          },
        },
      },
    });

    const jsonResponse = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/platform/v1/customers/agreement/sessions") && method === "POST") {
        return Promise.resolve(jsonResponse({ reference: "agr_1", agreements: [] }, 201));
      }
      if (url.includes("/platform/v1/customers/agreement/sessions/") && method === "PUT") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.endsWith("/platform/v1/customers") && method === "POST") {
        return Promise.resolve(jsonResponse({ reference: "cust_1", status: "VERIFIED" }, 201));
      }
      if (url.includes("/ledger/v2/wallets/profiles") && method === "GET") {
        return Promise.resolve(
          jsonResponse({
            content: [{ id: "fiat:usd:test", currencies: ["USD"], methods: ["ACH", "SWIFT"] }],
          })
        );
      }
      if (url.endsWith("/ledger/v2/wallets") && method === "POST") {
        return Promise.resolve(
          jsonResponse(
            {
              id: "wallet_1",
              name: "SDP onramp",
              status: "ACTIVE",
              paymentInstruments: [
                {
                  type: "FIAT",
                  accountNumber: "000123456789",
                  remittanceInformationPrefix: "REF-1",
                  bankDetails: { name: "BVNK Bank", bic: "BVNKUS33" },
                },
              ],
            },
            201
          )
        );
      }
      if (url.endsWith("/payment/v1/rules") && method === "POST") {
        return Promise.resolve(
          jsonResponse({
            id: "rule_bvnk_123",
            reference: "bvnk_reference_onramp",
            status: "ACTIVE",
            originator: { currency: "USD", walletId: "wallet_1" },
          })
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
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
          provider: "bvnk",
          counterpartyId,
          destinationWallet: TEST_WALLET_ID,
          cryptoToken: "USDC",
          fiatCurrency: "USD",
          fiatAmount: "120.50",
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
          reference: string;
          paymentInstructions: {
            provider: string;
            onboardingStatus: string;
            ruleId: string;
            fundingWalletId: string;
            fiatCurrency: string;
            beneficiaryAddress: string;
            network: string;
            bankAccount?: { accountNumber?: string; bankName?: string };
          }[];
        };
      };
    };

    expect(body.data.ramp.provider).toBe("bvnk");
    expect(body.data.ramp.status).toBe("pending");
    const instruction = body.data.ramp.paymentInstructions[0];
    expect(instruction?.provider).toBe("bvnk");
    expect(instruction?.onboardingStatus).toBe("ready");
    expect(instruction?.ruleId).toBe("rule_bvnk_123");
    expect(instruction?.fundingWalletId).toBe("wallet_1");
    expect(instruction?.fiatCurrency).toBe("USD");
    expect(instruction?.beneficiaryAddress).toBe(TEST_SOLANA_ADDRESSES.wallet1);
    expect(instruction?.network).toBe("SOLANA");
    expect(instruction?.bankAccount?.accountNumber).toBe("000123456789");
    expect(instruction?.bankAccount?.bankName).toBe("BVNK Bank");

    const calledUrls = fetchSpy.mock.calls.map((call) => String(call[0]));
    expect(calledUrls).toContain(`${TEST_BVNK_API_BASE_URL}/payment/v1/rules`);
    expect(calledUrls).toContain(`${TEST_BVNK_API_BASE_URL}/ledger/v2/wallets`);

    const ruleCall = fetchSpy.mock.calls.find((call) =>
      String(call[0]).endsWith("/payment/v1/rules")
    );
    const ruleInit = ruleCall?.[1];
    expect((ruleInit?.headers as Record<string, string>).Authorization).toMatch(/^Hawk /);
    const payload = JSON.parse(String(ruleInit?.body)) as {
      trigger: string;
      walletId: string;
      beneficiary: {
        currency: string;
        entity: { type: string; customerIdentifier: string; address: { countryCode: string } };
        cryptoAddress: { network: string; address: string };
      };
    };
    expect(payload.trigger).toBe("payment:payin:fiat");
    expect(payload.walletId).toBe("wallet_1");
    expect(payload.beneficiary.currency).toBe("USDC");
    expect(payload.beneficiary.entity.customerIdentifier).toBe("cust_1");
    expect(payload.beneficiary.cryptoAddress.address).toBe(TEST_SOLANA_ADDRESSES.wallet1);

    const walletCall = fetchSpy.mock.calls.find((call) =>
      String(call[0]).endsWith("/ledger/v2/wallets")
    );
    expect((walletCall?.[1]?.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
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
      complianceDetails: { partyDetails: Record<string, unknown>[] };
    };
    expect(estimatePayload.walletId).toBe(TEST_BVNK_WALLET_ID);
    expect(estimatePayload.walletCurrency).toBe("USD");
    expect(estimatePayload.paidCurrency).toBe("USDC");
    expect(estimatePayload.paidRequiredAmount).toBe(75.25);
    expect(estimatePayload.network).toBe("SOLANA");
    expect(estimatePayload.complianceDetails.partyDetails).toHaveLength(1);

    const acceptPayload = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)) as {
      customerId: string;
      payOutDetails: { currency: string; address: string; network: string };
      complianceDetails: { partyDetails: Record<string, unknown>[] };
    };
    expect(acceptPayload.customerId).toBe("customer_456");
    expect(acceptPayload.payOutDetails.currency).toBe("USDC");
    expect(acceptPayload.payOutDetails.address).toBe(TEST_SOLANA_ADDRESSES.wallet1);
    expect(acceptPayload.payOutDetails.network).toBe("SOLANA");
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

    it("rejects MagicBlock execution when gasless sponsorship is explicitly disabled", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

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
                  gasless: false,
                },
              },
            }),
          },
          env
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("BAD_REQUEST");
        expect(body.error.message).toContain("requires gasless transactions");
        expect(fetchSpy).not.toHaveBeenCalled();
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
          gasless: true,
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("replaces a MagicBlock gasless sponsor signer with Kora during execution", async () => {
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
              feePayer: TEST_MAGICBLOCK_SPONSOR_FEE_PAYER,
              source: sourceSigner.address,
            }),
            sendTo: "base",
            recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
            lastValidBlockHeight: 123456,
            instructionCount: 5,
            requiredSigners: [TEST_MAGICBLOCK_SPONSOR_FEE_PAYER, sourceSigner.address],
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
              amount: "5",
              privateTransfer: {
                provider: "magicblock",
                magicBlock: {},
              },
            }),
          },
          env
        );

        expect(res.status).toBe(200);
        expect(signAndSendMock).toHaveBeenCalledTimes(1);
        const [encodedTransaction] = signAndSendMock.mock.calls[0] ?? [];
        const transaction = getTransactionDecoder().decode(encodedTransaction as Uint8Array);
        const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
        expect(message.staticAccounts[0]).toBe(TEST_KORA_FEE_PAYER);
        expect(message.staticAccounts[1]).toBe(sourceSigner.address);
        expect(message.staticAccounts).not.toContain(TEST_MAGICBLOCK_SPONSOR_FEE_PAYER);
        expect(Object.keys(transaction.signatures)).toContain(TEST_KORA_FEE_PAYER);
        expect(Object.keys(transaction.signatures)).toContain(sourceSigner.address);
        expect(Object.keys(transaction.signatures)).not.toContain(
          TEST_MAGICBLOCK_SPONSOR_FEE_PAYER
        );
        const [, init] = fetchSpy.mock.calls[0] ?? [];
        const providerPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(providerPayload).toMatchObject({
          from: sourceSigner.address,
          visibility: "private",
          fromBalance: "base",
          toBalance: "base",
          gasless: true,
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

    it("returns 404 when the transfer belongs to a different project in the same org", async () => {
      const otherProjectId = "prj_payments_cross_project";
      const now = new Date().toISOString();

      await getDb(env)
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          otherProjectId,
          TEST_ORG.id,
          "Other Payments Project",
          "other-payments-project",
          "sandbox",
          "active",
          TEST_USER.id
        )
        .run();

      await getDb(env)
        .prepare(
          `INSERT INTO payment_transfers
             (id, organization_id, project_id, wallet_id, source_address, destination_address, token, amount, memo, type, direction, status, signature, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          "xfr_cross_project_iso",
          TEST_ORG.id,
          otherProjectId,
          TEST_WALLET_ID,
          TEST_SOLANA_ADDRESSES.wallet1,
          TEST_SOLANA_ADDRESSES.wallet2,
          "SOL",
          "1",
          null,
          "transfer",
          "outbound",
          "confirmed",
          null,
          now,
          now
        )
        .run();

      const res = await app.request(
        "/v1/payments/transfers/xfr_cross_project_iso",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(404);
    });
  });
});
