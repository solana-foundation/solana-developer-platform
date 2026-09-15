import type * as feePaymentAdapters from "@sdp/payments/fee-payment";
import { getBase58Decoder } from "@solana/codecs";
import { address, generateKeyPairSigner, type Signature, signature } from "@solana/kit";
import { beforeEach, expect, vi } from "vitest";
import type { z } from "zod";
import { getDb } from "@/db";
import app from "@/index";
import { successResponseSchema } from "@/openapi/schemas/base";
import {
  paymentRecurringPaymentCollectionResponseSchema,
  paymentRecurringPaymentResponseSchema,
} from "@/openapi/schemas/payments";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  createFeePaymentAdapterMock,
  createOrgSignerMock,
  DEVNET_USDC_MINT,
  mockRecurringActivationRpc,
  seedCounterparty,
  TEST_CUSTODY_WALLET_ID,
  TEST_SPONSORSHIP_PROVIDER_CONFIG,
  updateSeededWalletPublicKey,
} from "@/test/helpers/payments-routes";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { fullySignTestTransaction, TEST_MOCK_FEE_PAYER } from "@/test/helpers/sponsor-signing";

const recurringResponseSchema = successResponseSchema(paymentRecurringPaymentResponseSchema);
const collectionResponseSchema = successResponseSchema(
  paymentRecurringPaymentCollectionResponseSchema
);

export const RECURRING_HEADERS = {
  Authorization: "Bearer sk_test_payments_policy",
  "Content-Type": "application/json",
};

function testSignature(seed: number): Signature {
  return signature(getBase58Decoder().decode(new Uint8Array(64).fill(seed)));
}

export function installRecurringExecutionHooks() {
  let sourceSigner: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let signAsFeePayerMock: ReturnType<
    typeof vi.fn<(transaction: Uint8Array) => Promise<Uint8Array>>
  >;
  let signAndSendMock: ReturnType<typeof vi.fn<(transaction: Uint8Array) => Promise<Signature>>>;

  beforeEach(async () => {
    sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerMock.mockResolvedValue(sourceSigner);
    mockRecurringActivationRpc({});
    signAsFeePayerMock = vi
      .fn<(transaction: Uint8Array) => Promise<Uint8Array>>()
      .mockImplementation(async (transaction) => fullySignTestTransaction(transaction));
    signAndSendMock = vi
      .fn<(transaction: Uint8Array) => Promise<Signature>>()
      .mockResolvedValueOnce(testSignature(1))
      .mockResolvedValueOnce(testSignature(2));
    createFeePaymentAdapterMock.mockReturnValue({
      providerId: "mock",
      getFeePayer: vi.fn().mockResolvedValue(TEST_MOCK_FEE_PAYER),
      getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
      signAsFeePayer: signAsFeePayerMock,
      signAndSend: signAndSendMock,
    } satisfies ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);
  });

  return {
    sourceSigner: () => sourceSigner,
    signAsFeePayerMock: () => signAsFeePayerMock,
    signAndSendMock: () => signAndSendMock,
  };
}

export async function parseRecurringResponse(
  response: Response
): Promise<z.infer<typeof recurringResponseSchema>> {
  return recurringResponseSchema.parse(await response.json());
}

export async function parseCollectionResponse(
  response: Response
): Promise<z.infer<typeof collectionResponseSchema>> {
  return collectionResponseSchema.parse(await response.json());
}

