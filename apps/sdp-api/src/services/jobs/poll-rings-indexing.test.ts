import type { WalletOperationPolicyEnforcement } from "@sdp/policy";
import {
  createKeyPairFromPrivateKeyBytes,
  getAddressFromPublicKey,
  getBase64Codec,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  type SignatureBytes,
  signBytes,
} from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  createHeliusRingsOperationRepository,
  createHeliusRingsWalletRepository,
} from "@/db/repositories";
import { createHeliusRingsService } from "@/services/helius-rings";
import {
  InMemoryRingsGateway,
  type InMemoryRingsGatewayOptions,
} from "@/test/fixtures/in-memory-rings-gateway";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { unsignedRingsTransaction } from "@/test/fixtures/rings-transactions";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  pollRingsIndexing,
  RINGS_INDEXING_TIMEOUT_MS,
  RINGS_UNSIGNED_GRACE_MS,
} from "./poll-rings-indexing";

const TEST_PROJECT_ID = "prj_hr_job_test";
const tenant = { organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };

const allowPolicy = async () =>
  ({
    operation: { id: "wop_1" },
    evaluation: {
      id: "pev_1",
      decision: "allow",
      reason: null,
      requiresApproval: false,
      approvalRequestId: null,
    },
  }) as unknown as WalletOperationPolicyEnforcement;

const OWNER_KEYPAIR = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(61));
const OWNER = await getAddressFromPublicKey(OWNER_KEYPAIR.publicKey);
const OUTER_UNSIGNED_TX = unsignedRingsTransaction(OWNER);

async function signOuterTransaction(unsignedTxBase64: string) {
  const transaction = getTransactionDecoder().decode(getBase64Codec().encode(unsignedTxBase64));
  const ownerSignature = await signBytes(OWNER_KEYPAIR.privateKey, transaction.messageBytes);
  const signed = {
    ...transaction,
    signatures: { [OWNER]: ownerSignature as SignatureBytes },
  };
  return {
    signedTxBase64: getBase64Codec().decode(getTransactionEncoder().encode(signed)),
    signature: getSignatureFromTransaction(signed),
  };
}

const OUTER_TX = await signOuterTransaction(OUTER_UNSIGNED_TX);

function ringsGateway(
  options: Omit<InMemoryRingsGatewayOptions, "buildUnsignedTx"> = {}
): InMemoryRingsGateway {
  return new InMemoryRingsGateway({
    ...options,
    buildUnsignedTx: () => OUTER_UNSIGNED_TX,
  });
}

/**
 * The reconciliation sweep sits in front of the indexing poll and asks the chain
 * for its height. These tests are about the poll, so it is told the height is
 * unavailable — which the sweep treats as "judge nothing this tick".
 */
const NO_HEIGHT = async () => null;

let walletId: string;
let jobEnv: typeof env;

function serviceWith(gateway: InMemoryRingsGateway) {
  return createHeliusRingsService(env, tenant, {
    gateway,
    enforcePolicy: allowPolicy,
    validateOuterTransaction: async () => {},
    signOuterTransaction: async ({ unsignedTxBase64 }) =>
      (await signOuterTransaction(unsignedTxBase64)).signedTxBase64,
    submitOuterTransaction: async () => OUTER_TX.signature,
  });
}

