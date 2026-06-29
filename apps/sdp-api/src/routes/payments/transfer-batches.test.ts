import { type CachedApiKey, SPL_TOKEN_PROGRAMS } from "@sdp/types";
import { address, createNoopSigner, generateKeyPairSigner } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { hashString } from "@/lib/hash";
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
const createFeePaymentAdapterMock = vi.spyOn(feePaymentAdapters, "createFeePaymentAdapter");
const createOrgSignerMock = vi.spyOn(solanaServices, "createOrgSigner");

const TEST_CONFIG_ID = "cust_cfg_batch_payments_test";
const TEST_CUSTODY_WALLET_ID = "cwlt_batch_payments_test";
const TEST_WALLET_ID = "wal_batch_payments_test";
const TEST_ORG = {
  id: "org_batch_payments_test",
  name: "Batch Payments Test Org",
  slug: "batch-payments-test-org",
};
const TEST_PROJECT = {
  id: "prj_batch_payments_test",
  slug: "batch-payments-test-project",
};
const TEST_USER = {
  id: "usr_batch_payments_test",
  email: "batch-payments-test@example.com",
};
const TEST_API_KEY = {
  id: "key_batch_payments_test",
  raw: "sk_test_batch_payments",
  prefix: "sk_test_bat",
};
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
const TEST_KORA_FEE_PAYER = "4YhMUz8xDgHMPAevvfMpnJX9TJmw9DTNDA1sNWPRZG9q";
const FIRST_SIGNATURE =
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy";
const SECOND_SIGNATURE =
  "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV";
const TEST_TOKEN_ACCOUNT = TEST_SOLANA_ADDRESSES.wallet3;

