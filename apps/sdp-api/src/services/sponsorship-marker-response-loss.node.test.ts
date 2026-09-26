/**
 * @title Regression: Managed sponsorship must be released when the pre-send
 * submission marker response is lost
 * @notice Proves that a project-scoped managed sponsorship is not left charged
 * (or aged into charged_unknown) when the payment transfer's durable submission
 * marker commits but its response is lost. The send boundary lives strictly
 * after `prepareOwnedSubmission` returns, so a marker failure — even a
 * committed one — means the signed bytes were never broadcast: the reservation
 * must be released, the budget window must stay free, and a corrected retry
 * must be admitted.
 */

import type { FeePaymentPort } from "@sdp/payments/fee-payment";
import type { SolanaRpc } from "@sdp/rpc/solana";
import type { Blockhash, Signature } from "@solana/kit";
import {
  compileTransaction,
  createTransactionMessage,
  getBase58Codec,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import type { PaymentsRepository, PaymentTransferRow } from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import {
  type SponsorshipBudgetPolicy,
  SponsorshipBudgetRepository,
} from "@/db/repositories/sponsorship-budget.repository";
import { SponsorshipBudgetRedis } from "@/runtime/sponsorship-budget-redis";
import { reconcileSponsorshipBudgets } from "@/services/jobs/reconcile-sponsorship-budgets";
import { createTransferSignedSubmissionStore } from "@/services/payments/signed-submission";
import { BudgetedFeePayment } from "@/services/sponsorship-budget.service";
import {
  isDefiniteSubmissionError,
  submitSponsoredTransaction,
} from "@/services/sponsorship-submission";
import { env } from "@/test/helpers/env";
import { sponsorSignTestTransaction, TEST_MOCK_FEE_PAYER } from "@/test/helpers/sponsor-signing";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";

const ORGANIZATION_ID = "org_regression_marker_loss";
const PROJECT_ID = "prj_regression_marker_loss";
const CUSTODY_CONFIG_ID = "cfg_regression_marker_loss";
const CUSTODY_WALLET_ID = "cwlt_regression_marker_loss";
const WALLET_ID = "wallet_regression_marker_loss";
const TRANSFER_ID = "xfr_regression_marker_loss";
const SIGNATURE =
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature;
const BLOCKHASH = getBase58Codec().decode(new Uint8Array(32).fill(7)) as Blockhash;
const RETRY_BLOCKHASH = getBase58Codec().decode(new Uint8Array(32).fill(8)) as Blockhash;

const PROVIDER_CONFIGURATION = {
  signerAddress: TEST_MOCK_FEE_PAYER,
  maxAllowedLamports: 1_000_000n,
  feePayerMayTransferLamports: false,
  feePayerPolicy: { system: { allow_transfer: false } },
};

function buildTransaction(blockhash: Blockhash): Uint8Array {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayer(TEST_MOCK_FEE_PAYER, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash, lastValidBlockHeight: 100n },
        current
      )
  );
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
}

async function seedPaymentTransfer(): Promise<PaymentTransferRow> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'Marker Loss Regression', ?, 'individual', 'active')`
      )
      .bind(ORGANIZATION_ID, ORGANIZATION_ID),
    db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, ?, 1, 'active')`
      )
      .bind("usr_regression_marker_loss", `${ORGANIZATION_ID}@example.com`),
    db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Marker Loss Regression', ?, 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, ORGANIZATION_ID, PROJECT_ID, "usr_regression_marker_loss"),
    db
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted)
         VALUES (?, ?, ?, 'regression', 'encrypted')`
      )
      .bind(CUSTODY_CONFIG_ID, ORGANIZATION_ID, PROJECT_ID),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key)
         VALUES (?, ?, ?, ?)`
      )
      .bind(CUSTODY_WALLET_ID, CUSTODY_CONFIG_ID, WALLET_ID, TEST_MOCK_FEE_PAYER),
  ]);

  const repository = createPostgresPaymentsRepository(db);
  const transfer = await repository.createTransfer({
    id: TRANSFER_ID,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    custodyWalletId: CUSTODY_WALLET_ID,
    walletId: WALLET_ID,
    counterpartyId: null,
    sourceAddress: TEST_MOCK_FEE_PAYER,
    destinationAddress: TEST_MOCK_FEE_PAYER,
    token: "SOL",
    amount: "1",
    memo: null,
    type: "transfer",
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
    initiatedByKeyId: null,
    idempotencyKey: "regression-marker-loss",
    idempotencyFingerprint: "regression-marker-loss-fingerprint",
  });
  if (!transfer) throw new Error("Failed to create regression payment transfer");
  return transfer;
}

