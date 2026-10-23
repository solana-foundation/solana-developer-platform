import { runInClusterScope } from "@sdp/rpc/scope";
import { NATIVE_ASSET } from "@sdp/solana/asset-ref";
import {
  PAYMENT_REQUEST_TRANSACTION_OUTCOMES,
  type PaymentRequestTransactionOutcome,
} from "@sdp/types/payments";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { getBase58Decoder, type Signature, signature } from "@solana/kit";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import * as repositoryFactory from "@/db/repositories/repository-factory";
import {
  createPaymentRequestsRepository,
  createPaymentsRepository,
  createSystemPaymentRequestsRepository,
} from "@/db/repositories/repository-factory";
import { recordedLegQuote } from "@/db/repositories/token-movement-legs.repository";
import { createTenantScope } from "@/lib/tenant-scope";
import { rootLogger } from "@/runtime/logger";
import { TEST_CUSTODY_PUBLIC_KEY } from "@/test/fixtures/custody";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import {
  installClusterRpcResponder,
  type SignatureStatusesRead,
  type StubSignatureStatus,
  signatureStatusesRead,
  signatureStatusesReplyAt,
} from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { BLANK_MANAGED_POOL_ENV } from "@/test/helpers/managed-pool-env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { nativeQuote, testExpectation } from "@/test/helpers/token-movement";
import { seedTestDatabase } from "@/test/mocks/db";
import { reconcilePaymentRequest } from "./payment-requests";

const TEST_PROJECT_ID = "prj_preq_handler_test";
const TEST_CONFIG_ID = "cust_cfg_preq_handler_test";
const TEST_CUSTODY_WALLET_ID = "cwlt_preq_handler_test";
const TEST_WALLET_ID = "wal_preq_handler_test";
const PAYER = TEST_SOLANA_ADDRESSES.wallet2;

function testSignatureOf(seed: number): Signature {
  return signature(getBase58Decoder().decode(new Uint8Array(64).fill(seed)));
}

const CONFIRMED: StubSignatureStatus = {
  slot: 77,
  confirmations: 5,
  confirmationStatus: "confirmed",
  err: null,
};

async function createRequest(params: { expiresAt: string | null }) {
  return createPaymentRequestsRepository(
    env,
    createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID })
  ).createPaymentRequest({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    custodyWalletId: TEST_CUSTODY_WALLET_ID,
    walletId: TEST_WALLET_ID,
    destinationAddress: TEST_CUSTODY_PUBLIC_KEY,
    token: SOL_MINT,
    amount: "1.5",
    expectation: testExpectation(NATIVE_ASSET, "1.5", 9),
    expiresAt: params.expiresAt,
    createdBy: TEST_USER.id,
  });
}

/**
 * Records a window /pay issued for the request, signed by the sponsor: the
 * claim with its 1.5 SOL credit quote, then the saved signature.
 */
async function issueTransaction(
  request: PaymentRequestRow,
  seed: number,
  options: { lastValidBlockHeight: bigint }
): Promise<Signature> {
  const repository = createSystemPaymentRequestsRepository(env);
  const unsigned = `dW5zaWduZWQ${seed}`;
  expect(
    await repository.claimSponsoredTransactionWindow({
      requestId: request.id,
      account: PAYER,
      unsignedTransaction: unsigned,
      lastValidBlockHeight: options.lastValidBlockHeight,
      currentBlockHeight: options.lastValidBlockHeight * 10n,
      quote: recordedLegQuote(nativeQuote("1.5", "credit")),
    })
  ).toBe(true);
  const issued = testSignatureOf(seed);
  expect(
    await repository.storeSponsoredTransactionSignature({
      requestId: request.id,
      account: PAYER,
      unsignedTransaction: unsigned,
      signedTransaction: `c2lnbmVk${seed}`,
      signature: issued,
    })
  ).toBe(true);
  return issued;
}

/** Moves a window's issue time into the past, so a check may lapse it. */
async function ageTransaction(issued: Signature, issuedAt: string): Promise<void> {
  await getDb(env)
    .prepare("UPDATE payment_request_transactions SET created_at = ? WHERE signature = ?")
    .bind(issuedAt, issued)
    .run();
}