function mockSourceTokenAccountRpc(params: {
  mint: string;
  tokenAccount: string;
  decimals: number;
}) {
  createRpcMock.mockReturnValue({
    getTokenAccountsByOwner: () => ({
      send: async () => ({
        value: [
          {
            pubkey: params.tokenAccount,
            account: {
              data: {
                parsed: {
                  info: {
                    mint: params.mint,
                    tokenAmount: {
                      amount: "1000000000",
                      decimals: params.decimals,
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
  } as unknown as ReturnType<typeof solanaRpc.createRpc>);
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
        "Batch Payments Test Project",
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
        "Batch Payments Test Key",
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
        "Batch Payments Wallet",
        "transfer",
        "active"
      ),
  ]);
}

async function updateSeededWalletPublicKey(publicKey: string): Promise<void> {
  await getDb(env)
    .prepare("UPDATE custody_wallets SET public_key = ? WHERE wallet_id = ?")
    .bind(publicKey, TEST_WALLET_ID)
    .run();
}

async function seedCounterparty(externalId: string): Promise<string> {
  const id = `counterparty_${crypto.randomUUID()}`;
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
      externalId,
      "individual",
      "Batch Test Counterparty",
      "batch-counterparty@example.com",
      {},
      {},
      TEST_USER.id
    )
    .run();

  return id;
}

async function seedCryptoWalletCounterpartyAccount(params: {
  counterpartyId: string;
  walletAddress: string;
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
      "Batch payment wallet",
      JSON.stringify({ network: "solana", address: params.walletAddress }),
      JSON.stringify({}),
      "active",
      now,
      now
    )
    .run();

  return id;
}

describe("payment transfer batches", () => {
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
      signature: FIRST_SIGNATURE as Awaited<
        ReturnType<typeof solanaRpc.confirmTransaction>
      >["signature"],
      slot: 100n,
      confirmationStatus: "confirmed",
      err: null,
    });
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: vi.fn().mockResolvedValue(FIRST_SIGNATURE),
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    createOrgSignerMock.mockResolvedValue(
      createNoopSigner(address("8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ"))
    );

    await seedTestDatabase(env);
    await seedAuthAndWallet();
  });

  afterEach(async () => {
    await clearTestDatabase(env);
    await clearKVNamespaces(env);
  });

  it("estimates a SOL transfer batch", async () => {
    const getFeeForMessageMock = vi.fn(() => ({
      send: async () => ({ value: 5000n }),
    }));
    createRpcMock.mockReturnValueOnce({
      getFeeForMessage: getFeeForMessageMock,
    } as unknown as ReturnType<typeof solanaRpc.createRpc>);

    const counterpartyId = await seedCounterparty("batch_estimate_counterparty");
    const firstAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      walletAddress: TEST_SOLANA_ADDRESSES.wallet2,
    });
    const secondAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      walletAddress: TEST_SOLANA_ADDRESSES.wallet3,
    });

    const res = await app.request(
      "/v1/payments/transfer-batches/estimate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          token: "SOL",
          recipients: [
            {
              counterpartyId,
              counterpartyAccountId: firstAccountId,
              amount: "0.1",
            },
            {
              counterpartyId,
              counterpartyAccountId: secondAccountId,
              amount: "0.2",
            },
          ],
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        estimate: {
          recipientCount: number;
          transactionCount: number;
          estimatedFees: {
            networkFeeLamports: string;
            priorityFeeLamports: string;
            tokenAccountRentLamports: string;
            sponsored: boolean;
          };
        };
      };
    };
    expect(body.data.estimate).toMatchObject({
      recipientCount: 2,
      transactionCount: 1,
      estimatedFees: {
        networkFeeLamports: "5000",
        priorityFeeLamports: "0",
        tokenAccountRentLamports: "0",
        sponsored: true,
      },
    });
    expect(getFeeForMessageMock).toHaveBeenCalledTimes(1);
  });

  it("creates a SOL transfer batch and records chunk transfers", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValueOnce(sourceSigner);

    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(FIRST_SIGNATURE)
      .mockResolvedValueOnce(SECOND_SIGNATURE);
    createFeePaymentAdapterMock.mockReturnValueOnce({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

    const counterpartyId = await seedCounterparty("batch_create_counterparty");
    const firstAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      walletAddress: TEST_SOLANA_ADDRESSES.wallet2,
    });
    const secondAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      walletAddress: TEST_SOLANA_ADDRESSES.wallet3,
    });

    const res = await app.request(
      "/v1/payments/transfer-batches",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          externalId: "batch-create-001",
          source: TEST_WALLET_ID,
          token: "SOL",
          recipients: [
            {
              externalId: "batch-recipient-001",
              counterpartyId,
              counterpartyAccountId: firstAccountId,
              amount: "0.1",
            },
            {
              externalId: "batch-recipient-002",
              counterpartyId,
              counterpartyAccountId: secondAccountId,
              amount: "0.2",
            },
          ],
          options: {
            maxRecipientsPerTransaction: 1,
            preflight: false,
          },
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        batch: {
          id: string;
          status: string;
          externalId: string | null;
          totalAmount: string | null;
          recipientCount: number;
          transactionCount: number;
        };
        recipients: Array<{ status: string; transferId: string | null }>;
        transfers: Array<{ id: string; type: string; status: string; signature: string | null }>;
      };
    };
    expect(body.data.batch).toMatchObject({
      status: "confirmed",
      externalId: "batch-create-001",
      totalAmount: "0.3",
      recipientCount: 2,
      transactionCount: 2,
    });
    expect(body.data.recipients).toHaveLength(2);
    expect(body.data.recipients.every((recipient) => recipient.status === "confirmed")).toBe(true);
    expect(body.data.recipients.every((recipient) => Boolean(recipient.transferId))).toBe(true);
    expect(body.data.transfers).toHaveLength(2);
    expect(body.data.transfers.map((transfer) => transfer.signature)).toEqual([
      FIRST_SIGNATURE,
      SECOND_SIGNATURE,
    ]);
    expect(body.data.transfers.every((transfer) => transfer.type === "transfer_batch")).toBe(true);
    expect(signAndSendMock).toHaveBeenCalledTimes(2);

    const batchRow = await getDb(env)
      .prepare(
        `SELECT status, total_amount, recipient_count, transaction_count
           FROM payment_transfer_batches
          WHERE id = ?`
      )
      .bind(body.data.batch.id)
      .first<{
        status: string;
        total_amount: string | null;
        recipient_count: number;
        transaction_count: number;
      }>();
    expect(batchRow).toMatchObject({
      status: "confirmed",
      total_amount: "0.3",
      recipient_count: 2,
      transaction_count: 2,
    });

    const recipientRows = await getDb(env)
      .prepare(
        `SELECT status, transfer_id
           FROM payment_transfer_recipients
          WHERE batch_id = ?
          ORDER BY external_id ASC`
      )
      .bind(body.data.batch.id)
      .all<{ status: string; transfer_id: string | null }>();
    expect(recipientRows.results).toHaveLength(2);
    expect(recipientRows.results.every((recipient) => recipient.status === "confirmed")).toBe(true);
    expect(recipientRows.results.every((recipient) => Boolean(recipient.transfer_id))).toBe(true);

    const transferRows = await getDb(env)
      .prepare(
        `SELECT type, status, signature
           FROM payment_transfers
          WHERE type = 'transfer_batch'
          ORDER BY signature ASC`
      )
      .all<{ type: string; status: string; signature: string | null }>();
    expect(transferRows.results).toHaveLength(2);
    expect(transferRows.results.every((transfer) => transfer.status === "confirmed")).toBe(true);

    const detailRes = await app.request(
      `/v1/payments/transfer-batches/${body.data.batch.id}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as {
      data: { recipients: unknown[]; transfers: unknown[] };
    };
    expect(detailBody.data.recipients).toHaveLength(2);
    expect(detailBody.data.transfers).toHaveLength(2);

    const listRes = await app.request(
      "/v1/payments/transfer-batches",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: Array<{ id: string }> };
    expect(listBody.data.map((batch) => batch.id)).toContain(body.data.batch.id);
  });

  it.each([
    ["legacy SPL Token", SPL_TOKEN_PROGRAMS["spl-token"]],
    ["Token-2022", SPL_TOKEN_PROGRAMS["token-2022"]],
  ])("creates a %s transfer batch", async (_label, tokenProgram) => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValueOnce(sourceSigner);
    getAccountInfoMock.mockResolvedValueOnce({
      lamports: 4200000000n,
      owner: tokenProgram,
    } as Awaited<ReturnType<typeof solanaRpc.getAccountInfo>>);
    mockSourceTokenAccountRpc({
      mint: TEST_SOLANA_ADDRESSES.mint,
      tokenAccount: TEST_TOKEN_ACCOUNT,
      decimals: 6,
    });

    const signAndSendMock = vi.fn().mockResolvedValueOnce(FIRST_SIGNATURE);
    createFeePaymentAdapterMock.mockReturnValueOnce({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

    const counterpartyId = await seedCounterparty(`batch_token_counterparty_${tokenProgram}`);
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      walletAddress: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const res = await app.request(
      "/v1/payments/transfer-batches",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          token: TEST_SOLANA_ADDRESSES.mint,
          recipients: [
            {
              counterpartyId,
              counterpartyAccountId,
              amount: "1.25",
            },
          ],
          options: {
            preflight: false,
          },
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        batch: { status: string; token: string; totalAmount: string | null };
        recipients: Array<{ status: string; destination: string }>;
        transfers: Array<{ type: string; status: string; signature: string | null }>;
      };
    };
    expect(body.data.batch).toMatchObject({
      status: "confirmed",
      token: TEST_SOLANA_ADDRESSES.mint,
      totalAmount: "1.25",
    });
    expect(body.data.recipients).toMatchObject([
      {
        status: "confirmed",
        destination: TEST_SOLANA_ADDRESSES.wallet2,
      },
    ]);
    expect(body.data.transfers).toMatchObject([
      {
        type: "transfer_batch",
        status: "confirmed",
        signature: FIRST_SIGNATURE,
      },
    ]);
    expect(signAndSendMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a chunk processing when confirmation times out (tx may still land)", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValueOnce(sourceSigner);

    const signAndSendMock = vi.fn().mockResolvedValueOnce(FIRST_SIGNATURE);
    createFeePaymentAdapterMock.mockReturnValueOnce({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    confirmTransactionMock.mockRejectedValueOnce(
      new Error(`Transaction ${FIRST_SIGNATURE} confirmation timed out`)
    );

    const counterpartyId = await seedCounterparty("batch_timeout_counterparty");
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      walletAddress: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const res = await app.request(
      "/v1/payments/transfer-batches",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          token: "SOL",
          recipients: [{ counterpartyId, counterpartyAccountId, amount: "0.1" }],
          options: { preflight: false },
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        batch: { status: string };
        recipients: Array<{ status: string }>;
        transfers: Array<{ status: string; signature: string | null }>;
      };
    };
    expect(body.data.batch.status).toBe("processing");
    expect(body.data.recipients).toMatchObject([{ status: "processing" }]);
    expect(body.data.transfers).toMatchObject([
      { status: "processing", signature: FIRST_SIGNATURE },
    ]);
    expect(signAndSendMock).toHaveBeenCalledTimes(1);
  });

  it("marks a chunk failed on a definitive on-chain error", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValueOnce(sourceSigner);

    const signAndSendMock = vi.fn().mockResolvedValueOnce(FIRST_SIGNATURE);
    createFeePaymentAdapterMock.mockReturnValueOnce({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    confirmTransactionMock.mockResolvedValueOnce({
      signature: FIRST_SIGNATURE as Awaited<
        ReturnType<typeof solanaRpc.confirmTransaction>
      >["signature"],
      slot: 100n,
      confirmationStatus: "confirmed",
      err: { InstructionError: [0, { Custom: 1 }] },
    } as Awaited<ReturnType<typeof solanaRpc.confirmTransaction>>);

    const counterpartyId = await seedCounterparty("batch_onchain_error_counterparty");
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      walletAddress: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const res = await app.request(
      "/v1/payments/transfer-batches",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          token: "SOL",
          recipients: [{ counterpartyId, counterpartyAccountId, amount: "0.1" }],
          options: { preflight: false },
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        batch: { status: string };
        recipients: Array<{ status: string }>;
        transfers: Array<{ status: string }>;
      };
    };
    expect(body.data.batch.status).toBe("failed");
    expect(body.data.recipients).toMatchObject([{ status: "failed" }]);
    expect(body.data.transfers).toMatchObject([{ status: "failed" }]);
  });
});
