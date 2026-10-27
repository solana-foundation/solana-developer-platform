import { getBase58Decoder } from "@solana/codecs";
import {
  generateKeyPairSigner,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Signature,
  signature,
} from "@solana/kit";
import { beforeEach, expect, vi } from "vitest";
import type { z } from "zod";
import { getDb } from "@/db/client";
import { app as baseApp } from "@/index";
import { successResponseSchema } from "@/openapi/schemas/base";
import {
  paymentRecurringPaymentCollectionResponseSchema,
  paymentRecurringPaymentResponseSchema,
} from "@/openapi/schemas/payments";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { installClusterRpcResponder, type JsonRpcResult } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import {
  createKoraAdapterMock,
  createOrgSignerForCustodyWalletMock,
  DEVNET_USDC_MINT,
  MAINNET_USDC_MINT,
  seedCounterparty,
  sendTransactionMock,
  TEST_CUSTODY_WALLET_ID,
  TEST_SPONSORSHIP_PROVIDER_CONFIG,
  testKoraAdapter,
  updateSeededWalletPublicKey,
} from "@/test/helpers/payments-routes";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import { fullySignTestTransaction, TEST_MOCK_FEE_PAYER } from "@/test/helpers/sponsor-signing";
import { withIdempotencyKeys } from "./idempotency-keys";
import {
  answerMovementAccounts,
  associatedTokenAccount,
  mintRpcAccount,
  tokenRpcAccount,
} from "./token-movement";

/**
 * The accounts a recurring terms read sees for `mints`: each as a classic
 * 6-decimal mint, and every owner's existing token account of each.
 *
 * @param mints - The mints the read may ask for.
 * @param owners - The wallets with a token account of each mint.
 */
async function classicMintAccounts(
  mints: readonly string[],
  owners: readonly string[]
): Promise<Map<string, JsonRpcResult>> {
  const accounts = new Map<string, JsonRpcResult>();
  for (const mint of mints) {
    accounts.set(mint, mintRpcAccount("spl-token", { decimals: 6, extensions: null }));
    for (const owner of owners) {
      accounts.set(
        await associatedTokenAccount("spl-token", mint, owner),
        tokenRpcAccount("spl-token", { mint, owner, amount: 1_000_000_000n, extensions: null })
      );
    }
  }
  return accounts;
}

/**
 * The accounts a recurring terms read sees: the mints recurring tests pay in,
 * as a classic 6-decimal mint, and every test wallet's existing token account
 * of each (the source's included), as the stubbed `getAccountInfo` answered
 * before mandates. The read that makes a mandate, activates it and decides
 * each pull answers with them.
 *
 * @param owners - The wallets with a token account of each mint.
 */
export function recurringMintAccounts(
  owners: readonly string[]
): Promise<Map<string, JsonRpcResult>> {
  return classicMintAccounts([DEVNET_USDC_MINT, MAINNET_USDC_MINT], owners);
}

// Every mutation carries a fresh key unless a test sets its own (HOO-1918).
const app = withIdempotencyKeys(baseApp);

const recurringResponseSchema = successResponseSchema(paymentRecurringPaymentResponseSchema);
const collectionResponseSchema = successResponseSchema(
  paymentRecurringPaymentCollectionResponseSchema
);

export const RECURRING_HEADERS = {
  Authorization: "Bearer sk_test_payments_policy",
  "Content-Type": "application/json",
};

export function testSignature(seed: number): Signature {
  return signature(getBase58Decoder().decode(new Uint8Array(64).fill(seed)));
}

export function installRecurringExecutionHooks() {
  const rpc = installClusterRpcResponder();
  let sourceSigner: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let signAsFeePayerMock: ReturnType<
    typeof vi.fn<(transaction: Uint8Array) => Promise<Uint8Array>>
  >;

  beforeEach(async () => {
    sourceSigner = await generateKeyPairSigner();
    await updateSeededWalletPublicKey(sourceSigner.address);
    createOrgSignerForCustodyWalletMock.mockResolvedValue(sourceSigner);
    // Mandates are made, and pulls decided, from the mint's terms (ADR 0012).
    answerMovementAccounts(rpc, await recurringMintAccounts(owners()));
    signAsFeePayerMock = vi
      .fn<(transaction: Uint8Array) => Promise<Uint8Array>>()
      .mockImplementation(async (transaction) => fullySignTestTransaction(transaction));
    createKoraAdapterMock.mockReturnValue(
      testKoraAdapter({
        getFeePayer: vi.fn().mockResolvedValue(TEST_MOCK_FEE_PAYER),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
        signAsFeePayer: signAsFeePayerMock,
      })
    );
  });

  /** Every wallet the hooks give a token account: the source and each test wallet. */
  const owners = () => [sourceSigner.address, ...Object.values(TEST_SOLANA_ADDRESSES)];

  return {
    rpc,
    sourceSigner: () => sourceSigner,
    signAsFeePayerMock: () => signAsFeePayerMock,
    /** Answers terms reads for tokens issued in the project too, beside the catalogue mints. */
    answerIssuedMints: async (mints: readonly string[]) => {
      answerMovementAccounts(
        rpc,
        new Map([
          ...(await recurringMintAccounts(owners())),
          ...(await classicMintAccounts(mints, owners())),
        ])
      );
    },
  };
}

/** The signature of each transaction the managed pool was asked to send, in order. */
export function poolSentSignatures(): Signature[] {
  return sendTransactionMock.mock.calls.map(([, transactionBytes]) =>
    getSignatureFromTransaction(getTransactionDecoder().decode(transactionBytes))
  );
}

/**
 * Let the managed pool deliver the next `deliveredSends` sends as usual, then fail the one after.
 *
 * @param deliveredSends - How many sends succeed first.
 * @param error - What the failing send rejects with.
 */
export function rejectPoolSendAfter(deliveredSends: number, error: Error): void {
  const deliver = required(sendTransactionMock.getMockImplementation());
  for (let send = 0; send < deliveredSends; send += 1) {
    sendTransactionMock.mockImplementationOnce(deliver);
  }
  sendTransactionMock.mockRejectedValueOnce(error);
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
  /** The project the key and source wallet live in; defaults to the Sandbox test project. */
  projectId?: string;
  sourceCustodyWalletId: string;
  destinationAddress: string;
  token: string;
  amount: string;
  periodHours: number;
  firstCollectionAt?: string;
}): Promise<z.infer<typeof recurringResponseSchema>["data"]["recurringPayment"]> {
  const projectId = options.projectId ?? "prj_test_payments_policy";
  const counterpartyId = await seedCounterparty({
    externalId: `recurring_fixture_${crypto.randomUUID()}`,
    projectId,
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
      projectId,
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
  projectId?: string;
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
        options.stage === "confirmed" ? "confirmed" : "processing",
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
           (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'local', 'encrypted', 'active')`
      )
      .bind(options.custodyConfigId, options.organizationId, options.projectId),
    db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, purpose, status)
         VALUES (?, ?, ?, ?, 'transfer', 'active')`
      )
      .bind(
        options.custodyWalletId,
        options.custodyConfigId,
        options.providerWalletId,
        options.publicKey
      ),
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
