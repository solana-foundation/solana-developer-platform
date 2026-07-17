import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { createPostgresPaymentTransferBatchesRepository } from "./payment-transfer-batches.repository.postgres";
import { createPostgresPaymentsRepository } from "./payments.repository.postgres";

const TEST_PROJECT_ID = "prj_payment_transfer_listing_test";
const TEST_WALLET_ID = "wallet_payment_transfer_listing_test";
const FIRST_COUNTERPARTY_ID = "cp_payment_transfer_listing_first";
const SECOND_COUNTERPARTY_ID = "cp_payment_transfer_listing_second";
const FIRST_ACCOUNT_ID = "cpa_payment_transfer_listing_first";
const SECOND_ACCOUNT_ID = "cpa_payment_transfer_listing_second";

async function seedScope(): Promise<void> {
  const now = new Date().toISOString();
  await getDb(env).batch([
    getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(TEST_USER.id, TEST_USER.email),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Transfer Listing Test', ?, 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT_ID, TEST_ORG.id, TEST_PROJECT_ID, TEST_USER.id),
    ...[
      {
        counterpartyId: FIRST_COUNTERPARTY_ID,
        accountId: FIRST_ACCOUNT_ID,
        email: "first-transfer-listing@example.com",
      },
      {
        counterpartyId: SECOND_COUNTERPARTY_ID,
        accountId: SECOND_ACCOUNT_ID,
        email: "second-transfer-listing@example.com",
      },
    ].flatMap((fixture) => [
      getDb(env)
        .prepare(
          `INSERT INTO counterparties (
             id, organization_id, project_id, entity_type, display_name, email,
             identity, provider_data, status, created_by
           ) VALUES (?, ?, ?, 'individual', ?, ?, ?, ?, 'active', ?)`
        )
        .bind(
          fixture.counterpartyId,
          TEST_ORG.id,
          TEST_PROJECT_ID,
          fixture.counterpartyId,
          fixture.email,
          {},
          {},
          TEST_USER.id
        ),
      getDb(env)
        .prepare(
          `INSERT INTO counterparty_accounts (
             id, organization_id, project_id, counterparty_id, account_kind,
             label, details, provider_account_data, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'crypto_wallet', ?, ?, ?, 'active', ?, ?)`
        )
        .bind(
          fixture.accountId,
          TEST_ORG.id,
          TEST_PROJECT_ID,
          fixture.counterpartyId,
          fixture.accountId,
          JSON.stringify({ network: "solana", address: fixture.accountId }),
          JSON.stringify({}),
          now,
          now
        ),
    ]),
  ]);
}

async function seedTransfer(input: {
  transferId: string;
  counterpartyId: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers (
         id, organization_id, project_id, wallet_id, counterparty_id, token,
         type, direction, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'USDC', ?, 'outbound', 'confirmed', ?, ?)`
    )
    .bind(
      input.transferId,
      TEST_ORG.id,
      TEST_PROJECT_ID,
      TEST_WALLET_ID,
      input.counterpartyId,
      input.counterpartyId === null ? "transfer_batch" : "transfer",
      now,
      now
    )
    .run();
}

async function seedBatchRecipient(input: {
  batchId: string;
  transferId: string;
  recipientId: string;
  counterpartyId: string;
  counterpartyAccountId: string;
  status: "confirmed" | "archived";
}): Promise<void> {
  const now = new Date().toISOString();
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO payment_transfer_batches (
           id, organization_id, project_id, source_wallet_id, source_address,
           token, status, recipient_count, transaction_count
         ) VALUES (?, ?, ?, ?, ?, 'USDC', 'confirmed', 1, 1)
         ON CONFLICT (id) DO NOTHING`
      )
      .bind(input.batchId, TEST_ORG.id, TEST_PROJECT_ID, TEST_WALLET_ID, TEST_WALLET_ID),
    getDb(env)
      .prepare(
        `INSERT INTO payment_transfer_recipients (
           id, batch_id, organization_id, project_id, transfer_id,
           counterparty_id, counterparty_account_id, destination_address,
           amount, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '1.00', ?, ?, ?)`
      )
      .bind(
        input.recipientId,
        input.batchId,
        TEST_ORG.id,
        TEST_PROJECT_ID,
        input.transferId,
        input.counterpartyId,
        input.counterpartyAccountId,
        input.counterpartyAccountId,
        input.status,
        now,
        now
      ),
  ]);
}

