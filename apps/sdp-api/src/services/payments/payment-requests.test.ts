import { runInClusterScope } from "@sdp/rpc/scope";
import * as solanaRpc from "@sdp/rpc/solana";
import * as verifiedConfirmation from "@sdp/rpc/verified-confirmation";
import { SOL_MINT, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import {
  address,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  lamports,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signature,
  type UnixTimestamp,
  unixTimestamp,
} from "@solana/kit";
import * as solanaPay from "@solana/pay";
import { ValidateTransferError } from "@solana/pay";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { getDb } from "@/db/client";
import type {
  PaymentRequestRow,
  SignatureScanPosition,
} from "@/db/repositories/payment-requests.repository";
import * as repositoryFactory from "@/db/repositories/repository-factory";
import {
  createPaymentRequestsRepository,
  createPaymentsRepository,
} from "@/db/repositories/repository-factory";
import { createTenantScope } from "@/lib/tenant-scope";
import * as moneyPathEvents from "@/runtime/money-path-events";
import { TEST_CUSTODY_PUBLIC_KEY } from "@/test/fixtures/custody";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { seedProjectCryptoWalletCounterparty } from "@/test/helpers/counterparties";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  checkAwaitingPaymentRequest,
  checkExpiredPaymentRequestForLatePayment,
  closeLapsedPaymentRequest,
  reconcilePaymentRequest,
} from "./payment-requests";

const TEST_PROJECT_ID = "prj_preq_handler_test";
const TEST_CONFIG_ID = "cust_cfg_preq_handler_test";
const TEST_CUSTODY_WALLET_ID = "cwlt_preq_handler_test";
const TEST_WALLET_ID = "wal_preq_handler_test";
const SIGNATURE = signature(getBase58Decoder().decode(new Uint8Array(64).fill(5)));
const LATER_SIGNATURE = signature(getBase58Decoder().decode(new Uint8Array(64).fill(6)));
const FAILED_SIGNATURE = signature(getBase58Decoder().decode(new Uint8Array(64).fill(4)));
const DEVNET_USDC_MINT = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;
const PAST = "2020-01-01T00:00:00.000Z";
const PAST_SECONDS = BigInt(Date.parse(PAST) / 1000);

let signaturesSpy: MockInstance<typeof solanaRpc.getSignaturesForAddress>;
let validateTransferSpy: MockInstance<typeof solanaPay.validateTransfer>;
let verifyTransactionLandedSpy: MockInstance<typeof verifiedConfirmation.verifyTransactionLanded>;

function verifiedOk(): Awaited<ReturnType<typeof verifiedConfirmation.verifyTransactionLanded>> {
  return {
    ok: true,
    status: { slot: 1n, confirmations: null, confirmationStatus: "finalized", err: null },
    transaction: { slot: 1n, executionResultKnown: true, err: null, instructions: [] },
  };
}

function verifiedConfirmedOnly(): Awaited<
  ReturnType<typeof verifiedConfirmation.verifyTransactionLanded>
> {
  const verified = verifiedOk();
  return verified.ok
    ? { ...verified, status: { ...verified.status, confirmationStatus: "confirmed" } }
    : verified;
}

function signatureInfo(
  sig: Signature,
  overrides: Partial<solanaRpc.SignatureInfo> = {}
): solanaRpc.SignatureInfo {
  return {
    signature: sig,
    slot: 1n,
    blockTime: null,
    err: null,
    confirmationStatus: "confirmed",
    ...overrides,
  };
}

function mockSignatures(...newestFirst: solanaRpc.SignatureInfo[]) {
  signaturesSpy.mockResolvedValue(newestFirst);
}

function mockNoSignatures() {
  signaturesSpy.mockResolvedValue([]);
}

function validatedTransfer(
  blockTime: UnixTimestamp | null = null
): Awaited<ReturnType<typeof solanaPay.validateTransfer>> {
  const transaction = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayer(address(TEST_CUSTODY_PUBLIC_KEY), message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash(getBase58Decoder().decode(new Uint8Array(32).fill(7))),
            lastValidBlockHeight: 1n,
          },
          message
        )
    )
  );
  return {
    slot: 1n,
    blockTime,
    version: 0,
    meta: {
      err: null,
      fee: lamports(5_000n),
      logMessages: [],
      preBalances: [],
      postBalances: [],
      rewards: [],
      status: { Ok: null },
      loadedAddresses: { readonly: [], writable: [] },
    },
    transaction: [getBase64EncodedWireTransaction(transaction), "base64"],
  };
}

function mockSettlementSucceeds(blockTime: bigint | null = null) {
  mockSignatures(signatureInfo(SIGNATURE, { blockTime }));
  verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
  validateTransferSpy.mockResolvedValue(validatedTransfer());
}

async function createRequest(params: { token: string; expiresAt: string | null }) {
  return createPaymentRequestsRepository(
    env,
    createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID })
  ).createPaymentRequest({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    custodyWalletId: TEST_CUSTODY_WALLET_ID,
    walletId: TEST_WALLET_ID,
    destinationAddress: TEST_CUSTODY_PUBLIC_KEY,
    token: params.token,
    amount: "1.5",
    expiresAt: params.expiresAt,
    createdBy: TEST_USER.id,
  });
}

function onSandbox<T>(fn: () => Promise<T>) {
  return runInClusterScope({ projectId: TEST_PROJECT_ID, environment: "sandbox" }, fn);
}

function reconcileOnSandbox(row: PaymentRequestRow, setRetryAfter = (_seconds: number) => {}) {
  return onSandbox(() => reconcilePaymentRequest(env, row, setRetryAfter));
}

function checkOnSandbox(row: PaymentRequestRow) {
  return onSandbox(() => checkAwaitingPaymentRequest(env, row));
}

async function listInboundTransfers() {
  const result = await getDb(env)
    .prepare("SELECT * FROM payment_transfers WHERE wallet_id = ?")
    .bind(TEST_WALLET_ID)
    .all<Record<string, unknown>>();
  return result.results;
}

function installSettlementHooks() {
  installClusterRpcStub();

  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    signaturesSpy = vi.spyOn(solanaRpc, "getSignaturesForAddress");
    validateTransferSpy = vi.spyOn(solanaPay, "validateTransfer");
    verifyTransactionLandedSpy = vi.spyOn(verifiedConfirmation, "verifyTransactionLanded");

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
}