describe("managed sponsorship marker response loss", () => {
  beforeAll(async () => {
    await seedTestDatabase(env as Env);
  });

  it("releases the reservation and keeps the budget window free", async () => {
    const transfer = await seedPaymentTransfer();
    const paymentsRepository = createPostgresPaymentsRepository(getDb(env));
    const sponsorshipRepository = new SponsorshipBudgetRepository(getDb(env));
    const budgetRedis = new SponsorshipBudgetRedis(env);

    // Constrain every devnet policy to exactly one reservation's worth of
    // budget so a retained reservation is observable as a denied retry.
    const policies = await sponsorshipRepository.listPolicies("devnet");
    const constrainedPolicies: SponsorshipBudgetPolicy[] = [];
    for (const policy of policies) {
      const constrained = await sponsorshipRepository.upsertPolicy({
        network: policy.network,
        scopeType: policy.scopeType,
        scopeId: policy.scopeId,
        enabled: true,
        perTransactionLamports: 5_000,
        hourlyLamports: 5_000,
        dailyLamports: 5_000,
        operator: "regression-validator",
        reason: "Bounded capacity for marker-loss regression",
      });
      constrainedPolicies.push(constrained);
    }
    await Promise.all(constrainedPolicies.map((policy) => budgetRedis.syncPolicy(policy)));

    let signCalls = 0;
    const provider: FeePaymentPort = {
      providerId: "kora",
      getFeePayer: async () => TEST_MOCK_FEE_PAYER,
      getSponsorshipConfiguration: async () => PROVIDER_CONFIGURATION,
      signAsFeePayer: async (bytes) => {
        signCalls += 1;
        return sponsorSignTestTransaction(bytes);
      },
      signAndSend: async () => SIGNATURE,
    };
    const feePayment = new BudgetedFeePayment(
      { ...env, SOLANA_NETWORK: "devnet" } as Env,
      {
        environment: "sandbox",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        actor: { type: "api_key", id: "key_regression_marker_loss" },
        cluster: "devnet",
      },
      provider,
      {
        repository: sponsorshipRepository,
        budgetRedis,
        getNetworkFee: async () => 5_000n,
        now: () => new Date("2026-09-25T05:00:00.000Z"),
      }
    );

    const faultInjectedPaymentsRepository: PaymentsRepository = {
      ...paymentsRepository,
      markTransferSubmissionStarted: async (input) => {
        const committed = await paymentsRepository.markTransferSubmissionStarted(input);
        if (!committed) throw new Error("marker write did not commit");
        // Model a lost database response after the UPDATE committed.
        throw new Error("marker response lost");
      },
    };
    const submissionStore = createTransferSignedSubmissionStore(
      faultInjectedPaymentsRepository,
      transfer
    );
    const noBroadcastRpc = new Proxy(
      {},
      {
        get: () => {
          throw new Error("unexpected RPC broadcast");
        },
      }
    ) as SolanaRpc;

    let markerError: unknown;
    try {
      await submitSponsoredTransaction({
        feePayment,
        rpc: noBroadcastRpc,
        transaction: buildTransaction(BLOCKHASH),
        lastValidBlockHeight: 100n,
        store: submissionStore,
      });
      throw new Error("submission unexpectedly returned");
    } catch (error) {
      markerError = error;
    }

    // The marker failure propagates: it is not a definitive preflight verdict.
    expect(markerError).toMatchObject({ message: "marker response lost" });
    expect(isDefiniteSubmissionError(markerError)).toBe(false);

    // The marker itself is durable (a lease for the in-flight attempt), and the
    // submission never reached the broadcast boundary.
    const transferAfterMarkerLoss = await paymentsRepository.getTransferById({
      transferId: transfer.id,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    });
    expect(transferAfterMarkerLoss).toMatchObject({
      status: "processing",
      signed_transaction: expect.any(String),
      submission_started_at: expect.any(String),
    });
    // The durable marker (read back from the database above) also leaves the
    // route's post-marker failure posture unchanged: the signed submission row
    // stays owned by the store, so the transfer keeps processing for chain
    // reconciliation instead of failing with an unowned signature.
    expect(await submissionStore.submittedRow()).toMatchObject({
      signature: expect.any(String),
    });

    // The unsent reservation was released under the durable owner token, so it
    // is neither a reconciliation candidate nor a budget occupant.
    const HOUR_BUCKET = "2026-09-25T05:00:00.000Z";
    const DAY_BUCKET = "2026-09-25T00:00:00.000Z";
    const aged = new Date("2100-01-01T00:00:00.000Z");
    await expect(
      sponsorshipRepository.listReconciliationCandidates("devnet", aged.toISOString())
    ).resolves.toHaveLength(0);
    const reservationRow = await getDb(env).queryOne<{
      id: string;
      status: string;
      actual_lamports: number | null;
      reserved_lamports: number;
    }>(
      `SELECT id, status, actual_lamports, reserved_lamports
       FROM sponsorship_budget_reservations
       WHERE network = 'devnet'
         AND organization_id = ?
         AND hour_bucket = ?`,
      [ORGANIZATION_ID, HOUR_BUCKET]
    );
    if (!reservationRow) throw new Error("Released regression reservation not found");
    expect(reservationRow).toMatchObject({
      status: "released",
      actual_lamports: 0,
      reserved_lamports: 5_000,
    });

    // Reconciliation has nothing to settle: repeated ticks change nothing.
    const reconciliation = {
      repository: sponsorshipRepository,
      budgetRedis,
      getProviderConfiguration: async () => PROVIDER_CONFIGURATION,
      getTransaction: async () => null,
      isBlockhashValid: async () => false,
      now: () => aged,
      sleep: async () => {},
    };
    await reconcileSponsorshipBudgets(env as Env, reconciliation);
    await reconcileSponsorshipBudgets(env as Env, reconciliation);
    await expect(sponsorshipRepository.getReservation(reservationRow.id)).resolves.toMatchObject({
      status: "released",
      actualLamports: 0,
    });
    const usageAfterSettlement = await sponsorshipRepository.getWindowUsage({
      network: "devnet",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      hourBucket: HOUR_BUCKET,
      dayBucket: DAY_BUCKET,
    });
    expect(usageAfterSettlement.hour.project).toBe(0);

    // A corrected retry is admitted again: the freed budget supports it.
    await expect(feePayment.signAndSend(buildTransaction(RETRY_BLOCKHASH))).resolves.toBe(
      SIGNATURE
    );
    expect(signCalls).toBe(1);
  });
});