export async function createRecurringPaymentFixture(options: {
  headers: Record<string, string>;
  sourceCustodyWalletId: string;
  destinationAddress: string;
  token: string;
  amount: string;
  periodHours: number;
  firstCollectionAt?: string;
}): Promise<z.infer<typeof recurringResponseSchema>["data"]["recurringPayment"]> {
  const counterpartyId = await seedCounterparty({
    externalId: `recurring_fixture_${crypto.randomUUID()}`,
  });
  const counterpartyAccountId = `counterparty_account_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await getDb(env)
    .prepare(
      `INSERT INTO counterparty_accounts (
         id, organization_id, project_id, counterparty_id, account_kind, label,
         details, provider_account_data, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'crypto_wallet', 'Recurring payment wallet', ?, '{}', 'active', ?, ?)`
    )
    .bind(
      counterpartyAccountId,
      "org_payments_policy_test",
      "prj_test_payments_policy",
      counterpartyId,
      JSON.stringify({ network: "solana", address: options.destinationAddress }),
      now,
      now
    )
    .run();
  const response = await app.request(
    "/v1/payments/recurring-payments",
    {
      method: "POST",
      headers: options.headers,
      body: JSON.stringify({
        sourceCustodyWalletId: options.sourceCustodyWalletId,
        counterpartyId,
        counterpartyAccountId,
        token: options.token,
        amount: options.amount,
        periodHours: options.periodHours,
        firstCollectionAt: options.firstCollectionAt,
      }),
    },
    env
  );
  expect(response.status).toBe(201);
  return (await parseRecurringResponse(response)).data.recurringPayment;
}

export async function activateRecurringPaymentFixture(options: {
  headers: Record<string, string>;
  sourceCustodyWalletId: string;
  destinationAddress: string;
  token: string;
  amount: string;
  periodHours: number;
  firstCollectionAt?: string;
}): Promise<
  z.infer<typeof recurringResponseSchema>["data"]["recurringPayment"] & {
    planId: string;
    subscriptionId: string;
  }
> {
  const recurringPayment = await createRecurringPaymentFixture(options);
  const response = await app.request(
    `/v1/payments/recurring-payments/${recurringPayment.id}/activate`,
    { method: "POST", headers: options.headers, body: "{}" },
    env
  );
  expect(response.status).toBe(200);
  const activated = (await parseRecurringResponse(response)).data.recurringPayment;
  expect(activated.status).toBe("active");
  if (activated.planId === null || activated.subscriptionId === null) {
    throw new Error("Activated recurring payment is missing execution IDs");
  }
  return { ...activated, planId: activated.planId, subscriptionId: activated.subscriptionId };
}

export async function setRecurringCollectionDue(options: {
  recurringPaymentId: string;
  subscriptionId: string;
  dueAt: string;
}): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare("UPDATE payment_recurring_payments SET next_collection_due_at = ? WHERE id = ?")
      .bind(options.dueAt, options.recurringPaymentId),
    db
      .prepare("UPDATE payment_subscriptions SET next_collection_due_at = ? WHERE id = ?")
      .bind(options.dueAt, options.subscriptionId),
  ]);
}

type DurableCollectionJournal =
  | { stage: "claimed"; transfer?: never }
  | {
      stage: "submitted" | "confirmed";
      transfer: {
        id: string;
        walletId: string;
        counterpartyId: string;
        sourceAddress: string;
        destinationAddress: string;
        signature: Signature;
      };
    };

export async function seedRecurringCollectionJournal(
  options: DurableCollectionJournal & {
    attemptId: string;
    organizationId: string;
    projectId: string;
    recurringPaymentId: string;
    subscriptionId: string;
    collectionDueAt: string;
    token: string;
    amount: string;
    attemptedAt: string;
  }
): Promise<void> {
  const db = getDb(env);
  const transfer = options.stage === "claimed" ? null : options.transfer;
  const statements = transfer
    ? [
        db
          .prepare(
            `INSERT INTO payment_transfers (
               id, organization_id, project_id, wallet_id, counterparty_id,
               source_address, destination_address, token, amount, memo, type,
               direction, status, provider_data, signature, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'transfer', 'outbound', ?, ?::jsonb, ?, ?, ?)`
          )
          .bind(
            transfer.id,
            options.organizationId,
            options.projectId,
            transfer.walletId,
            transfer.counterpartyId,
            transfer.sourceAddress,
            transfer.destinationAddress,
            options.token,
            options.amount,
            options.stage === "confirmed" ? "confirmed" : "processing",
            JSON.stringify({
              recurringPaymentId: options.recurringPaymentId,
              subscriptionId: options.subscriptionId,
              collectionDueAt: options.collectionDueAt,
            }),
            transfer.signature,
            options.attemptedAt,
            options.attemptedAt
          ),
      ]
    : [];
  statements.push(
    db
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts
           (id, organization_id, project_id, subscription_id, transfer_id, token,
            amount, due_at, attempted_at, status, signature, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        options.attemptId,
        options.organizationId,
        options.projectId,
        options.subscriptionId,
        transfer?.id ?? null,
        options.token,
        options.amount,
        options.collectionDueAt,
        options.attemptedAt,
        options.stage === "confirmed" ? "succeeded" : "processing",
        transfer?.signature ?? null,
        JSON.stringify({
          source: "manual",
          recurringPaymentId: options.recurringPaymentId,
          initiatedByKeyId: null,
        }),
        options.attemptedAt,
        options.attemptedAt
      )
  );
  await db.batch(statements);
}

export async function seedRecurringDatabaseTenant(options: {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  userId: string;
  userEmail: string;
  projectId: string;
  custodyConfigId: string;
  custodyWalletId: string;
  providerWalletId: string;
  publicKey: string;
}): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active') ON CONFLICT (id) DO NOTHING"
      )
      .bind(options.organizationId, options.organizationName, options.organizationSlug),
    db
      .prepare(
        "INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active') ON CONFLICT (id) DO NOTHING"
      )
      .bind(options.userId, options.userEmail),
  ]);
  await seedDefaultProjects(db, {
    organizationId: options.organizationId,
    createdBy: options.userId,
    members: [],
    ids: { sandbox: options.projectId, production: `${options.projectId}_production` },
  });
  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, default_wallet_id, status)
         VALUES (?, ?, ?, 'local', 'encrypted', NULL, 'active')`
      )
      .bind(options.custodyConfigId, options.organizationId, options.projectId),
    db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(
        options.custodyWalletId,
        options.custodyConfigId,
        options.providerWalletId,
        options.publicKey
      ),
    db
      .prepare("UPDATE custody_configs SET default_wallet_id = ? WHERE id = ?")
      .bind(options.providerWalletId, options.custodyConfigId),
  ]);
}

export const DEFAULT_RECURRING_FIXTURE = {
  headers: RECURRING_HEADERS,
  sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
  destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
  token: DEVNET_USDC_MINT,
  amount: "25.00",
  periodHours: 24,
} as const;
