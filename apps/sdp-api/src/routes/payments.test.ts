import { createHmac } from "node:crypto";
import * as feePaymentAdapters from "@sdp/payments/fee-payment";
import { hashString } from "@sdp/payments/hash";
import * as solanaRpc from "@sdp/rpc/solana";
import {
  type CachedApiKey,
  type PolicyDefaultAction,
  type PolicyRule,
  type TokenStatus,
  WELL_KNOWN_TOKENS,
} from "@sdp/types";
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
import * as subscriptionsProgram from "@solana/subscriptions";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresPolicyRepository } from "@/db/repositories";
import app from "@/index";
import * as tokenAccounts from "@/routes/payments/token-accounts";
import * as solanaServices from "@/services/solana";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

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
const fetchMaybePlanMock = vi.spyOn(subscriptionsProgram, "fetchMaybePlan");
const fetchMaybeSubscriptionAuthorityMock = vi.spyOn(
  subscriptionsProgram,
  "fetchMaybeSubscriptionAuthority"
);
const fetchMaybeSubscriptionDelegationMock = vi.spyOn(
  subscriptionsProgram,
  "fetchMaybeSubscriptionDelegation"
);

const TEST_CONFIG_ID = "cust_cfg_payments_test";
const TEST_CUSTODY_WALLET_ID = "cwlt_payments_test";
const TEST_WALLET_ID = "wal_payments_test";
const TEST_ADDITIONAL_CUSTODY_WALLET_ID = "cwlt_payments_additional_test";
const TEST_ADDITIONAL_WALLET_ID = "wal_payments_additional_test";
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
const TEST_COUNTERPARTY_IDENTITY = {
  firstName: "Ada",
  lastName: "Lovelace",
  dateOfBirth: "1990-01-15",
  phone: "+14155551234",
  address: {
    line1: "1 Market St",
    city: "San Francisco",
    countryCode: "US",
  },
} as const;
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
const TEST_BVNK_HAWK_AUTH_ID = "bvnk_hawk_auth_id";
const TEST_BVNK_HAWK_SECRET_KEY = "bvnk_hawk_secret_key";
const TEST_BVNK_WALLET_ID = "a:24122329329347:HsdJVhW:1";
const TEST_BVNK_OFFRAMP_WALLET_ID = "a:99887766554433:OffRmpW:1";
const TEST_BVNK_API_BASE_URL = "https://api.sandbox.bvnk.test";
const TEST_MAGICBLOCK_API_BASE_URL = "https://payments.magicblock.test";
const TEST_MAGICBLOCK_SPONSOR_FEE_PAYER = "CrankS2fXgMGvQJ3VBrZmRfGrfogDY6pq5YcgkPEpSNf";
const DEVNET_USDC_MINT = WELL_KNOWN_TOKENS.USDC.mints.devnet;
const MOONPAY_PARAM_BASE_CURRENCY_AMOUNT = "baseCurrencyAmount";
const MOONPAY_PARAM_EXTERNAL_CUSTOMER_ID = "externalCustomerId";

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

function mockMagicBlockAdditionalSignerResponse(
  sourceAddress: string,
  additionalSignerAddress: string
) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        kind: "transfer",
        version: "v0",
        transactionBase64: buildMagicBlockTestTransactionBase64({
          source: sourceAddress,
          additionalSigner: additionalSignerAddress,
        }),
        sendTo: "base",
        recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
        lastValidBlockHeight: 123456,
        instructionCount: 4,
        requiredSigners: [sourceAddress, additionalSignerAddress],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    )
  );
}