describe("reconcilePaymentRequest", () => {
  installSettlementHooks();

  it("settles an awaiting request and links an inbound transfer attributed to no counterparty", async () => {
    mockSettlementSucceeds();
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    await seedProjectCryptoWalletCounterparty(getDb(env), {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      createdBy: TEST_USER.id,
      counterpartyId: "cp_preq_handler_legacy_payer",
      counterpartyAccountId: "cpa_preq_handler_legacy_payer",
      walletAddress: TEST_SOLANA_ADDRESSES.wallet1,
    });
    await getDb(env)
      .prepare("UPDATE payment_requests SET counterparty_id = ? WHERE id = ?")
      .bind("cp_preq_handler_legacy_payer", request.id)
      .run();

    const settled = await reconcileOnSandbox(request);

    expect(settled.status).toBe("paid");
    expect(settled.fulfilled_by_transfer_id).not.toBeNull();

    const transfers = await listInboundTransfers();
    expect(transfers).toHaveLength(1);
    expect(transfers[0].id).toBe(settled.fulfilled_by_transfer_id);
    expect(transfers[0].direction).toBe("inbound");
    expect(transfers[0].status).toBe("finalized");
    expect(transfers[0].signature).toBe(SIGNATURE);
    expect(transfers[0].custody_wallet_id).toBe(TEST_CUSTODY_WALLET_ID);
    expect(transfers[0].counterparty_id).toBeNull();
  });

  it("settles an SPL request, exercising the splToken branch", async () => {
    mockSettlementSucceeds();

    const settled = await reconcileOnSandbox(
      await createRequest({ token: DEVNET_USDC_MINT, expiresAt: null })
    );

    expect(settled.status).toBe("paid");
    const fields = validateTransferSpy.mock.calls[0][2];
    expect(fields.splToken).toBe(DEVNET_USDC_MINT);
  });

  it("checks a SOL request as a native transfer with no SPL token", async () => {
    mockSettlementSucceeds();

    const settled = await reconcileOnSandbox(
      await createRequest({ token: SOL_MINT, expiresAt: null })
    );

    expect(settled.status).toBe("paid");
    expect(validateTransferSpy.mock.calls[0][2].splToken).toBeUndefined();
  });

  it("converges concurrent reconciles of the same request to a single settlement", async () => {
    mockSettlementSucceeds();
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });

    const [a, b] = await Promise.all([reconcileOnSandbox(request), reconcileOnSandbox(request)]);

    expect(a.status).toBe("paid");
    expect(b.status).toBe("paid");
    expect(await listInboundTransfers()).toHaveLength(1);
  });

  it("does not link a request to a conflicting transfer with the same signature", async () => {
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
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
      signature: SIGNATURE,
      slot: 1,
      initiatedByKeyId: null,
    });
    if (!transfer) throw new Error("Expected conflicting transfer fixture creation to succeed");
    await getDb(env)
      .prepare("UPDATE payment_transfers SET custody_wallet_id = NULL WHERE id = ?")
      .bind(transfer.id)
      .run();
    mockSettlementSucceeds();

    await expect(reconcileOnSandbox(request)).rejects.toThrow("does not match payment request");
    expect(await listInboundTransfers()).toMatchObject([{ custody_wallet_id: null }]);
  });

  it.for(["not_confirmed", "not_indexed"] as const)(
    "asks the payer to retry instead of answering payable while a candidate is %s",
    async (reason) => {
      mockSignatures(signatureInfo(SIGNATURE));
      verifyTransactionLandedSpy.mockResolvedValue({ ok: false, reason });
      validateTransferSpy.mockResolvedValue(validatedTransfer());
      const setRetryAfter = vi.fn();
      const request = await createRequest({ token: SOL_MINT, expiresAt: null });

      await expect(reconcileOnSandbox(request, setRetryAfter)).rejects.toMatchObject({
        code: "RATE_LIMITED",
        statusCode: 429,
      });

      expect(setRetryAfter).toHaveBeenCalledWith(expect.any(Number));
      expect(setRetryAfter.mock.calls[0]?.[0]).toBeGreaterThan(0);
      expect(validateTransferSpy).not.toHaveBeenCalled();
      expect(await listInboundTransfers()).toHaveLength(0);
      expect(await readStored(request.id)).toMatchObject({ status: "awaiting_payment" });
    }
  );

  it("asks the payer to retry while the payment is confirmed but not finalized", async () => {
    mockSignatures(signatureInfo(SIGNATURE));
    verifyTransactionLandedSpy.mockResolvedValue(verifiedConfirmedOnly());
    validateTransferSpy.mockResolvedValue(validatedTransfer());
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });

    await expect(reconcileOnSandbox(request)).rejects.toMatchObject({ code: "RATE_LIMITED" });

    expect(validateTransferSpy).not.toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
    expect(await readStored(request.id)).toMatchObject({ status: "awaiting_payment" });
  });

  it("validates the transfer against the finalized transaction", async () => {
    mockSettlementSucceeds();

    await reconcileOnSandbox(await createRequest({ token: SOL_MINT, expiresAt: null }));

    expect(validateTransferSpy.mock.calls[0]?.[3]).toEqual({ commitment: "finalized" });
  });

  it("asks the payer to retry while the verify budget leaves candidates unchecked", async () => {
    mockSignatures(
      ...Array.from({ length: 30 }, (_, index) =>
        signatureInfo(signature(getBase58Decoder().decode(new Uint8Array(64).fill(index + 10))))
      )
    );
    verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
    validateTransferSpy.mockRejectedValue(new ValidateTransferError("wrong amount"));

    await expect(
      reconcileOnSandbox(await createRequest({ token: SOL_MINT, expiresAt: null }))
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("does not settle in a background check while a candidate is not indexed yet", async () => {
    mockSignatures(signatureInfo(SIGNATURE));
    verifyTransactionLandedSpy.mockResolvedValue({ ok: false, reason: "not_indexed" });

    const result = await checkOnSandbox(await createRequest({ token: SOL_MINT, expiresAt: null }));

    expect(result.status).toBe("awaiting_payment");
    expect(validateTransferSpy).not.toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("leaves the request awaiting when no transfer references it", async () => {
    mockNoSignatures();

    const result = await reconcileOnSandbox(
      await createRequest({ token: SOL_MINT, expiresAt: null })
    );

    expect(result.status).toBe("awaiting_payment");
    expect(result.fulfilled_by_transfer_id).toBeNull();
    expect(validateTransferSpy).not.toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("leaves the request awaiting when the referenced transfer is invalid", async () => {
    mockSignatures(signatureInfo(SIGNATURE));
    verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
    validateTransferSpy.mockRejectedValue(new ValidateTransferError("wrong amount"));

    const result = await reconcileOnSandbox(
      await createRequest({ token: SOL_MINT, expiresAt: null })
    );

    expect(result.status).toBe("awaiting_payment");
    expect(result.fulfilled_by_transfer_id).toBeNull();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("rethrows unexpected errors instead of swallowing them", async () => {
    signaturesSpy.mockRejectedValue(new Error("rpc exploded"));

    await expect(
      reconcileOnSandbox(await createRequest({ token: SOL_MINT, expiresAt: null }))
    ).rejects.toThrow("rpc exploded");
  });

  it("rejects an unresolved legacy request when current state is required", async () => {
    const request: PaymentRequestRow = {
      ...(await createRequest({ token: SOL_MINT, expiresAt: null })),
      custody_wallet_id: null,
    };

    await expect(reconcileOnSandbox(request)).rejects.toMatchObject({
      code: "CONFLICT",
      statusCode: 409,
    });
    expect(signaturesSpy).not.toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("short-circuits non-awaiting requests without touching the chain", async () => {
    const canceled: PaymentRequestRow = {
      ...(await createRequest({ token: SOL_MINT, expiresAt: null })),
      status: "canceled",
    };

    const result = await reconcileOnSandbox(canceled);

    expect(result).toBe(canceled);
    expect(signaturesSpy).not.toHaveBeenCalled();
  });

  it("short-circuits expired requests without touching the chain", async () => {
    const expired = await createRequest({ token: SOL_MINT, expiresAt: "2000-01-01T00:00:00.000Z" });

    const result = await reconcileOnSandbox(expired);

    expect(result.status).toBe("awaiting_payment");
    expect(signaturesSpy).not.toHaveBeenCalled();
  });
});

describe("closeLapsedPaymentRequest", () => {
  installSettlementHooks();

  it("stores expired when the final chain check finds nothing", async () => {
    mockNoSignatures();
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const closed = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(closed).toMatchObject({ status: "expired", paid_late: false });
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("settles on time when the payment landed before expires_at", async () => {
    mockSettlementSucceeds(PAST_SECONDS - 10n);
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const closed = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(closed).toMatchObject({ status: "paid", paid_late: false });
  });

  it("settles late when the payment landed after expires_at", async () => {
    mockSettlementSucceeds(PAST_SECONDS + 10n);
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const closed = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(closed).toMatchObject({ status: "paid", paid_late: true });
  });

  it("keeps the request awaiting while the payment is confirmed but not finalized", async () => {
    mockSignatures(signatureInfo(SIGNATURE, { blockTime: PAST_SECONDS - 10n }));
    verifyTransactionLandedSpy.mockResolvedValue(verifiedConfirmedOnly());
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const closed = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(closed).toMatchObject({ status: "awaiting_payment" });
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("judges lateness by the finalized transaction's block time", async () => {
    mockSignatures(signatureInfo(SIGNATURE, { blockTime: PAST_SECONDS + 10n }));
    verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
    validateTransferSpy.mockResolvedValue(validatedTransfer(unixTimestamp(PAST_SECONDS - 10n)));
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const closed = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(closed).toMatchObject({ status: "paid", paid_late: false });
  });

  it("settles late when the chain gives no block time", async () => {
    mockSettlementSucceeds(null);
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const closed = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(closed).toMatchObject({ status: "paid", paid_late: true });
  });

  it("expires an unresolved legacy request without touching the chain", async () => {
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });
    await getDb(env)
      .prepare("UPDATE payment_requests SET custody_wallet_id = NULL WHERE id = ?")
      .bind(request.id)
      .run();

    const closed = await onSandbox(() =>
      closeLapsedPaymentRequest(env, { ...request, custody_wallet_id: null })
    );

    expect(closed.status).toBe("expired");
    expect(signaturesSpy).not.toHaveBeenCalled();
  });

  it("leaves a request another writer already settled", async () => {
    mockSettlementSucceeds();
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    await reconcileOnSandbox(request);

    const closed = await onSandbox(() =>
      closeLapsedPaymentRequest(env, { ...request, expires_at: PAST })
    );

    expect(closed).toMatchObject({ status: "paid", paid_late: false });
    expect(await listInboundTransfers()).toHaveLength(1);
  });

  it("leaves an unexpired request to the awaiting lanes", async () => {
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });

    const closed = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(closed).toBe(request);
    expect(signaturesSpy).not.toHaveBeenCalled();
  });
});

describe("checkExpiredPaymentRequestForLatePayment", () => {
  installSettlementHooks();

  it("moves an expired request to paid late when a payment shows up", async () => {
    mockNoSignatures();
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });
    const expired = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    mockSettlementSucceeds(PAST_SECONDS + 60n);
    const late = await onSandbox(() => checkExpiredPaymentRequestForLatePayment(env, expired));

    expect(late).toMatchObject({ status: "paid", paid_late: true });
    expect(late.fulfilled_by_transfer_id).not.toBeNull();
    expect(await listInboundTransfers()).toHaveLength(1);
  });

  it("keeps an expired request expired while no payment shows up", async () => {
    mockNoSignatures();
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });
    const expired = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    const checked = await onSandbox(() => checkExpiredPaymentRequestForLatePayment(env, expired));

    expect(checked).toMatchObject({ status: "expired", paid_late: false });
    expect(await listInboundTransfers()).toHaveLength(0);
  });
});

describe("checkAwaitingPaymentRequest", () => {
  installSettlementHooks();

  it("settles an unexpired awaiting request", async () => {
    mockSettlementSucceeds();
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });

    const checked = await onSandbox(() => checkAwaitingPaymentRequest(env, request));

    expect(checked).toMatchObject({ status: "paid", paid_late: false });
  });

  it("leaves a lapsed request to the expiry cron", async () => {
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const checked = await onSandbox(() => checkAwaitingPaymentRequest(env, request));

    expect(checked.status).toBe("awaiting_payment");
    expect(signaturesSpy).not.toHaveBeenCalled();
  });

  it("skips an unresolved legacy request without touching the chain", async () => {
    const request: PaymentRequestRow = {
      ...(await createRequest({ token: SOL_MINT, expiresAt: null })),
      custody_wallet_id: null,
    };

    const checked = await onSandbox(() => checkAwaitingPaymentRequest(env, request));

    expect(checked).toBe(request);
    expect(signaturesSpy).not.toHaveBeenCalled();
  });
});

async function listSettlementAudits(requestId: string) {
  const result = await getDb(env)
    .prepare(
      "SELECT organization_id, metadata FROM audit_logs WHERE resource_type = 'payment_request' AND resource_id = ? AND action = 'settle'"
    )
    .bind(requestId)
    .all<{ organization_id: string; metadata: string | Record<string, unknown> }>();
  return result.results.map((row) => ({
    organizationId: row.organization_id,
    metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
  }));
}

describe("settlement audit", () => {
  installSettlementHooks();

  it("records one settle entry for the awaiting to paid transition", async () => {
    mockSettlementSucceeds();
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });

    const settled = await reconcileOnSandbox(request);
    await onSandbox(() => checkAwaitingPaymentRequest(env, request));

    expect(await listSettlementAudits(request.id)).toEqual([
      {
        organizationId: TEST_ORG.id,
        metadata: expect.objectContaining({
          fromStatus: "awaiting_payment",
          paidLate: false,
          transferId: settled.fulfilled_by_transfer_id,
          signature: SIGNATURE,
        }),
      },
    ]);
  });

  it("records the expired to paid conversion as late", async () => {
    mockNoSignatures();
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });
    const expired = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    mockSettlementSucceeds(PAST_SECONDS + 60n);
    await onSandbox(() => checkExpiredPaymentRequestForLatePayment(env, expired));

    expect(await listSettlementAudits(request.id)).toEqual([
      {
        organizationId: TEST_ORG.id,
        metadata: expect.objectContaining({ fromStatus: "expired", paidLate: true }),
      },
    ]);
  });
});