function reconcileOnSandbox(row: PaymentRequestRow, options: { bestEffort: boolean }) {
  return runInClusterScope({ projectId: TEST_PROJECT_ID, environment: "sandbox" }, () =>
    reconcilePaymentRequest(env, row, options)
  );
}

async function listInboundTransfers() {
  const result = await getDb(env)
    .prepare("SELECT * FROM payment_transfers WHERE wallet_id = ?")
    .bind(TEST_WALLET_ID)
    .all<Record<string, unknown>>();
  return result.results;
}

const issuedOutcomeSchema = z.object({
  outcome: z.enum(PAYMENT_REQUEST_TRANSACTION_OUTCOMES),
  landed_slot: z.string().nullable(),
});

async function issuedOutcome(issued: Signature) {
  return issuedOutcomeSchema.parse(
    await getDb(env)
      .prepare("SELECT outcome, landed_slot FROM payment_request_transactions WHERE signature = ?")
      .bind(issued)
      .first()
  );
}

describe("reconcilePaymentRequest (ADR 0012: settlement on the signatures SDP issued)", () => {
  const rpc = installClusterRpcResponder();
  let statusReads: SignatureStatusesRead[];

  /** Answers each signature status read with `verdict`, from a node at `contextSlot`. */
  function answerStatuses(
    verdict: (issued: string) => StubSignatureStatus | null,
    contextSlot = 1
  ) {
    rpc.respond("getSignatureStatuses", (request) => {
      const read = signatureStatusesRead(request);
      statusReads.push(read);
      return signatureStatusesReplyAt(contextSlot, read.signatures.map(verdict));
    });
  }

  function answerChainTip(tip: { blockHeight: number; absoluteSlot: number }) {
    rpc.respond("getEpochInfo", () => ({
      result: {
        absoluteSlot: tip.absoluteSlot,
        blockHeight: tip.blockHeight,
        epoch: 1,
        slotIndex: 1,
        slotsInEpoch: 432_000,
        transactionCount: null,
      },
    }));
  }

  /** The chain reads of the test, past the RPC factory's one-time cluster check. */
  function chainMethods() {
    return rpc.calls.map((call) => call.method).filter((method) => method !== "getGenesisHash");
  }

  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    statusReads = [];
    const db = getDb(env);
    await db.prepare("DELETE FROM payment_requests").run();
    await db.prepare("DELETE FROM payment_transfers").run();
    await db.prepare("DELETE FROM projects").run();

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
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT_ID, production: `${TEST_PROJECT_ID}_production` },
    });
    await db
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted,
            encryption_version, status)
         VALUES (?, ?, ?, 'local', 'test-config', 'sdp-custody-encryption-v1', 'active')`
      )
      .bind(TEST_CONFIG_ID, TEST_ORG.id, TEST_PROJECT_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(TEST_CUSTODY_WALLET_ID, TEST_CONFIG_ID, TEST_WALLET_ID, TEST_CUSTODY_PUBLIC_KEY)
      .run();
  });

  it("settles a request when a transaction SDP issued lands, verified by construction", async () => {
    const request = await createRequest({ expiresAt: null });
    const issued = await issueTransaction(request, 1, { lastValidBlockHeight: 1_000n });
    answerStatuses((candidate) => (candidate === issued ? CONFIRMED : null));

    const settled = await reconcileOnSandbox(request, { bestEffort: false });

    expect(settled.status).toBe("paid");
    const transfers = await listInboundTransfers();
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      id: settled.fulfilled_by_transfer_id,
      direction: "inbound",
      status: "confirmed",
      signature: issued,
      slot: 77,
      amount: "1.5",
      source_address: PAYER,
      custody_wallet_id: TEST_CUSTODY_WALLET_ID,
      counterparty_id: null,
    });
    const leg = await getDb(env)
      .prepare(
        `SELECT basis, quoted_debit, quoted_fee, quoted_credit, verified_by,
                verification_state, verification_reason
           FROM token_movement_legs WHERE payment_transfer_id = ?`
      )
      .bind(settled.fulfilled_by_transfer_id)
      .first();
    expect(leg).toEqual({
      basis: "credit",
      quoted_debit: "1500000000",
      quoted_fee: "0",
      quoted_credit: "1500000000",
      verified_by: "construction",
      verification_state: "verified",
      verification_reason: "sdp_built_transfer_landed",
    });
    expect(await issuedOutcome(issued)).toEqual({ outcome: "landed", landed_slot: "77" });
    // One status read of the issued signatures, from history: no reference search and no
    // `getTransaction`.
    expect(chainMethods()).toEqual(["getSignatureStatuses"]);
    expect(statusReads).toEqual([
      { cluster: "devnet", signatures: [issued], searchTransactionHistory: true },
    ]);
  });

  it("reads nothing and settles nothing for a request SDP issued no transaction for (SOLA9-699)", async () => {
    // A transfer anyone sends with the request's reference is not a transaction SDP issued.
    const request = await createRequest({ expiresAt: null });

    const result = await reconcileOnSandbox(request, { bestEffort: false });

    expect(result.status).toBe("awaiting_payment");
    expect(chainMethods()).toEqual([]);
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("converges concurrent reconciles of the same request to a single settlement", async () => {
    const request = await createRequest({ expiresAt: null });
    const issued = await issueTransaction(request, 1, { lastValidBlockHeight: 1_000n });
    answerStatuses((candidate) => (candidate === issued ? CONFIRMED : null));

    const [a, b] = await Promise.all([
      reconcileOnSandbox(request, { bestEffort: false }),
      reconcileOnSandbox(request, { bestEffort: false }),
    ]);

    expect(a.status).toBe("paid");
    expect(b.status).toBe("paid");
    expect(await listInboundTransfers()).toHaveLength(1);
  });

  it("answers the settled request to a reconcile that read it before another settled it", async () => {
    const request = await createRequest({ expiresAt: null });
    const issued = await issueTransaction(request, 1, { lastValidBlockHeight: 1_000n });
    answerStatuses((candidate) => (candidate === issued ? CONFIRMED : null));
    expect((await reconcileOnSandbox(request, { bestEffort: false })).status).toBe("paid");

    // The stale row still says awaiting_payment; its windows are closed now.
    const late = await reconcileOnSandbox(request, { bestEffort: false });

    expect(late.status).toBe("paid");
    expect(await listInboundTransfers()).toHaveLength(1);
  });

  it("does not link a request to a conflicting transfer with the same signature", async () => {
    const request = await createRequest({ expiresAt: null });
    const issued = await issueTransaction(request, 1, { lastValidBlockHeight: 1_000n });
    const transfer = await createPaymentsRepository(
      env,
      createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID })
    ).createTransfer({
      id: "xfr_conflicting_signature",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: TEST_WALLET_ID,
      counterpartyId: null,
      sourceAddress: null,
      destinationAddress: TEST_CUSTODY_PUBLIC_KEY,
      token: SOL_MINT,
      amount: "1.5",
      memo: null,
      type: "transfer",
      direction: "inbound",
      status: "confirmed",
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: {},
      serializedTx: null,
      signature: issued,
      slot: 1,
      initiatedByKeyId: null,
    });
    if (!transfer) throw new Error("Expected conflicting transfer fixture creation to succeed");
    await getDb(env)
      .prepare("UPDATE payment_transfers SET custody_wallet_id = NULL WHERE id = ?")
      .bind(transfer.id)
      .run();
    answerStatuses(() => CONFIRMED);

    await expect(reconcileOnSandbox(request, { bestEffort: false })).rejects.toThrow(
      "does not match payment request"
    );
    expect(await listInboundTransfers()).toMatchObject([{ custody_wallet_id: null }]);
  });

  it("does not settle while the issued transaction is processed only", async () => {
    const request = await createRequest({ expiresAt: null });
    const issued = await issueTransaction(request, 1, { lastValidBlockHeight: 1_000n });
    answerStatuses(() => ({ ...CONFIRMED, confirmationStatus: "processed" }));

    const result = await reconcileOnSandbox(request, { bestEffort: false });

    expect(result.status).toBe("awaiting_payment");
    expect(await issuedOutcome(issued)).toEqual({ outcome: "open", landed_slot: null });
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("keeps a window open on a processed failure, which its fork can still undo, and settles it once confirmed", async () => {
    const request = await createRequest({ expiresAt: null });
    const issued = await issueTransaction(request, 1, { lastValidBlockHeight: 1_000n });
    answerStatuses(() => ({
      ...CONFIRMED,
      confirmationStatus: "processed",
      err: { InstructionError: [0, "Custom"] },
    }));

    const pending = await reconcileOnSandbox(request, { bestEffort: false });

    expect(pending.status).toBe("awaiting_payment");
    expect(await issuedOutcome(issued)).toEqual({ outcome: "open", landed_slot: null });

    answerStatuses(() => CONFIRMED);
    const paid = await reconcileOnSandbox(pending, { bestEffort: false });

    expect(paid.status).toBe("paid");
    expect(await listInboundTransfers()).toHaveLength(1);
  });

  it("closes a window whose transaction landed with an error, and settles nothing", async () => {
    const request = await createRequest({ expiresAt: null });
    const issued = await issueTransaction(request, 1, { lastValidBlockHeight: 1_000n });
    answerStatuses(() => ({ ...CONFIRMED, err: { InstructionError: [0, "Custom"] } }));

    const result = await reconcileOnSandbox(request, { bestEffort: false });

    expect(result.status).toBe("awaiting_payment");
    expect(await issuedOutcome(issued)).toEqual({ outcome: "failed", landed_slot: "77" });
    expect(await listInboundTransfers()).toHaveLength(0);

    await reconcileOnSandbox(result, { bestEffort: false });
    expect(statusReads).toHaveLength(1);
  });

  it("lapses an old window past its blockhash's expiry, and keeps it open while the status node lags", async () => {
    const request = await createRequest({ expiresAt: null });
    const issued = await issueTransaction(request, 1, { lastValidBlockHeight: 1_000n });
    await ageTransaction(issued, new Date(Date.now() - 5 * 60_000).toISOString());
    answerChainTip({ blockHeight: 1_001, absoluteSlot: 5_000 });

    answerStatuses(() => null, 4_999);
    await reconcileOnSandbox(request, { bestEffort: false });
    expect(await issuedOutcome(issued)).toEqual({ outcome: "open", landed_slot: null });
    // The tip is read before the statuses, so nothing can land after the status read.
    expect(chainMethods()).toEqual(["getEpochInfo", "getSignatureStatuses"]);

    answerStatuses(() => null, 5_000);
    await reconcileOnSandbox(request, { bestEffort: false });
    expect(await issuedOutcome(issued)).toEqual({ outcome: "lapsed", landed_slot: null });
  });

  it("keeps a window open while its blockhash may still land", async () => {
    const request = await createRequest({ expiresAt: null });
    const issued = await issueTransaction(request, 1, { lastValidBlockHeight: 1_000n });
    await ageTransaction(issued, new Date(Date.now() - 5 * 60_000).toISOString());
    answerChainTip({ blockHeight: 1_000, absoluteSlot: 5_000 });
    answerStatuses(() => null, 9_999);

    await reconcileOnSandbox(request, { bestEffort: false });

    expect(await issuedOutcome(issued)).toEqual({ outcome: "open", landed_slot: null });
  });

  it("checks every open window, not only the request's current claim", async () => {
    const request = await createRequest({ expiresAt: null });
    const first = await issueTransaction(request, 1, { lastValidBlockHeight: 1_000n });
    // Two signed windows are open at once only when a claim raced the
    // signature store of a window whose blockhash had already expired: the
    // first is closed for the second claim, then opened again.
    const setOutcome = (outcome: PaymentRequestTransactionOutcome) =>
      getDb(env)
        .prepare("UPDATE payment_request_transactions SET outcome = ? WHERE signature = ?")
        .bind(outcome, first)
        .run();
    await setOutcome("lapsed");
    const second = await issueTransaction(request, 2, { lastValidBlockHeight: 2_000n });
    await setOutcome("open");
    answerStatuses((candidate) => (candidate === first ? CONFIRMED : null));

    const settled = await reconcileOnSandbox(request, { bestEffort: false });

    expect(settled.status).toBe("paid");
    expect(statusReads[0]?.signatures).toEqual([first, second]);
    expect((await listInboundTransfers())[0]).toMatchObject({ signature: first });
  });

  it("settles an expired request whose transaction was issued, and landed, before it expired", async () => {
    const request = await createRequest({ expiresAt: null });
    const issued = await issueTransaction(request, 1, { lastValidBlockHeight: 1_000n });
    // Issued two minutes ago, the request expired one minute ago.
    await ageTransaction(issued, new Date(Date.now() - 120_000).toISOString());
    await getDb(env)
      .prepare("UPDATE payment_requests SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 60_000).toISOString(), request.id)
      .run();
    answerChainTip({ blockHeight: 2_000, absoluteSlot: 5_000 });
    answerStatuses(() => CONFIRMED, 5_000);

    const settled = await reconcileOnSandbox(request, { bestEffort: false });

    expect(settled.status).toBe("paid");
  });

  it("reads nothing for an expired request with no open window", async () => {
    const expired = await createRequest({ expiresAt: "2000-01-01T00:00:00.000Z" });

    const result = await reconcileOnSandbox(expired, { bestEffort: false });

    expect(result.status).toBe("awaiting_payment");
    expect(chainMethods()).toEqual([]);
  });

  it("rethrows unexpected errors instead of swallowing them", async () => {
    const request = await createRequest({ expiresAt: null });
    await issueTransaction(request, 1, { lastValidBlockHeight: 1_000n });
    rpc.respond("getSignatureStatuses", () => ({
      error: { code: -32_603, message: "rpc exploded" },
    }));

    await expect(reconcileOnSandbox(request, { bestEffort: false })).rejects.toThrow();
  });

  it("best-effort returns the stored row and logs when reconcile errors unexpectedly", async () => {
    const errorSpy = vi.spyOn(rootLogger, "error").mockImplementation(() => {});
    const request = await createRequest({ expiresAt: null });
    await issueTransaction(request, 1, { lastValidBlockHeight: 1_000n });
    rpc.respond("getSignatureStatuses", () => ({
      error: { code: -32_603, message: "rpc exploded" },
    }));

    const result = await reconcileOnSandbox(request, { bestEffort: true });

    expect(result).toBe(request);
    expect(errorSpy).toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("answers a best-effort read with no window from the row it read, reading it no second time", async () => {
    const request = await createRequest({ expiresAt: null });
    const factory = repositoryFactory.createPaymentRequestsRepository;
    const reread = vi.fn(() => Promise.reject(new Error("connection lost")));
    vi.spyOn(repositoryFactory, "createPaymentRequestsRepository").mockImplementation(
      (...args) => ({ ...factory(...args), getPaymentRequestById: reread })
    );

    const result = await reconcileOnSandbox(request, { bestEffort: true });

    expect(result).toBe(request);
    expect(reread).not.toHaveBeenCalled();
    // A path that acts on the status reads the current row, and fails with it.
    await expect(reconcileOnSandbox(request, { bestEffort: false })).rejects.toThrow(
      "connection lost"
    );
  });

  it("best-effort rethrows RPC_NOT_CONFIGURED instead of degrading to the stored row", async () => {
    const errorSpy = vi.spyOn(rootLogger, "error").mockImplementation(() => {});
    const request = await createRequest({ expiresAt: null });
    await issueTransaction(request, 1, { lastValidBlockHeight: 1_000n });
    for (const [envKey, blankValue] of Object.entries(BLANK_MANAGED_POOL_ENV)) {
      vi.stubEnv(envKey, blankValue);
    }

    await expect(reconcileOnSandbox(request, { bestEffort: true })).rejects.toMatchObject({
      name: "SdpRpcError",
      code: "RPC_NOT_CONFIGURED",
      details: { cluster: "devnet" },
    });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("returns an unresolved legacy request on best-effort reads without touching the chain", async () => {
    const request: PaymentRequestRow = {
      ...(await createRequest({ expiresAt: null })),
      custody_wallet_id: null,
    };

    const result = await reconcileOnSandbox(request, { bestEffort: true });

    expect(result).toBe(request);
    expect(chainMethods()).toEqual([]);
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("rejects an unresolved legacy request when current state is required", async () => {
    const request: PaymentRequestRow = {
      ...(await createRequest({ expiresAt: null })),
      custody_wallet_id: null,
    };

    await expect(reconcileOnSandbox(request, { bestEffort: false })).rejects.toMatchObject({
      code: "CONFLICT",
      statusCode: 409,
    });
    expect(chainMethods()).toEqual([]);
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("short-circuits non-awaiting requests without touching the chain", async () => {
    const canceled: PaymentRequestRow = {
      ...(await createRequest({ expiresAt: null })),
      status: "canceled",
    };

    const result = await reconcileOnSandbox(canceled, { bestEffort: false });

    expect(result).toBe(canceled);
    expect(chainMethods()).toEqual([]);
  });
});
