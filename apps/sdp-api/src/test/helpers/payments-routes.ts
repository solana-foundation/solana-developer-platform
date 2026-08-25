import { createHash } from "node:crypto";
import * as feePaymentAdapters from "@sdp/payments/fee-payment";
import { hashString } from "@sdp/payments/hash";
import * as solanaRpc from "@sdp/rpc/solana";
import { type CachedApiKey, WELL_KNOWN_TOKENS } from "@sdp/types";
import { getBase58Codec } from "@solana/codecs";
import {
  address,
  createNoopSigner,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  type Signature,
  type SignatureBytes,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
} from "@solana/kit";
import * as subscriptionsProgram from "@solana/subscriptions";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { afterEach, beforeEach, vi } from "vitest";
import { getDb } from "@/db";
import * as tokenAccounts from "@/routes/payments/token-accounts";
import * as solanaServices from "@/services/solana";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

export const createRpcMock = vi.spyOn(solanaRpc, "createRpc");

export const getAccountInfoMock = vi.spyOn(solanaRpc, "getAccountInfo");

export const getRecentBlockhashMock = vi.spyOn(solanaRpc, "getRecentBlockhash");

export const confirmTransactionMock = vi.spyOn(solanaRpc, "confirmTransaction");

export const getTransactionMock = vi.spyOn(solanaRpc, "getTransaction");

export const sendAndConfirmTransactionMock = vi.spyOn(solanaRpc, "sendAndConfirmTransaction");

export const sendTransactionMock = vi.spyOn(solanaRpc, "sendTransaction");

export const getSignaturesForAddressMock = vi.spyOn(solanaRpc, "getSignaturesForAddress");

export const getSplTokenBalancesMock = vi.spyOn(tokenAccounts, "getSplTokenBalances");

export const getSplTokenAccountAddressesMock = vi.spyOn(
  tokenAccounts,
  "getSplTokenAccountAddresses"
);

export const createFeePaymentAdapterMock = vi.spyOn(feePaymentAdapters, "createFeePaymentAdapter");

export const createOrgSignerMock = vi.spyOn(solanaServices, "createOrgSigner");

const fetchMaybePlanMock = vi.spyOn(subscriptionsProgram, "fetchMaybePlan");

const fetchMaybeSubscriptionAuthorityMock = vi.spyOn(
  subscriptionsProgram,
  "fetchMaybeSubscriptionAuthority"
);

export const fetchMaybeSubscriptionDelegationMock = vi.spyOn(
  subscriptionsProgram,
  "fetchMaybeSubscriptionDelegation"
);

export const TEST_CONFIG_ID = "cust_cfg_payments_test";

export const TEST_CUSTODY_WALLET_ID = "cwlt_payments_test";

export const TEST_WALLET_ID = "wal_payments_test";

export const TEST_ORG = {
  id: "org_payments_policy_test",
  name: "Payments Policy Test Org",
  slug: "payments-policy-test-org",
};

export const TEST_PROJECT = {
  id: "prj_test_payments_policy",
  slug: "test-payments-policy-project",
};

export const TEST_USER = {
  id: "usr_payments_policy_test",
  email: "payments-policy-test@example.com",
};

export const TEST_API_KEY = {
  id: "key_payments_policy_test",
  raw: "sk_test_payments_policy",
  prefix: "sk_test_pay",
};

export const TEST_KORA_FEE_PAYER = "4YhMUz8xDgHMPAevvfMpnJX9TJmw9DTNDA1sNWPRZG9q";

export const TEST_SPONSORSHIP_PROVIDER_CONFIG = {
  signerAddress: address(TEST_KORA_FEE_PAYER),
  maxAllowedLamports: 0n,
  feePayerMayTransferLamports: false,
  feePayerPolicy: { test: "zero-outflow" },
} satisfies feePaymentAdapters.SponsorshipProviderConfiguration;

export function sendTransactionPreflightError(customProgramErrorCode?: number): SolanaError {
  const cause =
    customProgramErrorCode === undefined
      ? undefined
      : new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, {
          code: customProgramErrorCode,
          index: 0,
        });
  return new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
    accounts: null,
    fee: null,
    loadedAccountsDataSize: null,
    loadedAddresses: null,
    logs: null,
    postBalances: null,
    postTokenBalances: null,
    preBalances: null,
    preTokenBalances: null,
    replacementBlockhash: null,
    returnData: null,
    unitsConsumed: null,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function fullySignTestTransaction(transactionBytes: Uint8Array): Uint8Array {
  const transaction = getTransactionDecoder().decode(transactionBytes);
  const signatureSeed = createHash("sha512")
    .update(new Uint8Array(transaction.messageBytes))
    .digest();
  const signatures = Object.fromEntries(
    Object.entries(transaction.signatures).map(([signer, signature], index) => [
      signer,
      signature ?? (new Uint8Array(signatureSeed.map((byte) => byte ^ index)) as SignatureBytes),
    ])
  ) as typeof transaction.signatures;
  return new Uint8Array(getTransactionEncoder().encode({ ...transaction, signatures }));
}

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

