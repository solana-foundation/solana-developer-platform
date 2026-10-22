import * as feePaymentAdapters from "@sdp/fee-payment";
import * as feePaymentChainReads from "@sdp/fee-payment/chain-reads";
import { KoraAdapter } from "@sdp/fee-payment/kora.adapter";
import type { SponsorshipProviderConfiguration } from "@sdp/fee-payment/port";
import { hashString } from "@sdp/payments/hash";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import * as solanaRpc from "@sdp/rpc/solana";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { getBase58Codec } from "@solana/codecs";
import {
  address,
  createNoopSigner,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Signature,
} from "@solana/kit";
import * as subscriptionsProgram from "@solana/subscriptions";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { afterEach, beforeEach, onTestFinished, vi } from "vitest";
import { getDb } from "@/db/client";
import { SponsorshipBudgetRepository } from "@/db/repositories/sponsorship-budget.repository";
import * as tokenAccounts from "@/routes/payments/token-accounts";
import * as solanaSigner from "@/services/solana/signer";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import {
  seedTestPrivyConnection,
  writeTestPrivyCredentialSecret,
} from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { fullySignTestTransaction, TEST_MOCK_FEE_PAYER } from "@/test/helpers/sponsor-signing";
import { type SeededApiKey, seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

export const createRpcMock = vi.spyOn(solanaRpc, "createRpc");

export const getAccountInfoMock = vi.spyOn(solanaRpc, "getAccountInfo");

export const getRecentBlockhashMock = vi.spyOn(solanaRpc, "getRecentBlockhash");

export const confirmTransactionMock = vi.spyOn(solanaRpc, "confirmTransaction");

export const getTransactionMock = vi.spyOn(solanaRpc, "getTransaction");

export const sendAndConfirmTransactionMock = vi.spyOn(solanaRpc, "sendAndConfirmTransaction");

export const sendTransactionMock = vi.spyOn(solanaRpc, "sendTransaction");

export const getSignaturesForAddressMock = vi.spyOn(solanaRpc, "getSignaturesForAddress");

export const getSplTokenAccountAddressesMock = vi.spyOn(
  tokenAccounts,
  "getSplTokenAccountAddresses"
);

export const createKoraAdapterMock = vi.spyOn(feePaymentAdapters, "createKoraAdapter");

export const priceSponsoredTransactionMock = vi.spyOn(
  feePaymentChainReads,
  "priceSponsoredTransaction"
);

export const TEST_SPONSORED_PRICE = { networkFee: 5000n, lastValidBlockHeight: 1000n };

export function testKoraAdapter(
  methods: Pick<KoraAdapter, "getFeePayer" | "getSponsorshipConfiguration" | "signAsFeePayer">
): KoraAdapter {
  return Object.assign(
    new KoraAdapter({ rpcUrl: "https://kora.payments.test", userId: "sdp:v1:test" }),
    methods
  );
}

/** MoonPay's sale cancel, answered here so a route test never reaches MoonPay. */
export const cancelMoonpaySaleMock = vi.spyOn(RAMP_PROVIDER_CLIENTS.moonpay, "cancelOfframpSale");

export const createOrgSignerForCustodyWalletMock = vi.spyOn(
  solanaSigner,
  "createOrgSignerForCustodyWallet"
);

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

export const TEST_PRODUCTION_PROJECT_ID = `${TEST_PROJECT.id}_production`;

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
  signerAddress: TEST_MOCK_FEE_PAYER,
  maxAllowedLamports: 0n,
  feePayerMayTransferLamports: false,
  feePayerPolicy: { test: "zero-outflow" },
} satisfies SponsorshipProviderConfiguration;

const TEST_SEEDED_API_KEY: SeededApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  grants: ALL_API_KEY_GRANTS,
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  status: "active",
  expiresAt: null,
};

export const TEST_MOONPAY_API_KEY = "pk_test_moonpay";

export const TEST_MOONPAY_SECRET_KEY = "sk_test_moonpay";

export const TEST_MOONPAY_ONRAMP_URL = "https://buy-sandbox.moonpay.com";

export const TEST_MOONPAY_OFFRAMP_URL = "https://sell-sandbox.moonpay.com";