describe("payment transfer batch listing repositories", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedScope();
  });

  afterAll(async () => {
    await clearTestDatabase(env);
  });

  it("lists recipient rows by transfer IDs within the requested scope, including archived linkage", async () => {
    await seedTransfer({ transferId: "xfr_batch_first", counterpartyId: null });
    await seedTransfer({ transferId: "xfr_batch_second", counterpartyId: null });
    await seedBatchRecipient({
      batchId: "xbatch_first",
      transferId: "xfr_batch_first",
      recipientId: "xrec_first_active",
      counterpartyId: FIRST_COUNTERPARTY_ID,
      counterpartyAccountId: FIRST_ACCOUNT_ID,
      status: "confirmed",
    });
    await seedBatchRecipient({
      batchId: "xbatch_first",
      transferId: "xfr_batch_first",
      recipientId: "xrec_first_archived",
      counterpartyId: SECOND_COUNTERPARTY_ID,
      counterpartyAccountId: SECOND_ACCOUNT_ID,
      status: "archived",
    });
    await seedBatchRecipient({
      batchId: "xbatch_second",
      transferId: "xfr_batch_second",
      recipientId: "xrec_second_active",
      counterpartyId: SECOND_COUNTERPARTY_ID,
      counterpartyAccountId: SECOND_ACCOUNT_ID,
      status: "confirmed",
    });

    const repo = createPostgresPaymentTransferBatchesRepository(getDb(env));
    const rows = await repo.listTransferRecipientsByTransferIds({
      transferIds: ["xfr_batch_first", "xfr_batch_second"],
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
    });

    expect(rows.map((row) => row.id).sort()).toEqual([
      "xrec_first_active",
      "xrec_first_archived",
      "xrec_second_active",
    ]);
  });

  it("matches batch transfers through active recipient membership and keeps count consistent", async () => {
    await seedTransfer({ transferId: "xfr_batch_member", counterpartyId: null });
    await seedTransfer({
      transferId: "xfr_direct_second",
      counterpartyId: SECOND_COUNTERPARTY_ID,
    });
    await seedBatchRecipient({
      batchId: "xbatch_member",
      transferId: "xfr_batch_member",
      recipientId: "xrec_member_active",
      counterpartyId: FIRST_COUNTERPARTY_ID,
      counterpartyAccountId: FIRST_ACCOUNT_ID,
      status: "confirmed",
    });
    await seedBatchRecipient({
      batchId: "xbatch_member",
      transferId: "xfr_batch_member",
      recipientId: "xrec_member_archived",
      counterpartyId: SECOND_COUNTERPARTY_ID,
      counterpartyAccountId: SECOND_ACCOUNT_ID,
      status: "archived",
    });

    const repo = createPostgresPaymentsRepository(getDb(env));
    const firstCounterpartyResult = await repo.listTransfers({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: FIRST_COUNTERPARTY_ID,
      limit: 20,
      offset: 0,
    });
    const secondCounterpartyResult = await repo.listTransfers({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: SECOND_COUNTERPARTY_ID,
      limit: 20,
      offset: 0,
    });

    expect(firstCounterpartyResult.rows.map((row) => row.id)).toEqual(["xfr_batch_member"]);
    expect(firstCounterpartyResult.total).toBe(1);
    expect(secondCounterpartyResult.rows.map((row) => row.id)).toEqual(["xfr_direct_second"]);
    expect(secondCounterpartyResult.total).toBe(1);
  });
});
