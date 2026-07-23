import * as feePaymentAdapters from "@sdp/payments/fee-payment";
import { hashString } from "@sdp/payments/hash";
import * as solanaRpc from "@sdp/rpc/solana";
import { type CachedApiKey, SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types";
import { address, createNoopSigner, generateKeyPairSigner, type Signature } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPaymentTransferBatchesRepository } from "@/db/repositories";
import * as batchesRepositoryPostgres from "@/db/repositories/payment-transfer-batches.repository.postgres";
import * as paymentsRepositoryPostgres from "@/db/repositories/payments.repository.postgres";
import app from "@/index";
import { trackPendingTransfers } from "@/services/jobs/track-pending-transfers";
import * as solanaServices from "@/services/solana";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const createRpcMock = vi.spyOn(solanaRpc, "createRpc");
const getAccountInfoMock = vi.spyOn(solanaRpc, "getAccountInfo");
const getRecentBlockhashMock = vi.spyOn(solanaRpc, "getRecentBlockhash");
const confirmTransactionMock = vi.spyOn(solanaRpc, "confirmTransaction");
const getSignatureStatusesMock = vi.spyOn(solanaRpc, "getSignatureStatuses");
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

async function seedCryptoWalletCounterpartyAccounts(
  counterpartyId: string,
  walletAddresses: string[]
): Promise<string[]> {
  const now = new Date().toISOString();
  const ids = walletAddresses.map(() => `counterparty_account_${crypto.randomUUID()}`);
  const placeholders = walletAddresses.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
  const values = walletAddresses.flatMap((walletAddress, index) => [
    ids[index],
    TEST_ORG.id,
    TEST_PROJECT.id,
    counterpartyId,
    "crypto_wallet",
    "Batch payment wallet",
    JSON.stringify({ network: "solana", address: walletAddress }),
    JSON.stringify({}),
    "active",
    now,
    now,
  ]);

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
       ) VALUES ${placeholders}`
    )
    .bind(...values)
    .run();

  return ids;
}

async function seedCryptoWalletCounterpartyAccount(params: {
  counterpartyId: string;
  walletAddress: string;
}): Promise<string> {
  const [id] = await seedCryptoWalletCounterpartyAccounts(params.counterpartyId, [
    params.walletAddress,
  ]);
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
    await clearKVStores(env);
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

  it("estimates a batch when counterpartyId is omitted (derived from account)", async () => {
    const getFeeForMessageMock = vi.fn(() => ({
      send: async () => ({ value: 5000n }),
    }));
    createRpcMock.mockReturnValueOnce({
      getFeeForMessage: getFeeForMessageMock,
    } as unknown as ReturnType<typeof solanaRpc.createRpc>);

    const counterpartyId = await seedCounterparty("batch_derive_counterparty");
    const accountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      walletAddress: TEST_SOLANA_ADDRESSES.wallet2,
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
          recipients: [{ counterpartyAccountId: accountId, amount: "0.1" }],
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { estimate: { recipientCount: number } } };
    expect(body.data.estimate.recipientCount).toBe(1);
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
      status: "processing",
      externalId: "batch-create-001",
      totalAmount: "0.3",
      recipientCount: 2,
      transactionCount: 2,
    });
    expect(body.data.recipients).toHaveLength(2);
    expect(body.data.recipients.every((recipient) => recipient.status === "processing")).toBe(true);
    expect(body.data.recipients.every((recipient) => Boolean(recipient.transferId))).toBe(true);
    expect(body.data.transfers).toHaveLength(2);
    expect(body.data.transfers.map((transfer) => transfer.signature).sort()).toEqual(
      [FIRST_SIGNATURE, SECOND_SIGNATURE].sort()
    );
    expect(body.data.transfers.every((transfer) => transfer.type === "transfer_batch")).toBe(true);
    expect(body.data.transfers.every((transfer) => transfer.status === "processing")).toBe(true);
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
    expect(confirmTransactionMock).not.toHaveBeenCalled();

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
      status: "processing",
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
    expect(recipientRows.results.every((recipient) => recipient.status === "processing")).toBe(
      true
    );
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
    expect(transferRows.results.every((transfer) => transfer.status === "processing")).toBe(true);

    getSignatureStatusesMock.mockResolvedValueOnce([
      {
        slot: 101n,
        confirmations: 1n,
        confirmationStatus: "confirmed",
        err: null,
      },
      {
        slot: 102n,
        confirmations: 0n,
        confirmationStatus: "confirmed",
        err: { InstructionError: [0, "InsufficientFunds"] },
      },
    ]);
    await trackPendingTransfers(env);

    const settledBatch = await getDb(env)
      .prepare("SELECT status FROM payment_transfer_batches WHERE id = ?")
      .bind(body.data.batch.id)
      .first<{ status: string }>();
    const settledRecipients = await getDb(env)
      .prepare(
        `SELECT status
           FROM payment_transfer_recipients
          WHERE batch_id = ?
          ORDER BY status ASC`
      )
      .bind(body.data.batch.id)
      .all<{ status: string }>();
    expect(settledBatch?.status).toBe("partially_failed");
    expect(settledRecipients.results.map((recipient) => recipient.status).sort()).toEqual([
      "confirmed",
      "failed",
    ]);

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

  it("replays the original transfer batch for the same idempotency key and payload", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);

    const signAndSendMock = vi.fn().mockResolvedValue(FIRST_SIGNATURE);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

    const counterpartyId = await seedCounterparty("batch_idempotent_replay_counterparty");
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      walletAddress: TEST_SOLANA_ADDRESSES.wallet2,
    });
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Idempotency-Key": "batch-replay-key",
    };
    const requestBody = JSON.stringify({
      source: TEST_WALLET_ID,
      token: "SOL",
      recipients: [{ counterpartyId, counterpartyAccountId, amount: "0.1" }],
      options: { preflight: false },
    });

    const first = await app.request(
      "/v1/payments/transfer-batches",
      { method: "POST", headers, body: requestBody },
      env
    );
    const second = await app.request(
      "/v1/payments/transfer-batches",
      { method: "POST", headers, body: requestBody },
      env
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { data: unknown };
    const secondBody = (await second.json()) as { data: unknown };
    expect(secondBody.data).toEqual(firstBody.data);
    expect(signAndSendMock).toHaveBeenCalledTimes(1);
    expect(createOrgSignerMock).toHaveBeenCalledTimes(1);

    const count = await getDb(env)
      .prepare(
        `SELECT COUNT(*)::int AS count
           FROM payment_transfer_batches
          WHERE organization_id = ? AND project_id = ?`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id)
      .first<{ count: number }>();
    expect(count).toEqual({ count: 1 });
  });

  it("rejects an idempotency key reused with a different transfer batch payload", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);

    const signAndSendMock = vi.fn().mockResolvedValue(FIRST_SIGNATURE);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

    const counterpartyId = await seedCounterparty("batch_idempotency_conflict_counterparty");
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      walletAddress: TEST_SOLANA_ADDRESSES.wallet2,
    });
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Idempotency-Key": "batch-conflict-key",
    };

    const first = await app.request(
      "/v1/payments/transfer-batches",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          token: "SOL",
          recipients: [{ counterpartyId, counterpartyAccountId, amount: "0.1" }],
          options: { preflight: false },
        }),
      },
      env
    );
    const conflict = await app.request(
      "/v1/payments/transfer-batches",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          token: "SOL",
          recipients: [{ counterpartyId, counterpartyAccountId, amount: "0.2" }],
          options: { preflight: false },
        }),
      },
      env
    );

    expect(first.status).toBe(200);
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as { error: { code: string } };
    expect(conflictBody.error.code).toBe("CONFLICT");
    expect(signAndSendMock).toHaveBeenCalledTimes(1);
    expect(createOrgSignerMock).toHaveBeenCalledTimes(1);
  });

  it("returns the original batch when a concurrent insert loses the idempotency race", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    let releaseSignerGate!: () => void;
    const signerGate = new Promise<void>((resolve) => {
      releaseSignerGate = resolve;
    });
    let signerCallCount = 0;
    createOrgSignerMock.mockImplementation(async () => {
      signerCallCount += 1;
      if (signerCallCount === 2) {
        releaseSignerGate();
      }
      await signerGate;
      return sourceSigner;
    });

    const signAndSendMock = vi.fn().mockResolvedValue(FIRST_SIGNATURE);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

    const counterpartyId = await seedCounterparty("batch_idempotency_race_counterparty");
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      walletAddress: TEST_SOLANA_ADDRESSES.wallet2,
    });
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Idempotency-Key": "batch-race-key",
    };
    const requestBody = JSON.stringify({
      source: TEST_WALLET_ID,
      token: "SOL",
      recipients: [{ counterpartyId, counterpartyAccountId, amount: "0.1" }],
      options: { preflight: false },
    });

    const responses = await Promise.all([
      app.request(
        "/v1/payments/transfer-batches",
        { method: "POST", headers, body: requestBody },
        env
      ),
      app.request(
        "/v1/payments/transfer-batches",
        { method: "POST", headers, body: requestBody },
        env
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(
      responses.map(
        async (response) =>
          (await response.json()) as {
            data: { batch: { id: string }; recipients: unknown[]; transfers: unknown[] };
          }
      )
    );
    expect(bodies[1].data.batch.id).toBe(bodies[0].data.batch.id);
    expect(bodies[0].data.recipients).toHaveLength(1);
    expect(bodies[1].data.recipients).toHaveLength(1);
    expect(Array.isArray(bodies[0].data.transfers)).toBe(true);
    expect(Array.isArray(bodies[1].data.transfers)).toBe(true);
    expect(signerCallCount).toBe(2);
    expect(signAndSendMock).toHaveBeenCalledTimes(1);

    const count = await getDb(env)
      .prepare(
        `SELECT COUNT(*)::int AS count
           FROM payment_transfer_batches
          WHERE organization_id = ? AND project_id = ?`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id)
      .first<{ count: number }>();
    expect(count).toEqual({ count: 1 });
  });

  it("creates two transfer batches when no idempotency key is supplied", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);

    const signAndSendMock = vi
      .fn()
      .mockResolvedValueOnce(FIRST_SIGNATURE)
      .mockResolvedValueOnce(SECOND_SIGNATURE);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

    const counterpartyId = await seedCounterparty("batch_without_idempotency_counterparty");
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      walletAddress: TEST_SOLANA_ADDRESSES.wallet2,
    });
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
    };
    const requestBody = JSON.stringify({
      source: TEST_WALLET_ID,
      token: "SOL",
      recipients: [{ counterpartyId, counterpartyAccountId, amount: "0.1" }],
      options: { preflight: false },
    });

    const first = await app.request(
      "/v1/payments/transfer-batches",
      { method: "POST", headers, body: requestBody },
      env
    );
    const second = await app.request(
      "/v1/payments/transfer-batches",
      { method: "POST", headers, body: requestBody },
      env
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { data: { batch: { id: string } } };
    const secondBody = (await second.json()) as { data: { batch: { id: string } } };
    expect(secondBody.data.batch.id).not.toBe(firstBody.data.batch.id);
    expect(signAndSendMock).toHaveBeenCalledTimes(2);
    expect(createOrgSignerMock).toHaveBeenCalledTimes(2);

    const count = await getDb(env)
      .prepare(
        `SELECT COUNT(*)::int AS count
           FROM payment_transfer_batches
          WHERE organization_id = ? AND project_id = ?`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id)
      .first<{ count: number }>();
    expect(count).toEqual({ count: 2 });
  });

  it.each([
    {
      label: "legacy SPL Token",
      tokenProgram: SPL_TOKEN_PROGRAMS["spl-token"],
      requestToken: TEST_SOLANA_ADDRESSES.mint,
      expectedMint: TEST_SOLANA_ADDRESSES.mint,
    },
    {
      label: "Token-2022",
      tokenProgram: SPL_TOKEN_PROGRAMS["token-2022"],
      requestToken: TEST_SOLANA_ADDRESSES.mint,
      expectedMint: TEST_SOLANA_ADDRESSES.mint,
    },
    {
      label: "well-known symbol USDC",
      tokenProgram: SPL_TOKEN_PROGRAMS["spl-token"],
      requestToken: "USDC",
      expectedMint: WELL_KNOWN_TOKENS.USDC.mints.devnet,
    },
  ])("creates a $label transfer batch", async ({
    label,
    tokenProgram,
    requestToken,
    expectedMint,
  }) => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValueOnce(sourceSigner);
    getAccountInfoMock.mockResolvedValueOnce({
      lamports: 4200000000n,
      owner: tokenProgram,
    } as Awaited<ReturnType<typeof solanaRpc.getAccountInfo>>);
    mockSourceTokenAccountRpc({
      mint: expectedMint,
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

    const counterpartyId = await seedCounterparty(`batch_token_counterparty_${label}`);
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
          token: requestToken,
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
      status: "processing",
      token: expectedMint,
      totalAmount: "1.25",
    });
    expect(body.data.recipients).toMatchObject([
      {
        status: "processing",
        destination: TEST_SOLANA_ADDRESSES.wallet2,
      },
    ]);
    expect(body.data.transfers).toMatchObject([
      {
        type: "transfer_batch",
        status: "processing",
        signature: FIRST_SIGNATURE,
      },
    ]);
    expect(signAndSendMock).toHaveBeenCalledTimes(1);
    getSignatureStatusesMock.mockResolvedValueOnce([
      {
        slot: 103n,
        confirmations: 1n,
        confirmationStatus: "confirmed",
        err: null,
      },
    ]);
    await trackPendingTransfers(env);
    const settledBatch = await getDb(env)
      .prepare(
        `SELECT status
           FROM payment_transfer_batches
          ORDER BY created_at DESC
          LIMIT 1`
      )
      .first<{ status: string }>();
    expect(settledBatch?.status).toBe("confirmed");
  });

  it("returns a submitted chunk as processing without confirming in-request", async () => {
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
        batch: { id: string; status: string };
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
    expect(confirmTransactionMock).not.toHaveBeenCalled();
  });

  it("does not inspect on-chain status during batch creation", async () => {
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
        batch: { id: string; status: string };
        recipients: Array<{ status: string }>;
        transfers: Array<{ status: string }>;
      };
    };
    expect(body.data.batch.status).toBe("processing");
    expect(body.data.recipients).toMatchObject([{ status: "processing" }]);
    expect(body.data.transfers).toMatchObject([{ status: "processing" }]);
    expect(confirmTransactionMock).not.toHaveBeenCalled();

    getSignatureStatusesMock.mockResolvedValueOnce([
      {
        slot: 104n,
        confirmations: 0n,
        confirmationStatus: "confirmed",
        err: { InstructionError: [0, "InsufficientFunds"] },
      },
    ]);
    await trackPendingTransfers(env);
    const settledBatch = await getDb(env)
      .prepare("SELECT status FROM payment_transfer_batches WHERE id = ?")
      .bind(body.data.batch.id)
      .first<{ status: string }>();
    expect(settledBatch?.status).toBe("failed");
  });

  it("settles a mixed batch to partially_failed via the reconciliation job", async () => {
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

    const counterpartyId = await seedCounterparty("batch_settlement_counterparty");
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
          source: TEST_WALLET_ID,
          token: "SOL",
          recipients: [
            { counterpartyId, counterpartyAccountId: firstAccountId, amount: "0.1" },
            { counterpartyId, counterpartyAccountId: secondAccountId, amount: "0.2" },
          ],
          options: { preflight: false, maxRecipientsPerTransaction: 1 },
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        batch: { id: string; status: string };
        transfers: Array<{ status: string }>;
      };
    };
    expect(body.data.batch.status).toBe("processing");
    expect(body.data.transfers).toHaveLength(2);

    getSignatureStatusesMock.mockImplementation(async (_rpc, signatures) =>
      signatures.map((signature) =>
        String(signature) === FIRST_SIGNATURE
          ? { slot: 200n, confirmations: 5n, confirmationStatus: "confirmed" as const, err: null }
          : {
              slot: 201n,
              confirmations: 0n,
              confirmationStatus: "confirmed" as const,
              err: { InstructionError: [0, "Custom"] },
            }
      )
    );
    await trackPendingTransfers(env);

    const batchRow = await getDb(env)
      .prepare("SELECT status, error FROM payment_transfer_batches WHERE id = ?")
      .bind(body.data.batch.id)
      .first<{ status: string; error: string | null }>();
    expect(batchRow?.status).toBe("partially_failed");
    expect(batchRow?.error).toBe("One or more transfer batch transactions failed during execution");

    const recipientRows = await getDb(env)
      .prepare(
        `SELECT r.status, r.error, t.signature
           FROM payment_transfer_recipients r
           JOIN payment_transfers t ON t.id = r.transfer_id
          WHERE r.batch_id = ?
          ORDER BY t.signature`
      )
      .bind(body.data.batch.id)
      .all<{ status: string; error: string | null; signature: string }>();
    expect(recipientRows.results).toMatchObject([
      { status: "confirmed", error: null, signature: FIRST_SIGNATURE },
      { status: "failed", signature: SECOND_SIGNATURE },
    ]);
    expect(recipientRows.results[1].error).toContain("InstructionError");
  });

  it("settles a chunk's recipients as failed when its execution throws mid-flight", async () => {
    const createRepository = paymentsRepositoryPostgres.createPostgresPaymentsRepository;
    const repositorySpy = vi.spyOn(paymentsRepositoryPostgres, "createPostgresPaymentsRepository");
    let createTransferCalls = 0;
    repositorySpy.mockImplementation((db) => {
      const repository = createRepository(db);
      return {
        ...repository,
        createTransfer: async (params) => {
          createTransferCalls += 1;
          if (createTransferCalls === 2) {
            throw new Error("simulated transfer persistence failure");
          }
          return repository.createTransfer(params);
        },
      };
    });

    try {
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      createOrgSignerMock.mockResolvedValueOnce(sourceSigner);
      let signatureIndex = 0;
      const signAndSendMock = vi.fn(
        async () => `${FIRST_SIGNATURE}${signatureIndex++}` as Signature
      );
      createFeePaymentAdapterMock.mockReturnValueOnce({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const counterpartyId = await seedCounterparty("batch_stranded_counterparty");
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
            source: TEST_WALLET_ID,
            token: "SOL",
            recipients: [
              { counterpartyId, counterpartyAccountId: firstAccountId, amount: "0.1" },
              { counterpartyId, counterpartyAccountId: secondAccountId, amount: "0.2" },
            ],
            options: { preflight: false, maxRecipientsPerTransaction: 1 },
          }),
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          batch: { id: string; status: string };
          recipients: Array<{ status: string; error: string | null }>;
          transfers: Array<{ status: string }>;
        };
      };
      expect(body.data.transfers).toHaveLength(1);
      expect(body.data.batch.status).toBe("processing");
      const statuses = body.data.recipients.map((recipient) => recipient.status).sort();
      expect(statuses).toEqual(["failed", "processing"]);
      const failedRecipient = body.data.recipients.find(
        (recipient) => recipient.status === "failed"
      );
      expect(failedRecipient?.error).toContain("simulated transfer persistence failure");

      const pendingRows = await getDb(env)
        .prepare(
          "SELECT COUNT(*) AS count FROM payment_transfer_recipients WHERE batch_id = ? AND status = 'pending'"
        )
        .bind(body.data.batch.id)
        .first<{ count: number | string }>();
      expect(Number(pendingRows?.count)).toBe(0);
    } finally {
      repositorySpy.mockRestore();
    }
  });

  it("rolls back the chunk transfer when recipient linking fails so reconciliation never sees an orphan", async () => {
    const createBatchesRepository =
      batchesRepositoryPostgres.createPostgresPaymentTransferBatchesRepository;
    const batchesSpy = vi.spyOn(
      batchesRepositoryPostgres,
      "createPostgresPaymentTransferBatchesRepository"
    );
    let linkFailureInjected = false;
    batchesSpy.mockImplementation((db) => {
      const repository = createBatchesRepository(db);
      return {
        ...repository,
        updateTransferRecipientsStatus: async (input) => {
          if (!linkFailureInjected && input.transferId !== null && input.status === "processing") {
            linkFailureInjected = true;
            throw new Error("simulated recipient link failure");
          }
          return repository.updateTransferRecipientsStatus(input);
        },
      };
    });

    try {
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      createOrgSignerMock.mockResolvedValueOnce(sourceSigner);
      const signAndSendMock = vi.fn(async () => FIRST_SIGNATURE as Signature);
      createFeePaymentAdapterMock.mockReturnValueOnce({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const counterpartyId = await seedCounterparty("batch_link_failure_counterparty");
      const accountId = await seedCryptoWalletCounterpartyAccount({
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
            recipients: [{ counterpartyId, counterpartyAccountId: accountId, amount: "0.1" }],
            options: { preflight: false },
          }),
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          batch: { id: string; status: string };
          recipients: Array<{ status: string; error: string | null; transferId: string | null }>;
          transfers: Array<{ status: string }>;
        };
      };
      expect(signAndSendMock).not.toHaveBeenCalled();
      expect(body.data.batch.status).toBe("failed");
      expect(body.data.transfers).toHaveLength(0);
      expect(body.data.recipients).toHaveLength(1);
      expect(body.data.recipients[0].status).toBe("failed");
      expect(body.data.recipients[0].error).toContain("simulated recipient link failure");

      const orphanRows = await getDb(env)
        .prepare(
          "SELECT COUNT(*) AS count FROM payment_transfers WHERE type = 'transfer_batch' AND status = 'processing'"
        )
        .first<{ count: number | string }>();
      expect(Number(orphanRows?.count)).toBe(0);

      await trackPendingTransfers(env);
      await trackPendingTransfers(env);

      const batchRow = await getDb(env)
        .prepare("SELECT status FROM payment_transfer_batches WHERE id = ?")
        .bind(body.data.batch.id)
        .first<{ status: string }>();
      expect(batchRow?.status).toBe("failed");
    } finally {
      batchesSpy.mockRestore();
    }
  });

  it("leaves linked recipients for reconciliation when settlement fails after submission", async () => {
    const createBatchesRepository =
      batchesRepositoryPostgres.createPostgresPaymentTransferBatchesRepository;
    const batchesSpy = vi.spyOn(
      batchesRepositoryPostgres,
      "createPostgresPaymentTransferBatchesRepository"
    );
    let linkedWriteCalls = 0;
    batchesSpy.mockImplementation((db) => {
      const repository = createBatchesRepository(db);
      return {
        ...repository,
        updateTransferRecipientsStatus: async (input) => {
          if (input.transferId !== null) {
            linkedWriteCalls += 1;
            if (linkedWriteCalls === 2) {
              throw new Error("simulated settlement write failure");
            }
          }
          return repository.updateTransferRecipientsStatus(input);
        },
      };
    });

    try {
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      createOrgSignerMock.mockResolvedValueOnce(sourceSigner);
      const signAndSendMock = vi.fn(async () => FIRST_SIGNATURE as Signature);
      createFeePaymentAdapterMock.mockReturnValueOnce({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const counterpartyId = await seedCounterparty("batch_settle_failure_counterparty");
      const accountId = await seedCryptoWalletCounterpartyAccount({
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
            source: TEST_WALLET_ID,
            token: "SOL",
            recipients: [{ counterpartyId, counterpartyAccountId: accountId, amount: "0.1" }],
            options: { preflight: false },
          }),
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { batch: { id: string; status: string } };
      };
      expect(signAndSendMock).toHaveBeenCalledTimes(1);

      const linkedRecipient = await getDb(env)
        .prepare("SELECT status, transfer_id FROM payment_transfer_recipients WHERE batch_id = ?")
        .bind(body.data.batch.id)
        .first<{ status: string; transfer_id: string | null }>();
      expect(linkedRecipient?.transfer_id).not.toBeNull();
      expect(linkedRecipient?.status).toBe("processing");

      await getDb(env)
        .prepare(
          `UPDATE payment_transfers
              SET updated_at = ?
            WHERE type = 'transfer_batch' AND status = 'processing'`
        )
        .bind(new Date(Date.now() - 10 * 60 * 1000).toISOString())
        .run();

      await trackPendingTransfers(env);

      const transferRow = await getDb(env)
        .prepare("SELECT status FROM payment_transfers WHERE id = ?")
        .bind(linkedRecipient?.transfer_id)
        .first<{ status: string }>();
      expect(transferRow?.status).toBe("failed");

      const settledRecipient = await getDb(env)
        .prepare("SELECT status, transfer_id FROM payment_transfer_recipients WHERE batch_id = ?")
        .bind(body.data.batch.id)
        .first<{ status: string; transfer_id: string | null }>();
      expect(settledRecipient?.status).toBe("failed");
      expect(settledRecipient?.transfer_id).toBe(linkedRecipient?.transfer_id);

      const batchRow = await getDb(env)
        .prepare("SELECT status FROM payment_transfer_batches WHERE id = ?")
        .bind(body.data.batch.id)
        .first<{ status: string }>();
      expect(batchRow?.status).toBe("failed");
    } finally {
      batchesSpy.mockRestore();
    }
  });

  it("returns the terminal status when reconciliation settles the batch mid-request", async () => {
    const createBatchesRepository =
      batchesRepositoryPostgres.createPostgresPaymentTransferBatchesRepository;
    const batchesSpy = vi.spyOn(
      batchesRepositoryPostgres,
      "createPostgresPaymentTransferBatchesRepository"
    );
    let reconciliationInjected = false;
    batchesSpy.mockImplementation((db) => {
      const repository = createBatchesRepository(db);
      return {
        ...repository,
        recomputeTransferBatchStatus: async (input) => {
          if (!reconciliationInjected) {
            reconciliationInjected = true;
            getSignatureStatusesMock.mockResolvedValueOnce([
              { slot: 300n, confirmations: 3n, confirmationStatus: "confirmed", err: null },
            ]);
            await trackPendingTransfers(env);
          }
          return repository.recomputeTransferBatchStatus(input);
        },
      };
    });

    try {
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

      const counterpartyId = await seedCounterparty("batch_midflight_counterparty");
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
      expect(reconciliationInjected).toBe(true);
      expect(body.data.batch.status).toBe("confirmed");
      expect(body.data.recipients).toMatchObject([{ status: "confirmed" }]);
      expect(body.data.transfers).toMatchObject([{ status: "confirmed" }]);
    } finally {
      batchesSpy.mockRestore();
    }
  });

  it("resolves concurrent settlements of the same batch to the correct final status", async () => {
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

    const counterpartyId = await seedCounterparty("batch_concurrent_settle_counterparty");
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
          source: TEST_WALLET_ID,
          token: "SOL",
          recipients: [
            { counterpartyId, counterpartyAccountId: firstAccountId, amount: "0.1" },
            { counterpartyId, counterpartyAccountId: secondAccountId, amount: "0.2" },
          ],
          options: { preflight: false, maxRecipientsPerTransaction: 1 },
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { batch: { id: string }; transfers: Array<{ id: string }> };
    };
    expect(body.data.transfers).toHaveLength(2);

    const repository = createPaymentTransferBatchesRepository(env);
    await Promise.all([
      repository.settleTransferBatch({
        transferId: body.data.transfers[0].id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        transferStatus: "confirmed",
        error: null,
      }),
      repository.settleTransferBatch({
        transferId: body.data.transfers[1].id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        transferStatus: "failed",
        error: "on-chain failure",
      }),
    ]);

    const batchRow = await getDb(env)
      .prepare("SELECT status FROM payment_transfer_batches WHERE id = ?")
      .bind(body.data.batch.id)
      .first<{ status: string }>();
    expect(batchRow?.status).toBe("partially_failed");
  });

  it("creates a 500-recipient batch within a bounded time", async () => {
    const createRepository = paymentsRepositoryPostgres.createPostgresPaymentsRepository;
    const getWalletPolicies = vi.fn();
    const listTransfersByIds = vi.fn();
    const getTransferById = vi.fn();
    vi.spyOn(paymentsRepositoryPostgres, "createPostgresPaymentsRepository").mockImplementation(
      (db) => {
        const repository = createRepository(db);
        return {
          ...repository,
          getWalletPoliciesByCustodyWalletId: async (custodyWalletId) => {
            getWalletPolicies(custodyWalletId);
            return repository.getWalletPoliciesByCustodyWalletId(custodyWalletId);
          },
          listTransfersByIds: async (params) => {
            listTransfersByIds(params);
            return repository.listTransfersByIds(params);
          },
          getTransferById: async (params) => {
            getTransferById(params);
            return repository.getTransferById(params);
          },
        };
      }
    );
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    let signatureIndex = 0;
    const signAndSendMock = vi.fn(async () => `${FIRST_SIGNATURE}${signatureIndex++}` as Signature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const counterpartyId = await seedCounterparty("batch_stress_counterparty");
    const destinationSigners = await Promise.all(
      Array.from({ length: 500 }, () => generateKeyPairSigner())
    );
    const counterpartyAccountIds = await seedCryptoWalletCounterpartyAccounts(
      counterpartyId,
      destinationSigners.map((destinationSigner) => destinationSigner.address)
    );
    const recipients = counterpartyAccountIds.map((counterpartyAccountId, index) => ({
      externalId: `stress-recipient-${index}`,
      counterpartyId,
      counterpartyAccountId,
      amount: "0.000001",
    }));

    const startedAt = performance.now();
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
          recipients,
          options: { preflight: false },
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { batch: { id: string } } };
    expect(performance.now() - startedAt).toBeLessThan(15_000);
    expect(signAndSendMock).toHaveBeenCalled();
    expect(confirmTransactionMock).not.toHaveBeenCalled();
    expect(getWalletPolicies).toHaveBeenCalledTimes(1);

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
    expect(listTransfersByIds).toHaveBeenCalledTimes(2);
    expect(getTransferById).not.toHaveBeenCalled();

    const distinctDestinations = await getDb(env)
      .prepare(
        `SELECT COUNT(DISTINCT destination_address) AS count
           FROM payment_transfer_recipients
          WHERE batch_id = ?`
      )
      .bind(body.data.batch.id)
      .first<{ count: number | string }>();
    expect(Number(distinctDestinations?.count)).toBe(500);
  }, 30_000);

  it("handles a burst of five concurrent batch creates", async () => {
    const sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    let signatureIndex = 0;
    const signAndSendMock = vi.fn(async () => `${FIRST_SIGNATURE}${signatureIndex++}` as Signature);
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
      signAsFeePayer: vi.fn(),
      signAndSend: signAndSendMock,
    } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
    const counterpartyId = await seedCounterparty("batch_burst_counterparty");
    const counterpartyAccountId = await seedCryptoWalletCounterpartyAccount({
      counterpartyId,
      walletAddress: TEST_SOLANA_ADDRESSES.wallet2,
    });
    const recipients = Array.from({ length: 50 }, (_, index) => ({
      externalId: `burst-recipient-${index}`,
      counterpartyId,
      counterpartyAccountId,
      amount: "0.000001",
    }));

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.request(
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
              recipients,
              options: { preflight: false },
            }),
          },
          env
        )
      )
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
  }, 20_000);
});