export const DEVNET_USDC_MINT = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;

export const MAINNET_USDC_MINT = WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address;

let originalMoonPaySandboxApiKey: string | undefined;

let originalMoonPaySandboxSecretKey: string | undefined;

async function seedAuthAndWallet(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);

  await seedApiKeyRow(env, keyHash, TEST_SEEDED_API_KEY);

  await getDb(env).batch([
    getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status, settings) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(
        TEST_ORG.id,
        TEST_ORG.name,
        TEST_ORG.slug,
        "enterprise",
        "active",
        JSON.stringify({ providerOverrides: { custody: { local: true } } })
      ),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER.id, TEST_USER.email, 1, "active"),
  ]);
  await seedDefaultProjects(getDb(env), {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [TEST_USER.id],
    ids: { sandbox: TEST_PROJECT.id, production: TEST_PRODUCTION_PROJECT_ID },
  });
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, grants, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET organization_id = excluded.organization_id, project_id = excluded.project_id, created_by = excluded.created_by, name = excluded.name, key_prefix = excluded.key_prefix, key_hash = excluded.key_hash, grants = excluded.grants, status = excluded.status`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        "Payments Test Key",
        TEST_API_KEY.prefix,
        keyHash,
        ALL_API_KEY_GRANTS,
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_CONFIG_ID,
        TEST_ORG.id,
        TEST_PROJECT.id,
        "local",
        "test-config",
        "sdp-custody-encryption-v1",
        "active"
      ),
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

export async function seedCachedKey(override: Partial<SeededApiKey>): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedApiKeyRow(env, keyHash, {
    ...TEST_SEEDED_API_KEY,
    ...override,
  });
}

/**
 * Give a project a BYOK Privy wallet, the only custody Production allows (HOO-1970), with the
 * custody encryption key the connection's stored credential needs set for the current test.
 *
 * @param tenant - The project's owner and the wallet to seed.
 * @param tenant.organizationId - The organization that owns the project.
 * @param tenant.projectId - The project the connection belongs to.
 * @param tenant.createdBy - The user recorded as the connection's creator.
 * @param tenant.custodyWalletId - The SDP custody wallet id, also the connection's default wallet.
 * @param tenant.publicKey - The address the wallet's signer signs as.
 * @returns The wallet's provider wallet id, once the wallet and its connection are seeded.
 */
export async function seedProjectPrivyWallet(tenant: {
  organizationId: string;
  projectId: string;
  createdBy: string;
  custodyWalletId: string;
  publicKey: string;
}): Promise<string> {
  const walletId = `privy_${tenant.custodyWalletId}`;
  const originalEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
  env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 41).toString("base64");
  onTestFinished(() => {
    env.CUSTODY_ENCRYPTION_KEY = originalEncryptionKey;
  });
  await seedTestPrivyConnection(getDb(env), {
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
    connectionId: `cconn_${tenant.custodyWalletId}`,
    credentialId: `pcred_${tenant.custodyWalletId}`,
    createdBy: tenant.createdBy,
    stored: await writeTestPrivyCredentialSecret(env, {
      organizationId: tenant.organizationId,
      credentialId: `pcred_${tenant.custodyWalletId}`,
      appId: `app_${tenant.custodyWalletId}`,
      appSecret: `secret_${tenant.custodyWalletId}`,
    }),
    providerAccountFingerprint: `sha256:${tenant.custodyWalletId}`,
    wallets: [
      {
        id: tenant.custodyWalletId,
        walletId,
        publicKey: tenant.publicKey,
        label: "Production Payments Wallet",
        purpose: "transfer",
        status: "active",
      },
    ],
    lastCheckStatus: "success",
    defaultCustodyWalletId: tenant.custodyWalletId,
  });
  return walletId;
}

/**
 * Re-home the seeded API key onto the organization's Production project and give that project a
 * BYOK Privy wallet.
 *
 * @param wallet - The Production wallet to seed.
 * @param wallet.custodyWalletId - The SDP custody wallet id, also the connection's default wallet.
 * @param wallet.publicKey - The address the wallet's signer signs as.
 * @returns The wallet's provider wallet id, once the wallet, its connection and the re-homed key
 *   are seeded.
 */
export async function seedProductionPrivyWallet(wallet: {
  custodyWalletId: string;
  publicKey: string;
}): Promise<string> {
  const walletId = await seedProjectPrivyWallet({
    organizationId: TEST_ORG.id,
    projectId: TEST_PRODUCTION_PROJECT_ID,
    createdBy: TEST_USER.id,
    custodyWalletId: wallet.custodyWalletId,
    publicKey: wallet.publicKey,
  });
  await getDb(env)
    .prepare("UPDATE api_keys SET project_id = ? WHERE id = ?")
    .bind(TEST_PRODUCTION_PROJECT_ID, TEST_API_KEY.id)
    .run();
  await seedCachedKey({ projectId: TEST_PRODUCTION_PROJECT_ID, environment: "production" });
  return walletId;
}

/**
 * Enable the mainnet global sponsorship policy as an operator would; the seed ships it disabled
 * pending approval, so a Production project's sponsored movement needs this first.
 *
 * @returns Resolves once the policy is enabled at a new version.
 */
export async function enableMainnetSponsorship(): Promise<void> {
  await new SponsorshipBudgetRepository(getDb(env)).setPolicyEnabled({
    network: "mainnet",
    scopeType: "global",
    scopeId: null,
    enabled: true,
    operator: "operator:payments-test",
    reason: "Approve mainnet sponsorship for the Production project",
  });
}

export async function seedCounterparty(params?: {
  id?: string;
  externalId?: string | null;
  providerData?: Record<string, unknown>;
  projectId?: string;
}): Promise<string> {
  const id = params?.id ?? `cpty_${crypto.randomUUID()}`;
  const externalId = params?.externalId ?? null;
  const providerData = params?.providerData ?? {};
  await getDb(env)
    .prepare(
      `INSERT INTO counterparties (
         id,
         organization_id,
         project_id,
         external_id,
         entity_type,
         display_name,
         provider_data,
         status,
         created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
    )
    .bind(
      id,
      TEST_ORG.id,
      params?.projectId ?? TEST_PROJECT.id,
      externalId,
      "individual",
      "MoonPay Test Counterparty",
      providerData,
      TEST_USER.id
    )
    .run();

  return id;
}