export const TEST_MOONPAY_API_KEY = "pk_test_moonpay";

export const TEST_MOONPAY_SECRET_KEY = "moonpay_secret_key";

export const TEST_MOONPAY_ONRAMP_URL = "https://buy-sandbox.moonpay.com";

const TEST_MOONPAY_OFFRAMP_URL = "https://sell-sandbox.moonpay.com";

const TEST_LIGHTSPARK_GRID_CLIENT_ID = "lightspark_token_id";

const TEST_LIGHTSPARK_GRID_CLIENT_SECRET = "lightspark_client_secret";

export const TEST_BVNK_HAWK_AUTH_ID = "bvnk_hawk_auth_id";

const TEST_BVNK_HAWK_SECRET_KEY = "bvnk_hawk_secret_key";

const TEST_BVNK_WALLET_ID = "a:24122329329347:HsdJVhW:1";

export const TEST_BVNK_API_BASE_URL = "https://api.sandbox.bvnk.test";

export const DEVNET_USDC_MINT = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;

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

export async function updateSeededWalletPublicKey(publicKey: string): Promise<void> {
  await getDb(env)
    .prepare("UPDATE custody_wallets SET public_key = ? WHERE wallet_id = ?")
    .bind(publicKey, TEST_WALLET_ID)
    .run();
}

export async function seedCachedKey(override: Partial<CachedApiKey>): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, {
    ...TEST_CACHED_API_KEY,
    ...override,
  });
}

export async function seedCounterparty(params?: {
  id?: string;
  externalId?: string | null;
  identity?: Record<string, unknown>;
  providerData?: Record<string, unknown>;
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
      params?.providerData ?? {},
      TEST_USER.id
    )
    .run();

  return id;
}

export function mockTokenSupplyDecimalsOnce(decimals = 6): void {
  createRpcMock.mockReturnValueOnce({
    getTokenSupply: () => ({
      send: async () => ({ value: { decimals } }),
    }),
    getFeeForMessage: () => ({
      send: async () => ({ value: 5000n }),
    }),
  } as unknown as ReturnType<typeof solanaRpc.createRpc>);
}

export function mockRecurringActivationRpc(options?: {
  tokenAccounts?: Array<{
    pubkey: string;
    mint: string;
    amount: string;
    decimals: number;
    uiAmountString: string;
  }>;
}) {
  const tokenAccounts = options?.tokenAccounts ?? [
    {
      pubkey: TEST_SOLANA_ADDRESSES.wallet3,
      mint: DEVNET_USDC_MINT,
      amount: "1000000000",
      decimals: 6,
      uiAmountString: "1000",
    },
  ];

  createRpcMock.mockReturnValue({
    getTokenAccountsByOwner: () => ({
      send: async () => ({
        value: tokenAccounts.map((account) => ({
          pubkey: account.pubkey,
          account: {
            data: {
              parsed: {
                info: {
                  mint: account.mint,
                  tokenAmount: {
                    amount: account.amount,
                    decimals: account.decimals,
                    uiAmountString: account.uiAmountString,
                  },
                },
              },
            },
          },
        })),
      }),
    }),
    getTokenSupply: () => ({
      send: async () => ({
        value: {
          decimals: 6,
        },
      }),
    }),
    getFeeForMessage: () => ({
      send: async () => ({ value: 5000n }),
    }),
  } as unknown as ReturnType<typeof solanaRpc.createRpc>);
}

