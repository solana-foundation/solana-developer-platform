import { getBase58Decoder } from "@solana/codecs";
import {
  address,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Signature,
  signature,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, expect, vi } from "vitest";
import type { z } from "zod";
import { getDb } from "@/db/client";
import type { CollectionAttemptDelegationPreImage } from "@/db/repositories/payment-subscriptions.repository";
import { createPostgresPaymentSubscriptionsRepository } from "@/db/repositories/payment-subscriptions.repository.postgres";
import { app as baseApp } from "@/index";
import { successResponseSchema } from "@/openapi/schemas/base";
import {
  paymentRecurringPaymentCollectionResponseSchema,
  paymentRecurringPaymentResponseSchema,
} from "@/openapi/schemas/payments";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import {
  type ClusterRpcResponder,
  epochInfoResult,
  installClusterRpcResponder,
  multipleAccountsRead,
  multipleAccountsResult,
  type StubEncodedAccount,
  tokenSupplyResult,
} from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import {
  createKoraAdapterMock,
  createOrgSignerForCustodyWalletMock,
  DEVNET_USDC_MINT,
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
import {
  planAccount,
  type StubDelegation,
  type StubPlan,
  soleDestination,
  subscriptionDelegationAccount,
  tokenMintAccount,
} from "@/test/helpers/subscription-accounts";
import { withIdempotencyKeys } from "./idempotency-keys";

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

/** The decimals every fixture token's mint reports, to `getTokenSupply` and in its account. */
export const RECURRING_FIXTURE_TOKEN_DECIMALS = 6;

/** `DEFAULT_RECURRING_FIXTURE.amount` in base units at the fixture decimals. */
export const RECURRING_FIXTURE_PULL_BASE_UNITS = 25_000_000n;

/**
 * The delegation's period as a fixture activation leaves it, which is the pre-image a fresh
 * collection of it saves: the opening period, with nothing pulled.
 */
export const RECURRING_FIXTURE_PRE_IMAGE = {
  periodStartTs: 1_770_000_000n,
  amountPulled: 0n,
} as const satisfies CollectionAttemptDelegationPreImage;

/**
 * The fixture delegation in its opening period with nothing pulled.
 *
 * @param expiresAtTs - The delegation's expiry: 0 while active, the period's end once canceled.
 * @returns The delegation.
 */
export function unpulledDelegation(expiresAtTs: bigint): StubDelegation {
  return {
    expiresAtTs,
    currentPeriodStartTs: RECURRING_FIXTURE_PRE_IMAGE.periodStartTs,
    amountPulledInPeriod: RECURRING_FIXTURE_PRE_IMAGE.amountPulled,
  };
}

/**
 * The fixture delegation once the fixture amount was pulled in its opening period: a collection
 * saved against `RECURRING_FIXTURE_PRE_IMAGE` landed.
 *
 * @param expiresAtTs - The delegation's expiry: 0 while active, the period's end once canceled.
 * @returns The delegation.
 */
export function delegationPulledOnce(expiresAtTs: bigint): StubDelegation {
  return {
    expiresAtTs,
    currentPeriodStartTs: RECURRING_FIXTURE_PRE_IMAGE.periodStartTs,
    amountPulledInPeriod:
      RECURRING_FIXTURE_PRE_IMAGE.amountPulled + RECURRING_FIXTURE_PULL_BASE_UNITS,
  };
}

/** A recorded plan's parties as its row names them: its owner and its one destination. */
export type RecordedPlanParties = Pick<StubPlan, "owner" | "destinations">;

/**
 * The chain a resumed recurring step reads at `confirmed`: the tip `getEpochInfo` reports, the
 * plan or delegation at each address SDP recorded as one, every schedule's token mint at the
 * fixture decimals, and any other account at an address it never recorded.
 */
export interface RecurringChainView {
  absoluteSlot: number;
  blockHeight: number;
  /** The plan at a recorded plan address, given the parties its row names at the time of the read. */
  plan: (planPda: string, recorded: RecordedPlanParties) => StubPlan | null;
  /** The delegation at `subscriptionPda`, or null when it does not exist. */
  delegation: (subscriptionPda: string) => StubDelegation | null;
  /** The account at an address recorded as none of them, or null when it does not exist. */
  unrecorded: (accountAddress: string) => StubEncodedAccount | null;
}

/**
 * Every recorded plan on chain as the fixtures create it, owned by and paying the wallets its row
 * names, every recorded delegation canceled with nothing pulled, as the codama fetch stubs answer,
 * and no other account; the tip is below the default blockhash's expiry.
 */
export const DEFAULT_RECURRING_CHAIN: RecurringChainView = {
  absoluteSlot: 1_250,
  blockHeight: 940,
  plan: (_planPda, recorded) => ({ ...recorded, createdAt: 1_770_000_000n, metadataUri: "" }),
  delegation: () => unpulledDelegation(1_800_000_000n),
  unrecorded: () => null,
};

/** What SDP recorded at an address a step read asked for. */
type RecordedSubscriptionAccount =
  | { kind: "plan"; parties: RecordedPlanParties }
  | { kind: "delegation" }
  | { kind: "mint" }
  | { kind: "unrecorded" };

/**
 * What SDP recorded at `accountAddress`: a plan, with the parties its row names, a subscription
 * delegation, a schedule's token mint, or nothing.
 *
 * @param accountAddress - An address a step read asked for.
 * @returns The recorded account.
 */
async function recordedSubscriptionAccount(
  accountAddress: string
): Promise<RecordedSubscriptionAccount> {
  // A step reads under its request's tenant identity, which owns every address it asks about.
  const db = getDb(env);
  const plan = await db
    .prepare(
      "SELECT owner_address, destination_address FROM payment_subscription_plans WHERE plan_pda = ?"
    )
    .bind(accountAddress)
    .first<{ owner_address: string; destination_address: string | null }>();
  if (plan !== null) {
    return {
      kind: "plan",
      parties: {
        owner: address(plan.owner_address),
        destinations: soleDestination(address(required(plan.destination_address))),
      },
    };
  }
  const recorded = required(
    await db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM payment_subscriptions WHERE subscription_pda = ?) AS delegation,
                EXISTS (SELECT 1 FROM payment_recurring_payments WHERE token = ?) AS mint`
      )
      .bind(accountAddress, accountAddress)
      .first<{ delegation: boolean; mint: boolean }>()
  );
  if (recorded.delegation) return { kind: "delegation" };
  if (recorded.mint) return { kind: "mint" };
  return { kind: "unrecorded" };
}

/**
 * The account `view` shows at `accountAddress`.
 *
 * @param view - The chain to read.
 * @param accountAddress - The requested address.
 * @returns The encoded account, or null when it does not exist.
 */
async function recurringChainAccount(
  view: RecurringChainView,
  accountAddress: string
): Promise<StubEncodedAccount | null> {
  const recorded = await recordedSubscriptionAccount(accountAddress);
  switch (recorded.kind) {
    case "plan": {
      const plan = view.plan(accountAddress, recorded.parties);
      return plan === null ? null : planAccount(plan);
    }
    case "delegation": {
      const delegation = view.delegation(accountAddress);
      return delegation === null ? null : subscriptionDelegationAccount(delegation);
    }
    case "mint":
      return tokenMintAccount({
        programAddress: TOKEN_PROGRAM_ADDRESS,
        decimals: RECURRING_FIXTURE_TOKEN_DECIMALS,
      });
    case "unrecorded":
      return view.unrecorded(accountAddress);
    default: {
      const exhaustive: never = recorded;
      throw new Error(`Unexpected subscription account ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Answer the current test's step reads (`getEpochInfo`, then `getMultipleAccounts` at the tip's
 * slot) from `view`, replacing any earlier view.
 *
 * @param rpc - The suite's responder.
 * @param view - The chain the reads see.
 */
function answerRecurringChain(rpc: ClusterRpcResponder, view: RecurringChainView): void {
  rpc.respond("getEpochInfo", () => ({
    result: epochInfoResult({ absoluteSlot: view.absoluteSlot, blockHeight: view.blockHeight }),
  }));
  rpc.respond("getMultipleAccounts", async (request) => ({
    result: multipleAccountsResult(
      view.absoluteSlot,
      await Promise.all(
        multipleAccountsRead(request).addresses.map((address) =>
          recurringChainAccount(view, address)
        )
      )
    ),
  }));
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
    rpc.answer("getTokenSupply", tokenSupplyResult(1, RECURRING_FIXTURE_TOKEN_DECIMALS));
    answerRecurringChain(rpc, DEFAULT_RECURRING_CHAIN);
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

  return {
    rpc,
    showChain: (view: RecurringChainView) => answerRecurringChain(rpc, view),
    sourceSigner: () => sourceSigner,
    signAsFeePayerMock: () => signAsFeePayerMock,
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

/** The signed bytes a seeded pull saves; recovery reads the chain, never these. */
const SEEDED_SIGNED_COLLECTION_TRANSACTION = "c2VlZGVkIHNpZ25lZCBjb2xsZWN0aW9uIHB1bGw=";

type DurableCollectionJournal =
  | { stage: "claimed"; transfer?: never; preImage?: never }
  | {
      stage: "submitted" | "confirmed";
      transfer: {
        id: string;
        walletId: string;
        counterpartyId: string;
        sourceAddress: string;
        destinationAddress: string;
        signature: Signature;
        /** The saved pull's last valid block height, a u64 decimal string. */
        lastValidBlockHeight: string;
        /** When its send started, or null when the process died between saving and sending. */
        submissionStartedAt: string | null;
      };
      /** The delegation read before signing, or null for an attempt signed before it was saved. */
      preImage: CollectionAttemptDelegationPreImage | null;
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
               direction, status, provider_data, signature, signed_transaction,
               last_valid_block_height, submission_started_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'transfer', 'outbound', ?, ?::jsonb, ?, ?, ?::numeric, ?, ?, ?)`
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
            SEEDED_SIGNED_COLLECTION_TRANSACTION,
            transfer.lastValidBlockHeight,
            transfer.submissionStartedAt,
            options.attemptedAt,
            options.attemptedAt
          ),
      ]
    : [];
  const preImage = options.stage === "claimed" ? null : options.preImage;
  statements.push(
    db
      .prepare(
        `INSERT INTO payment_subscription_collection_attempts
           (id, organization_id, project_id, subscription_id, transfer_id, token,
            amount, due_at, attempted_at, status, signature, metadata,
            delegation_period_start_ts_before, delegation_amount_pulled_before,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::bigint, ?::numeric, ?, ?)`
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
        preImage === null ? null : preImage.periodStartTs.toString(),
        preImage === null ? null : preImage.amountPulled.toString(),
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
           (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(
        options.custodyWalletId,
        options.custodyConfigId,
        options.providerWalletId,
        options.publicKey
      ),
  ]);
}

/**
 * Seeds an active subscription plan and an active subscription on it, the rows an `active`
 * recurring payment's `plan_id` and `subscription_id` point at.
 * @param options - The subscription's tenant, parties and schedule.
 * @param options.organizationId - Organization owning both rows.
 * @param options.projectId - Project owning both rows.
 * @param options.planId - Id of the plan to create.
 * @param options.subscriptionId - Id of the subscription to create.
 * @param options.counterpartyId - Counterparty the subscription collects for.
 * @param options.ownerWalletId - Provider wallet id owning the plan.
 * @param options.ownerAddress - Address owning the plan and subscribing to it.
 * @param options.destinationAddress - Address the plan pays out to.
 * @param options.token - Token the plan collects.
 * @param options.createdBy - User recorded as creator of both rows.
 * @param options.createdAt - Creation, update and current-period start timestamp.
 * @param options.nextCollectionDueAt - When the subscription's next collection falls due.
 * @returns Resolves once both rows exist.
 */
export async function seedActiveRecurringSubscription(options: {
  organizationId: string;
  projectId: string;
  planId: string;
  subscriptionId: string;
  counterpartyId: string;
  ownerWalletId: string;
  ownerAddress: string;
  destinationAddress: string;
  token: string;
  createdBy: string;
  createdAt: string;
  nextCollectionDueAt: string;
}): Promise<void> {
  const subscriptionsRepo = createPostgresPaymentSubscriptionsRepository(getDb(env));
  required(
    await subscriptionsRepo.createPlan({
      id: options.planId,
      organizationId: options.organizationId,
      projectId: options.projectId,
      ownerWalletId: options.ownerWalletId,
      ownerAddress: options.ownerAddress,
      token: options.token,
      amount: "10.00",
      periodHours: 24,
      programPlanId: "1",
      planPda: null,
      destinationAddress: options.destinationAddress,
      pullerWalletId: null,
      pullerAddress: null,
      metadataUri: null,
      status: "active",
      createdBy: options.createdBy,
      createdAt: options.createdAt,
      updatedAt: options.createdAt,
    })
  );
  required(
    await subscriptionsRepo.createSubscription({
      id: options.subscriptionId,
      organizationId: options.organizationId,
      projectId: options.projectId,
      planId: options.planId,
      counterpartyId: options.counterpartyId,
      subscriberAddress: options.ownerAddress,
      subscriberTokenAccount: null,
      subscriptionPda: null,
      subscriptionAuthorityAddress: null,
      authorizationSignature: null,
      status: "active",
      currentPeriodStartAt: options.createdAt,
      nextCollectionDueAt: options.nextCollectionDueAt,
      createdBy: options.createdBy,
      createdAt: options.createdAt,
      updatedAt: options.createdAt,
    })
  );
}

export const DEFAULT_RECURRING_FIXTURE = {
  headers: RECURRING_HEADERS,
  sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
  destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
  token: DEVNET_USDC_MINT,
  amount: "25.00",
  periodHours: 24,
} as const;