export async function recurringCollectionTransactionForSignature(options: {
  signature: Signature;
  decimals: number;
}) {
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
    .bind(options.signature, options.signature)
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

  const amountBaseUnits = parseDecimalAmount(row.amount, options.decimals);
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
    accountKeys: [row.subscription_authority_address],
    executionResultKnown: true,
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
    } as unknown as ReturnType<typeof solanaRpc.createRpc>);
    priceSponsoredTransactionMock.mockResolvedValue(TEST_SPONSORED_PRICE);
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
      recurringCollectionTransactionForSignature({ signature, decimals: 6 })
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
    createKoraAdapterMock.mockReturnValue(
      testKoraAdapter({
        getFeePayer: vi.fn().mockResolvedValue(TEST_MOCK_FEE_PAYER),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
        signAsFeePayer: vi.fn().mockImplementation(fullySignTestTransaction),
      })
    );
    createOrgSignerForCustodyWalletMock.mockResolvedValue(
      createNoopSigner(address("8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ"))
    );
    cancelMoonpaySaleMock.mockResolvedValue("canceled");

    originalMoonPaySandboxApiKey = env.MOONPAY_SANDBOX_API_KEY;
    originalMoonPaySandboxSecretKey = env.MOONPAY_SANDBOX_SECRET_KEY;

    env.MOONPAY_SANDBOX_API_KEY = TEST_MOONPAY_API_KEY;
    env.MOONPAY_SANDBOX_SECRET_KEY = TEST_MOONPAY_SECRET_KEY;

    await seedTestDatabase(env);
    await seedAuthAndWallet();
  });

  afterEach(async () => {
    env.MOONPAY_SANDBOX_API_KEY = originalMoonPaySandboxApiKey;
    env.MOONPAY_SANDBOX_SECRET_KEY = originalMoonPaySandboxSecretKey;

    await clearKVStores(env);
  });
}