async function requestMagicBlockPrivateTransfer(): Promise<Response> {
  return app.request(
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
}

async function updateSeededWalletPublicKey(publicKey: string): Promise<void> {
  await getDb(env)
    .prepare("UPDATE custody_wallets SET public_key = ? WHERE wallet_id = ?")
    .bind(publicKey, TEST_WALLET_ID)
    .run();
}

async function seedAdditionalCustodyWallet(publicKey: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_wallets
         (id, custody_config_id, wallet_id, public_key, label, purpose, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      TEST_ADDITIONAL_CUSTODY_WALLET_ID,
      TEST_CONFIG_ID,
      TEST_ADDITIONAL_WALLET_ID,
      publicKey,
      "Additional Payments Wallet",
      "transfer",
      "active"
    )
    .run();
}

async function seedAdditionalWalletDestinationPolicy(
  destinationAllowlist: string[]
): Promise<void> {
  const now = new Date().toISOString();
  await getDb(env)
    .prepare(
      `INSERT INTO payment_wallet_policies
         (id, custody_wallet_id, policy_type, policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      "pwp_additional_allowlist_test",
      TEST_ADDITIONAL_CUSTODY_WALLET_ID,
      "destination_allowlist",
      JSON.stringify({
        version: 1,
        destinationAllowlist,
      }),
      now,
      now
    )
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

async function seedWalletControlProfile(params: {
  rules: PolicyRule[];
  defaultAction?: PolicyDefaultAction;
}): Promise<void> {
  const repo = createPostgresPolicyRepository(getDb(env));
  const profile = await repo.createWalletControlProfile({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    custodyWalletId: TEST_CUSTODY_WALLET_ID,
    name: "Payment controls",
    createdBy: TEST_USER.id,
  });

  if (!profile) {
    throw new Error("Failed to create wallet control profile");
  }

  const revision = await repo.createWalletControlProfileRevision({
    profileId: profile.id,
    rules: params.rules,
    defaultAction: params.defaultAction,
    createdBy: TEST_USER.id,
  });

  if (!revision) {
    throw new Error("Failed to create wallet control profile revision");
  }

  await repo.activateWalletControlProfileRevision({
    profileId: profile.id,
    revisionId: revision.id,
  });
}

async function seedCounterparty(params?: {
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

async function seedCryptoWalletCounterpartyAccount(params: {
  counterpartyId: string;
  address: string;
}): Promise<string> {
  const id = `counterparty_account_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  await getDb(env)
    .prepare(
      `INSERT INTO counterparty_accounts (
         id,
         organization_id,
         project_id,
         counterparty_id,
         account_kind,
         label,
         details,
         provider_account_data,
         status,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      params.counterpartyId,
      "crypto_wallet",
      "Recurring payment wallet",
      JSON.stringify({ network: "solana", address: params.address }),
      JSON.stringify({}),
      "active",
      now,
      now
    )
    .run();

  return id;
}

async function seedIssuedTokenMint(params: {
  projectId: string;
  mintAddress: string;
  status: TokenStatus;
}): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO issued_tokens (id, project_id, organization_id, mint_address, name, symbol, decimals, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      `tok_${crypto.randomUUID()}`,
      params.projectId,
      TEST_ORG.id,
      params.mintAddress,
      "Issued Test Token",
      "ITT",
      6,
      params.status,
      TEST_USER.id
    )
    .run();
}

function mockTokenSupplyDecimalsOnce(decimals = 6): void {
  createRpcMock.mockReturnValueOnce({
    getTokenSupply: () => ({
      send: async () => ({ value: { decimals } }),
    }),
  } as unknown as ReturnType<typeof solanaRpc.createRpc>);
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

function mockRecurringActivationRpc(options?: {
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
  } as unknown as ReturnType<typeof solanaRpc.createRpc>);
}

async function createRecurringPaymentForActivation(headers: Record<string, string>) {
  const counterpartyId = await seedCounterparty({
    externalId: `recurring_activation_counterparty_${crypto.randomUUID()}`,
  });
  const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
    counterpartyId,
    address: TEST_SOLANA_ADDRESSES.wallet2,
  });

  const createRes = await app.request(
    "/v1/payments/recurring-payments",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        sourceWalletId: TEST_WALLET_ID,
        counterpartyId,
        counterpartyAccountId,
        token: DEVNET_USDC_MINT,
        amount: "25.00",
        periodHours: 24,
      }),
    },
    env
  );
  expect(createRes.status).toBe(201);
  const createBody = (await createRes.json()) as {
    data: { recurringPayment: { id: string } };
  };

  return createBody.data.recurringPayment.id;
}

async function activateRecurringPaymentForTest(headers: Record<string, string>) {
  const recurringPaymentId = await createRecurringPaymentForActivation(headers);
  const activateRes = await app.request(
    `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
    {
      method: "POST",
      headers,
    },
    env
  );
  expect(activateRes.status).toBe(200);
  const activateBody = (await activateRes.json()) as {
    data: {
      recurringPayment: {
        id: string;
        status: string;
        planId: string;
        subscriptionId: string;
        nextCollectionDueAt: string;
      };
    };
  };
  expect(activateBody.data.recurringPayment.status).toBe("active");
  return activateBody.data.recurringPayment;
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
    fetchMaybePlanMock.mockResolvedValue({
      exists: true,
      address: address(TEST_SOLANA_ADDRESSES.wallet3),
      data: {
        status: subscriptionsProgram.PlanStatus.Active,
        data: {
          endTs: 0n,
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
      data: {},
    } as Awaited<ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionDelegation>>);
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
    await clearKVStores(env);
  });

  it("creates, lists, and gets recurring payment records through SDP API routes", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const counterpartyId = await seedCounterparty({ externalId: "recurring_records_counterparty" });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 24,
        }),
      },
      env
    );

    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      data: {
        recurringPayment: {
          id: string;
          sourceWalletId: string;
          counterpartyId: string;
          counterpartyAccountId: string;
          destinationAddress: string;
          token: string;
          amount: string;
          status: string;
        };
      };
    };
    expect(createBody.data.recurringPayment.id).toMatch(/^prp_/);
    expect(createBody.data.recurringPayment.sourceWalletId).toBe(TEST_WALLET_ID);
    expect(createBody.data.recurringPayment.counterpartyId).toBe(counterpartyId);
    expect(createBody.data.recurringPayment.counterpartyAccountId).toBe(counterpartyAccountId);
    expect(createBody.data.recurringPayment.destinationAddress).toBe(TEST_SOLANA_ADDRESSES.wallet2);
    expect(createBody.data.recurringPayment.token).toBe(DEVNET_USDC_MINT);
    expect(createBody.data.recurringPayment.amount).toBe("25.00");
    expect(createBody.data.recurringPayment.status).toBe("pending_activation");

    const listRes = await app.request(
      "/v1/payments/recurring-payments?status=pending_activation",
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      data: { recurringPayments: Array<{ id: string }>; total: number };
    };
    expect(listBody.data.total).toBe(1);
    expect(listBody.data.recurringPayments[0]?.id).toBe(createBody.data.recurringPayment.id);

    const getRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      data: { recurringPayment: { id: string; status: string } };
    };
    expect(getBody.data.recurringPayment.id).toBe(createBody.data.recurringPayment.id);
    expect(getBody.data.recurringPayment.status).toBe("pending_activation");
  });

  it("restricts recurring payment tokens to USD stablecoins and project-issued tokens", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const counterpartyId = await seedCounterparty({ externalId: "recurring_token_gate" });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRecurring = (token: string) =>
      app.request(
        "/v1/payments/recurring-payments",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            sourceWalletId: TEST_WALLET_ID,
            counterpartyId,
            counterpartyAccountId,
            token,
            amount: "25.00",
            periodHours: 24,
          }),
        },
        env
      );

    const expectTokenRejected = async (token: string) => {
      const res = await createRecurring(token);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe(
        "Recurring payments support USD stablecoins and tokens issued in this project; native SOL is not supported"
      );
    };

    await expectTokenRejected("SOL");
    await expectTokenRejected(TEST_SOLANA_ADDRESSES.wallet1);

    const otherProject = { id: "prj_other_token_gate", slug: "other-token-gate-project" };
    await getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        otherProject.id,
        TEST_ORG.id,
        "Other Token Gate Project",
        otherProject.slug,
        "sandbox",
        "active",
        TEST_USER.id
      )
      .run();

    const issuedMint = (await generateKeyPairSigner()).address;
    const pausedMint = (await generateKeyPairSigner()).address;
    const otherProjectMint = (await generateKeyPairSigner()).address;
    await seedIssuedTokenMint({
      projectId: TEST_PROJECT.id,
      mintAddress: issuedMint,
      status: "active",
    });
    await seedIssuedTokenMint({
      projectId: TEST_PROJECT.id,
      mintAddress: pausedMint,
      status: "paused",
    });
    await seedIssuedTokenMint({
      projectId: otherProject.id,
      mintAddress: otherProjectMint,
      status: "active",
    });

    await expectTokenRejected(pausedMint);
    await expectTokenRejected(otherProjectMint);

    const issuedRes = await createRecurring(issuedMint);
    expect(issuedRes.status).toBe(201);
    const issuedBody = (await issuedRes.json()) as {
      data: { recurringPayment: { token: string } };
    };
    expect(issuedBody.data.recurringPayment.token).toBe(issuedMint);

    const stableRes = await createRecurring("USDC");
    expect(stableRes.status).toBe(201);
    const stableBody = (await stableRes.json()) as {
      data: { recurringPayment: { token: string } };
    };
    expect(stableBody.data.recurringPayment.token).toBe(DEVNET_USDC_MINT);
  });

  it("activates recurring payments through SDP API routes", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const counterpartyId = await seedCounterparty({
      externalId: "recurring_activation_counterparty",
    });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 24,
        }),
      },
      env
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      data: { recurringPayment: { id: string } };
    };

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      {
        method: "POST",
        headers,
      },
      env
    );

    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: {
        recurringPayment: {
          id: string;
          status: string;
          planId: string;
          subscriptionId: string;
          planPda: string;
          planCreatedAt: string;
          planCreationSignature: string;
          subscriptionPda: string;
          subscriptionAuthorityAddress: string;
          authorizationSignature: string;
          nextCollectionDueAt: string;
        };
      };
    };
    expect(activateBody.data.recurringPayment).toMatchObject({
      id: createBody.data.recurringPayment.id,
      status: "active",
      planCreatedAt: "1770000000",
      planCreationSignature:
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy",
      authorizationSignature:
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV",
    });
    expect(activateBody.data.recurringPayment.planId).toMatch(/^psp_/);
    expect(activateBody.data.recurringPayment.subscriptionId).toMatch(/^psub_/);
    expect(activateBody.data.recurringPayment.planPda).toBeTruthy();
    expect(activateBody.data.recurringPayment.subscriptionPda).toBeTruthy();
    expect(activateBody.data.recurringPayment.subscriptionAuthorityAddress).toBeTruthy();
    expect(activateBody.data.recurringPayment.nextCollectionDueAt).toBeTruthy();
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
    const confirmedAttempts = await getDb(env)
      .prepare(
        `SELECT status, stage, plan_creation_signature, authorization_signature
           FROM payment_recurring_payment_activation_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(createBody.data.recurringPayment.id)
      .all<{
        status: string;
        stage: string;
        plan_creation_signature: string | null;
        authorization_signature: string | null;
      }>();
    expect(confirmedAttempts.results[0]).toMatchObject({
      status: "confirmed",
      stage: "finalize",
      plan_creation_signature: activateBody.data.recurringPayment.planCreationSignature,
      authorization_signature: activateBody.data.recurringPayment.authorizationSignature,
    });

    const replayRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      {
        method: "POST",
        headers,
      },
      env
    );

    expect(replayRes.status).toBe(200);
    const replayBody = (await replayRes.json()) as {
      data: { recurringPayment: { id: string; status: string; authorizationSignature: string } };
    };
    expect(replayBody.data.recurringPayment).toMatchObject({
      id: createBody.data.recurringPayment.id,
      status: "active",
      authorizationSignature: activateBody.data.recurringPayment.authorizationSignature,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(2);

    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_payment_activation_attempts
            SET status = 'processing',
                stage = 'finalize',
                updated_at = ?
          WHERE recurring_payment_id = ?`
      )
      .bind(new Date().toISOString(), createBody.data.recurringPayment.id)
      .run();

    const repairedReplayRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      {
        method: "POST",
        headers,
      },
      env
    );

    expect(repairedReplayRes.status).toBe(200);
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
    const repairedAttempt = await getDb(env)
      .prepare(
        `SELECT status, stage
           FROM payment_recurring_payment_activation_attempts
          WHERE recurring_payment_id = ?`
      )
      .bind(createBody.data.recurringPayment.id)
      .first<{ status: string; stage: string }>();
    expect(repairedAttempt).toMatchObject({
      status: "confirmed",
      stage: "finalize",
    });
  });

  it("updates pending recurring payment terms directly and journals an audit event", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const counterpartyId = await seedCounterparty({
      externalId: "recurring_pending_update_counterparty",
    });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 24,
        }),
      },
      env
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      data: { recurringPayment: { id: string } };
    };

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          amount: "30.50",
          periodHours: 48,
          firstCollectionAt: null,
          metadataUri: "https://example.com/recurring/update.json",
        }),
      },
      env
    );

    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as {
      data: {
        recurringPayment: {
          id: string;
          amount: string;
          periodHours: number;
          metadataUri: string | null;
          status: string;
        };
      };
    };
    expect(updateBody.data.recurringPayment).toMatchObject({
      id: createBody.data.recurringPayment.id,
      amount: "30.50",
      periodHours: 48,
      metadataUri: "https://example.com/recurring/update.json",
      status: "pending_activation",
    });

    const event = await getDb(env)
      .prepare(
        `SELECT changed_fields, before_values, after_values
           FROM payment_recurring_payment_update_events
          WHERE recurring_payment_id = ?`
      )
      .bind(createBody.data.recurringPayment.id)
      .first<{
        changed_fields: string[];
        before_values: Record<string, unknown>;
        after_values: Record<string, unknown>;
      }>();
    expect(event?.changed_fields).toEqual(expect.arrayContaining(["amount", "periodHours"]));
    expect(event?.before_values.amount).toBe("25.00");
    expect(event?.after_values.amount).toBe("30.50");
  });

  it("updates active recurring payment metadata in place on the existing on-chain plan", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const updatePlanSignature =
      "4hVxsUpdat3Plan111111111111111111111111111111111111111111111111" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(updatePlanSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const laterPeriodStartAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET current_period_start_at = ? WHERE id = ?")
      .bind(laterPeriodStartAt, activated.subscriptionId)
      .run();

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          metadataUri: "https://example.com/recurring/active.json",
          nextCollectionDueAt: null,
        }),
      },
      env
    );

    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as {
      data: {
        recurringPayment: {
          status: string;
          planId: string;
          subscriptionId: string;
          metadataUri: string | null;
          nextCollectionDueAt: string;
        };
      };
    };
    expect(updateBody.data.recurringPayment).toMatchObject({
      status: "active",
      planId: activated.planId,
      subscriptionId: activated.subscriptionId,
      metadataUri: "https://example.com/recurring/active.json",
    });
    expect(updateBody.data.recurringPayment.nextCollectionDueAt).not.toBeNull();
    expect(signAndSendMock).toHaveBeenCalledTimes(3);

    const attempt = await getDb(env)
      .prepare(
        `SELECT mode, status, stage, plan_update_signature
           FROM payment_recurring_payment_update_attempts
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{
        mode: string;
        status: string;
        stage: string;
        plan_update_signature: string | null;
      }>();
    expect(attempt).toMatchObject({
      mode: "metadata_schedule",
      status: "confirmed",
      stage: "finalize",
      plan_update_signature: updatePlanSignature,
    });
    const event = await getDb(env)
      .prepare(
        `SELECT after_values
           FROM payment_recurring_payment_update_events
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{ after_values: Record<string, unknown> }>();
    expect(event?.after_values.nextCollectionDueAt).toBe(
      updateBody.data.recurringPayment.nextCollectionDueAt
    );
  });

  it("replaces active recurring payment records for term changes and cancels the old subscription", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const replacementPlanSignature =
      "4hVxsReplac3Plan11111111111111111111111111111111111111111111" as Signature;
    const replacementAuthSignature =
      "4hVxsReplac3Auth11111111111111111111111111111111111111111111" as Signature;
    const oldCancelSignature =
      "4hVxsOldCanc3l111111111111111111111111111111111111111111111" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(replacementPlanSignature)
      .mockResolvedValueOnce(replacementAuthSignature)
      .mockResolvedValueOnce(oldCancelSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const firstCollectionAt = "2026-07-02T00:00:00.000Z";
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET first_collection_at = ? WHERE id = ?")
      .bind(firstCollectionAt, activated.id)
      .run();

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ amount: "35.00", periodHours: 48, nextCollectionDueAt: null }),
      },
      env
    );

    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as {
      data: {
        recurringPayment: {
          status: string;
          amount: string;
          periodHours: number;
          planId: string;
          subscriptionId: string;
          authorizationSignature: string;
          nextCollectionDueAt: string;
        };
      };
    };
    expect(updateBody.data.recurringPayment).toMatchObject({
      status: "active",
      amount: "35.00",
      periodHours: 48,
      authorizationSignature: replacementAuthSignature,
    });
    expect(updateBody.data.recurringPayment.nextCollectionDueAt).not.toBeNull();
    expect(updateBody.data.recurringPayment.planId).not.toBe(activated.planId);
    expect(updateBody.data.recurringPayment.subscriptionId).not.toBe(activated.subscriptionId);
    expect(signAndSendMock).toHaveBeenCalledTimes(5);

    const oldSubscription = await getDb(env)
      .prepare("SELECT status FROM payment_subscriptions WHERE id = ?")
      .bind(activated.subscriptionId)
      .first<{ status: string }>();
    const oldPlan = await getDb(env)
      .prepare("SELECT status FROM payment_subscription_plans WHERE id = ?")
      .bind(activated.planId)
      .first<{ status: string }>();
    const attempt = await getDb(env)
      .prepare(
        `SELECT mode, status, stage, plan_creation_signature, authorization_signature, old_cancel_signature
           FROM payment_recurring_payment_update_attempts
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{
        mode: string;
        status: string;
        stage: string;
        plan_creation_signature: string | null;
        authorization_signature: string | null;
        old_cancel_signature: string | null;
      }>();
    expect(oldSubscription?.status).toBe("canceled");
    expect(oldPlan?.status).toBe("archived");
    expect(attempt).toMatchObject({
      mode: "replacement",
      status: "confirmed",
      stage: "finalize",
      plan_creation_signature: replacementPlanSignature,
      authorization_signature: replacementAuthSignature,
      old_cancel_signature: oldCancelSignature,
    });
    const event = await getDb(env)
      .prepare(
        `SELECT changed_fields, before_values, after_values
           FROM payment_recurring_payment_update_events
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{
        changed_fields: string[];
        before_values: Record<string, unknown>;
        after_values: Record<string, unknown>;
      }>();
    expect(event?.changed_fields).toContain("firstCollectionAt");
    expect(event?.changed_fields).toContain("nextCollectionDueAt");
    expect(event?.before_values.firstCollectionAt).toBe(firstCollectionAt);
    expect(event?.after_values.firstCollectionAt).toBeNull();
    expect(event?.after_values.nextCollectionDueAt).toBe(
      updateBody.data.recurringPayment.nextCollectionDueAt
    );
  });

  it("rejects active replacement next due dates before replacement transactions are submitted", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const tooEarlyNextDue = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          amount: "35.00",
          periodHours: 48,
          nextCollectionDueAt: tooEarlyNextDue,
        }),
      },
      env
    );

    expect(updateRes.status).toBe(400);
    const body = (await updateRes.json()) as { error: { message: string } };
    expect(body.error.message).toContain("replacement subscription period");
    expect(signAndSendMock).toHaveBeenCalledTimes(2);

    const recurringPayment = await getDb(env)
      .prepare("SELECT status FROM payment_recurring_payments WHERE id = ?")
      .bind(activated.id)
      .first<{ status: string }>();
    const attempt = await getDb(env)
      .prepare(
        `SELECT status, error, plan_creation_signature, authorization_signature, old_cancel_signature
           FROM payment_recurring_payment_update_attempts
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{
        status: string;
        error: string | null;
        plan_creation_signature: string | null;
        authorization_signature: string | null;
        old_cancel_signature: string | null;
      }>();
    expect(recurringPayment?.status).toBe("active");
    expect(attempt).toMatchObject({
      status: "failed",
      plan_creation_signature: null,
      authorization_signature: null,
      old_cancel_signature: null,
    });
    expect(attempt?.error).toContain("replacement subscription period");
  });

  it("rejects fresh in-flight recurring payment updates", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET status = 'updating' WHERE id = ?")
      .bind(recurringPaymentId)
      .run();

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ metadataUri: "https://example.com/recurring/wait.json" }),
      },
      env
    );

    expect(updateRes.status).toBe(409);
    const body = (await updateRes.json()) as { error: { message: string } };
    expect(body.error.message).toContain("already processing");
  });

  it("rejects stale recurring payment update recovery with a different payload", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();

    await getDb(env)
      .prepare(
        "UPDATE payment_recurring_payments SET status = 'updating', updated_at = ? WHERE id = ?"
      )
      .bind(staleAt, activated.id)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_payment_update_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           mode,
           status,
           stage,
           old_plan_id,
           old_subscription_id,
           changed_fields,
           before_values,
           after_values,
           created_at,
           updated_at
         ) VALUES (
           'prpu_stale_payload_mismatch',
           ?, ?, ?, 'replacement', 'processing', 'create_plan', ?, ?,
           ARRAY['amount']::text[], ?::jsonb, ?::jsonb, ?, ?
         )`
      )
      .bind(
        TEST_ORG.id,
        TEST_PROJECT.id,
        activated.id,
        activated.planId,
        activated.subscriptionId,
        JSON.stringify({ amount: "25.00" }),
        JSON.stringify({ amount: "35.00" }),
        staleAt,
        staleAt
      )
      .run();

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ amount: "36.00" }),
      },
      env
    );

    expect(updateRes.status).toBe(409);
    const body = (await updateRes.json()) as { error: { message: string } };
    expect(body.error.message).toContain("retry the same update");
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("clamps stale metadata update retries after the subscription period advances", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const planCreationSignature =
      "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature;
    const authorizationSignature =
      "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature;
    const updatePlanSignature =
      "3agLAsjf2Qba9W59cqxbXFoPRJFDFKB3efqYRhT6wLxaM4KwV31NVrLDjKAw22hR1GFcQc4mePSjZ6XZEHUAjN4c" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(planCreationSignature)
      .mockResolvedValueOnce(authorizationSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const requestedNextDueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const advancedPeriodStartAt = new Date().toISOString();
    const expectedClampedDueAt = new Date(
      new Date(advancedPeriodStartAt).getTime() + 24 * 60 * 60 * 1000
    ).toISOString();
    const metadataUri = "https://example.com/recurring/recovered.json";

    await getDb(env)
      .prepare(
        "UPDATE payment_recurring_payments SET status = 'updating', updated_at = ? WHERE id = ?"
      )
      .bind(staleAt, activated.id)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET current_period_start_at = ? WHERE id = ?")
      .bind(advancedPeriodStartAt, activated.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_payment_update_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           mode,
           status,
           stage,
           old_plan_id,
           old_subscription_id,
           plan_update_signature,
           changed_fields,
           before_values,
           after_values,
           created_at,
           updated_at
         ) VALUES (
           'prpu_stale_metadata_schedule_recovery',
           ?, ?, ?, 'metadata_schedule', 'processing', 'update_plan', ?, ?, ?,
           ARRAY['nextCollectionDueAt', 'metadataUri']::text[], ?::jsonb, ?::jsonb, ?, ?
         )`
      )
      .bind(
        TEST_ORG.id,
        TEST_PROJECT.id,
        activated.id,
        activated.planId,
        activated.subscriptionId,
        updatePlanSignature,
        JSON.stringify({ nextCollectionDueAt: activated.nextCollectionDueAt, metadataUri: null }),
        JSON.stringify({ nextCollectionDueAt: requestedNextDueAt, metadataUri }),
        staleAt,
        staleAt
      )
      .run();

    const updateRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ metadataUri, nextCollectionDueAt: requestedNextDueAt }),
      },
      env
    );

    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as {
      data: {
        recurringPayment: {
          status: string;
          metadataUri: string;
          nextCollectionDueAt: string;
        };
      };
    };
    expect(updateBody.data.recurringPayment).toMatchObject({
      status: "active",
      metadataUri,
      nextCollectionDueAt: expectedClampedDueAt,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(2);

    const event = await getDb(env)
      .prepare(
        `SELECT after_values
           FROM payment_recurring_payment_update_events
          WHERE recurring_payment_id = ?`
      )
      .bind(activated.id)
      .first<{ after_values: Record<string, unknown> }>();
    expect(event?.after_values.nextCollectionDueAt).toBe(expectedClampedDueAt);
  });

  it("creates the source token account during recurring payment activation when it is missing", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc({ tokenAccounts: [] });
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "2MAd2T6zSaHCcmstzbmY2uFw5gJtbSjz3GbASJw9XhD27K3F2JWGY4frA44oXpXbpMC5Qn2ePekemCzGH8Eb7L7J" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);
    const [expectedSourceAta] = await findAssociatedTokenPda({
      owner: sourceSigner.address,
      tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      mint: address(DEVNET_USDC_MINT),
    });

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      {
        method: "POST",
        headers,
      },
      env
    );

    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { status: string; subscriptionId: string } };
    };
    expect(activateBody.data.recurringPayment.status).toBe("active");
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
    const subscriptionRow = await getDb(env)
      .prepare("SELECT subscriber_token_account FROM payment_subscriptions WHERE id = ?")
      .bind(activateBody.data.recurringPayment.subscriptionId)
      .first<{ subscriber_token_account: string | null }>();
    expect(subscriptionRow?.subscriber_token_account).toBe(expectedSourceAta);
  });

  it("cancels active recurring payments through SDP API routes", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const cancelSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(cancelSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers },
      env
    );

    expect(cancelRes.status).toBe(200);
    const cancelBody = (await cancelRes.json()) as {
      data: { recurringPayment: { id: string; status: string } };
    };
    expect(cancelBody.data.recurringPayment).toMatchObject({
      id: activated.id,
      status: "canceled",
    });
    const lifecycleAttempt = await getDb(env)
      .prepare(
        `SELECT operation, status, stage, signature
           FROM payment_recurring_payment_lifecycle_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(activated.id)
      .first<{ operation: string; status: string; stage: string; signature: string | null }>();
    expect(lifecycleAttempt).toMatchObject({
      operation: "cancel",
      status: "confirmed",
      stage: "finalize",
      signature: cancelSignature,
    });
    const subscriptionRow = await getDb(env)
      .prepare("SELECT status, cancel_at, canceled_at FROM payment_subscriptions WHERE id = ?")
      .bind(activated.subscriptionId)
      .first<{ status: string; cancel_at: string | null; canceled_at: string | null }>();
    expect(subscriptionRow?.status).toBe("canceled");
    expect(subscriptionRow?.cancel_at).toBeTruthy();
    expect(subscriptionRow?.canceled_at).toBeTruthy();

    const replayRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers },
      env
    );

    expect(replayRes.status).toBe(200);
    const replayBody = (await replayRes.json()) as {
      data: { recurringPayment: { id: string; status: string } };
    };
    expect(replayBody.data.recurringPayment).toMatchObject({
      id: activated.id,
      status: "canceled",
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
  });

  it("cancels pending_activation recurring payments directly without on-chain tx", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/cancel`,
      { method: "POST", headers },
      env
    );

    expect(cancelRes.status).toBe(200);
    const cancelBody = (await cancelRes.json()) as {
      data: { recurringPayment: { id: string; status: string } };
    };
    expect(cancelBody.data.recurringPayment).toMatchObject({
      id: recurringPaymentId,
      status: "canceled",
    });

    const dbRow = await getDb(env)
      .prepare("SELECT status FROM payment_recurring_payments WHERE id = ?")
      .bind(recurringPaymentId)
      .first<{ status: string }>();
    expect(dbRow?.status).toBe("canceled");
  });

  it("resumes canceled recurring payments through SDP API routes", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const cancelSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const resumeSignature =
      "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(cancelSignature)
      .mockResolvedValueOnce(resumeSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers },
      env
    );
    expect(cancelRes.status).toBe(200);

    const resumeRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/resume`,
      { method: "POST", headers },
      env
    );

    expect(resumeRes.status).toBe(200);
    const resumeBody = (await resumeRes.json()) as {
      data: { recurringPayment: { id: string; status: string } };
    };
    expect(resumeBody.data.recurringPayment).toMatchObject({
      id: activated.id,
      status: "active",
    });
    const lifecycleAttempt = await getDb(env)
      .prepare(
        `SELECT operation, status, stage, signature
           FROM payment_recurring_payment_lifecycle_attempts
          WHERE recurring_payment_id = ? AND operation = 'resume'
          ORDER BY created_at DESC`
      )
      .bind(activated.id)
      .first<{ operation: string; status: string; stage: string; signature: string | null }>();
    expect(lifecycleAttempt).toMatchObject({
      operation: "resume",
      status: "confirmed",
      stage: "finalize",
      signature: resumeSignature,
    });
    const subscriptionRow = await getDb(env)
      .prepare("SELECT status, cancel_at, canceled_at FROM payment_subscriptions WHERE id = ?")
      .bind(activated.subscriptionId)
      .first<{ status: string; cancel_at: string | null; canceled_at: string | null }>();
    expect(subscriptionRow).toMatchObject({
      status: "active",
      cancel_at: null,
      canceled_at: null,
    });

    const replayRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/resume`,
      { method: "POST", headers },
      env
    );

    expect(replayRes.status).toBe(200);
    expect(signAndSendMock).toHaveBeenCalledTimes(4);
  });

  it("recovers submitted recurring payment cancel attempts", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const cancelSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const staleUpdatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const attemptId = `prpl_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare(
        "UPDATE payment_recurring_payments SET status = 'canceling', updated_at = ? WHERE id = ?"
      )
      .bind(staleUpdatedAt, activated.id)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_payment_lifecycle_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           operation,
           status,
           stage,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activated.id,
        "cancel",
        "processing",
        "submit",
        cancelSignature,
        JSON.stringify({}),
        staleUpdatedAt,
        staleUpdatedAt
      )
      .run();

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers },
      env
    );

    expect(cancelRes.status).toBe(200);
    const cancelBody = (await cancelRes.json()) as {
      data: { recurringPayment: { status: string } };
    };
    expect(cancelBody.data.recurringPayment.status).toBe("canceled");
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
    expect(confirmTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      cancelSignature,
      expect.objectContaining({ commitment: "confirmed" })
    );
    const recoveredAttempt = await getDb(env)
      .prepare(
        "SELECT status, stage, signature FROM payment_recurring_payment_lifecycle_attempts WHERE id = ?"
      )
      .bind(attemptId)
      .first<{ status: string; stage: string; signature: string | null }>();
    expect(recoveredAttempt).toMatchObject({
      status: "confirmed",
      stage: "finalize",
      signature: cancelSignature,
    });
  });

  it("recovers submitted recurring payment resume attempts", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const cancelSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const resumeSignature =
      "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(cancelSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers },
      env
    );
    expect(cancelRes.status).toBe(200);

    const staleUpdatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const attemptId = `prpl_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare(
        "UPDATE payment_recurring_payments SET status = 'resuming', updated_at = ? WHERE id = ?"
      )
      .bind(staleUpdatedAt, activated.id)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_payment_lifecycle_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           operation,
           status,
           stage,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activated.id,
        "resume",
        "processing",
        "submit",
        resumeSignature,
        JSON.stringify({}),
        staleUpdatedAt,
        staleUpdatedAt
      )
      .run();

    const resumeRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/resume`,
      { method: "POST", headers },
      env
    );

    expect(resumeRes.status).toBe(200);
    const resumeBody = (await resumeRes.json()) as {
      data: { recurringPayment: { status: string } };
    };
    expect(resumeBody.data.recurringPayment.status).toBe("active");
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
    expect(confirmTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      resumeSignature,
      expect.objectContaining({ commitment: "confirmed" })
    );
    const recoveredAttempt = await getDb(env)
      .prepare(
        "SELECT status, stage, signature FROM payment_recurring_payment_lifecycle_attempts WHERE id = ?"
      )
      .bind(attemptId)
      .first<{ status: string; stage: string; signature: string | null }>();
    expect(recoveredAttempt).toMatchObject({
      status: "confirmed",
      stage: "finalize",
      signature: resumeSignature,
    });
  });

  it("blocks recurring payment cancellation while a fresh collection is processing", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activated.id)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activated.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts (
           id,
           organization_id,
           project_id,
           subscription_id,
           transfer_id,
           token,
           amount,
           due_at,
           attempted_at,
           status,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        `psca_${crypto.randomUUID()}`,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activated.subscriptionId,
        DEVNET_USDC_MINT,
        "25.00",
        dueAt,
        now,
        "processing",
        JSON.stringify({ recurringPaymentId: activated.id }),
        now,
        now
      )
      .run();

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers },
      env
    );

    expect(cancelRes.status).toBe(409);
    const row = await getDb(env)
      .prepare("SELECT status FROM payment_recurring_payments WHERE id = ?")
      .bind(activated.id)
      .first<{ status: string }>();
    expect(row?.status).toBe("active");
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("resets recurring payment cancellation claims when subscription validation fails", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET status = 'paused' WHERE id = ?")
      .bind(activated.subscriptionId)
      .run();

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers },
      env
    );

    expect(cancelRes.status).toBe(409);
    const cancelBody = (await cancelRes.json()) as { error: { message: string } };
    expect(cancelBody.error.message).toContain("Subscription cannot be canceled");
    const row = await getDb(env)
      .prepare("SELECT status FROM payment_recurring_payments WHERE id = ?")
      .bind(activated.id)
      .first<{ status: string }>();
    expect(row?.status).toBe("active");
    const lifecycleAttempt = await getDb(env)
      .prepare(
        `SELECT operation, status, stage, error
           FROM payment_recurring_payment_lifecycle_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(activated.id)
      .first<{ operation: string; status: string; stage: string; error: string | null }>();
    expect(lifecycleAttempt).toMatchObject({
      operation: "cancel",
      status: "failed",
      stage: "claim",
    });
    expect(lifecycleAttempt?.error).toContain("Subscription cannot be canceled");
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("recovers confirmed recurring payment collections before cancellation", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const collectionSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const cancelSignature =
      "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(cancelSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const activated = await activateRecurringPaymentForTest(headers);
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const transferId = `xfr_${crypto.randomUUID()}`;
    const attemptId = `psca_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activated.id)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activated.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id,
           organization_id,
           project_id,
           wallet_id,
           counterparty_id,
           source_address,
           destination_address,
           token,
           amount,
           memo,
           type,
           direction,
           status,
           provider_data,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?::jsonb, ?, ?, ?)`
      )
      .bind(
        transferId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        sourceSigner.address,
        TEST_SOLANA_ADDRESSES.wallet2,
        DEVNET_USDC_MINT,
        "25.00",
        "transfer",
        "outbound",
        "confirmed",
        JSON.stringify({ recurringPaymentId: activated.id }),
        collectionSignature,
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts (
           id,
           organization_id,
           project_id,
           subscription_id,
           transfer_id,
           token,
           amount,
           due_at,
           attempted_at,
           status,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activated.subscriptionId,
        transferId,
        DEVNET_USDC_MINT,
        "25.00",
        dueAt,
        now,
        "confirmed",
        collectionSignature,
        JSON.stringify({ recurringPaymentId: activated.id }),
        now,
        now
      )
      .run();

    const cancelRes = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/cancel`,
      { method: "POST", headers },
      env
    );

    expect(cancelRes.status).toBe(200);
    const cancelBody = (await cancelRes.json()) as {
      data: { recurringPayment: { status: string; nextCollectionDueAt: string } };
    };
    expect(cancelBody.data.recurringPayment.status).toBe("canceled");
    expect(new Date(cancelBody.data.recurringPayment.nextCollectionDueAt).getTime()).toBe(
      new Date(dueAt).getTime() + 24 * 60 * 60 * 1000
    );
    const recoveredAttempt = await getDb(env)
      .prepare(
        "SELECT status, signature FROM payment_subscription_collection_attempts WHERE id = ?"
      )
      .bind(attemptId)
      .first<{ status: string; signature: string | null }>();
    expect(recoveredAttempt).toMatchObject({
      status: "confirmed",
      signature: collectionSignature,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
  });

  it("collects due recurring payments through SDP API routes", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const collectionSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(collectionSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { subscriptionId: string } };
    };
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_payments
            SET next_collection_due_at = ?
          WHERE id = ?`
      )
      .bind(dueAt, recurringPaymentId)
      .run();
    await getDb(env)
      .prepare(
        `UPDATE payment_subscriptions
            SET next_collection_due_at = ?
          WHERE id = ?`
      )
      .bind(dueAt, activateBody.data.recurringPayment.subscriptionId)
      .run();
    const [expectedDestinationAta] = await findAssociatedTokenPda({
      owner: address(TEST_SOLANA_ADDRESSES.wallet2),
      tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      mint: address(DEVNET_USDC_MINT),
    });

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(200);
    const collectBody = (await collectRes.json()) as {
      data: {
        recurringPayment: {
          id: string;
          status: string;
          nextCollectionDueAt: string;
          destinationTokenAccount: string;
        };
        collectionAttempt: {
          id: string;
          transferId: string;
          status: string;
          signature: string;
          dueAt: string;
        };
        transfer: {
          id: string;
          status: string;
          signature: string;
          source: string;
          destination: string;
        };
      };
    };
    expect(collectBody.data.recurringPayment).toMatchObject({
      id: recurringPaymentId,
      status: "active",
      destinationTokenAccount: expectedDestinationAta,
    });
    expect(new Date(collectBody.data.recurringPayment.nextCollectionDueAt).getTime()).toBe(
      new Date(dueAt).getTime() + 24 * 60 * 60 * 1000
    );
    expect(collectBody.data.collectionAttempt).toMatchObject({
      status: "confirmed",
      signature: collectionSignature,
      dueAt,
    });
    const manualAttempt = await getDb(env)
      .prepare("SELECT metadata FROM payment_subscription_collection_attempts WHERE id = ?")
      .bind(collectBody.data.collectionAttempt.id)
      .first<{ metadata: { collectionSource?: string; initiatedByKeyId?: string } }>();
    expect(manualAttempt?.metadata).toMatchObject({
      collectionSource: "manual",
      initiatedByKeyId: TEST_API_KEY.id,
    });
    expect(collectBody.data.transfer).toMatchObject({
      id: collectBody.data.collectionAttempt.transferId,
      status: "confirmed",
      signature: collectionSignature,
      source: sourceSigner.address,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
  });

  it("recovers submitted recurring payment collection attempts", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const submittedSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { subscriptionId: string } };
    };
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const transferId = `xfr_${crypto.randomUUID()}`;
    const attemptId = `psca_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, recurringPaymentId)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activateBody.data.recurringPayment.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id,
           organization_id,
           project_id,
           wallet_id,
           counterparty_id,
           source_address,
           destination_address,
           token,
           amount,
           memo,
           type,
           direction,
           status,
           provider_data,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?::jsonb, ?, ?, ?)`
      )
      .bind(
        transferId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        sourceSigner.address,
        TEST_SOLANA_ADDRESSES.wallet2,
        DEVNET_USDC_MINT,
        "25.00",
        "transfer",
        "outbound",
        "processing",
        JSON.stringify({ recurringPaymentId }),
        submittedSignature,
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts (
           id,
           organization_id,
           project_id,
           subscription_id,
           transfer_id,
           token,
           amount,
           due_at,
           attempted_at,
           status,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activateBody.data.recurringPayment.subscriptionId,
        transferId,
        DEVNET_USDC_MINT,
        "25.00",
        dueAt,
        now,
        "processing",
        null,
        JSON.stringify({ recurringPaymentId }),
        now,
        now
      )
      .run();
    const [expectedDestinationAta] = await findAssociatedTokenPda({
      owner: address(TEST_SOLANA_ADDRESSES.wallet2),
      tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      mint: address(DEVNET_USDC_MINT),
    });

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(200);
    const collectBody = (await collectRes.json()) as {
      data: {
        recurringPayment: { destinationTokenAccount: string; nextCollectionDueAt: string };
        collectionAttempt: { id: string; status: string; signature: string };
        transfer: { id: string; status: string; signature: string };
      };
    };
    expect(collectBody.data.recurringPayment.destinationTokenAccount).toBe(expectedDestinationAta);
    expect(collectBody.data.collectionAttempt).toMatchObject({
      id: attemptId,
      status: "confirmed",
      signature: submittedSignature,
    });
    expect(collectBody.data.transfer).toMatchObject({
      id: transferId,
      status: "confirmed",
      signature: submittedSignature,
    });
    expect(new Date(collectBody.data.recurringPayment.nextCollectionDueAt).getTime()).toBe(
      new Date(dueAt).getTime() + 24 * 60 * 60 * 1000
    );
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
    expect(confirmTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      submittedSignature,
      expect.objectContaining({ commitment: "confirmed" })
    );
  });

  it("finalizes recovered recurring payment collections after cancellation", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const submittedSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { subscriptionId: string } };
    };
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const transferId = `xfr_${crypto.randomUUID()}`;
    const attemptId = `psca_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_payments
            SET next_collection_due_at = ?,
                status = 'canceled'
          WHERE id = ?`
      )
      .bind(dueAt, recurringPaymentId)
      .run();
    await getDb(env)
      .prepare(
        `UPDATE payment_subscriptions
            SET next_collection_due_at = ?,
                status = 'canceled',
                canceled_at = ?
          WHERE id = ?`
      )
      .bind(dueAt, now, activateBody.data.recurringPayment.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id,
           organization_id,
           project_id,
           wallet_id,
           counterparty_id,
           source_address,
           destination_address,
           token,
           amount,
           memo,
           type,
           direction,
           status,
           provider_data,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?::jsonb, ?, ?, ?)`
      )
      .bind(
        transferId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        sourceSigner.address,
        TEST_SOLANA_ADDRESSES.wallet2,
        DEVNET_USDC_MINT,
        "25.00",
        "transfer",
        "outbound",
        "confirmed",
        JSON.stringify({ recurringPaymentId }),
        submittedSignature,
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts (
           id,
           organization_id,
           project_id,
           subscription_id,
           transfer_id,
           token,
           amount,
           due_at,
           attempted_at,
           status,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activateBody.data.recurringPayment.subscriptionId,
        transferId,
        DEVNET_USDC_MINT,
        "25.00",
        dueAt,
        now,
        "confirmed",
        submittedSignature,
        JSON.stringify({ recurringPaymentId }),
        now,
        now
      )
      .run();

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(200);
    const collectBody = (await collectRes.json()) as {
      data: {
        recurringPayment: { status: string; nextCollectionDueAt: string };
        collectionAttempt: { id: string; status: string; signature: string };
        transfer: { id: string; status: string; signature: string };
      };
    };
    expect(collectBody.data.recurringPayment.status).toBe("canceled");
    expect(new Date(collectBody.data.recurringPayment.nextCollectionDueAt).getTime()).toBe(
      new Date(dueAt).getTime()
    );
    expect(collectBody.data.collectionAttempt).toMatchObject({
      id: attemptId,
      status: "confirmed",
      signature: submittedSignature,
    });
    expect(collectBody.data.transfer).toMatchObject({
      id: transferId,
      status: "confirmed",
      signature: submittedSignature,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("retries recurring payment collection after pre-submission crash", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const retrySignature =
      "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(retrySignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { subscriptionId: string } };
    };
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const staleAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const transferId = `xfr_${crypto.randomUUID()}`;
    const attemptId = `psca_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, recurringPaymentId)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activateBody.data.recurringPayment.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id,
           organization_id,
           project_id,
           wallet_id,
           counterparty_id,
           source_address,
           destination_address,
           token,
           amount,
           memo,
           type,
           direction,
           status,
           provider_data,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?::jsonb, ?, ?, ?)`
      )
      .bind(
        transferId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        sourceSigner.address,
        TEST_SOLANA_ADDRESSES.wallet2,
        DEVNET_USDC_MINT,
        "25.00",
        "transfer",
        "outbound",
        "processing",
        JSON.stringify({ recurringPaymentId }),
        null,
        staleAt,
        staleAt
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts (
           id,
           organization_id,
           project_id,
           subscription_id,
           transfer_id,
           token,
           amount,
           due_at,
           attempted_at,
           status,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activateBody.data.recurringPayment.subscriptionId,
        transferId,
        DEVNET_USDC_MINT,
        "25.00",
        dueAt,
        now,
        "processing",
        null,
        JSON.stringify({ recurringPaymentId }),
        staleAt,
        staleAt
      )
      .run();

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(200);
    const collectBody = (await collectRes.json()) as {
      data: {
        collectionAttempt: { id: string; status: string; signature: string };
        transfer: { id: string; status: string; signature: string };
      };
    };
    expect(collectBody.data.collectionAttempt).toMatchObject({
      status: "confirmed",
      signature: retrySignature,
    });
    expect(collectBody.data.collectionAttempt.id).not.toBe(attemptId);
    expect(collectBody.data.transfer).toMatchObject({
      status: "confirmed",
      signature: retrySignature,
    });
    expect(collectBody.data.transfer.id).not.toBe(transferId);
    const staleAttempt = await getDb(env)
      .prepare(
        `SELECT status, error, metadata
           FROM payment_subscription_collection_attempts
          WHERE id = ?`
      )
      .bind(attemptId)
      .first<{ status: string; error: string | null; metadata: { retryAfterAt?: string } }>();
    expect(staleAttempt?.status).toBe("failed");
    expect(staleAttempt?.error).toContain("interrupted before submission");
    expect(staleAttempt?.metadata.retryAfterAt).toBeTruthy();
    const staleTransfer = await getDb(env)
      .prepare("SELECT status, error, signature FROM payment_transfers WHERE id = ?")
      .bind(transferId)
      .first<{ status: string; error: string | null; signature: string | null }>();
    expect(staleTransfer).toMatchObject({
      status: "failed",
      signature: null,
    });
    expect(staleTransfer?.error).toContain("interrupted before submission");
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
  });

  it("does not fail fresh transferless recurring payment attempts during recovery", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { subscriptionId: string } };
    };
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const attemptId = `psca_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, recurringPaymentId)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activateBody.data.recurringPayment.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts (
           id,
           organization_id,
           project_id,
           subscription_id,
           transfer_id,
           token,
           amount,
           due_at,
           attempted_at,
           status,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activateBody.data.recurringPayment.subscriptionId,
        DEVNET_USDC_MINT,
        "25.00",
        dueAt,
        now,
        "processing",
        JSON.stringify({ recurringPaymentId }),
        now,
        now
      )
      .run();

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(409);
    const attempt = await getDb(env)
      .prepare(
        `SELECT status, transfer_id, error
           FROM payment_subscription_collection_attempts
          WHERE id = ?`
      )
      .bind(attemptId)
      .first<{ status: string; transfer_id: string | null; error: string | null }>();
    expect(attempt).toMatchObject({
      status: "processing",
      transfer_id: null,
      error: null,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("does not fail fresh unsigned recurring payment transfers during recovery", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { subscriptionId: string } };
    };
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const transferId = `xfr_${crypto.randomUUID()}`;
    const attemptId = `psca_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, recurringPaymentId)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activateBody.data.recurringPayment.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id,
           organization_id,
           project_id,
           wallet_id,
           counterparty_id,
           source_address,
           destination_address,
           token,
           amount,
           memo,
           type,
           direction,
           status,
           provider_data,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?::jsonb, NULL, ?, ?)`
      )
      .bind(
        transferId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        sourceSigner.address,
        TEST_SOLANA_ADDRESSES.wallet2,
        DEVNET_USDC_MINT,
        "25.00",
        "transfer",
        "outbound",
        "processing",
        JSON.stringify({ recurringPaymentId }),
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts (
           id,
           organization_id,
           project_id,
           subscription_id,
           transfer_id,
           token,
           amount,
           due_at,
           attempted_at,
           status,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activateBody.data.recurringPayment.subscriptionId,
        transferId,
        DEVNET_USDC_MINT,
        "25.00",
        dueAt,
        now,
        "processing",
        JSON.stringify({ recurringPaymentId }),
        now,
        now
      )
      .run();

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(409);
    const attempt = await getDb(env)
      .prepare(
        `SELECT status, signature, error
           FROM payment_subscription_collection_attempts
          WHERE id = ?`
      )
      .bind(attemptId)
      .first<{ status: string; signature: string | null; error: string | null }>();
    expect(attempt).toMatchObject({
      status: "processing",
      signature: null,
      error: null,
    });
    const transfer = await getDb(env)
      .prepare("SELECT status, signature, error FROM payment_transfers WHERE id = ?")
      .bind(transferId)
      .first<{ status: string; signature: string | null; error: string | null }>();
    expect(transfer).toMatchObject({
      status: "processing",
      signature: null,
      error: null,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("journals failed recovered recurring payment collection attempts and allows retry", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const submittedSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const retrySignature =
      "4rNhfL5s9hQfCjVxrTQDAZECJ5M99kzF8JRgWEzZEijj73D4Jsiz82cgwxUc71vWR9NBdk2zX9qQREx9UvP4QREe" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      )
      .mockResolvedValueOnce(retrySignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { subscriptionId: string } };
    };
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const transferId = `xfr_${crypto.randomUUID()}`;
    const attemptId = `psca_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, recurringPaymentId)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activateBody.data.recurringPayment.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id,
           organization_id,
           project_id,
           wallet_id,
           counterparty_id,
           source_address,
           destination_address,
           token,
           amount,
           memo,
           type,
           direction,
           status,
           provider_data,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?::jsonb, ?, ?, ?)`
      )
      .bind(
        transferId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        sourceSigner.address,
        TEST_SOLANA_ADDRESSES.wallet2,
        DEVNET_USDC_MINT,
        "25.00",
        "transfer",
        "outbound",
        "processing",
        JSON.stringify({ recurringPaymentId }),
        submittedSignature,
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts (
           id,
           organization_id,
           project_id,
           subscription_id,
           transfer_id,
           token,
           amount,
           due_at,
           attempted_at,
           status,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activateBody.data.recurringPayment.subscriptionId,
        transferId,
        DEVNET_USDC_MINT,
        "25.00",
        dueAt,
        now,
        "processing",
        submittedSignature,
        JSON.stringify({ recurringPaymentId }),
        now,
        now
      )
      .run();
    confirmTransactionMock.mockImplementation(async (_rpc, signature) => ({
      signature,
      slot: 101n,
      confirmationStatus: "confirmed",
      err: signature === submittedSignature ? { InstructionError: [0, "Custom"] } : null,
    }));

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(200);
    const collectBody = (await collectRes.json()) as {
      data: {
        collectionAttempt: { id: string; status: string; signature: string };
        transfer: { status: string; signature: string };
      };
    };
    const failedAttempt = await getDb(env)
      .prepare(
        `SELECT status, error, metadata
           FROM payment_subscription_collection_attempts
          WHERE id = ?`
      )
      .bind(attemptId)
      .first<{ status: string; error: string | null; metadata: { retryAfterAt?: string } }>();
    expect(failedAttempt?.status).toBe("failed");
    expect(failedAttempt?.error).toContain("collection failed on-chain");
    expect(failedAttempt?.metadata.retryAfterAt).toBeTruthy();
    const failedTransfer = await getDb(env)
      .prepare("SELECT status, error, signature FROM payment_transfers WHERE id = ?")
      .bind(transferId)
      .first<{ status: string; error: string | null; signature: string | null }>();
    expect(failedTransfer).toMatchObject({
      status: "failed",
      signature: submittedSignature,
    });
    expect(failedTransfer?.error).toContain("collection failed on-chain");
    expect(collectBody.data.collectionAttempt).toMatchObject({
      status: "confirmed",
      signature: retrySignature,
    });
    expect(collectBody.data.collectionAttempt.id).not.toBe(attemptId);
    expect(collectBody.data.transfer).toMatchObject({
      status: "confirmed",
      signature: retrySignature,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
  });

  it("recovers confirmed collection transfers without reopening the due period", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const submittedSignature =
      "3hdAMf5sGEHn2UAjViFvX9YtZQdRfeHEGwNEc8GjVKFG5MGNs27jVrNuQXHcr1JAkzjcJtS4Lo6z33Z5fbT2gq13" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { subscriptionId: string } };
    };
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const transferId = `xfr_${crypto.randomUUID()}`;
    const attemptId = `psca_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, recurringPaymentId)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activateBody.data.recurringPayment.subscriptionId)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id,
           organization_id,
           project_id,
           wallet_id,
           counterparty_id,
           source_address,
           destination_address,
           token,
           amount,
           memo,
           type,
           direction,
           status,
           provider_data,
           signature,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?::jsonb, ?, ?, ?)`
      )
      .bind(
        transferId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        sourceSigner.address,
        TEST_SOLANA_ADDRESSES.wallet2,
        DEVNET_USDC_MINT,
        "25.00",
        "transfer",
        "outbound",
        "confirmed",
        JSON.stringify({ recurringPaymentId }),
        submittedSignature,
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts (
           id,
           organization_id,
           project_id,
           subscription_id,
           transfer_id,
           token,
           amount,
           due_at,
           attempted_at,
           status,
           signature,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        activateBody.data.recurringPayment.subscriptionId,
        transferId,
        DEVNET_USDC_MINT,
        "25.00",
        dueAt,
        now,
        "processing",
        submittedSignature,
        JSON.stringify({ recurringPaymentId }),
        now,
        now
      )
      .run();
    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(200);
    const collectBody = (await collectRes.json()) as {
      data: {
        recurringPayment: { nextCollectionDueAt: string };
        collectionAttempt: { id: string; status: string; signature: string };
        transfer: { id: string; status: string; signature: string };
      };
    };
    expect(collectBody.data.collectionAttempt).toMatchObject({
      id: attemptId,
      status: "confirmed",
      signature: submittedSignature,
    });
    expect(collectBody.data.transfer).toMatchObject({
      id: transferId,
      status: "confirmed",
      signature: submittedSignature,
    });
    expect(new Date(collectBody.data.recurringPayment.nextCollectionDueAt).getTime()).toBe(
      new Date(dueAt).getTime() + 24 * 60 * 60 * 1000
    );
    expect(confirmTransactionMock).not.toHaveBeenCalledWith(
      expect.anything(),
      submittedSignature,
      expect.anything()
    );
    const attempt = await getDb(env)
      .prepare("SELECT status, error FROM payment_subscription_collection_attempts WHERE id = ?")
      .bind(attemptId)
      .first<{ status: string; error: string | null }>();
    expect(attempt).toMatchObject({ status: "confirmed", error: null });
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("rejects early recurring payment collection", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(400);
    const collectBody = (await collectRes.json()) as { error: { message: string } };
    expect(collectBody.error.message).toContain("not due yet");
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
    const attempts = await getDb(env)
      .prepare("SELECT id FROM payment_subscription_collection_attempts")
      .all<{ id: string }>();
    expect(attempts.results).toHaveLength(0);
  });

  it("journals failed pre-submission recurring payment collection attempts", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const recurringPaymentId = await createRecurringPaymentForActivation(headers);

    const activateRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/activate`,
      { method: "POST", headers },
      env
    );
    expect(activateRes.status).toBe(200);
    const activateBody = (await activateRes.json()) as {
      data: { recurringPayment: { subscriptionId: string } };
    };
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, recurringPaymentId)
      .run();
    await getDb(env)
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(dueAt, activateBody.data.recurringPayment.subscriptionId)
      .run();
    createOrgSignerMock.mockRejectedValueOnce(new Error("collection signer unavailable"));

    const collectRes = await app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers },
      env
    );

    expect(collectRes.status).toBe(500);
    const attempts = await getDb(env)
      .prepare(
        `SELECT status, error, metadata, transfer_id
           FROM payment_subscription_collection_attempts
          WHERE subscription_id = ?`
      )
      .bind(activateBody.data.recurringPayment.subscriptionId)
      .all<{
        status: string;
        error: string | null;
        metadata: { retryAfterAt?: string };
        transfer_id: string | null;
      }>();
    expect(attempts.results[0]?.status).toBe("failed");
    expect(attempts.results[0]?.error).toContain("collection signer unavailable");
    expect(attempts.results[0]?.metadata.retryAfterAt).toBeTruthy();
    expect(attempts.results[0]?.transfer_id).toMatch(/^xfr_/);
    const transfer = await getDb(env)
      .prepare("SELECT status, error, signature FROM payment_transfers WHERE id = ?")
      .bind(attempts.results[0]?.transfer_id)
      .first<{ status: string; error: string | null; signature: string | null }>();
    expect(transfer).toMatchObject({
      status: "failed",
      signature: null,
    });
    expect(transfer?.error).toContain("collection signer unavailable");
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("journals failed activation attempts and allows activation retry", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock
      .mockRejectedValueOnce(new Error("signer temporarily unavailable"))
      .mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature
      )
      .mockResolvedValueOnce(
        "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature
      );
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const counterpartyId = await seedCounterparty({
      externalId: "recurring_activation_recovery_counterparty",
    });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 24,
        }),
      },
      env
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      data: { recurringPayment: { id: string } };
    };

    const failedRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      { method: "POST", headers },
      env
    );

    expect(failedRes.status).toBe(500);
    const getAfterFailureRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(getAfterFailureRes.status).toBe(200);
    const getAfterFailureBody = (await getAfterFailureRes.json()) as {
      data: { recurringPayment: { status: string } };
    };
    expect(getAfterFailureBody.data.recurringPayment.status).toBe("pending_activation");

    const attempts = await getDb(env)
      .prepare(
        `SELECT status, stage, error
           FROM payment_recurring_payment_activation_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(createBody.data.recurringPayment.id)
      .all<{ status: string; stage: string; error: string | null }>();
    expect(attempts.results[0]).toMatchObject({
      status: "failed",
      stage: "create_plan",
    });
    expect(attempts.results[0]?.error).toContain("signer temporarily unavailable");

    const retryRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      { method: "POST", headers },
      env
    );

    expect(retryRes.status).toBe(200);
    const retryBody = (await retryRes.json()) as {
      data: { recurringPayment: { status: string } };
    };
    expect(retryBody.data.recurringPayment.status).toBe("active");
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
  });

  it("recovers stale activating recurring payments without recreating the plan", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const authorizationSignature =
      "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature;
    const signAndSendMock = vi.fn().mockResolvedValue(authorizationSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const counterpartyId = await seedCounterparty({
      externalId: "recurring_activation_stale_counterparty",
    });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 24,
        }),
      },
      env
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      data: { recurringPayment: { id: string } };
    };
    const planId = `psp_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_plans (
           id,
           organization_id,
           project_id,
           owner_wallet_id,
           owner_address,
           token,
           amount,
           period_hours,
           program_plan_id,
           status,
           created_by,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        planId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        sourceSigner.address,
        DEVNET_USDC_MINT,
        "25.00",
        24,
        "1001",
        "active",
        TEST_USER.id,
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_payments
            SET status = 'activating',
                plan_id = ?,
                plan_created_at = ?,
                plan_creation_signature = ?,
                updated_at = ?
          WHERE id = ?`
      )
      .bind(
        planId,
        "1770000000",
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy",
        now,
        createBody.data.recurringPayment.id
      )
      .run();
    const attemptId = `prpa_${crypto.randomUUID()}`;
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_payment_activation_attempts (
           id,
           organization_id,
           project_id,
           recurring_payment_id,
           status,
           stage,
           plan_creation_signature,
           authorization_signature,
           error,
           metadata,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        attemptId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        createBody.data.recurringPayment.id,
        "processing",
        "create_plan",
        "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy",
        null,
        null,
        "{}",
        now,
        now
      )
      .run();

    const freshRetryRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      { method: "POST", headers },
      env
    );
    expect(freshRetryRes.status).toBe(409);

    await getDb(env)
      .prepare("UPDATE payment_recurring_payments SET updated_at = ? WHERE id = ?")
      .bind(
        new Date(Date.now() - 16 * 60 * 1000).toISOString(),
        createBody.data.recurringPayment.id
      )
      .run();

    const staleRetryRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      { method: "POST", headers },
      env
    );

    expect(staleRetryRes.status).toBe(200);
    const staleRetryBody = (await staleRetryRes.json()) as {
      data: { recurringPayment: { status: string; authorizationSignature: string } };
    };
    expect(staleRetryBody.data.recurringPayment).toMatchObject({
      status: "active",
      authorizationSignature,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(1);
    const recoveredAttempts = await getDb(env)
      .prepare(
        `SELECT id, status, stage, plan_creation_signature, authorization_signature
           FROM payment_recurring_payment_activation_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(createBody.data.recurringPayment.id)
      .all<{
        id: string;
        status: string;
        stage: string;
        plan_creation_signature: string | null;
        authorization_signature: string | null;
      }>();
    expect(recoveredAttempts.results).toHaveLength(1);
    expect(recoveredAttempts.results[0]).toMatchObject({
      id: attemptId,
      status: "confirmed",
      stage: "finalize",
      authorization_signature: authorizationSignature,
    });
  });

  it("recovers stale authorized recurring payments without re-confirming old signatures", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    confirmTransactionMock.mockRejectedValue(new Error("transaction history expired"));
    const signAndSendMock = vi.fn();
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const counterpartyId = await seedCounterparty({
      externalId: `recurring_activation_authorized_stale_${crypto.randomUUID()}`,
    });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 24,
        }),
      },
      env
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      data: { recurringPayment: { id: string } };
    };
    const planId = `psp_${crypto.randomUUID()}`;
    const subscriptionId = `psub_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const staleUpdatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const planCreationSignature =
      "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature;
    const authorizationSignature =
      "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature;

    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_plans (
           id,
           organization_id,
           project_id,
           owner_wallet_id,
           owner_address,
           token,
           amount,
           period_hours,
           program_plan_id,
           status,
           created_by,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        planId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_WALLET_ID,
        sourceSigner.address,
        DEVNET_USDC_MINT,
        "25.00",
        24,
        "1002",
        "active",
        TEST_USER.id,
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscriptions (
           id,
           organization_id,
           project_id,
           plan_id,
           counterparty_id,
           subscriber_address,
           authorization_signature,
           status,
           created_by,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        subscriptionId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        planId,
        counterpartyId,
        sourceSigner.address,
        authorizationSignature,
        "pending_authorization",
        TEST_USER.id,
        now,
        now
      )
      .run();
    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_payments
            SET status = 'activating',
                plan_id = ?,
                subscription_id = ?,
                plan_created_at = ?,
                plan_creation_signature = ?,
                authorization_signature = ?,
                updated_at = ?
          WHERE id = ?`
      )
      .bind(
        planId,
        subscriptionId,
        "1770000000",
        planCreationSignature,
        authorizationSignature,
        staleUpdatedAt,
        createBody.data.recurringPayment.id
      )
      .run();

    const staleRetryRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      { method: "POST", headers },
      env
    );

    expect(staleRetryRes.status).toBe(200);
    const staleRetryBody = (await staleRetryRes.json()) as {
      data: { recurringPayment: { status: string; authorizationSignature: string } };
    };
    expect(staleRetryBody.data.recurringPayment).toMatchObject({
      status: "active",
      authorizationSignature,
    });
    expect(confirmTransactionMock).not.toHaveBeenCalled();
    expect(signAndSendMock).not.toHaveBeenCalled();
  });

  it("journals failed on-chain activation attempts and retries with a fresh signature", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    const failedPlanSignature =
      "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature;
    const retryPlanSignature =
      "3eWxmHfS3EPf7nmtdDQ6CTwWqCnX2bAdtc9h1kReBLbqjP99kphnf3UhpSGA8qpmkHxnhqsWyVbRoQY2yagRZkzp" as Signature;
    const authorizationSignature =
      "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(failedPlanSignature)
      .mockResolvedValueOnce(retryPlanSignature)
      .mockResolvedValueOnce(authorizationSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    confirmTransactionMock
      .mockResolvedValueOnce({
        signature: failedPlanSignature,
        slot: 100n,
        confirmationStatus: "confirmed",
        err: { InstructionError: [0, "Custom"] },
      } as Awaited<ReturnType<typeof solanaRpc.confirmTransaction>>)
      .mockResolvedValue({
        signature: retryPlanSignature,
        slot: 101n,
        confirmationStatus: "confirmed",
        err: null,
      } as Awaited<ReturnType<typeof solanaRpc.confirmTransaction>>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const counterpartyId = await seedCounterparty({
      externalId: "recurring_activation_onchain_failure_counterparty",
    });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 24,
        }),
      },
      env
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      data: { recurringPayment: { id: string } };
    };

    const failedRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      { method: "POST", headers },
      env
    );

    expect(failedRes.status).toBe(400);
    const getAfterFailureRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    const getAfterFailureBody = (await getAfterFailureRes.json()) as {
      data: { recurringPayment: { status: string; planCreationSignature: string | null } };
    };
    expect(getAfterFailureBody.data.recurringPayment).toMatchObject({
      status: "pending_activation",
      planCreationSignature: null,
    });

    const attempts = await getDb(env)
      .prepare(
        `SELECT status, stage, error
           FROM payment_recurring_payment_activation_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(createBody.data.recurringPayment.id)
      .all<{ status: string; stage: string; error: string | null }>();
    expect(attempts.results[0]).toMatchObject({
      status: "failed",
      stage: "create_plan",
      error: "Recurring payment activation failed on-chain",
    });

    const retryRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      { method: "POST", headers },
      env
    );

    expect(retryRes.status).toBe(200);
    const retryBody = (await retryRes.json()) as {
      data: { recurringPayment: { status: string; planCreationSignature: string } };
    };
    expect(retryBody.data.recurringPayment).toMatchObject({
      status: "active",
      planCreationSignature: retryPlanSignature,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
  });

  it("clears failed authorization signatures when finalization cannot find the subscription", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc();
    fetchMaybeSubscriptionDelegationMock
      .mockResolvedValueOnce({
        exists: false,
        address: address(TEST_SOLANA_ADDRESSES.wallet3),
      } as Awaited<ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionDelegation>>)
      .mockResolvedValue({
        exists: true,
        address: address(TEST_SOLANA_ADDRESSES.wallet3),
        data: {},
      } as Awaited<ReturnType<typeof subscriptionsProgram.fetchMaybeSubscriptionDelegation>>);
    const planSignature =
      "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature;
    const failedAuthorizationSignature =
      "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV" as Signature;
    const retryAuthorizationSignature =
      "3eWxmHfS3EPf7nmtdDQ6CTwWqCnX2bAdtc9h1kReBLbqjP99kphnf3UhpSGA8qpmkHxnhqsWyVbRoQY2yagRZkzp" as Signature;
    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(planSignature)
      .mockResolvedValueOnce(failedAuthorizationSignature)
      .mockResolvedValueOnce(retryAuthorizationSignature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const counterpartyId = await seedCounterparty({
      externalId: "recurring_activation_missing_delegation_counterparty",
    });
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const createRes = await app.request(
      "/v1/payments/recurring-payments",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceWalletId: TEST_WALLET_ID,
          counterpartyId,
          counterpartyAccountId,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 24,
        }),
      },
      env
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      data: { recurringPayment: { id: string } };
    };

    const failedRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      { method: "POST", headers },
      env
    );

    expect(failedRes.status).toBe(400);
    const getAfterFailureRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    const getAfterFailureBody = (await getAfterFailureRes.json()) as {
      data: {
        recurringPayment: {
          status: string;
          planCreationSignature: string | null;
          authorizationSignature: string | null;
        };
      };
    };
    expect(getAfterFailureBody.data.recurringPayment).toMatchObject({
      status: "pending_activation",
      planCreationSignature: planSignature,
      authorizationSignature: null,
    });

    const attempts = await getDb(env)
      .prepare(
        `SELECT status, stage, error
           FROM payment_recurring_payment_activation_attempts
          WHERE recurring_payment_id = ?
          ORDER BY created_at DESC`
      )
      .bind(createBody.data.recurringPayment.id)
      .all<{ status: string; stage: string; error: string | null }>();
    expect(attempts.results[0]).toMatchObject({
      status: "failed",
      stage: "finalize",
      error: "Subscription authorization was not found on-chain",
    });

    const retryRes = await app.request(
      `/v1/payments/recurring-payments/${createBody.data.recurringPayment.id}/activate`,
      { method: "POST", headers },
      env
    );

    expect(retryRes.status).toBe(200);
    const retryBody = (await retryRes.json()) as {
      data: {
        recurringPayment: {
          status: string;
          planCreationSignature: string;
          authorizationSignature: string;
        };
      };
    };
    expect(retryBody.data.recurringPayment).toMatchObject({
      status: "active",
      planCreationSignature: planSignature,
      authorizationSignature: retryAuthorizationSignature,
    });
    expect(signAndSendMock).toHaveBeenCalledTimes(3);
  });

  it("requires owner wallet access when updating subscription plans", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };

    const planRes = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ownerWalletId: TEST_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 720,
        }),
      },
      env
    );
    expect(planRes.status).toBe(201);
    const planBody = (await planRes.json()) as { data: { subscriptionPlan: { id: string } } };

    await seedCachedKey({
      walletBindings: [{ walletId: "wal_other_wallet", permissions: ["payments:write"] }],
    });

    const updateRes = await app.request(
      `/v1/payments/subscription-plans/${planBody.data.subscriptionPlan.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "archived" }),
      },
      env
    );

    expect(updateRes.status).toBe(403);
    const updateBody = (await updateRes.json()) as { error: { code: string; message: string } };
    expect(updateBody.error.code).toBe("FORBIDDEN");
    expect(updateBody.error.message).toContain("requested wallet");
  });

  it("rejects archived counterparties when creating subscriptions", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };

    const counterpartyRes = await app.request(
      "/v1/counterparties",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          externalId: "subscription_archived_counterparty",
          entityType: "individual",
          displayName: "Archived Subscription Counterparty",
          email: "subscription-archived-counterparty@example.com",
          identity: TEST_COUNTERPARTY_IDENTITY,
        }),
      },
      env
    );
    expect(counterpartyRes.status).toBe(201);
    const counterpartyBody = (await counterpartyRes.json()) as {
      data: { counterparty: { id: string } };
    };

    const planRes = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ownerWalletId: TEST_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 720,
        }),
      },
      env
    );
    expect(planRes.status).toBe(201);
    const planBody = (await planRes.json()) as { data: { subscriptionPlan: { id: string } } };

    const archiveRes = await app.request(
      `/v1/counterparties/${counterpartyBody.data.counterparty.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
      },
      env
    );
    expect(archiveRes.status).toBe(204);

    const subscriptionRes = await app.request(
      "/v1/payments/subscriptions",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          planId: planBody.data.subscriptionPlan.id,
          counterpartyId: counterpartyBody.data.counterparty.id,
          subscriberAddress: TEST_SOLANA_ADDRESSES.wallet2,
        }),
      },
      env
    );

    expect(subscriptionRes.status).toBe(404);
    const subscriptionBody = (await subscriptionRes.json()) as {
      error: { code: string; message: string };
    };
    expect(subscriptionBody.error.code).toBe("NOT_FOUND");
    expect(subscriptionBody.error.message).toContain("Counterparty not found");
  });

  it("requires plan wallet access when mutating subscriptions and collection attempts", async () => {
    const headers = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Content-Type": "application/json",
    };

    const counterpartyRes = await app.request(
      "/v1/counterparties",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          externalId: "subscription_wallet_scope_counterparty",
          entityType: "individual",
          displayName: "Wallet Scope Subscription Counterparty",
          email: "subscription-wallet-scope-counterparty@example.com",
          identity: TEST_COUNTERPARTY_IDENTITY,
        }),
      },
      env
    );
    expect(counterpartyRes.status).toBe(201);
    const counterpartyBody = (await counterpartyRes.json()) as {
      data: { counterparty: { id: string } };
    };

    const planRes = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers,
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
    expect(planRes.status).toBe(201);
    const planBody = (await planRes.json()) as { data: { subscriptionPlan: { id: string } } };

    const subscriptionRes = await app.request(
      "/v1/payments/subscriptions",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          planId: planBody.data.subscriptionPlan.id,
          counterpartyId: counterpartyBody.data.counterparty.id,
          subscriberAddress: TEST_SOLANA_ADDRESSES.wallet2,
          status: "active",
        }),
      },
      env
    );
    expect(subscriptionRes.status).toBe(201);
    const subscriptionBody = (await subscriptionRes.json()) as {
      data: { subscription: { id: string } };
    };

    await seedCachedKey({
      walletBindings: [{ walletId: "wal_other_wallet", permissions: ["payments:write"] }],
    });

    const updateSubscriptionRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionBody.data.subscription.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "paused" }),
      },
      env
    );
    expect(updateSubscriptionRes.status).toBe(403);

    const attemptRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionBody.data.subscription.id}/collection-attempts`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ status: "processing" }),
      },
      env
    );
    expect(attemptRes.status).toBe(403);
  });

  it("exercises the recurring subscription lifecycle through SDP API routes", async () => {
    const authHeaders = {
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
    };
    const jsonHeaders = {
      ...authHeaders,
      "Content-Type": "application/json",
    };
    const subscriberTokenAccount = TEST_SOLANA_ADDRESSES.wallet3;
    const currentPeriodStartAt = "2026-01-01T00:00:00.000Z";
    const nextCollectionDueAt = "2026-02-01T00:00:00.000Z";

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
          identity: TEST_COUNTERPARTY_IDENTITY,
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

    const duplicatePlanRes = await app.request(
      "/v1/payments/subscription-plans",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          ownerWalletId: TEST_WALLET_ID,
          token: DEVNET_USDC_MINT,
          amount: "25.00",
          periodHours: 720,
          programPlanId: planBody.data.subscriptionPlan.programPlanId,
        }),
      },
      env
    );
    expect(duplicatePlanRes.status).toBe(409);

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

    const dueSubscriptionsRes = await app.request(
      `/v1/payments/subscriptions?status=active&dueBefore=${encodeURIComponent("2026-02-02T00:00:00.000Z")}`,
      {
        headers: authHeaders,
      },
      env
    );

    expect(dueSubscriptionsRes.status).toBe(200);
    const dueSubscriptionsBody = (await dueSubscriptionsRes.json()) as {
      data: { subscriptions: Array<{ id: string }>; total: number };
    };
    expect(dueSubscriptionsBody.data.subscriptions.map((subscription) => subscription.id)).toEqual([
      subscriptionId,
    ]);
    expect(dueSubscriptionsBody.data.total).toBe(1);

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

    const attemptRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/collection-attempts`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          amount: "10.50",
          attemptedAt: "2026-02-01T00:01:00.000Z",
          dueAt: nextCollectionDueAt,
          metadata: { source: "api-lifecycle-test" },
          signature: "sig_collection_attempt_test",
          status: "processing",
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
      status: "processing",
      signature: "sig_collection_attempt_test",
      metadata: { source: "api-lifecycle-test" },
    });

    const duplicateAttemptRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/collection-attempts`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          dueAt: nextCollectionDueAt,
          signature: "sig_collection_attempt_test",
          status: "processing",
        }),
      },
      env
    );
    expect(duplicateAttemptRes.status).toBe(409);

    const attemptsRes = await app.request(
      `/v1/payments/subscriptions/${subscriptionId}/collection-attempts?status=processing`,
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
        status: "processing",
      }),
    ]);
    expect(attemptsBody.data.total).toBe(1);
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
          redirectUrl: "https://example.com/onramp-done",
          metadata: { invoice: "INV-123", po: "PO-9" },
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
      data: [{ id: string; metadata: Record<string, string> }];
    };
    expect(transfersBody.data).toHaveLength(1);
    expect(transfersBody.data[0].metadata).toEqual({ invoice: "INV-123", po: "PO-9" });

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
      data: { transfer: { metadata: Record<string, string> } };
    };
    expect(transferBody.data.transfer.metadata).toEqual({ invoice: "INV-123", po: "PO-9" });
  });

  it("rejects ramp quote metadata with more than 20 fields", async () => {
    const counterpartyId = await seedCounterparty({ externalId: "moonpay_metadata_limit" });
    const metadata = Object.fromEntries(
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
          metadata,
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { details: { errors: { metadata: string[] } } };
    };
    expect(body.error.details.errors.metadata).toContain(
      "metadata must contain at most 20 key-value pairs"
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
          metadata: { invoice: "INV-123", po: "PO-9" },
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
      data: [{ metadata: Record<string, string> }];
    };
    expect(transfersBody.data[0].metadata).toEqual({ invoice: "INV-123", po: "PO-9" });
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

  it("activates immutable wallet control profile revisions from wallet policy updates", async () => {
    const rules = [
      {
        id: "deny-raw-signing",
        kind: "operation_family",
        family: "raw_sign",
        action: "deny",
      },
      {
        id: "approval-for-payments",
        kind: "approval",
        families: ["payment"],
        action: "approval_required",
      },
      {
        id: "deny-payment-execution",
        kind: "operation_type",
        operationType: "payment_transfer_execute",
        action: "deny",
      },
      {
        id: "approve-usdc",
        kind: "asset",
        asset: "USDC",
        action: "approval_required",
      },
    ];

    const updateRes = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          destinationAllowlist: [TEST_SOLANA_ADDRESSES.wallet2],
          maxTransferAmount: "5",
          defaultAction: "allow",
          rules,
        }),
      },
      env
    );

    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as {
      data: {
        policy: {
          destinationAllowlist: string[];
          maxTransferAmount?: string;
          defaultAction?: string;
          rules?: unknown[];
          controlProfile?: {
            id: string;
            status: string;
            revisionId: string;
            revisionNumber: number;
            providerMappingStatus: string;
          };
        };
      };
    };
    expect(updateBody.data.policy.destinationAllowlist).toEqual([TEST_SOLANA_ADDRESSES.wallet2]);
    expect(updateBody.data.policy.maxTransferAmount).toBe("5");
    expect(updateBody.data.policy.defaultAction).toBe("allow");
    expect(updateBody.data.policy.rules).toEqual(rules);
    expect(updateBody.data.policy.controlProfile).toMatchObject({
      status: "active",
      revisionNumber: 1,
      providerMappingStatus: "not_applicable",
    });

    const revisionRows = await getDb(env)
      .prepare(
        `SELECT revision_number, default_action, rules
         FROM wallet_control_profile_revisions
         ORDER BY revision_number ASC`
      )
      .all<{
        revision_number: number;
        default_action: string;
        rules: unknown;
      }>();
    expect(revisionRows.results).toHaveLength(1);
    expect(revisionRows.results[0]).toMatchObject({
      revision_number: 1,
      default_action: "allow",
    });

    const secondRes = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          destinationAllowlist: [],
          defaultAction: "allow",
          rules: [
            {
              id: "deny-programs",
              kind: "operation_family",
              family: "program",
              action: "deny",
            },
          ],
        }),
      },
      env
    );

    expect(secondRes.status).toBe(200);
    const secondBody = (await secondRes.json()) as typeof updateBody;
    expect(secondBody.data.policy.controlProfile?.id).toBe(
      updateBody.data.policy.controlProfile?.id
    );
    expect(secondBody.data.policy.controlProfile?.revisionNumber).toBe(2);

    const getRes = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies`,
      {
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as typeof updateBody;
    expect(getBody.data.policy.controlProfile).toMatchObject({
      id: updateBody.data.policy.controlProfile?.id,
      revisionNumber: 2,
    });
    expect(getBody.data.policy.rules).toEqual([
      {
        id: "deny-programs",
        kind: "operation_family",
        family: "program",
        action: "deny",
      },
    ]);
  });

  it("rejects invalid public wallet policy rule values", async () => {
    const updateRes = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          destinationAllowlist: [],
          rules: [{ kind: "operation_type", operationType: "" }],
        }),
      },
      env
    );

    expect(updateRes.status).toBe(400);
    const body = (await updateRes.json()) as {
      error: { code: string; message: string; details?: { errors?: Record<string, string[]> } };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Invalid request body");
    expect(body.error.details?.errors?.rules).toContain("operationType must not be empty");
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

    const operation = await getDb(env)
      .prepare("SELECT status, operation_family, operation_type FROM wallet_operations")
      .first<{ status: string; operation_family: string; operation_type: string }>();
    expect(operation).toMatchObject({
      status: "failed",
      operation_family: "payment",
      operation_type: "payment_transfer_execute",
    });

    const evaluations = await getDb(env)
      .prepare("SELECT decision, reason_code FROM policy_evaluations")
      .all<{ decision: string; reason_code: string }>();
    expect(evaluations.results).toHaveLength(2);
    expect(evaluations.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ decision: "allow" }),
        expect.objectContaining({
          decision: "deny",
          reason_code: "legacy_wallet_policy_denied",
        }),
      ])
    );
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
    counterpartyId?: string | null;
    destination?: string;
    source?: string;
    token?: string;
    amount?: string;
    memo?: string | null;
    type?: "transfer" | "transfer_confidential" | "transfer_batch" | "onramp" | "offramp";
    direction?: "inbound" | "outbound";
    provider?: "moonpay" | "lightspark" | "bvnk" | "moneygram" | "coinbase" | "mural" | "stripe";
    providerReference?: string | null;
    createdAt?: string;
  }): Promise<void> {
    const now = params.createdAt ?? new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers
           (id, organization_id, project_id, wallet_id, counterparty_id, source_address, destination_address, token, amount, memo, type, direction, status, provider, provider_reference, signature, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        params.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        params.walletId ?? TEST_WALLET_ID,
        params.counterpartyId ?? null,
        params.source ?? TEST_SOLANA_ADDRESSES.wallet1,
        params.destination ?? TEST_SOLANA_ADDRESSES.wallet2,
        params.token ?? "SOL",
        params.amount ?? "1",
        params.memo ?? null,
        params.type ?? "transfer",
        params.direction ?? "outbound",
        params.status,
        params.provider ?? null,
        params.providerReference ?? null,
        params.signature ?? null,
        now,
        now
      )
      .run();
  }

  describe("execute transfer — happy path", () => {
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
      await seedCachedKey({
        walletBindings: [{ walletId: TEST_WALLET_ID, permissions: ["payments:write"] }],
      });
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
      createFeePaymentAdapterMock.mockReturnValue({
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

    it("does not re-run MagicBlock preparation on an idempotent replay", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      createRpcMock.mockReturnValue({
        getTokenSupply: () => ({ send: async () => ({ value: { decimals: 6 } }) }),
      } as unknown as ReturnType<typeof solanaRpc.createRpc>);
      createOrgSignerMock.mockResolvedValue(sourceSigner);
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

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      try {
        const headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Idempotency-Key": "confidential-replay-key",
        };
        const body = JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: DEVNET_USDC_MINT,
          amount: "1",
          privateTransfer: {
            provider: "magicblock",
            magicBlock: { split: 2, minDelayMs: "0", maxDelayMs: "1000" },
          },
        });

        const first = await app.request(
          "/v1/payments/transfers",
          { method: "POST", headers, body },
          env
        );
        const second = await app.request(
          "/v1/payments/transfers",
          { method: "POST", headers, body },
          env
        );

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        const firstBody = (await first.json()) as {
          data: { transfer: { id: string }; privateTransfer: unknown };
        };
        const secondBody = (await second.json()) as {
          data: { transfer: { id: string }; privateTransfer: unknown };
        };
        expect(secondBody.data.transfer.id).toBe(firstBody.data.transfer.id);
        expect(secondBody.data.privateTransfer).toEqual(firstBody.data.privateTransfer);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(signAndSendMock).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("rejects a confidential replay when magicBlock options differ", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      createRpcMock.mockReturnValue({
        getTokenSupply: () => ({ send: async () => ({ value: { decimals: 6 } }) }),
      } as unknown as ReturnType<typeof solanaRpc.createRpc>);
      createOrgSignerMock.mockResolvedValue(sourceSigner);
      const signAndSendMock = vi
        .fn()
        .mockResolvedValue(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        );
      createFeePaymentAdapterMock.mockReturnValue({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      try {
        const headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Idempotency-Key": "confidential-opts-key",
        };
        const bodyA = JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: DEVNET_USDC_MINT,
          amount: "1",
          privateTransfer: {
            provider: "magicblock",
            magicBlock: { split: 2, minDelayMs: "0", maxDelayMs: "1000" },
          },
        });
        const bodyB = JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: DEVNET_USDC_MINT,
          amount: "1",
          privateTransfer: {
            provider: "magicblock",
            magicBlock: { split: 3, minDelayMs: "0", maxDelayMs: "1000" },
          },
        });
        const first = await app.request(
          "/v1/payments/transfers",
          { method: "POST", headers, body: bodyA },
          env
        );
        const conflict = await app.request(
          "/v1/payments/transfers",
          { method: "POST", headers, body: bodyB },
          env
        );
        expect(first.status).toBe(200);
        expect(conflict.status).toBe(409);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("replaces a MagicBlock gasless sponsor signer with Kora during execution", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      await seedCachedKey({
        walletBindings: [{ walletId: TEST_WALLET_ID, permissions: ["payments:write"] }],
      });
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

    it("rejects an additional custody signer outside the API key wallet authorization boundary", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      const additionalSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      await seedAdditionalCustodyWallet(additionalSigner.address);
      await seedCachedKey({
        walletBindings: [{ walletId: TEST_WALLET_ID, permissions: ["payments:write"] }],
      });
      mockTokenSupplyDecimalsOnce();
      createOrgSignerMock.mockImplementation(async (_env, _organizationId, _projectId, walletId) =>
        walletId === TEST_ADDITIONAL_WALLET_ID ? additionalSigner : sourceSigner
      );

      const fetchSpy = mockMagicBlockAdditionalSignerResponse(
        sourceSigner.address,
        additionalSigner.address
      );

      try {
        const res = await requestMagicBlockPrivateTransfer();

        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("FORBIDDEN");
        expect(body.error.message).toContain("not authorized for the requested wallet");
        expect(createOrgSignerMock).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("signs with every custody signer authorized for the API key and transfer policy", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      const additionalSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      await seedAdditionalCustodyWallet(additionalSigner.address);
      await seedAdditionalWalletDestinationPolicy([TEST_SOLANA_ADDRESSES.wallet2]);
      await seedCachedKey({
        walletBindings: [
          { walletId: TEST_WALLET_ID, permissions: ["payments:write"] },
          { walletId: TEST_ADDITIONAL_WALLET_ID, permissions: ["payments:write"] },
        ],
      });
      mockTokenSupplyDecimalsOnce();
      createOrgSignerMock.mockImplementation(async (_env, _organizationId, _projectId, walletId) =>
        walletId === TEST_ADDITIONAL_WALLET_ID ? additionalSigner : sourceSigner
      );
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

      const fetchSpy = mockMagicBlockAdditionalSignerResponse(
        sourceSigner.address,
        additionalSigner.address
      );

      try {
        const res = await requestMagicBlockPrivateTransfer();

        expect(res.status).toBe(200);
        expect(createOrgSignerMock.mock.calls.map((call) => call[3])).toEqual([
          TEST_WALLET_ID,
          TEST_ADDITIONAL_WALLET_ID,
        ]);
        expect(signAndSendMock).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("rejects an authorized additional custody signer denied by its wallet policy", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      const additionalSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      await seedAdditionalCustodyWallet(additionalSigner.address);
      await seedAdditionalWalletDestinationPolicy([TEST_SOLANA_ADDRESSES.wallet3]);
      await seedCachedKey({
        walletBindings: [
          { walletId: TEST_WALLET_ID, permissions: ["payments:write"] },
          { walletId: TEST_ADDITIONAL_WALLET_ID, permissions: ["payments:write"] },
        ],
      });
      mockTokenSupplyDecimalsOnce();
      const fetchSpy = mockMagicBlockAdditionalSignerResponse(
        sourceSigner.address,
        additionalSigner.address
      );

      try {
        const res = await requestMagicBlockPrivateTransfer();

        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("FORBIDDEN");
        expect(body.error.message).toBe("Destination address is not allowed by wallet policy");
        expect(createOrgSignerMock).not.toHaveBeenCalled();
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

    it("blocks a transfer denied by an active wallet control profile before signing", async () => {
      await seedWalletControlProfile({
        rules: [{ id: "small-transfer-only", kind: "amount", max: "0.5" }],
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

      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: {
          code: string;
          details: {
            walletOperationId: string;
            policyEvaluationId: string;
            decision: string;
          };
        };
      };
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.details).toMatchObject({
        decision: "deny",
      });
      expect(body.error.details.walletOperationId).toMatch(/^wop_/);
      expect(body.error.details.policyEvaluationId).toMatch(/^peval_/);
      expect(createOrgSignerMock).not.toHaveBeenCalled();

      const operation = await getDb(env)
        .prepare("SELECT status, operation_family, operation_type FROM wallet_operations")
        .first<{ status: string; operation_family: string; operation_type: string }>();
      expect(operation).toMatchObject({
        status: "failed",
        operation_family: "payment",
        operation_type: "payment_transfer_execute",
      });

      const evaluation = await getDb(env)
        .prepare("SELECT decision FROM policy_evaluations")
        .first<{ decision: string }>();
      expect(evaluation?.decision).toBe("deny");

      const transfers = await getDb(env).prepare("SELECT id FROM payment_transfers").all<{
        id: string;
      }>();
      expect(transfers.results).toHaveLength(0);
    });

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

    it("replays a transfer when the same Idempotency-Key + body is retried", async () => {
      const signAndSendMock = vi
        .fn()
        .mockResolvedValue(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        );
      createFeePaymentAdapterMock.mockReturnValue({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const headers = {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "xfer-key-1",
      };
      const body = JSON.stringify({
        source: TEST_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "1",
      });

      const first = await app.request(
        "/v1/payments/transfers",
        { method: "POST", headers, body },
        env
      );
      const second = await app.request(
        "/v1/payments/transfers",
        { method: "POST", headers, body },
        env
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstJson = (await first.json()) as { data: { transfer: { id: string } } };
      const secondJson = (await second.json()) as { data: { transfer: { id: string } } };
      expect(secondJson.data.transfer.id).toBe(firstJson.data.transfer.id);
      expect(signAndSendMock).toHaveBeenCalledTimes(1);
    });

    it("replays a failed transfer on retry without submitting again", async () => {
      const signAndSendMock = vi.fn().mockRejectedValue(new Error("rpc down"));
      createFeePaymentAdapterMock.mockReturnValue({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const headers = {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "failed-retry-key",
      };
      const body = JSON.stringify({
        source: TEST_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.001",
      });

      const first = await app.request(
        "/v1/payments/transfers",
        { method: "POST", headers, body },
        env
      );
      const second = await app.request(
        "/v1/payments/transfers",
        { method: "POST", headers, body },
        env
      );

      expect(first.status).toBeGreaterThanOrEqual(400);
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { data: { transfer: { status: string } } };
      expect(secondBody.data.transfer.status).toBe("failed");
      expect(signAndSendMock).toHaveBeenCalledTimes(1);
    });

    it("does not re-run policy enforcement on an idempotent replay", async () => {
      const signAndSendMock = vi
        .fn()
        .mockResolvedValue(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        );
      createFeePaymentAdapterMock.mockReturnValue({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const headers = {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "xfer-policy-replay-key",
      };
      const body = JSON.stringify({
        source: TEST_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "1",
      });

      const countWalletOperations = async () => {
        const row = await getDb(env)
          .prepare("SELECT COUNT(*) AS count FROM wallet_operations WHERE organization_id = ?")
          .bind(TEST_ORG.id)
          .first<{ count: number }>();
        return Number(row?.count ?? 0);
      };

      const before = await countWalletOperations();

      const first = await app.request(
        "/v1/payments/transfers",
        { method: "POST", headers, body },
        env
      );
      expect(first.status).toBe(200);
      const afterFirst = await countWalletOperations();
      expect(afterFirst).toBe(before + 1);

      const second = await app.request(
        "/v1/payments/transfers",
        { method: "POST", headers, body },
        env
      );
      expect(second.status).toBe(200);
      const afterSecond = await countWalletOperations();

      const firstJson = (await first.json()) as { data: { transfer: { id: string } } };
      const secondJson = (await second.json()) as { data: { transfer: { id: string } } };
      expect(secondJson.data.transfer.id).toBe(firstJson.data.transfer.id);
      expect(afterSecond).toBe(afterFirst);
      expect(signAndSendMock).toHaveBeenCalledTimes(1);
    });

    it("rejects the same Idempotency-Key with a different body", async () => {
      const headers = {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "xfer-key-2",
      };

      const first = await app.request(
        "/v1/payments/transfers",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            source: TEST_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: "SOL",
            amount: "1",
          }),
        },
        env
      );
      expect(first.status).toBe(200);

      const conflict = await app.request(
        "/v1/payments/transfers",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            source: TEST_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: "SOL",
            amount: "2",
          }),
        },
        env
      );
      expect(conflict.status).toBe(409);
    });

    it("does not dedup when no Idempotency-Key is supplied", async () => {
      const signAndSendMock = vi
        .fn()
        .mockResolvedValueOnce(
          "3agLAsjf2Qba9W59cqxbXFoPRJFDFKB3efqYRhT6wLxaM4KwV31NVrLDjKAw22hR1GFcQc4mePSjZ6XZEHUAjN4c"
        )
        .mockResolvedValueOnce(
          "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV"
        );
      createFeePaymentAdapterMock.mockReturnValue({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const headers = {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
      };
      const body = JSON.stringify({
        source: TEST_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "1",
      });

      const a = await app.request("/v1/payments/transfers", { method: "POST", headers, body }, env);
      const b = await app.request("/v1/payments/transfers", { method: "POST", headers, body }, env);

      const aJson = (await a.json()) as { data: { transfer: { id: string } } };
      const bJson = (await b.json()) as { data: { transfer: { id: string } } };
      expect(bJson.data.transfer.id).not.toBe(aJson.data.transfer.id);
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

    it("returns 400 ACCOUNT_FROZEN when the source SPL token account is frozen", async () => {
      mockRecurringActivationRpc();
      createFeePaymentAdapterMock.mockReturnValueOnce({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        signAsFeePayer: vi.fn(),
        signAndSend: vi
          .fn()
          .mockRejectedValue(
            new Error(
              "Failed to sign and send transaction: RPC Error -32000: Invalid transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x11"
            )
          ),
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
            token: DEVNET_USDC_MINT,
            amount: "1",
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("ACCOUNT_FROZEN");

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
                    mint: DEVNET_USDC_MINT,
                    owner: TEST_SOLANA_ADDRESSES.wallet2,
                    uiTokenAmount: {
                      amount: "10000000",
                      decimals: 6,
                      uiAmountString: "10",
                    },
                  },
                  {
                    accountIndex: 1,
                    mint: DEVNET_USDC_MINT,
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
                    mint: DEVNET_USDC_MINT,
                    owner: TEST_SOLANA_ADDRESSES.wallet2,
                    uiTokenAmount: {
                      amount: "0",
                      decimals: 6,
                      uiAmountString: "0",
                    },
                  },
                  {
                    accountIndex: 1,
                    mint: DEVNET_USDC_MINT,
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
                          mint: DEVNET_USDC_MINT,
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

    it("scopes database-backed wallet-address history to the resolved wallet", async () => {
      await seedTransfer({
        id: "xfr_address_resolved_outbound",
        status: "confirmed",
        source: TEST_SOLANA_ADDRESSES.wallet1,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
      });
      await seedTransfer({
        id: "xfr_address_resolved_inbound",
        status: "confirmed",
        source: TEST_SOLANA_ADDRESSES.wallet2,
        destination: TEST_SOLANA_ADDRESSES.wallet1,
        direction: "inbound",
      });
      await seedTransfer({
        id: "xfr_address_other_wallet",
        status: "confirmed",
        walletId: "wal_payments_other",
        source: TEST_SOLANA_ADDRESSES.wallet2,
        destination: TEST_SOLANA_ADDRESSES.wallet3,
      });

      const res = await app.request(
        `/v1/payments/transfers?walletAddress=${TEST_SOLANA_ADDRESSES.wallet1}&includeObserved=false`,
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
      expect(body.data.map((transfer) => transfer.id).sort()).toEqual([
        "xfr_address_resolved_inbound",
        "xfr_address_resolved_outbound",
      ]);
      expect(body.meta.total).toBe(2);
      expect(getSignaturesForAddressMock).not.toHaveBeenCalled();
    });

    it("matches either side of an unowned address in database-backed history", async () => {
      await seedTransfer({
        id: "xfr_address_external_outbound",
        status: "confirmed",
        walletId: "wal_external_outbound",
        source: TEST_SOLANA_ADDRESSES.wallet2,
        destination: TEST_SOLANA_ADDRESSES.wallet3,
      });
      await seedTransfer({
        id: "xfr_address_external_inbound",
        status: "confirmed",
        walletId: "wal_external_inbound",
        source: TEST_SOLANA_ADDRESSES.wallet3,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        direction: "inbound",
      });
      await seedTransfer({
        id: "xfr_address_external_unrelated",
        status: "confirmed",
        walletId: "wal_external_unrelated",
        source: TEST_SOLANA_ADDRESSES.wallet3,
        destination: TEST_KORA_FEE_PAYER,
      });

      const res = await app.request(
        `/v1/payments/transfers?walletAddress=${TEST_SOLANA_ADDRESSES.wallet2}&includeObserved=false`,
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
      expect(body.data.map((transfer) => transfer.id).sort()).toEqual([
        "xfr_address_external_inbound",
        "xfr_address_external_outbound",
      ]);
      expect(body.meta.total).toBe(2);
    });

    it("enforces payments:read wallet grants for database-backed transfer lists", async () => {
      await seedTransfer({ id: "xfr_wallet_readable", status: "confirmed" });
      await seedTransfer({
        id: "xfr_wallet_write_only",
        status: "confirmed",
        walletId: "wal_payments_write_only",
      });
      await seedCachedKey({
        walletBindings: [
          { walletId: TEST_WALLET_ID, permissions: ["payments:read"] },
          { walletId: "wal_payments_write_only", permissions: ["payments:write"] },
        ],
      });

      const listRes = await app.request(
        "/v1/payments/transfers?includeObserved=false",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { data: Array<{ id: string }> };
      expect(listBody.data.map((transfer) => transfer.id)).toEqual(["xfr_wallet_readable"]);

      const forbiddenRes = await app.request(
        "/v1/payments/transfers?wallet=wal_payments_write_only&includeObserved=false",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(forbiddenRes.status).toBe(403);
    });

    it("returns no rows when selected wallets grant no payments:read access", async () => {
      await seedTransfer({ id: "xfr_wallet_not_readable", status: "confirmed" });
      await seedCachedKey({
        walletBindings: [{ walletId: TEST_WALLET_ID, permissions: ["payments:write"] }],
      });

      const res = await app.request(
        "/v1/payments/transfers?includeObserved=false",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[]; meta: { total: number } };
      expect(body.data).toEqual([]);
      expect(body.meta.total).toBe(0);
    });

    it("enforces payments:read on exact provider-reference lookups", async () => {
      await seedTransfer({
        id: "xfr_provider_reference_private",
        status: "completed",
        type: "offramp",
        provider: "moonpay",
        providerReference: "private-provider-reference",
      });
      await seedCachedKey({
        walletBindings: [{ walletId: TEST_WALLET_ID, permissions: ["payments:write"] }],
      });

      const res = await app.request(
        "/v1/payments/transfers?provider=moonpay&providerReference=private-provider-reference",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toContain("requested wallet");
    });

    it("composes exact provider-reference lookups with every ledger filter and pagination", async () => {
      const counterpartyId = await seedCounterparty({ id: "counterparty_exact_reference" });
      await seedTransfer({
        id: "xfr_exact_reference_match",
        status: "completed",
        counterpartyId,
        source: TEST_SOLANA_ADDRESSES.wallet1,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "USDC",
        memo: "Quarterly invoice",
        type: "offramp",
        direction: "outbound",
        provider: "moonpay",
        providerReference: "exact-reference-42",
        createdAt: "2026-01-02T12:00:00.000Z",
      });

      const matchingQuery = new URLSearchParams({
        provider: "moonpay",
        providerReference: "exact-reference-42",
        wallet: TEST_WALLET_ID,
        walletAddress: TEST_SOLANA_ADDRESSES.wallet1,
        search: "quarterly",
        status: "completed",
        category: "ramp",
        type: "offramp",
        counterpartyId,
        token: "USDC",
        direction: "outbound",
        from: "2026-01-02T16:00:00+05:00",
        to: "2026-01-02T08:00:00-05:00",
        sortBy: "amount",
        sortDirection: "asc",
        pageSize: "1",
      });

      const firstPageRes = await app.request(
        `/v1/payments/transfers?${matchingQuery}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(firstPageRes.status).toBe(200);
      const firstPage = (await firstPageRes.json()) as {
        data: Array<{ id: string }>;
        meta: { page: number; pageSize: number; total: number };
      };
      expect(firstPage.data.map((transfer) => transfer.id)).toEqual(["xfr_exact_reference_match"]);
      expect(firstPage.meta).toMatchObject({ page: 1, pageSize: 1, total: 1 });

      matchingQuery.set("page", "2");
      const secondPageRes = await app.request(
        `/v1/payments/transfers?${matchingQuery}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(secondPageRes.status).toBe(200);
      const secondPage = (await secondPageRes.json()) as {
        data: unknown[];
        meta: { hasMore: boolean; page: number; total: number };
      };
      expect(secondPage.data).toEqual([]);
      expect(secondPage.meta).toMatchObject({ hasMore: false, page: 2, total: 1 });

      matchingQuery.set("page", "1");
      matchingQuery.set("status", "failed");
      const mismatchedFilterRes = await app.request(
        `/v1/payments/transfers?${matchingQuery}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(mismatchedFilterRes.status).toBe(200);
      const mismatchedFilter = (await mismatchedFilterRes.json()) as {
        data: unknown[];
        meta: { total: number };
      };
      expect(mismatchedFilter.data).toEqual([]);
      expect(mismatchedFilter.meta.total).toBe(0);
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

    it("filters by multiple statuses when status query param is comma-separated", async () => {
      await seedTransfer({ id: "xfr_multi_completed", status: "completed" });
      await seedTransfer({ id: "xfr_multi_confirmed", status: "confirmed" });
      await seedTransfer({ id: "xfr_multi_pending", status: "pending" });

      const res = await app.request(
        "/v1/payments/transfers?status=completed,confirmed,finalized",
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
      expect(body.data).toHaveLength(2);
      expect(body.data.map((transfer) => transfer.status).sort()).toEqual([
        "completed",
        "confirmed",
      ]);
    });

    it("composes search, type, provider, and stable database pagination", async () => {
      const counterpartyId = await seedCounterparty({ id: "counterparty_searchable" });
      await seedTransfer({
        id: "xfr_search_old",
        status: "completed",
        counterpartyId,
        type: "offramp",
        provider: "moonpay",
        providerReference: "merchant-reference-42",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await seedTransfer({
        id: "xfr_search_new",
        status: "completed",
        counterpartyId,
        type: "offramp",
        provider: "moonpay",
        providerReference: "merchant-reference-43",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      await seedTransfer({
        id: "xfr_wrong_provider",
        status: "completed",
        counterpartyId,
        type: "offramp",
        provider: "stripe",
      });

      const query = new URLSearchParams({
        search: "MoonPay Test Counterparty",
        type: "offramp",
        provider: "moonpay",
        status: "completed",
        sortBy: "createdAt",
        sortDirection: "asc",
        page: "2",
        pageSize: "1",
      });
      const res = await app.request(
        `/v1/payments/transfers?${query}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ id: string; walletId: string }>;
        meta: { total: number; page: number; pageSize: number; hasMore: boolean };
      };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        id: "xfr_search_new",
        walletId: TEST_WALLET_ID,
        counterpartyId,
        counterpartyDisplayName: "MoonPay Test Counterparty",
      });
      expect(body.meta).toMatchObject({ total: 2, page: 2, pageSize: 1, hasMore: false });
    });

    it("applies search, date filters, and amount sorting to observed wallet history", async () => {
      const counterpartyId = await seedCounterparty({ id: "counterparty_observed_search" });
      const matchingLowSignature = "observed-filter-match-low-signature";
      const matchingHighSignature = "observed-filter-match-high-signature";
      const outsideDateSignature = "observed-filter-outside-date-signature";
      const otherCounterpartySignature = "observed-filter-other-counterparty-signature";

      await seedTransfer({
        id: "xfr_observed_filter_low",
        status: "confirmed",
        signature: matchingLowSignature,
        counterpartyId,
        amount: "2",
        createdAt: "2026-01-02T16:00:00.000Z",
      });
      await seedTransfer({
        id: "xfr_observed_filter_high",
        status: "confirmed",
        signature: matchingHighSignature,
        counterpartyId,
        amount: "20",
        createdAt: "2026-01-03T00:00:00.000Z",
      });
      await seedTransfer({
        id: "xfr_observed_filter_outside_date",
        status: "confirmed",
        signature: outsideDateSignature,
        counterpartyId,
        amount: "1",
        createdAt: "2025-12-31T23:59:59.000Z",
      });
      await seedTransfer({
        id: "xfr_observed_filter_other_counterparty",
        status: "confirmed",
        signature: otherCounterpartySignature,
        amount: "0.5",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      getSignaturesForAddressMock.mockResolvedValueOnce(
        [
          matchingLowSignature,
          matchingHighSignature,
          outsideDateSignature,
          otherCounterpartySignature,
        ].map((signature, index) => ({
          signature: signature as unknown as Signature,
          slot: BigInt(200 + index),
          blockTime: 1_767_225_600n + BigInt(index),
          err: null,
        }))
      );

      const query = new URLSearchParams({
        wallet: TEST_WALLET_ID,
        search: "moonpay test",
        from: "2026-01-02T20:00:00+05:00",
        to: "2026-01-03T19:00:00-05:00",
        sortBy: "amount",
        sortDirection: "asc",
      });
      const res = await app.request(
        `/v1/payments/transfers?${query}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ amount: string; counterpartyDisplayName?: string; id: string }>;
        meta: { total: number };
      };
      expect(body.data).toEqual([
        expect.objectContaining({
          id: "xfr_observed_filter_low",
          amount: "2",
          counterpartyDisplayName: "MoonPay Test Counterparty",
        }),
        expect.objectContaining({
          id: "xfr_observed_filter_high",
          amount: "20",
          counterpartyDisplayName: "MoonPay Test Counterparty",
        }),
      ]);
      expect(body.meta.total).toBe(2);
    });

    it("uses database-backed pagination for wallet filters when observed history is disabled", async () => {
      await seedTransfer({ id: "xfr_wallet_recorded", status: "confirmed" });

      const res = await app.request(
        `/v1/payments/transfers?wallet=${TEST_WALLET_ID}&includeObserved=false`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }>; meta: { total: number } };
      expect(body.data.map((transfer) => transfer.id)).toEqual(["xfr_wallet_recorded"]);
      expect(body.meta.total).toBe(1);
      expect(getSignaturesForAddressMock).not.toHaveBeenCalled();
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

    it("allows blank searches but rejects searches shorter than three characters", async () => {
      await seedTransfer({ id: "xfr_search_contract", status: "confirmed" });

      const blankRes = await app.request(
        "/v1/payments/transfers?search=%20%20%20&includeObserved=false",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(blankRes.status).toBe(200);
      const blankBody = (await blankRes.json()) as { data: Array<{ id: string }> };
      expect(blankBody.data.map((transfer) => transfer.id)).toEqual(["xfr_search_contract"]);

      const shortRes = await app.request(
        "/v1/payments/transfers?search=xy&includeObserved=false",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(shortRes.status).toBe(400);
      const shortBody = (await shortRes.json()) as {
        error: { code: string; message: string };
      };
      expect(shortBody.error.code).toBe("BAD_REQUEST");
      expect(shortBody.error.message).toContain("Invalid query parameters");
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

    it("enforces payments:read when getting a transfer by ID", async () => {
      await seedTransfer({ id: "xfr_single_write_only", status: "confirmed" });
      await seedCachedKey({
        walletBindings: [{ walletId: TEST_WALLET_ID, permissions: ["payments:write"] }],
      });

      const res = await app.request(
        "/v1/payments/transfers/xfr_single_write_only",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("FORBIDDEN");
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