describe("pollRingsIndexing", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    jobEnv = { ...env, HELIUS_RINGS_ENABLED: "true" };
    const db = getDb(env);

    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT_ID, TEST_ORG.id, TEST_PROJECT_ID, TEST_USER.id)
      .run();

    const wallets = createHeliusRingsWalletRepository(env);
    const wallet = await wallets.createWallet({
      ...tenant,
      sdpWalletId: "wal_hr_job_test",
      name: "Treasury",
      materialTag: "simulated",
    });
    if (!wallet) throw new Error("wallet fixture was not created");
    walletId = wallet.id;

    // Provisioned, because every operation here is a spend and the pipeline
    // needs the owner the shielded identity is published under.
    await wallets.markProvisioned({
      ...tenant,
      id: wallet.id,
      shieldedAddress: "rings1jobtestidentity",
      ownerAddress: OWNER,
      materialTag: "simulated",
      expectedStatus: "pending",
    });
  });

  it("stays dormant unless the feature flag is set", async () => {
    const gateway = ringsGateway({ indexingDelayMs: 0 });
    const operation = await serviceWith(gateway).prepareOperation(
      {
        walletId,
        opType: "shield",
        asset: { mint: "So11111111111111111111111111111111111111112", amountRaw: "1000" },
        clientNonce: "job-dormant",
      },
      { apiKeyId: null, actor: null, custodyWalletId: null }
    );
    expect(operation.state).toBe("indexing");
    gateway.recordSubmission(OUTER_TX.signature);

    await pollRingsIndexing(
      { ...env, HELIUS_RINGS_ENABLED: undefined },
      { createService: () => serviceWith(gateway), readBlockHeight: NO_HEIGHT }
    );

    const row = await createHeliusRingsOperationRepository(env).getOperationById({
      ...tenant,
      id: operation.id,
    });
    expect(row?.state).toBe("indexing");
  });

  it("completes an indexing operation once Photon reports it", async () => {
    const gateway = ringsGateway({ indexingDelayMs: 0 });
    const operation = await serviceWith(gateway).prepareOperation(
      {
        walletId,
        opType: "shield",
        asset: { mint: "So11111111111111111111111111111111111111112", amountRaw: "1000" },
        clientNonce: "job-complete",
      },
      { apiKeyId: null, actor: null, custodyWalletId: null }
    );
    expect(operation.state).toBe("indexing");
    gateway.recordSubmission(OUTER_TX.signature);

    await pollRingsIndexing(jobEnv, {
      createService: () => serviceWith(gateway),
      readBlockHeight: NO_HEIGHT,
    });

    const row = await createHeliusRingsOperationRepository(env).getOperationById({
      ...tenant,
      id: operation.id,
    });
    expect(row?.state).toBe("completed");
  });

  it("times out an operation stuck in indexing past the budget", async () => {
    const gateway = ringsGateway({ indexingDelayMs: 60 * 60 * 1000 });
    const operation = await serviceWith(gateway).prepareOperation(
      {
        walletId,
        opType: "shield",
        asset: { mint: "So11111111111111111111111111111111111111112", amountRaw: "1000" },
        clientNonce: "job-timeout",
      },
      { apiKeyId: null, actor: null, custodyWalletId: null }
    );
    expect(operation.state).toBe("indexing");

    // Sweep from a clock beyond the budget, with the chain height unavailable
    // so the reconciliation pass is skipped and this backstop is what runs.
    await pollRingsIndexing(jobEnv, {
      createService: () => serviceWith(gateway),
      now: () => new Date(Date.now() + RINGS_INDEXING_TIMEOUT_MS + 60_000),
      readBlockHeight: NO_HEIGHT,
    });

    const row = await createHeliusRingsOperationRepository(env).getOperationById({
      ...tenant,
      id: operation.id,
    });
    // Failed rather than left in limbo, but not retryable: nothing here
    // confirmed whether the signed bytes landed, and inviting another attempt
    // is how the same deposit gets made twice.
    expect(row?.state).toBe("failed");
    expect(row?.failure_code).toBe("manual_reconciliation_required");
    expect(row?.retryable).toBe(false);
  });

  it("sweeps a broadcast stranded in submitted into reconciliation", async () => {
    const gateway = ringsGateway({ indexingDelayMs: 0 });
    const operation = await serviceWith(gateway).prepareOperation(
      {
        walletId,
        opType: "shield",
        asset: { mint: "So11111111111111111111111111111111111111112", amountRaw: "1000" },
        clientNonce: "job-stranded",
      },
      { apiKeyId: null, actor: null, custodyWalletId: null }
    );
    expect(operation.state).toBe("indexing");
    gateway.recordSubmission(OUTER_TX.signature);

    // Exactly the row a process that died between the RPC broadcast and the
    // submitted → indexing commit leaves behind. Before the sweep covered
    // `submitted`, nothing in the system would ever look at this row again.
    await getDb(env)
      .prepare("UPDATE helius_rings_operations SET state = 'submitted' WHERE id = ?")
      .bind(operation.id)
      .run();

    await pollRingsIndexing(jobEnv, {
      createService: () => serviceWith(gateway),
      readBlockHeight: NO_HEIGHT,
    });

    const row = await createHeliusRingsOperationRepository(env).getOperationById({
      ...tenant,
      id: operation.id,
    });
    expect(row?.state).toBe("completed");
  });

  /**
   * What happens once signed bytes can no longer land. The distinction is not
   * how long it waited but what it consumed: a shield created notes and can be
   * re-attempted, a spend consumed them and might already have settled.
   */
  describe("reconciliation sweep", () => {
    /** Never reports indexed, so nothing completes out from under the sweep. */
    const stalled = () => ringsGateway({ indexingDelayMs: 60 * 60 * 1000 });

    async function strand(opType: "shield" | "withdraw", nonce: string): Promise<string> {
      const gateway = stalled();
      const operation = await serviceWith(gateway).prepareOperation(
        {
          walletId,
          opType,
          asset: { mint: "So11111111111111111111111111111111111111112", amountRaw: "1000" },
          ...(opType === "withdraw" ? { to: OWNER } : {}),
          clientNonce: nonce,
        },
        { apiKeyId: null, actor: null, custodyWalletId: null }
      );

      // The pipeline persists the expiry from the build; force it low so the
      // sweep sees bytes that can no longer land.
      await getDb(env)
        .prepare("UPDATE helius_rings_operations SET last_valid_block_height = 10 WHERE id = ?")
        .bind(operation.id)
        .run();

      return operation.id;
    }

    it("refuses to offer a retry for a stranded spend", async () => {
      const id = await strand("withdraw", "job-strand-spend");

      await pollRingsIndexing(jobEnv, {
        createService: () => serviceWith(stalled()),
        readBlockHeight: async () => "5000",
      });

      const row = await createHeliusRingsOperationRepository(env).getOperationById({
        ...tenant,
        id,
      });
      // A withdrawal consumed notes. If it landed, retrying pays twice; if it
      // did not, the notes are still there. Only a human can tell which.
      expect(row?.failure_code).toBe("manual_reconciliation_required");
      expect(row?.retryable).toBe(false);
    });

    it("refuses to offer a retry for a stranded shield either", async () => {
      const id = await strand("shield", "job-strand-shield");

      await pollRingsIndexing(jobEnv, {
        createService: () => serviceWith(stalled()),
        readBlockHeight: async () => "5000",
      });

      const row = await createHeliusRingsOperationRepository(env).getOperationById({
        ...tenant,
        id,
      });
      // A deposit cannot spend a note twice, but it can execute twice, and the
      // owner who asked to shield one amount would have moved two.
      expect(row?.failure_code).toBe("manual_reconciliation_required");
      expect(row?.retryable).toBe(false);
    });

    it("completes a signed failure once Photon holds it", async () => {
      const id = await strand("withdraw", "job-failed-indexed");
      await createHeliusRingsOperationRepository(env).failOperation({
        ...tenant,
        id,
        expectedState: "indexing",
        code: "submit_failed",
        message: "rpc timed out",
        retryable: true,
      });

      const gateway = ringsGateway();
      gateway.recordSubmission(OUTER_TX.signature);

      await pollRingsIndexing(jobEnv, {
        createService: () => serviceWith(gateway),
        readBlockHeight: NO_HEIGHT,
      });

      const row = await createHeliusRingsOperationRepository(env).getOperationById({
        ...tenant,
        id,
      });
      // Nothing else would ever look at this row again: `failed` is not
      // in-flight work, so it would hold the wallet forever over a payment that
      // actually succeeded.
      expect(row?.state).toBe("completed");
      expect(row?.failure_code).toBeNull();
    });

    it("never voids from the poll", async () => {
      const id = await strand("withdraw", "job-failed-absent");
      await createHeliusRingsOperationRepository(env).failOperation({
        ...tenant,
        id,
        expectedState: "indexing",
        code: "submit_failed",
        message: "rpc timed out",
        retryable: true,
      });

      // A gateway that reports nothing indexed. Absence from an indexer is
      // never proof a transaction is dead, so this pass must leave it alone
      // and wait for an operator to check the chain.
      await pollRingsIndexing(jobEnv, {
        createService: () => serviceWith(stalled()),
        readBlockHeight: NO_HEIGHT,
      });

      const row = await createHeliusRingsOperationRepository(env).getOperationById({
        ...tenant,
        id,
      });
      expect(row?.state).toBe("failed");
    });

    it("escalates a stuck signed failure once its blockhash has expired", async () => {
      const id = await strand("withdraw", "job-failed-escalate");
      await createHeliusRingsOperationRepository(env).failOperation({
        ...tenant,
        id,
        expectedState: "indexing",
        code: "submit_failed",
        message: "Transaction simulation failed: InsufficientFundsForRent",
        retryable: false,
      });

      // Bytes still exist and the failure code is not yet reconcilable, so
      // the row holds the wallet's slot forever. The reconcile pass upgrades
      // it to manual_reconciliation_required so an operator can void.
      await pollRingsIndexing(jobEnv, {
        createService: () => serviceWith(stalled()),
        readBlockHeight: async () => "5000",
      });

      const row = await createHeliusRingsOperationRepository(env).getOperationById({
        ...tenant,
        id,
      });
      expect(row?.state).toBe("failed");
      expect(row?.failure_code).toBe("manual_reconciliation_required");
      expect(row?.retryable).toBe(false);
      expect(row?.signed_transaction).not.toBeNull();
    });

    it("leaves a signed failure alone until its blockhash has passed", async () => {
      const id = await strand("withdraw", "job-failed-not-expired");
      await createHeliusRingsOperationRepository(env).failOperation({
        ...tenant,
        id,
        expectedState: "indexing",
        code: "submit_failed",
        message: "Transaction simulation failed",
        retryable: false,
      });
      // Keep the blockhash alive against the sweep's view of the chain.
      await getDb(env)
        .prepare("UPDATE helius_rings_operations SET last_valid_block_height = 999999 WHERE id = ?")
        .bind(id)
        .run();

      await pollRingsIndexing(jobEnv, {
        createService: () => serviceWith(stalled()),
        readBlockHeight: async () => "5000",
      });

      const row = await createHeliusRingsOperationRepository(env).getOperationById({
        ...tenant,
        id,
      });
      // Blockhash still alive: the tx might yet land, so escalation is unsafe.
      expect(row?.failure_code).toBe("submit_failed");
    });

    /**
     * A crash inside the pipeline leaves an operation holding its wallet's
     * slot, in a state retry refuses for not being `failed`. Without the sweep
     * reaching these, the wallet is stuck for good.
     */
    describe("resuming a crashed pipeline", () => {
      async function strandIn(
        state: "proving" | "ready_to_sign",
        nonce: string,
        keepBytes: boolean
      ) {
        const gateway = ringsGateway({ indexingDelayMs: 0 });
        const operation = await serviceWith(gateway).prepareOperation(
          {
            walletId,
            opType: "shield",
            asset: { mint: "So11111111111111111111111111111111111111112", amountRaw: "1000" },
            clientNonce: nonce,
          },
          { apiKeyId: null, actor: null, custodyWalletId: null }
        );

        await getDb(env)
          .prepare(
            `UPDATE helius_rings_operations
                SET state = ?,
                    signed_transaction = CASE WHEN ? THEN signed_transaction ELSE NULL END,
                    last_valid_block_height = CASE WHEN ? THEN last_valid_block_height ELSE NULL END,
                    submission_started_at = NULL
              WHERE id = ?`
          )
          .bind(state, keepBytes, keepBytes, operation.id)
          .run();

        return { id: operation.id, gateway };
      }

      it("broadcasts the recorded bytes for an operation stranded after signing", async () => {
        const { id, gateway } = await strandIn("ready_to_sign", "job-strand-signed", true);

        await pollRingsIndexing(jobEnv, {
          createService: () => serviceWith(gateway),
          readBlockHeight: NO_HEIGHT,
        });

        const row = await createHeliusRingsOperationRepository(env).getOperationById({
          ...tenant,
          id,
        });
        // Those exact bytes, never a rebuild: they may already be in the
        // mempool, and a second build could differ.
        expect(row?.state).not.toBe("ready_to_sign");
      });

      it("fails an operation stranded before signing, so it can be retried", async () => {
        const { id, gateway } = await strandIn("ready_to_sign", "job-strand-unsigned", false);

        await pollRingsIndexing(jobEnv, {
          createService: () => serviceWith(gateway),
          // Past the grace: without bytes, a crashed owner and one still
          // waiting on custody look identical until the row stops being fresh.
          now: () => new Date(Date.now() + RINGS_UNSIGNED_GRACE_MS + 1_000),
          readBlockHeight: NO_HEIGHT,
        });

        const row = await createHeliusRingsOperationRepository(env).getOperationById({
          ...tenant,
          id,
        });
        // No bytes means nothing reached the chain, so a retry is safe and the
        // failure must say so rather than leaving the wallet held.
        expect(row?.state).toBe("failed");
        expect(row?.retryable).toBe(true);
      });

      /**
       * The sweep runs every minute and the pipeline signs inline, so a tick
       * regularly lands while a request is between its proof and its bytes.
       * Treating that as a crash failed live withdrawals with "signing did not
       * complete" while custody was still holding the request.
       */
      it("leaves an unsigned operation alone while its owner may still be working", async () => {
        const { id, gateway } = await strandIn("ready_to_sign", "job-strand-fresh", false);

        await pollRingsIndexing(jobEnv, {
          createService: () => serviceWith(gateway),
          readBlockHeight: NO_HEIGHT,
        });

        const row = await createHeliusRingsOperationRepository(env).getOperationById({
          ...tenant,
          id,
        });
        expect(row?.state).toBe("ready_to_sign");
        expect(row?.failure_code).toBeNull();
      });

      it("resumes the build for an operation stranded while proving", async () => {
        const { id, gateway } = await strandIn("proving", "job-strand-proving", false);

        await pollRingsIndexing(jobEnv, {
          createService: () => serviceWith(gateway),
          // Past the grace, so this is a crashed build rather than one the
          // owning request is still running.
          now: () => new Date(Date.now() + RINGS_UNSIGNED_GRACE_MS + 1_000),
          readBlockHeight: NO_HEIGHT,
        });

        const row = await createHeliusRingsOperationRepository(env).getOperationById({
          ...tenant,
          id,
        });
        // Nothing was signed, so building again is safe and no human is needed.
        expect(row?.state).not.toBe("proving");
      });
    });

    it("leaves everything alone when the chain height is unknown", async () => {
      const id = await strand("withdraw", "job-strand-unknown");

      await pollRingsIndexing(jobEnv, {
        createService: () => serviceWith(stalled()),
        readBlockHeight: NO_HEIGHT,
      });

      const row = await createHeliusRingsOperationRepository(env).getOperationById({
        ...tenant,
        id,
      });
      // Not knowing the height is a reason to wait, not a reason to escalate.
      expect(row?.state).toBe("indexing");
    });
  });
});