describe("expiry audit", () => {
  installSettlementHooks();

  it("records one update entry when the expiry lane stores expired", async () => {
    mockNoSignatures();
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    await onSandbox(() => closeLapsedPaymentRequest(env, request));
    await onSandbox(() => closeLapsedPaymentRequest(env, request));

    const result = await getDb(env)
      .prepare(
        "SELECT metadata FROM audit_logs WHERE resource_type = 'payment_request' AND resource_id = ? AND action = 'update'"
      )
      .bind(request.id)
      .all<{ metadata: string | Record<string, unknown> }>();
    expect(
      result.results.map((row) =>
        typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata
      )
    ).toEqual([expect.objectContaining({ fromStatus: "awaiting_payment", toStatus: "expired" })]);
  });

  it("records nothing when the request was already settled", async () => {
    mockSettlementSucceeds();
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    await reconcileOnSandbox(request);
    mockNoSignatures();

    await onSandbox(() => closeLapsedPaymentRequest(env, { ...request, expires_at: PAST }));

    const result = await getDb(env)
      .prepare(
        "SELECT id FROM audit_logs WHERE resource_type = 'payment_request' AND resource_id = ? AND action = 'update'"
      )
      .bind(request.id)
      .all<{ id: string }>();
    expect(result.results).toHaveLength(0);
  });
});

