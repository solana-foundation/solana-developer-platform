import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  createPaymentsRepository,
  createSystemPaymentTransferBatchesRepository,
} from "@/db/repositories";
import { createPostgresPaymentTransferBatchesRepository } from "@/db/repositories/payment-transfer-batches.repository.postgres";
import { generatePaymentTransferId } from "@/db/repositories/payments.repository";
import app from "@/index";
import { createTenantScope } from "@/lib/tenant-scope";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

/**
 * Regression for SOLA9-590: batch reconciliation must not settle a linked
 * chunk whose custody wallet identity disagrees with the parent batch.
 *
 * A persisted legacy-shaped batch whose exact source custody wallet differs
 * from its linked processing transfer used to be settled by the real
 * reconciliation sink — transfer, recipient, and parent batch all confirmed —
 * while the authenticated detail route then rejected the very same durable
 * rows with CONFLICT. Settlement must refuse the mismatched pair (rows stay
 * processing, no false attribution is committed) while a matched-wallet
 * control settles and reads normally.
 */
describe("settleTransferBatch custody-wallet identity fence", () => {
  const organizationId = "org_batch_wallet_identity_regression";
  const projectId = "prj_batch_wallet_identity_regression";
  const userId = "usr_batch_wallet_identity_regression";
  const apiKeyId = "key_batch_wallet_identity_regression";
  const apiKey = "sk_test_batch_wallet_identity_regression";
  const parentWalletId = "cw_batch_identity_parent";
  const transferWalletId = "cw_batch_identity_transfer";
  const matchedWalletId = "cw_batch_identity_matched";
  const legacyNullWalletId = "cw_batch_identity_legacy";
  const parentProviderWalletId = "wal_batch_identity_parent";
  const transferProviderWalletId = "wal_batch_identity_transfer";
  const matchedProviderWalletId = "wal_batch_identity_matched";
  const legacyNullProviderWalletId = "wal_batch_identity_legacy";
  const parentAddress = "11111111111111111111111111111111";
  const transferAddress = "SysvarRent111111111111111111111111111111111";
  const matchedAddress = "Stake11111111111111111111111111111111111111";
  const legacyNullAddress = "Config11111111111111111111111111111111111111";
  const destinationAddress = "Vote111111111111111111111111111111111111111";
  const scope = createTenantScope({ organizationId, projectId });

  const cachedApiKey: CachedApiKey = {
    id: apiKeyId,
    organizationId,
    projectId,
    role: "api_admin",
    permissions: ["*"],
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
  };

  beforeEach(async () => {
    await seedTestDatabase(env);
    const keyHash = await hashString(apiKey, env.API_KEY_PEPPER);
    await seedCachedApiKey(env, keyHash, cachedApiKey);
    const db = getDb(env);

    await db.batch([
      db
        .prepare(
          `INSERT INTO organizations (id, name, slug, tier, status, settings)
           VALUES (?, ?, ?, 'enterprise', 'active', '{}'::jsonb)`
        )
        .bind(organizationId, "Batch Identity Regression Org", "batch-identity-regression-org"),
      db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(userId, "batch-identity-regression@example.com"),
    ]);
    await seedDefaultProjects(db, {
      organizationId,
      createdBy: userId,
      members: [],
      ids: { sandbox: projectId, production: `${projectId}_production` },
    });
    await db.batch([
      db
        .prepare(
          `INSERT INTO api_keys
             (id, organization_id, project_id, created_by, name, key_prefix,
              key_hash, role, permissions, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, 'active')`
        )
        .bind(
          apiKeyId,
          organizationId,
          projectId,
          userId,
          "Batch identity regression API key",
          "sk_test_batch",
          keyHash,
          "api_admin",
          JSON.stringify(["*"])
        ),
      db
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted,
              encryption_version, status)
           VALUES (?, ?, NULL, 'local', 'regression', 'sdp-custody-encryption-v1', 'active')`
        )
        .bind("cfg_batch_identity_regression", organizationId),
    ]);
    await db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES
           (?, 'cfg_batch_identity_regression', ?, ?, 'Parent wallet', 'transfer', 'active'),
           (?, 'cfg_batch_identity_regression', ?, ?, 'Transfer wallet', 'transfer', 'active'),
           (?, 'cfg_batch_identity_regression', ?, ?, 'Matched wallet', 'transfer', 'active'),
           (?, 'cfg_batch_identity_regression', ?, ?, 'Legacy wallet', 'transfer', 'active')`
      )
      .bind(
        parentWalletId,
        parentProviderWalletId,
        parentAddress,
        transferWalletId,
        transferProviderWalletId,
        transferAddress,
        matchedWalletId,
        matchedProviderWalletId,
        matchedAddress,
        legacyNullWalletId,
        legacyNullProviderWalletId,
        legacyNullAddress
      )
      .run();
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  async function seedCounterparty(
    label: string
  ): Promise<{ counterpartyId: string; accountId: string }> {
    const db = getDb(env);
    const counterpartyId = `cpty_${label}`;
    const accountId = `cpacct_${label}`;
    await db.batch([
      db
        .prepare(
          `INSERT INTO counterparties
             (id, organization_id, project_id, external_id, entity_type,
              display_name, provider_data, created_by)
           VALUES (?, ?, ?, ?, 'individual', ?, '{}'::jsonb, ?)`
        )
        .bind(counterpartyId, organizationId, projectId, label, label, userId),
      db
        .prepare(
          `INSERT INTO counterparty_accounts
             (id, organization_id, project_id, counterparty_id, account_kind,
              label, details, provider_account_data, status)
           VALUES (?, ?, ?, ?, 'crypto_wallet', ?, ?, '{}'::jsonb, 'active')`
        )
        .bind(
          accountId,
          organizationId,
          projectId,
          counterpartyId,
          label,
          JSON.stringify({ network: "solana", address: destinationAddress })
        ),
    ]);
    return { counterpartyId, accountId };
  }

  /**
   * Seeds one processing batch with one recipient through the real production
   * writer, then applies the persisted legacy identity shape (`null` batch
   * custody id reproduces pre-0068 ambiguous rows).
   */
  async function createProcessingBatch(params: {
    batchCustodyWalletId: string | null;
    batchProviderWalletId: string;
    batchSourceAddress: string;
    counterpartyId: string;
    accountId: string;
  }): Promise<{ batchId: string; recipientId: string }> {
    const { batch, recipients } = await createPostgresPaymentTransferBatchesRepository(
      getDb(env)
    ).createTransferBatchWithRecipients({
      batch: {
        organizationId,
        projectId,
        sourceCustodyWalletId: params.batchCustodyWalletId ?? parentWalletId,
        sourceWalletId: params.batchProviderWalletId,
        sourceAddress: params.batchSourceAddress,
        token: "SOL",
        status: "processing",
        totalAmount: "1",
        recipientCount: 1,
        transactionCount: 1,
        options: {},
        initiatedByKeyId: apiKeyId,
      },
      recipients: [
        {
          organizationId,
          projectId,
          counterpartyId: params.counterpartyId,
          counterpartyAccountId: params.accountId,
          destinationAddress,
          amount: "1",
          status: "processing",
          error: null,
        },
      ],
    });

    if (params.batchCustodyWalletId === null) {
      await getDb(env)
        .prepare(`UPDATE payment_transfer_batches SET source_custody_wallet_id = NULL WHERE id = ?`)
        .bind(batch.id)
        .run();
    }

    return { batchId: batch.id, recipientId: recipients[0].id };
  }

  /**
   * Seeds one processing chunk transfer through the real production writer,
   * then applies the persisted legacy identity shape (`null` transfer custody
   * id reproduces pre-0068 ambiguous rows).
   */
  async function createProcessingChunkTransfer(params: {
    transferCustodyWalletId: string | null;
    transferProviderWalletId: string;
    transferSourceAddress: string;
    counterpartyId: string | null;
  }): Promise<string> {
    const transferId = generatePaymentTransferId();
    const transfer = await createPaymentsRepository(env, scope).createTransfer({
      id: transferId,
      organizationId,
      projectId,
      custodyWalletId: params.transferCustodyWalletId ?? transferWalletId,
      walletId: params.transferProviderWalletId,
      counterpartyId: params.counterpartyId,
      sourceAddress: params.transferSourceAddress,
      destinationAddress,
      token: "SOL",
      amount: "1",
      memo: null,
      type: "transfer_batch",
      direction: "outbound",
      status: "processing",
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: { proof: "synthetic-legacy-chunk" },
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: apiKeyId,
    });
    expect(transfer?.id).toBe(transferId);

    if (params.transferCustodyWalletId === null) {
      await getDb(env)
        .prepare(`UPDATE payment_transfers SET custody_wallet_id = NULL WHERE id = ?`)
        .bind(transferId)
        .run();
    }

    return transferId;
  }

  async function linkRecipientToTransfer(recipientId: string, transferId: string): Promise<void> {
    await createPostgresPaymentTransferBatchesRepository(getDb(env)).updateTransferRecipientsStatus(
      {
        recipientIds: [recipientId],
        organizationId,
        projectId,
        transferId,
        status: "processing",
        error: null,
      }
    );
  }

  /**
   * Seeds one linked processing batch/chunk pair through the real production
   * writers, then applies the persisted legacy identity shape to either side.
   */
  async function seedLinkedProcessingRows(params: {
    label: string;
    batchCustodyWalletId: string | null;
    transferCustodyWalletId: string | null;
    batchProviderWalletId: string;
    batchSourceAddress: string;
    transferProviderWalletId: string;
    transferSourceAddress: string;
  }): Promise<{ batchId: string; transferId: string }> {
    const { counterpartyId, accountId } = await seedCounterparty(params.label);
    const batch = await createProcessingBatch({
      batchCustodyWalletId: params.batchCustodyWalletId,
      batchProviderWalletId: params.batchProviderWalletId,
      batchSourceAddress: params.batchSourceAddress,
      counterpartyId,
      accountId,
    });
    const transferId = await createProcessingChunkTransfer({
      transferCustodyWalletId: params.transferCustodyWalletId,
      transferProviderWalletId: params.transferProviderWalletId,
      transferSourceAddress: params.transferSourceAddress,
      counterpartyId,
    });
    await linkRecipientToTransfer(batch.recipientId, transferId);

    return { batchId: batch.batchId, transferId };
  }

  async function linkedRows(batchId: string) {
    return getDb(env)
      .prepare(
        `SELECT b.source_custody_wallet_id, b.status AS batch_status,
                r.status AS recipient_status, t.custody_wallet_id,
                t.status AS transfer_status
           FROM payment_transfer_batches b
           JOIN payment_transfer_recipients r ON r.batch_id = b.id
           JOIN payment_transfers t ON t.id = r.transfer_id
          WHERE b.id = ?`
      )
      .bind(batchId)
      .first<Record<string, string | null>>();
  }

  function settle(input: {
    transferId: string;
    transferStatus: "confirmed" | "failed";
  }): Promise<void> {
    return createSystemPaymentTransferBatchesRepository(env).settleTransferBatch({
      transferId: input.transferId,
      organizationId,
      projectId,
      transferStatus: input.transferStatus,
      error: input.transferStatus === "failed" ? "on-chain failure" : null,
      slot: 123,
      updatedAt: new Date().toISOString(),
    });
  }

  it("refuses to settle a linked chunk whose custody wallet differs from the batch source", async () => {
    const mismatched = await seedLinkedProcessingRows({
      label: "regression_mismatch",
      batchCustodyWalletId: parentWalletId,
      transferCustodyWalletId: transferWalletId,
      batchProviderWalletId: parentProviderWalletId,
      batchSourceAddress: parentAddress,
      transferProviderWalletId,
      transferSourceAddress: transferAddress,
    });

    const before = await linkedRows(mismatched.batchId);
    expect(before).toMatchObject({
      batch_status: "processing",
      recipient_status: "processing",
      transfer_status: "processing",
    });

    await expect(
      settle({ transferId: mismatched.transferId, transferStatus: "confirmed" })
    ).rejects.toThrow(
      "Transfer batch settlement refused: linked batch source custody wallet does not match the transfer custody wallet"
    );

    const after = await linkedRows(mismatched.batchId);
    expect(after).toMatchObject({
      source_custody_wallet_id: parentWalletId,
      batch_status: "processing",
      recipient_status: "processing",
      custody_wallet_id: transferWalletId,
      transfer_status: "processing",
    });
  });

  it("refuses to fail a linked chunk whose custody wallet differs from the batch source", async () => {
    const mismatched = await seedLinkedProcessingRows({
      label: "regression_mismatch_failed",
      batchCustodyWalletId: parentWalletId,
      transferCustodyWalletId: transferWalletId,
      batchProviderWalletId: parentProviderWalletId,
      batchSourceAddress: parentAddress,
      transferProviderWalletId,
      transferSourceAddress: transferAddress,
    });

    await expect(
      settle({ transferId: mismatched.transferId, transferStatus: "failed" })
    ).rejects.toThrow(
      "Transfer batch settlement refused: linked batch source custody wallet does not match the transfer custody wallet"
    );

    const after = await linkedRows(mismatched.batchId);
    expect(after).toMatchObject({
      batch_status: "processing",
      recipient_status: "processing",
      transfer_status: "processing",
    });
  });

  it("refuses to settle a linked chunk whose batch source custody wallet is unresolved while the transfer's is pinned", async () => {
    const oneSided = await seedLinkedProcessingRows({
      label: "regression_batch_null",
      batchCustodyWalletId: null,
      transferCustodyWalletId: transferWalletId,
      batchProviderWalletId: legacyNullProviderWalletId,
      batchSourceAddress: legacyNullAddress,
      transferProviderWalletId,
      transferSourceAddress: transferAddress,
    });

    await expect(
      settle({ transferId: oneSided.transferId, transferStatus: "confirmed" })
    ).rejects.toThrow(
      "Transfer batch settlement refused: linked batch source custody wallet does not match the transfer custody wallet"
    );

    const after = await linkedRows(oneSided.batchId);
    expect(after).toMatchObject({
      source_custody_wallet_id: null,
      batch_status: "processing",
      recipient_status: "processing",
      custody_wallet_id: transferWalletId,
      transfer_status: "processing",
    });
  });

  it("refuses to settle a linked chunk whose transfer custody wallet is unresolved while the batch source is pinned", async () => {
    const oneSided = await seedLinkedProcessingRows({
      label: "regression_transfer_null",
      batchCustodyWalletId: parentWalletId,
      transferCustodyWalletId: null,
      batchProviderWalletId: parentProviderWalletId,
      batchSourceAddress: parentAddress,
      transferProviderWalletId: legacyNullProviderWalletId,
      transferSourceAddress: legacyNullAddress,
    });

    await expect(
      settle({ transferId: oneSided.transferId, transferStatus: "failed" })
    ).rejects.toThrow(
      "Transfer batch settlement refused: linked batch source custody wallet does not match the transfer custody wallet"
    );

    const after = await linkedRows(oneSided.batchId);
    expect(after).toMatchObject({
      source_custody_wallet_id: parentWalletId,
      batch_status: "processing",
      recipient_status: "processing",
      custody_wallet_id: null,
      transfer_status: "processing",
    });
  });

  it("refuses to settle a chunk transfer whose recipients span matched and mismatched batches", async () => {
    const matchedCounterparty = await seedCounterparty("mixed_link_match");
    const matchedBatch = await createProcessingBatch({
      batchCustodyWalletId: matchedWalletId,
      batchProviderWalletId: matchedProviderWalletId,
      batchSourceAddress: matchedAddress,
      counterpartyId: matchedCounterparty.counterpartyId,
      accountId: matchedCounterparty.accountId,
    });
    const mismatchedCounterparty = await seedCounterparty("mixed_link_mismatch");
    const mismatchedBatch = await createProcessingBatch({
      batchCustodyWalletId: parentWalletId,
      batchProviderWalletId: parentProviderWalletId,
      batchSourceAddress: parentAddress,
      counterpartyId: mismatchedCounterparty.counterpartyId,
      accountId: mismatchedCounterparty.accountId,
    });
    const transferId = await createProcessingChunkTransfer({
      transferCustodyWalletId: matchedWalletId,
      transferProviderWalletId: matchedProviderWalletId,
      transferSourceAddress: matchedAddress,
      counterpartyId: matchedCounterparty.counterpartyId,
    });
    await linkRecipientToTransfer(matchedBatch.recipientId, transferId);
    await linkRecipientToTransfer(mismatchedBatch.recipientId, transferId);

    await expect(settle({ transferId, transferStatus: "confirmed" })).rejects.toThrow(
      "Transfer batch settlement refused: linked batch source custody wallet does not match the transfer custody wallet"
    );

    expect(await linkedRows(matchedBatch.batchId)).toMatchObject({
      batch_status: "processing",
      recipient_status: "processing",
      transfer_status: "processing",
    });
    expect(await linkedRows(mismatchedBatch.batchId)).toMatchObject({
      batch_status: "processing",
      recipient_status: "processing",
      transfer_status: "processing",
    });
  });

  it("keeps the detail-route conflict while the mismatched rows stay unattributed, and settles a matched control", async () => {
    const mismatched = await seedLinkedProcessingRows({
      label: "regression_route_mismatch",
      batchCustodyWalletId: parentWalletId,
      transferCustodyWalletId: transferWalletId,
      batchProviderWalletId: parentProviderWalletId,
      batchSourceAddress: parentAddress,
      transferProviderWalletId,
      transferSourceAddress: transferAddress,
    });
    const matched = await seedLinkedProcessingRows({
      label: "regression_route_match",
      batchCustodyWalletId: matchedWalletId,
      transferCustodyWalletId: matchedWalletId,
      batchProviderWalletId: matchedProviderWalletId,
      batchSourceAddress: matchedAddress,
      transferProviderWalletId: matchedProviderWalletId,
      transferSourceAddress: matchedAddress,
    });

    await expect(
      settle({ transferId: mismatched.transferId, transferStatus: "confirmed" })
    ).rejects.toThrow("Transfer batch settlement refused");
    expect(await linkedRows(mismatched.batchId)).toMatchObject({
      batch_status: "processing",
      transfer_status: "processing",
    });

    const conflictResponse = await app.request(
      `/v1/payments/transfer-batches/${mismatched.batchId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      env
    );
    expect(conflictResponse.status).toBe(409);
    expect(((await conflictResponse.json()) as { error: { code: string } }).error.code).toBe(
      "CONFLICT"
    );
    expect(await linkedRows(mismatched.batchId)).toMatchObject({
      batch_status: "processing",
      transfer_status: "processing",
    });

    await settle({ transferId: matched.transferId, transferStatus: "confirmed" });
    expect(await linkedRows(matched.batchId)).toMatchObject({
      batch_status: "confirmed",
      recipient_status: "confirmed",
      transfer_status: "confirmed",
    });
    const matchedResponse = await app.request(
      `/v1/payments/transfer-batches/${matched.batchId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      env
    );
    expect(matchedResponse.status).toBe(200);
  });

  it("still settles the legacy ambiguous pair whose custody identities are both unresolved", async () => {
    const legacy = await seedLinkedProcessingRows({
      label: "regression_legacy_null",
      batchCustodyWalletId: null,
      transferCustodyWalletId: null,
      batchProviderWalletId: legacyNullProviderWalletId,
      batchSourceAddress: legacyNullAddress,
      transferProviderWalletId: legacyNullProviderWalletId,
      transferSourceAddress: legacyNullAddress,
    });

    await settle({ transferId: legacy.transferId, transferStatus: "confirmed" });

    const after = await linkedRows(legacy.batchId);
    expect(after).toMatchObject({
      source_custody_wallet_id: null,
      batch_status: "confirmed",
      recipient_status: "confirmed",
      custody_wallet_id: null,
      transfer_status: "confirmed",
    });
  });

  it("still trips the orphan tripwire when a chunk transfer has no linked recipients", async () => {
    const transferId = generatePaymentTransferId();
    await createPaymentsRepository(env, scope).createTransfer({
      id: transferId,
      organizationId,
      projectId,
      custodyWalletId: matchedWalletId,
      walletId: matchedProviderWalletId,
      counterpartyId: null,
      sourceAddress: matchedAddress,
      destinationAddress,
      token: "SOL",
      amount: "1",
      memo: null,
      type: "transfer_batch",
      direction: "outbound",
      status: "processing",
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: {},
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: apiKeyId,
    });

    await expect(settle({ transferId, transferStatus: "confirmed" })).rejects.toThrow(
      "Transfer batch recipients not found for settlement"
    );

    const orphan = await getDb(env)
      .prepare(`SELECT status FROM payment_transfers WHERE id = ?`)
      .bind(transferId)
      .first<{ status: string }>();
    expect(orphan?.status).toBe("processing");
  });
});