export async function recurringCollectionTransactionForSignature(signature: Signature) {
  const row = await getDb(env)
    .prepare(
      `SELECT t.source_address,
              t.token,
              t.amount,
              r.plan_pda,
              r.subscription_pda,
              r.destination_address,
              r.destination_token_account,
              s.subscription_authority_address,
              s.subscriber_token_account
         FROM payment_transfers t
         JOIN payment_recurring_payments r
           ON r.id = t.provider_data->>'recurringPaymentId'
          AND r.organization_id = t.organization_id
          AND r.project_id = t.project_id
         JOIN payment_subscriptions s
           ON s.id = r.subscription_id
          AND s.organization_id = r.organization_id
          AND s.project_id = r.project_id
        WHERE t.signature = ?
           OR EXISTS (
             SELECT 1
               FROM payment_subscription_collection_attempts a
              WHERE a.transfer_id = t.id
                AND a.organization_id = t.organization_id
                AND a.project_id = t.project_id
                AND a.signature = ?
           )`
    )
    .bind(signature, signature)
    .first<{
      source_address: string;
      token: string;
      amount: string;
      plan_pda: string;
      subscription_pda: string;
      destination_address: string;
      destination_token_account: string | null;
      subscription_authority_address: string;
      subscriber_token_account: string;
    }>();
  if (!row) {
    return null;
  }

  const [derivedDestinationTokenAccount] = await findAssociatedTokenPda({
    owner: address(row.destination_address),
    tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    mint: address(row.token),
  });
  const destinationTokenAccount = row.destination_token_account ?? derivedDestinationTokenAccount;

  const amountBaseUnits = BigInt(row.amount.replace(".", "").padEnd(8, "0"));
  const instructionData = subscriptionsProgram
    .getTransferSubscriptionInstructionDataEncoder()
    .encode({
      transferData: {
        amount: amountBaseUnits,
        delegator: address(row.source_address),
        mint: address(row.token),
      },
    });
  return {
    slot: 100n,
    err: null,
    instructions: [
      {
        programId: subscriptionsProgram.SUBSCRIPTIONS_PROGRAM_ADDRESS,
        accounts: [
          row.subscription_pda,
          row.plan_pda,
          row.subscription_authority_address,
          row.subscriber_token_account,
          destinationTokenAccount,
          row.source_address,
          row.token,
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          "3Hnj4BYoDgtpBuqXfiy7Y8cNa3jXaNd4oqgSXBzkMcH7",
          subscriptionsProgram.SUBSCRIPTIONS_PROGRAM_ADDRESS,
        ],
        data: getBase58Codec().decode(instructionData),
        parsedType: null,
        info: null,
      },
    ],
  } satisfies solanaRpc.ParsedTransaction;
}

/**
 * Installs the shared payments route test hooks.
 */
export function installPaymentsRouteTestHooks(): void {
  beforeEach(async () => {
    vi.clearAllMocks();

    createRpcMock.mockReturnValue({
      getTokenSupply: () => ({
        send: async () => ({ value: { decimals: 6 } }),
      }),
      getFeeForMessage: () => ({
        send: async () => ({ value: 5000n }),
      }),
    } as unknown as ReturnType<typeof solanaRpc.createRpc>);
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
    getTransactionMock.mockImplementation(async (_rpc, signature) =>
      recurringCollectionTransactionForSignature(signature)
    );
    sendAndConfirmTransactionMock.mockResolvedValue({
      signature:
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Awaited<
          ReturnType<typeof solanaRpc.sendAndConfirmTransaction>
        >["signature"],
      slot: 100n,
      confirmationStatus: "confirmed",
      err: null,
    });
    sendTransactionMock.mockImplementation(async (_rpc, transactionBytes) =>
      getSignatureFromTransaction(getTransactionDecoder().decode(transactionBytes))
    );
    getSignaturesForAddressMock.mockResolvedValue([]);
    getSplTokenBalancesMock.mockResolvedValue([]);
    getSplTokenAccountAddressesMock.mockResolvedValue([]);
    fetchMaybePlanMock.mockResolvedValue({
      exists: true,
      address: address(TEST_SOLANA_ADDRESSES.wallet3),
      data: {
        status: subscriptionsProgram.PlanStatus.Active,
        data: {
          endTs: 0n,
          metadataUri: "",
          pullers: [address(TEST_SOLANA_ADDRESSES.wallet1)],
          terms: { createdAt: 1_770_000_000n },
        },
      },
    } as Awaited<ReturnType<typeof subscriptionsProgram.fetchMaybePlan>>);
    fetchMaybeSubscriptionAuthorityMock.mockResolvedValue({
      exists: true,
      address: address(TEST_SOLANA_ADDRESSES.wallet3),
      data: { initId: 1n },
    } as Awaited<ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionAuthority>>);
    fetchMaybeSubscriptionDelegationMock.mockResolvedValue({
      exists: true,
      address: address(TEST_SOLANA_ADDRESSES.wallet3),
      data: { expiresAtTs: 1_800_000_000n },
    } as Awaited<ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionDelegation>>);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue({
        ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
        signerAddress: address("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
      }),
      signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
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

    await clearKVStores(env);
  });
}