async function storeExpired(requestId: string) {
  await getDb(env)
    .prepare("UPDATE payment_requests SET status = 'expired' WHERE id = ?")
    .bind(requestId)
    .run();
}

async function readStored(requestId: string) {
  const row = await createPaymentRequestsRepository(
    env,
    createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID })
  ).getPaymentRequestById({
    requestId,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
  });
  if (row === null) throw new Error(`payment request ${requestId} not found`);
  return row;
}

describe("payment lateness", () => {
  installSettlementHooks();

  it("settles a watched expired request on time when the payment landed before expires_at", async () => {
    mockNoSignatures();
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });
    const expired = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    mockSettlementSucceeds(PAST_SECONDS - 60n);
    const settled = await onSandbox(() => checkExpiredPaymentRequestForLatePayment(env, expired));

    expect(settled).toMatchObject({ status: "paid", paid_late: false });
  });
});

describe("lost race to expiry", () => {
  installSettlementHooks();

  it("settles a request another lane stored expired, on time per block time", async () => {
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });
    await storeExpired(request.id);
    mockSettlementSucceeds(PAST_SECONDS - 10n);

    const settled = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    const transfers = await listInboundTransfers();
    expect(transfers).toHaveLength(1);
    expect(settled).toMatchObject({
      status: "paid",
      paid_late: false,
      fulfilled_by_transfer_id: transfers[0].id,
    });
    expect(await readStored(request.id)).toMatchObject({ status: "paid", paid_late: false });
  });

  it("settles a request another lane stored expired, late per block time", async () => {
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });
    await storeExpired(request.id);
    mockSettlementSucceeds(PAST_SECONDS + 10n);

    const settled = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(settled).toMatchObject({ status: "paid", paid_late: true });
    expect(await readStored(request.id)).toMatchObject({ status: "paid", paid_late: true });
  });

  it("settles a stale awaiting row from the awaiting lanes after it was stored expired", async () => {
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    await storeExpired(request.id);
    mockSettlementSucceeds(null);

    const settled = await onSandbox(() => checkAwaitingPaymentRequest(env, request));

    const transfers = await listInboundTransfers();
    expect(transfers).toHaveLength(1);
    expect(settled).toMatchObject({
      status: "paid",
      paid_late: false,
      fulfilled_by_transfer_id: transfers[0].id,
    });
  });
});

describe("settlement atomicity", () => {
  installSettlementHooks();

  it("records no transfer when the status transition fails", async () => {
    const real = repositoryFactory.createTransactionalPaymentRequestsRepository;
    vi.spyOn(repositoryFactory, "createTransactionalPaymentRequestsRepository").mockImplementation(
      (db, scope) =>
        new Proxy(real(db, scope), {
          get: (target, property, receiver) =>
            property === "markPaymentRequest"
              ? () => Promise.reject(new Error("transition failed"))
              : Reflect.get(target, property, receiver),
        })
    );
    mockSettlementSucceeds();
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });

    await expect(reconcileOnSandbox(request)).rejects.toThrow("transition failed");

    expect(await listInboundTransfers()).toHaveLength(0);
    expect(await readStored(request.id)).toMatchObject({ status: "awaiting_payment" });
  });
});

describe("settlement convergence", () => {
  installSettlementHooks();

  it("converges on a transfer another settlement recorded between lookup and insert", async () => {
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    const recorded = await createPaymentsRepository(
      env,
      createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID })
    ).createTransfer({
      id: "xfr_concurrent_settlement",
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
      signature: SIGNATURE,
      slot: 1,
      initiatedByKeyId: null,
    });
    if (!recorded) throw new Error("Expected concurrent transfer fixture creation to succeed");
    const real = repositoryFactory.createTransactionalPaymentsRepository;
    let lookups = 0;
    vi.spyOn(repositoryFactory, "createTransactionalPaymentsRepository").mockImplementation(
      (db, scope) =>
        new Proxy(real(db, scope), {
          get: (target, property, receiver) =>
            property === "listTransfersBySignatures" && lookups++ === 0
              ? () => Promise.resolve([])
              : Reflect.get(target, property, receiver),
        })
    );
    mockSettlementSucceeds();

    const settled = await reconcileOnSandbox(request);

    expect(settled).toMatchObject({ status: "paid", fulfilled_by_transfer_id: recorded.id });
    expect(await listInboundTransfers()).toHaveLength(1);
  });
});

describe("payment search", () => {
  installSettlementHooks();

  it("asks the reference for confirmed signatures", async () => {
    mockNoSignatures();
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });

    await reconcileOnSandbox(request);

    expect(signaturesSpy).toHaveBeenCalledWith(
      expect.anything(),
      request.reference,
      expect.objectContaining({ commitment: "confirmed" })
    );
  });

  it("verifies candidates against the full signature history", async () => {
    mockSignatures(signatureInfo(SIGNATURE));
    verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
    validateTransferSpy.mockResolvedValue(validatedTransfer());

    await reconcileOnSandbox(await createRequest({ token: SOL_MINT, expiresAt: null }));

    expect(verifyTransactionLandedSpy).toHaveBeenCalledWith(expect.anything(), SIGNATURE, {
      searchTransactionHistory: true,
    });
  });

  it("settles a valid payment that follows a failed transaction on the same reference", async () => {
    mockSignatures(signatureInfo(LATER_SIGNATURE), signatureInfo(FAILED_SIGNATURE, { err: {} }));
    verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
    validateTransferSpy.mockResolvedValue(validatedTransfer());

    const settled = await reconcileOnSandbox(
      await createRequest({ token: SOL_MINT, expiresAt: null })
    );

    expect(settled.status).toBe("paid");
    expect(verifyTransactionLandedSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      FAILED_SIGNATURE,
      expect.anything()
    );
    expect(await listInboundTransfers()).toMatchObject([{ signature: LATER_SIGNATURE }]);
  });

  it("settles on a later signature when the oldest one does not validate", async () => {
    mockSignatures(signatureInfo(LATER_SIGNATURE), signatureInfo(SIGNATURE));
    verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
    validateTransferSpy.mockImplementation(async (_rpc, sig) => {
      if (sig === SIGNATURE) throw new ValidateTransferError("wrong amount");
      return validatedTransfer();
    });

    const settled = await reconcileOnSandbox(
      await createRequest({ token: SOL_MINT, expiresAt: null })
    );

    expect(settled.status).toBe("paid");
    expect(validateTransferSpy.mock.calls.map((call) => call[1])).toEqual([
      SIGNATURE,
      LATER_SIGNATURE,
    ]);
    expect(await listInboundTransfers()).toMatchObject([{ signature: LATER_SIGNATURE }]);
  });

  it("checks a bounded number of candidate signatures", async () => {
    mockSignatures(
      ...Array.from({ length: 30 }, (_, index) =>
        signatureInfo(signature(getBase58Decoder().decode(new Uint8Array(64).fill(index + 10))))
      )
    );
    verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
    validateTransferSpy.mockRejectedValue(new ValidateTransferError("wrong amount"));

    const result = await checkOnSandbox(await createRequest({ token: SOL_MINT, expiresAt: null }));

    expect(result.status).toBe("awaiting_payment");
    expect(validateTransferSpy).toHaveBeenCalledTimes(25);
  });
});

describe("closeLapsedPaymentRequest while a payment is indexing", () => {
  installSettlementHooks();

  it("leaves the request awaiting when a candidate is confirmed but not yet indexed", async () => {
    mockSignatures(signatureInfo(SIGNATURE));
    verifyTransactionLandedSpy.mockResolvedValue({ ok: false, reason: "not_indexed" });
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(result).toMatchObject({ status: "awaiting_payment" });
    expect(await readStored(request.id)).toMatchObject({ status: "awaiting_payment" });
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("leaves the request awaiting when one candidate is indexing and another is invalid", async () => {
    mockSignatures(signatureInfo(LATER_SIGNATURE), signatureInfo(SIGNATURE));
    verifyTransactionLandedSpy.mockImplementation(async (_rpc, sig) =>
      sig === SIGNATURE ? { ok: false, reason: "not_indexed" } : verifiedOk()
    );
    validateTransferSpy.mockRejectedValue(new ValidateTransferError("wrong amount"));
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(result.status).toBe("awaiting_payment");
    expect(await readStored(request.id)).toMatchObject({ status: "awaiting_payment" });
  });

  it("settles a later valid candidate even while an earlier one is indexing", async () => {
    mockSignatures(signatureInfo(LATER_SIGNATURE), signatureInfo(SIGNATURE));
    verifyTransactionLandedSpy.mockImplementation(async (_rpc, sig) =>
      sig === SIGNATURE ? { ok: false, reason: "not_indexed" } : verifiedOk()
    );
    validateTransferSpy.mockResolvedValue(validatedTransfer());
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(result.status).toBe("paid");
    expect(await listInboundTransfers()).toMatchObject([{ signature: LATER_SIGNATURE }]);
  });

  it("leaves the request awaiting when the only candidate is not confirmed by the status node yet", async () => {
    mockSignatures(signatureInfo(SIGNATURE));
    verifyTransactionLandedSpy.mockResolvedValue({ ok: false, reason: "not_confirmed" });
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(result.status).toBe("awaiting_payment");
    expect(await readStored(request.id)).toMatchObject({
      status: "awaiting_payment",
      signature_scan_cursor: null,
    });
  });

  it("stores expired and advances the cursor when the only candidate failed on-chain", async () => {
    mockSignatures(signatureInfo(SIGNATURE));
    verifyTransactionLandedSpy.mockResolvedValue({ ok: false, reason: "failed" });
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(result.status).toBe("expired");
    expect(await readStored(request.id)).toMatchObject({ signature_scan_cursor: SIGNATURE });
  });

  it.for(["not found", "missing meta"])(
    "leaves the request awaiting when the transfer check answers '%s'",
    async (message) => {
      mockSignatures(signatureInfo(SIGNATURE));
      verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
      validateTransferSpy.mockRejectedValue(new ValidateTransferError(message));
      const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

      const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

      expect(result.status).toBe("awaiting_payment");
      expect(await readStored(request.id)).toMatchObject({
        status: "awaiting_payment",
        signature_scan_cursor: null,
      });
      expect(await listInboundTransfers()).toHaveLength(0);
    }
  );

  it("settles a payment on a later check once the transfer check can read it", async () => {
    mockSignatures(signatureInfo(SIGNATURE));
    verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
    validateTransferSpy.mockRejectedValueOnce(new ValidateTransferError("not found"));
    validateTransferSpy.mockResolvedValueOnce(validatedTransfer());
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const first = await onSandbox(() => closeLapsedPaymentRequest(env, request));
    const second = await onSandbox(async () =>
      closeLapsedPaymentRequest(env, await readStored(request.id))
    );

    expect(first.status).toBe("awaiting_payment");
    expect(second).toMatchObject({ status: "paid", paid_late: true });
    expect(await listInboundTransfers()).toMatchObject([{ signature: SIGNATURE }]);
  });

  describe("when a listed signature stays unreadable", () => {
    const HOUR_MS = 60 * 60 * 1000;
    const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
    const unreadableVerdicts = [
      {
        reason: "not_indexed",
        setup: () =>
          verifyTransactionLandedSpy.mockResolvedValue({ ok: false, reason: "not_indexed" }),
      },
      {
        reason: "not_confirmed",
        setup: () =>
          verifyTransactionLandedSpy.mockResolvedValue({ ok: false, reason: "not_confirmed" }),
      },
      {
        reason: "not found",
        setup: () => {
          verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
          validateTransferSpy.mockRejectedValue(new ValidateTransferError("not found"));
        },
      },
      {
        reason: "missing meta",
        setup: () => {
          verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
          validateTransferSpy.mockRejectedValue(new ValidateTransferError("missing meta"));
        },
      },
    ];

    function expectNoGiveUp(logSpy: MockInstance<typeof moneyPathEvents.logEvent>) {
      expect(logSpy).not.toHaveBeenCalledWith(
        "warn",
        expect.objectContaining({ event: "payment_requests.signature_unreadable" })
      );
    }

    function expectRecentlyStuck(stored: PaymentRequestRow, sig: Signature) {
      expect(stored.signature_scan_stuck_signature).toBe(sig);
      expect(Date.now() - Date.parse(stored.signature_scan_stuck_since ?? "")).toBeLessThan(60_000);
    }

    it.for(unreadableVerdicts)(
      "keeps waiting on an hours-old $reason payment after one unreadable check, then settles it",
      async ({ setup }) => {
        const logSpy = vi.spyOn(moneyPathEvents, "logEvent");
        const listedHoursAgo = BigInt(Math.floor((Date.now() - 2 * HOUR_MS) / 1000));
        mockSignatures(signatureInfo(SIGNATURE, { blockTime: listedHoursAgo }));
        setup();
        const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

        const first = await onSandbox(() => closeLapsedPaymentRequest(env, request));

        expect(first.status).toBe("awaiting_payment");
        const stored = await readStored(request.id);
        expect(stored).toMatchObject({ status: "awaiting_payment", signature_scan_cursor: null });
        expectRecentlyStuck(stored, SIGNATURE);
        expectNoGiveUp(logSpy);

        verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
        validateTransferSpy.mockResolvedValue(validatedTransfer());
        const second = await onSandbox(() => closeLapsedPaymentRequest(env, stored));

        expect(second.status).toBe("paid");
        expect(await listInboundTransfers()).toMatchObject([{ signature: SIGNATURE }]);
      }
    );

    it.for(unreadableVerdicts)(
      "gives up on a signature that stayed $reason for over an hour and stores expired",
      async ({ reason, setup }) => {
        const logSpy = vi.spyOn(moneyPathEvents, "logEvent");
        mockSignatures(signatureInfo(SIGNATURE));
        setup();
        const request = await storeScanPosition(
          await createRequest({ token: SOL_MINT, expiresAt: PAST }),
          { stuckSignature: SIGNATURE, stuckSince: isoAgo(HOUR_MS + 60_000) }
        );

        const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

        expect(result).toMatchObject({ status: "expired", paid_late: false });
        expect(await readStored(request.id)).toMatchObject({
          status: "expired",
          signature_scan_cursor: SIGNATURE,
          signature_scan_stuck_signature: null,
          signature_scan_stuck_since: null,
        });
        expect(logSpy).toHaveBeenCalledWith("warn", {
          event: "payment_requests.signature_unreadable",
          payment_request_id: request.id,
          signature: SIGNATURE,
          reason,
        });
        expect(await listInboundTransfers()).toHaveLength(0);
      }
    );

    it("keeps waiting on a signature unreadable for less than an hour without restarting its clock", async () => {
      const logSpy = vi.spyOn(moneyPathEvents, "logEvent");
      mockSignatures(signatureInfo(SIGNATURE));
      verifyTransactionLandedSpy.mockResolvedValue({ ok: false, reason: "not_indexed" });
      const stuckSince = isoAgo(50 * 60_000);
      const request = await storeScanPosition(
        await createRequest({ token: SOL_MINT, expiresAt: PAST }),
        { stuckSignature: SIGNATURE, stuckSince }
      );

      const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

      expect(result.status).toBe("awaiting_payment");
      expect(await readStored(request.id)).toMatchObject({
        signature_scan_cursor: null,
        signature_scan_stuck_signature: SIGNATURE,
        signature_scan_stuck_since: stuckSince,
      });
      expectNoGiveUp(logSpy);
    });

    it("restarts the clock when a different signature becomes the first unreadable one", async () => {
      const logSpy = vi.spyOn(moneyPathEvents, "logEvent");
      mockSignatures(signatureInfo(SIGNATURE));
      verifyTransactionLandedSpy.mockResolvedValue({ ok: false, reason: "not_indexed" });
      const request = await storeScanPosition(
        await createRequest({ token: SOL_MINT, expiresAt: PAST }),
        { stuckSignature: FAILED_SIGNATURE, stuckSince: isoAgo(2 * HOUR_MS) }
      );

      const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

      expect(result.status).toBe("awaiting_payment");
      const stored = await readStored(request.id);
      expect(stored.signature_scan_cursor).toBeNull();
      expectRecentlyStuck(stored, SIGNATURE);
      expectNoGiveUp(logSpy);
    });

    it("tracks only the oldest unreadable signature", async () => {
      mockSignatures(signatureInfo(LATER_SIGNATURE), signatureInfo(SIGNATURE));
      verifyTransactionLandedSpy.mockResolvedValue({ ok: false, reason: "not_indexed" });
      const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

      await onSandbox(() => closeLapsedPaymentRequest(env, request));

      expectRecentlyStuck(await readStored(request.id), SIGNATURE);
    });

    it("clears the stuck signature once it reads as definitive", async () => {
      mockSignatures(signatureInfo(SIGNATURE));
      verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
      validateTransferSpy.mockRejectedValue(new ValidateTransferError("wrong amount"));
      const request = await storeScanPosition(
        await createRequest({ token: SOL_MINT, expiresAt: PAST }),
        { stuckSignature: SIGNATURE, stuckSince: isoAgo(5 * 60_000) }
      );

      const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

      expect(result.status).toBe("expired");
      expect(await readStored(request.id)).toMatchObject({
        signature_scan_cursor: SIGNATURE,
        signature_scan_stuck_signature: null,
        signature_scan_stuck_since: null,
      });
    });

    it("starts the clock on the next unreadable signature after giving up on one", async () => {
      mockSignatures(signatureInfo(LATER_SIGNATURE), signatureInfo(SIGNATURE));
      verifyTransactionLandedSpy.mockResolvedValue({ ok: false, reason: "not_indexed" });
      const request = await storeScanPosition(
        await createRequest({ token: SOL_MINT, expiresAt: PAST }),
        { stuckSignature: SIGNATURE, stuckSince: isoAgo(2 * HOUR_MS) }
      );

      const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

      expect(result.status).toBe("awaiting_payment");
      const stored = await readStored(request.id);
      expect(stored.signature_scan_cursor).toBe(SIGNATURE);
      expectRecentlyStuck(stored, LATER_SIGNATURE);
    });

    it("settles a valid payment listed after an abandoned unreadable signature", async () => {
      mockSignatures(signatureInfo(LATER_SIGNATURE), signatureInfo(SIGNATURE));
      verifyTransactionLandedSpy.mockImplementation(async (_rpc, sig) =>
        sig === SIGNATURE ? { ok: false, reason: "not_indexed" } : verifiedOk()
      );
      validateTransferSpy.mockResolvedValue(validatedTransfer());
      const request = await storeScanPosition(
        await createRequest({ token: SOL_MINT, expiresAt: null }),
        { stuckSignature: SIGNATURE, stuckSince: isoAgo(2 * HOUR_MS) }
      );

      const result = await reconcileOnSandbox(request);

      expect(result.status).toBe("paid");
      expect(await listInboundTransfers()).toMatchObject([{ signature: LATER_SIGNATURE }]);
      expect(await readStored(request.id)).toMatchObject({
        signature_scan_cursor: SIGNATURE,
        signature_scan_stuck_signature: null,
      });
    });
  });

  it("stores expired and advances the cursor past a transfer that does not match the request", async () => {
    mockSignatures(signatureInfo(SIGNATURE));
    verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
    validateTransferSpy.mockRejectedValue(new ValidateTransferError("amount not transferred"));
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(result.status).toBe("expired");
    expect(await readStored(request.id)).toMatchObject({ signature_scan_cursor: SIGNATURE });
  });
});

function chainSignature(index: number): Signature {
  const bytes = new Uint8Array(64).fill(9);
  bytes[0] = (index >> 8) & 0xff;
  bytes[1] = index & 0xff;
  return signature(getBase58Decoder().decode(bytes));
}

function chainOf(count: number, offset = 0): Signature[] {
  return Array.from({ length: count }, (_, index) => chainSignature(index + offset));
}

function mockChain(
  oldestFirst: readonly Signature[],
  failed: ReadonlySet<Signature> = new Set<Signature>()
) {
  signaturesSpy.mockImplementation(async (_rpc, _reference, options) => {
    const newestFirst = [...oldestFirst].reverse();
    const start = options?.before ? newestFirst.indexOf(options.before) + 1 : 0;
    const page: solanaRpc.SignatureInfo[] = [];
    for (const sig of newestFirst.slice(start)) {
      if (sig === options?.until || page.length >= (options?.limit ?? 100)) break;
      page.push(signatureInfo(sig, failed.has(sig) ? { err: {} } : {}));
    }
    return page;
  });
}

function mockOnlyValid(paid: Signature) {
  verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
  validateTransferSpy.mockImplementation(async (_rpc, sig) => {
    if (sig !== paid) throw new ValidateTransferError("wrong amount");
    return validatedTransfer();
  });
}

function validatedSignatures() {
  return validateTransferSpy.mock.calls.map((call) => call[1]);
}

async function checkUntilSettled(request: PaymentRequestRow, maxChecks: number) {
  let row = request;
  for (let checks = 0; checks < maxChecks && row.status !== "paid"; checks++) {
    await checkOnSandbox(row);
    row = await readStored(request.id);
  }
  return row;
}

async function storeScanPosition(request: PaymentRequestRow, to: Partial<SignatureScanPosition>) {
  await createPaymentRequestsRepository(
    env,
    createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID })
  ).advanceSignatureScan({
    requestId: request.id,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    from: { cursor: null, before: null, stuckSignature: null, stuckSince: null },
    to: { cursor: null, before: null, stuckSignature: null, stuckSince: null, ...to },
  });
  return readStored(request.id);
}

describe("signature scan cursor", () => {
  installSettlementHooks();

  const REAL = chainSignature(9999);

  it("works through junk older than the payment across checks instead of hiding it", async () => {
    const junk = chainOf(30);
    mockChain([...junk, REAL]);
    mockOnlyValid(REAL);
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });

    const first = await checkOnSandbox(request);

    expect(first.status).toBe("awaiting_payment");
    expect(validatedSignatures()).toEqual(junk.slice(0, 25));
    const stored = await readStored(request.id);
    expect(stored.signature_scan_cursor).toBe(junk[24]);

    validateTransferSpy.mockClear();
    const second = await checkOnSandbox(stored);

    expect(second.status).toBe("paid");
    expect(validatedSignatures()).toEqual([...junk.slice(25), REAL]);
    expect(await listInboundTransfers()).toMatchObject([{ signature: REAL }]);
  });

  it("does not store expired while junk older than the payment is still unevaluated", async () => {
    const junk = chainOf(30);
    mockChain([...junk, REAL]);
    mockOnlyValid(REAL);
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const first = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(first.status).toBe("awaiting_payment");
    expect(await readStored(request.id)).toMatchObject({
      status: "awaiting_payment",
      signature_scan_cursor: junk[24],
    });

    const second = await onSandbox(async () =>
      closeLapsedPaymentRequest(env, await readStored(request.id))
    );

    expect(second.status).toBe("paid");
  });

  it("pages back past junk newer than the payment", async () => {
    const junk = chainOf(1500);
    mockChain([REAL, ...junk]);
    mockOnlyValid(REAL);
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });

    const settled = await reconcileOnSandbox(request);

    expect(settled.status).toBe("paid");
    expect(validatedSignatures()).toEqual([REAL]);
    expect(signaturesSpy).toHaveBeenCalledTimes(2);
    expect(signaturesSpy.mock.calls[0]?.[2]).toMatchObject({ commitment: "confirmed" });
    expect(signaturesSpy.mock.calls[0]?.[2]?.before).toBeUndefined();
    expect(signaturesSpy.mock.calls[1]?.[2]).toMatchObject({
      commitment: "confirmed",
      before: junk[500],
    });
  });

  it("scans only signatures newer than the stored cursor", async () => {
    const [older, cursor] = chainOf(2);
    if (older === undefined || cursor === undefined) throw new Error("chain too short");
    mockChain([older, cursor, REAL]);
    mockOnlyValid(REAL);
    const request = await storeScanPosition(
      await createRequest({ token: SOL_MINT, expiresAt: null }),
      { cursor, before: null }
    );

    const settled = await reconcileOnSandbox(request);

    expect(settled.status).toBe("paid");
    expect(signaturesSpy).toHaveBeenCalledWith(
      expect.anything(),
      request.reference,
      expect.objectContaining({ until: cursor })
    );
    expect(verifyTransactionLandedSpy.mock.calls.map((call) => call[1])).toEqual([REAL]);
  });

  it("does not advance the cursor past a signature that is not indexed yet", async () => {
    const [rejected, indexing, later] = chainOf(3);
    if (rejected === undefined || indexing === undefined || later === undefined) {
      throw new Error("chain too short");
    }
    mockChain([rejected, indexing, later]);
    verifyTransactionLandedSpy.mockImplementation(async (_rpc, sig) =>
      sig === indexing ? { ok: false, reason: "not_indexed" } : verifiedOk()
    );
    validateTransferSpy.mockRejectedValue(new ValidateTransferError("wrong amount"));
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(result.status).toBe("awaiting_payment");
    expect(await readStored(request.id)).toMatchObject({
      status: "awaiting_payment",
      signature_scan_cursor: rejected,
    });
  });

  it("advances the cursor over failed transactions without verifying them", async () => {
    const [failed, rejected] = chainOf(2);
    if (failed === undefined || rejected === undefined) throw new Error("chain too short");
    signaturesSpy.mockResolvedValue([signatureInfo(rejected), signatureInfo(failed, { err: {} })]);
    verifyTransactionLandedSpy.mockResolvedValue(verifiedOk());
    validateTransferSpy.mockRejectedValue(new ValidateTransferError("wrong amount"));
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(result.status).toBe("expired");
    expect(verifyTransactionLandedSpy.mock.calls.map((call) => call[1])).toEqual([rejected]);
    expect(await readStored(request.id)).toMatchObject({ signature_scan_cursor: rejected });
  });

  it("does not let a stale check move the cursor back", async () => {
    const junk = chainOf(30);
    mockChain(junk);
    mockOnlyValid(REAL);
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    await storeScanPosition(request, { cursor: junk[27] ?? null, before: null });

    await checkOnSandbox(request);

    expect(await readStored(request.id)).toMatchObject({ signature_scan_cursor: junk[27] });
  });

  describe("when the signature history newer than the cursor exceeds the page cap", () => {
    it("evaluates nothing, reports truncation and resumes further back on the next check", async () => {
      const logSpy = vi.spyOn(moneyPathEvents, "logEvent");
      const junk = chainOf(5001);
      mockChain([REAL, ...junk]);
      mockOnlyValid(REAL);
      const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

      const first = await onSandbox(() => closeLapsedPaymentRequest(env, request));

      expect(first.status).toBe("awaiting_payment");
      expect(verifyTransactionLandedSpy).not.toHaveBeenCalled();
      expect(signaturesSpy).toHaveBeenCalledTimes(5);
      expect(logSpy).toHaveBeenCalledWith(
        "warn",
        expect.objectContaining({
          event: "payment_requests.signature_scan_truncated",
          requestId: request.id,
        })
      );
      const stored = await readStored(request.id);
      expect(stored).toMatchObject({
        status: "awaiting_payment",
        signature_scan_cursor: null,
        signature_scan_before: junk[2],
      });

      const second = await onSandbox(() => closeLapsedPaymentRequest(env, stored));

      expect(second.status).toBe("paid");
      expect(signaturesSpy.mock.calls.at(-1)?.[2]).toMatchObject({ before: junk[2] });
      expect(validatedSignatures()).toEqual([REAL]);
    });

    it("settles a payment that is the oldest of exactly a full capped scan above the cursor", async () => {
      const [cursor, ...junk] = chainOf(5000);
      if (cursor === undefined) throw new Error("chain too short");
      mockChain([cursor, REAL, ...junk]);
      mockOnlyValid(REAL);
      const request = await storeScanPosition(
        await createRequest({ token: SOL_MINT, expiresAt: null }),
        { cursor, before: null }
      );

      const settled = await checkUntilSettled(request, 3);

      expect(settled.status).toBe("paid");
      expect(await listInboundTransfers()).toMatchObject([{ signature: REAL }]);
    });

    it("settles a payment that is the oldest of exactly a full capped scan with no cursor", async () => {
      const junk = chainOf(4999);
      mockChain([REAL, ...junk]);
      mockOnlyValid(REAL);
      const request = await createRequest({ token: SOL_MINT, expiresAt: null });

      const settled = await checkUntilSettled(request, 3);

      expect(settled.status).toBe("paid");
    });

    it("settles a payment just above the cursor under a full capped scan of junk", async () => {
      const [cursor, ...junk] = chainOf(5001);
      if (cursor === undefined) throw new Error("chain too short");
      mockChain([cursor, REAL, ...junk]);
      mockOnlyValid(REAL);
      const request = await storeScanPosition(
        await createRequest({ token: SOL_MINT, expiresAt: null }),
        { cursor, before: null }
      );

      const settled = await checkUntilSettled(request, 3);

      expect(settled.status).toBe("paid");
      expect(await listInboundTransfers()).toMatchObject([{ signature: REAL }]);
    });

    const progressCases = [4999, 5000, 5001, 9999].flatMap((size) =>
      [0, 1, size - 5000, size - 4999, size - 1]
        .filter((paidAt, index, all) => paidAt >= 0 && all.indexOf(paidAt) === index)
        .map((paidAt) => ({ size, paidAt, label: `index ${paidAt} of ${size}` }))
    );

    it.for(progressCases)(
      "moves the scan forward on every check until the payment at $label settles",
      async ({ size, paidAt }) => {
        const chain = chainOf(size, 10_000);
        const paid = chain[paidAt];
        if (paid === undefined) throw new Error("payment outside chain");
        mockChain(chain, new Set(chain.filter((sig) => sig !== paid)));
        mockOnlyValid(paid);
        const position = (sig: string | null, unset: number) =>
          sig === null ? unset : chain.indexOf(signature(sig));
        let row = await createRequest({ token: SOL_MINT, expiresAt: null });

        for (let checks = 1; row.status !== "paid"; checks++) {
          expect(checks).toBeLessThanOrEqual(8);
          const previous = row;
          await checkOnSandbox(previous);
          row = await readStored(previous.id);
          if (row.status === "paid") break;
          const cursorAdvanced =
            position(row.signature_scan_cursor, -1) > position(previous.signature_scan_cursor, -1);
          const resumedFurtherBack =
            position(row.signature_scan_before, size) <
            position(previous.signature_scan_before, size);
          expect(cursorAdvanced || resumedFurtherBack).toBe(true);
          expect(position(row.signature_scan_cursor, -1)).toBeGreaterThanOrEqual(
            position(previous.signature_scan_cursor, -1)
          );
        }

        expect(await listInboundTransfers()).toMatchObject([{ signature: paid }]);
      }
    );

    it("keeps the request open after a resumed range holds no payment", async () => {
      const junk = chainOf(5002);
      mockChain(junk);
      mockOnlyValid(REAL);
      const request = await storeScanPosition(
        await createRequest({ token: SOL_MINT, expiresAt: PAST }),
        { cursor: null, before: junk[2] ?? null }
      );

      const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

      expect(result.status).toBe("awaiting_payment");
      expect(validatedSignatures()).toEqual(junk.slice(0, 2));
      expect(await readStored(request.id)).toMatchObject({
        status: "awaiting_payment",
        signature_scan_cursor: junk[1],
        signature_scan_before: null,
      });
    });
  });
});
