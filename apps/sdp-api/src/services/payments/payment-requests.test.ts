import { runInClusterScope } from "@sdp/rpc/scope";
import * as solanaRpc from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import { SOL_MINT, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  decodeTransactionFromRpcResponse,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  lamports,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signature,
  stringifiedBigInt,
  stringifiedNumber,
  type UnixTimestamp,
  unixTimestamp,
} from "@solana/kit";
import { ValidateTransferError } from "@solana/pay";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
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
import { z } from "zod";
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
import { badRequest } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { rootLogger } from "@/runtime/logger";
import * as moneyPathEvents from "@/runtime/money-path-events";
import * as paymentAmounts from "@/services/payments/token-amount";
import { TEST_CUSTODY_PUBLIC_KEY } from "@/test/fixtures/custody";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { installClusterRpcResponder } from "@/test/helpers/cluster-rpc";
import { seedProjectCryptoWalletCounterparty } from "@/test/helpers/counterparties";
import { env } from "@/test/helpers/env";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import * as paymentRequestTransfer from "./payment-request-transfer";
import * as paymentRequests from "./payment-requests";
import { reconcilePaymentRequest } from "./payment-requests";

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

async function checkAwaitingPaymentRequest(
  ...args: Parameters<typeof paymentRequests.checkAwaitingPaymentRequest>
) {
  return (await paymentRequests.checkAwaitingPaymentRequest(...args)).row;
}

async function closeLapsedPaymentRequest(
  ...args: Parameters<typeof paymentRequests.closeLapsedPaymentRequest>
) {
  return (await paymentRequests.closeLapsedPaymentRequest(...args)).row;
}

async function checkExpiredPaymentRequestForLatePayment(
  ...args: Parameters<typeof paymentRequests.checkExpiredPaymentRequestForLatePayment>
) {
  return (await paymentRequests.checkExpiredPaymentRequestForLatePayment(...args)).row;
}

let signaturesSpy: MockInstance<typeof solanaRpc.getSignaturesForAddress>;
let validateTransferSpy: MockInstance<typeof paymentRequestTransfer.validatePaymentRequestTransfer>;

const validateExactTransfer = paymentRequestTransfer.validatePaymentRequestTransfer;
let statusesSpy: MockInstance<typeof solanaRpc.getSignatureStatuses>;

function signatureStatus(
  confirmationStatus: "confirmed" | "finalized",
  err: solanaRpc.SignatureStatusInfo["err"]
): solanaRpc.SignatureStatusInfo {
  return { slot: 1n, confirmations: null, confirmationStatus, err };
}

const FINALIZED = signatureStatus("finalized", null);
const CONFIRMED_ONLY = signatureStatus("confirmed", null);
const FAILED_ON_CHAIN = signatureStatus("finalized", { InstructionError: [0, "InvalidArgument"] });

function mockStatus(status: solanaRpc.SignatureStatusInfo | null) {
  statusesSpy.mockResolvedValue([status]);
}

function mockUnindexed(
  unindexed: Signature,
  otherwise: (
    sig: Signature
  ) => ReturnType<typeof paymentRequestTransfer.validatePaymentRequestTransfer>
) {
  mockStatus(FINALIZED);
  validateTransferSpy.mockImplementation(async (sig) => {
    if (sig === unindexed) throw new ValidateTransferError("Transaction not found");
    return otherwise(sig);
  });
}

function checkedSignatures() {
  return statusesSpy.mock.calls.map((call) => call[1][0]);
}

function signatureInfo(
  sig: Signature,
  listed: Pick<solanaRpc.SignatureInfo, "blockTime" | "err">
): solanaRpc.SignatureInfo {
  return { signature: sig, slot: 1n, confirmationStatus: "confirmed", ...listed };
}

function mockSignatures(...newestFirst: solanaRpc.SignatureInfo[]) {
  signaturesSpy.mockResolvedValue(newestFirst);
}

function mockNoSignatures() {
  signaturesSpy.mockResolvedValue([]);
}

function validatedTransfer(
  blockTime: UnixTimestamp | null
): Awaited<ReturnType<typeof paymentRequestTransfer.validatePaymentRequestTransfer>> {
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

function mockSettlementSucceeds(blockTime: bigint | null) {
  mockSignatures(signatureInfo(SIGNATURE, { blockTime, err: null }));
  mockStatus(FINALIZED);
  validateTransferSpy.mockResolvedValue(validatedTransfer(null));
}

function createRequest(params: { token: string; expiresAt: string | null }) {
  return createRequestFor({ ...params, amount: "1.5" });
}

async function createRequestFor(params: {
  token: string;
  amount: string;
  expiresAt: string | null;
}) {
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
    amount: params.amount,
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
  const rpc = installClusterRpcResponder();

  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    signaturesSpy = vi.spyOn(solanaRpc, "getSignaturesForAddress");
    validateTransferSpy = vi.spyOn(paymentRequestTransfer, "validatePaymentRequestTransfer");
    statusesSpy = vi.spyOn(solanaRpc, "getSignatureStatuses");

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
  return rpc;
}

describe("reconcilePaymentRequest", () => {
  installSettlementHooks();

  it("settles an awaiting request and links an inbound transfer attributed to no counterparty", async () => {
    mockSettlementSucceeds(null);
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
    mockSettlementSucceeds(null);

    const settled = await reconcileOnSandbox(
      await createRequest({ token: DEVNET_USDC_MINT, expiresAt: null })
    );

    expect(settled.status).toBe("paid");
    const fields = validateTransferSpy.mock.calls[0][1];
    expect(fields.splToken).toBe(DEVNET_USDC_MINT);
  });

  it("checks a SOL request as a native transfer with no SPL token", async () => {
    mockSettlementSucceeds(null);

    const settled = await reconcileOnSandbox(
      await createRequest({ token: SOL_MINT, expiresAt: null })
    );

    expect(settled.status).toBe("paid");
    expect(validateTransferSpy.mock.calls[0][1].splToken).toBeUndefined();
  });

  it("converges concurrent reconciles of the same request to a single settlement", async () => {
    mockSettlementSucceeds(null);
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
    mockSettlementSucceeds(null);

    await expect(reconcileOnSandbox(request)).rejects.toThrow("does not match payment request");
    expect(await listInboundTransfers()).toMatchObject([{ custody_wallet_id: null }]);
  });

  it("finalizes a matching transfer an earlier check recorded as confirmed", async () => {
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    const transfer = await createPaymentsRepository(
      env,
      createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID })
    ).createTransfer({
      id: "xfr_confirmed_earlier",
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
    if (!transfer) throw new Error("Expected confirmed transfer fixture creation to succeed");
    mockSettlementSucceeds(null);

    const settled = await reconcileOnSandbox(request);

    expect(settled).toMatchObject({ status: "paid", fulfilled_by_transfer_id: transfer.id });
    expect(await listInboundTransfers()).toMatchObject([{ id: transfer.id, status: "finalized" }]);
  });

  it.for([
    {
      reason: "not confirmed",
      setup: () => {
        mockStatus(null);
        validateTransferSpy.mockResolvedValue(validatedTransfer(null));
      },
      validated: false,
    },
    {
      reason: "not indexed",
      setup: () => mockUnindexed(SIGNATURE, async () => validatedTransfer(null)),
      validated: true,
    },
  ])(
    "asks the payer to retry instead of answering payable while a candidate is $reason",
    async ({ setup, validated }) => {
      mockSignatures(signatureInfo(SIGNATURE, { blockTime: null, err: null }));
      setup();
      const setRetryAfter = vi.fn();
      const request = await createRequest({ token: SOL_MINT, expiresAt: null });

      await expect(reconcileOnSandbox(request, setRetryAfter)).rejects.toMatchObject({
        code: "RATE_LIMITED",
        statusCode: 429,
      });

      expect(setRetryAfter).toHaveBeenCalledWith(expect.any(Number));
      expect(setRetryAfter.mock.calls[0]?.[0]).toBeGreaterThan(0);
      expect(validateTransferSpy).toHaveBeenCalledTimes(validated ? 1 : 0);
      expect(await listInboundTransfers()).toHaveLength(0);
      expect(await readStored(request.id)).toMatchObject({ status: "awaiting_payment" });
    }
  );

  it("asks the payer to retry while the payment is confirmed but not finalized", async () => {
    mockSignatures(signatureInfo(SIGNATURE, { blockTime: null, err: null }));
    mockStatus(CONFIRMED_ONLY);
    validateTransferSpy.mockResolvedValue(validatedTransfer(null));
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });

    await expect(reconcileOnSandbox(request)).rejects.toMatchObject({ code: "RATE_LIMITED" });

    expect(validateTransferSpy).not.toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
    expect(await readStored(request.id)).toMatchObject({ status: "awaiting_payment" });
  });

  it("asks the payer to retry while the verify budget leaves candidates unchecked", async () => {
    mockSignatures(
      ...Array.from({ length: 30 }, (_, index) =>
        signatureInfo(signature(getBase58Decoder().decode(new Uint8Array(64).fill(index + 10))), {
          blockTime: null,
          err: null,
        })
      )
    );
    mockStatus(FINALIZED);
    validateTransferSpy.mockRejectedValue(new ValidateTransferError("wrong amount"));

    await expect(
      reconcileOnSandbox(await createRequest({ token: SOL_MINT, expiresAt: null }))
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("does not settle in a background check while a candidate is not indexed yet", async () => {
    mockSignatures(signatureInfo(SIGNATURE, { blockTime: null, err: null }));
    mockUnindexed(SIGNATURE, async () => validatedTransfer(null));

    const result = await checkOnSandbox(await createRequest({ token: SOL_MINT, expiresAt: null }));

    expect(result.status).toBe("awaiting_payment");
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
    mockSignatures(signatureInfo(SIGNATURE, { blockTime: null, err: null }));
    mockStatus(FINALIZED);
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
    mockSignatures(signatureInfo(SIGNATURE, { blockTime: PAST_SECONDS - 10n, err: null }));
    mockStatus(CONFIRMED_ONLY);
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const closed = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(closed).toMatchObject({ status: "awaiting_payment" });
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("judges lateness by the finalized transaction's block time", async () => {
    mockSignatures(signatureInfo(SIGNATURE, { blockTime: PAST_SECONDS + 10n, err: null }));
    mockStatus(FINALIZED);
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
    expect(closed.last_verified_at).toBeNull();
    expect(signaturesSpy).not.toHaveBeenCalled();
  });

  it("leaves a request another writer already settled", async () => {
    mockSettlementSucceeds(null);
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
    mockSettlementSucceeds(null);
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

const auditRowSchema = z.object({ organization_id: z.string(), metadata: z.string() });
const auditMetadataSchema = z.record(z.string(), z.unknown());

async function listPaymentRequestAudits(requestId: string, action: "settle" | "update") {
  const result = await getDb(env)
    .prepare(
      "SELECT organization_id, metadata FROM audit_logs WHERE resource_type = 'payment_request' AND resource_id = ? AND action = ?"
    )
    .bind(requestId, action)
    .all();
  return result.results.map((raw) => {
    const row = auditRowSchema.parse(raw);
    return {
      organizationId: row.organization_id,
      metadata: auditMetadataSchema.parse(JSON.parse(row.metadata)),
    };
  });
}

describe("settlement audit", () => {
  installSettlementHooks();

  it("records one settle entry for the awaiting to paid transition", async () => {
    mockSettlementSucceeds(null);
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });

    const settled = await reconcileOnSandbox(request);
    await onSandbox(() => checkAwaitingPaymentRequest(env, request));

    expect(await listPaymentRequestAudits(request.id, "settle")).toEqual([
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

    expect(await listPaymentRequestAudits(request.id, "settle")).toEqual([
      {
        organizationId: TEST_ORG.id,
        metadata: expect.objectContaining({ fromStatus: "expired", paidLate: true }),
      },
    ]);
  });
});

describe("verified check stamp", () => {
  installSettlementHooks();

  it("reports a check on a request that lapsed after selection as not reading the chain", async () => {
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const check = await onSandbox(() => paymentRequests.checkAwaitingPaymentRequest(env, request));

    expect(check).toEqual({ row: request, outcome: { kind: "skipped" } });
    expect(signaturesSpy).not.toHaveBeenCalled();
  });

  it("reports a completed search as reading the chain even when it finds nothing", async () => {
    mockNoSignatures();
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });

    const check = await onSandbox(() => paymentRequests.checkAwaitingPaymentRequest(env, request));

    expect(check).toEqual({ row: request, outcome: { kind: "read" } });
  });

  it("expires a lapsed request whose mint is no longer admitted without claiming a chain read", async () => {
    vi.spyOn(paymentAmounts, "loadPaymentMint").mockRejectedValue(
      badRequest("Token mint account does not exist")
    );
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const check = await onSandbox(() => paymentRequests.closeLapsedPaymentRequest(env, request));

    expect(check).toMatchObject({
      row: { status: "expired", last_verified_at: null },
      outcome: { kind: "blocked", reason: "mint_not_admitted" },
    });
    expect(signaturesSpy).not.toHaveBeenCalled();
  });

  it("stamps last_verified_at when a payer-path check settles the request", async () => {
    mockSettlementSucceeds(null);
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });

    await reconcileOnSandbox(request);

    expect((await readStored(request.id)).last_verified_at).not.toBeNull();
  });

  it("stamps last_verified_at when the expiry lane stores expired", async () => {
    mockNoSignatures();
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect((await readStored(request.id)).last_verified_at).not.toBeNull();
  });
});

describe("expiry audit", () => {
  installSettlementHooks();

  it("records one update entry when the expiry lane stores expired", async () => {
    mockNoSignatures();
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    await onSandbox(() => closeLapsedPaymentRequest(env, request));
    await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(await listPaymentRequestAudits(request.id, "update")).toEqual([
      {
        organizationId: TEST_ORG.id,
        metadata: expect.objectContaining({ fromStatus: "awaiting_payment", toStatus: "expired" }),
      },
    ]);
  });

  it("records nothing when the request was already settled", async () => {
    mockSettlementSucceeds(null);
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    await reconcileOnSandbox(request);
    mockNoSignatures();

    await onSandbox(() => closeLapsedPaymentRequest(env, { ...request, expires_at: PAST }));

    expect(await listPaymentRequestAudits(request.id, "update")).toHaveLength(0);
  });
});

async function exactTransferResponse(params: {
  token: string;
  rawAmount: bigint;
  reference: Address;
  lookupTable: Address | null;
}): Promise<Awaited<ReturnType<typeof paymentRequestTransfer.validatePaymentRequestTransfer>>> {
  const { token, rawAmount, reference, lookupTable } = params;
  const owner = address(TEST_CUSTODY_PUBLIC_KEY);
  const source = createNoopSigner(syntheticAddress(332));
  const destination =
    token === SOL_MINT
      ? owner
      : (
          await findAssociatedTokenPda({
            owner,
            mint: address(token),
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
          })
        )[0];
  const instruction =
    token === SOL_MINT
      ? getTransferSolInstruction({ source, destination, amount: rawAmount })
      : getTransferCheckedInstruction({
          source: syntheticAddress(333),
          mint: address(token),
          destination,
          authority: source,
          amount: rawAmount,
          decimals: 6,
        });
  const referenced = {
    ...instruction,
    accounts: [...instruction.accounts, { address: reference, role: AccountRole.READONLY }],
  };
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (message) => setTransactionMessageFeePayer(source.address, message),
    (message) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(getBase58Decoder().decode(new Uint8Array(32).fill(7))),
          lastValidBlockHeight: 1n,
        },
        message
      ),
    (message) => appendTransactionMessageInstructions([referenced], message)
  );
  const transaction = compileTransaction(
    lookupTable === null
      ? message
      : compressTransactionMessageUsingAddressLookupTables(message, {
          [lookupTable]: [destination],
        })
  );
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const loadedWritable = lookupTable === null ? [] : [destination];
  const accountKeys = [...compiled.staticAccounts, ...loadedWritable];
  const accountIndex = accountKeys.indexOf(destination);
  const tokenBalance = (amount: bigint) => ({
    accountIndex,
    mint: address(token),
    owner,
    programId: TOKEN_PROGRAM_ADDRESS,
    uiTokenAmount: {
      amount: stringifiedBigInt(amount.toString()),
      decimals: 6,
      uiAmount: null,
      uiAmountString: stringifiedNumber(formatDecimalAmount(amount, 6)),
    },
  });
  return {
    slot: 1n,
    blockTime: null,
    version: 0,
    meta: {
      err: null,
      fee: lamports(5_000n),
      logMessages: [],
      preBalances: accountKeys.map(() => lamports(0n)),
      postBalances: accountKeys.map((account) =>
        lamports(token === SOL_MINT && account === destination ? rawAmount : 0n)
      ),
      preTokenBalances: token === SOL_MINT ? [] : [tokenBalance(0n)],
      postTokenBalances: token === SOL_MINT ? [] : [tokenBalance(rawAmount)],
      rewards: [],
      status: { Ok: null },
      loadedAddresses: { readonly: [], writable: loadedWritable },
    },
    transaction: [getBase64EncodedWireTransaction(transaction), "base64"],
  };
}

// JSON-RPC token amounts are strings; all numeric fixture metadata is small.
function asRpcJson<T>(response: T) {
  return JSON.parse(
    JSON.stringify(response, (_, value) => (typeof value === "bigint" ? Number(value) : value))
  );
}

describe("exact transfer validation", () => {
  const rpc = installSettlementHooks();

  function mockExactCandidate() {
    mockSignatures(signatureInfo(SIGNATURE, { blockTime: null, err: null }));
    mockStatus(FINALIZED);
    validateTransferSpy.mockImplementation(validateExactTransfer);
  }

  it.each([
    {
      label: "legacy excessive precision",
      token: DEVNET_USDC_MINT,
      amount: "1.0000001",
      received: 1_000_000n,
      status: "awaiting_payment",
    },
    {
      label: "exact SPL above 2^53",
      token: DEVNET_USDC_MINT,
      amount: "9007199254.740993",
      received: 9007199254740993n,
      status: "paid",
    },
    {
      label: "one raw unit short above 2^53",
      token: DEVNET_USDC_MINT,
      amount: "9007199254.740993",
      received: 9007199254740992n,
      status: "awaiting_payment",
    },
    {
      label: "one lamport short",
      token: SOL_MINT,
      amount: "1.5",
      received: 1_499_999_999n,
      status: "awaiting_payment",
    },
  ])("checks $label with real transfer validation", async ({ token, amount, received, status }) => {
    const request = await createRequestFor({ token, amount, expiresAt: null });
    mockExactCandidate();
    rpc.answer(
      "getTransaction",
      asRpcJson(
        await exactTransferResponse({
          token,
          rawAmount: received,
          reference: address(request.reference),
          lookupTable: null,
        })
      )
    );

    const settled = await onSandbox(() => checkAwaitingPaymentRequest(env, request));

    expect(settled.status).toBe(status);
    expect(await listInboundTransfers()).toHaveLength(status === "paid" ? 1 : 0);
  });

  it("reads each candidate's transaction once", async () => {
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    mockExactCandidate();
    rpc.answer(
      "getTransaction",
      asRpcJson(
        await exactTransferResponse({
          token: SOL_MINT,
          rawAmount: 1_500_000_000n,
          reference: address(request.reference),
          lookupTable: null,
        })
      )
    );

    expect((await onSandbox(() => checkAwaitingPaymentRequest(env, request))).status).toBe("paid");
    expect(rpc.requests.filter((request) => request.method === "getTransaction")).toHaveLength(1);
  });

  it("reads the transfer at finalized commitment", async () => {
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    mockExactCandidate();
    rpc.answer(
      "getTransaction",
      asRpcJson(
        await exactTransferResponse({
          token: SOL_MINT,
          rawAmount: 1_500_000_000n,
          reference: address(request.reference),
          lookupTable: null,
        })
      )
    );

    await onSandbox(() => checkAwaitingPaymentRequest(env, request));

    // Kit omits the commitment from the request when it is the RPC default, finalized.
    expect(rpc.requests.find((request) => request.method === "getTransaction")?.params).toEqual([
      SIGNATURE,
      { encoding: "base64", maxSupportedTransactionVersion: 0 },
    ]);
  });

  it.each([
    { received: 1_500_000n, status: "paid" },
    { received: 1_499_999n, status: "awaiting_payment" },
  ])(
    "settles only sufficient payments into a fresh ATA: $received",
    async ({ received, status }) => {
      const request = await createRequest({ token: DEVNET_USDC_MINT, expiresAt: null });
      mockExactCandidate();
      const response = await exactTransferResponse({
        token: DEVNET_USDC_MINT,
        rawAmount: received,
        reference: address(request.reference),
        lookupTable: null,
      });
      if (response.meta === null) throw new Error("Fixture requires metadata");
      rpc.answer(
        "getTransaction",
        asRpcJson({ ...response, meta: { ...response.meta, preTokenBalances: [] } })
      );

      expect((await onSandbox(() => checkAwaitingPaymentRequest(env, request))).status).toBe(
        status
      );
      expect(await listInboundTransfers()).toHaveLength(status === "paid" ? 1 : 0);
    }
  );

  it.each(["wrong program", "wrong mint", "wrong decimals", "failed transaction"])(
    "rejects a fresh ATA payment with %s",
    async (fault) => {
      const request = await createRequest({ token: DEVNET_USDC_MINT, expiresAt: null });
      mockExactCandidate();
      const response = await exactTransferResponse({
        token: fault === "wrong program" ? SOL_MINT : DEVNET_USDC_MINT,
        rawAmount: 1_500_000n,
        reference: address(request.reference),
        lookupTable: null,
      });
      if (response.meta === null) throw new Error("Fixture requires metadata");
      const postTokenBalances = response.meta.postTokenBalances?.map((balance) => ({
        ...balance,
        mint: fault === "wrong mint" ? syntheticAddress(502) : balance.mint,
        uiTokenAmount: {
          ...balance.uiTokenAmount,
          decimals: fault === "wrong decimals" ? 5 : balance.uiTokenAmount.decimals,
        },
      }));
      rpc.answer(
        "getTransaction",
        asRpcJson({
          ...response,
          meta: {
            ...response.meta,
            preTokenBalances: [],
            postTokenBalances,
            err:
              fault === "failed transaction" ? { InstructionError: [0, "InvalidArgument"] } : null,
          },
        })
      );

      expect((await onSandbox(() => checkAwaitingPaymentRequest(env, request))).status).toBe(
        "awaiting_payment"
      );
      expect(await listInboundTransfers()).toHaveLength(0);
    }
  );

  it("settles an SPL payment whose recipient ATA loads from an address lookup table", async () => {
    const request = await createRequest({ token: DEVNET_USDC_MINT, expiresAt: null });
    mockExactCandidate();
    const response = await exactTransferResponse({
      token: DEVNET_USDC_MINT,
      rawAmount: 1_500_000n,
      reference: address(request.reference),
      lookupTable: syntheticAddress(335),
    });
    const [recipientAta] = await findAssociatedTokenPda({
      owner: address(TEST_CUSTODY_PUBLIC_KEY),
      mint: address(DEVNET_USDC_MINT),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const { compiledMessage, loadedAddresses } = decodeTransactionFromRpcResponse(response);
    expect(compiledMessage.staticAccounts).not.toContain(recipientAta);
    expect(loadedAddresses).toEqual({ readonly: [], writable: [recipientAta] });
    rpc.answer("getTransaction", asRpcJson(response));

    expect((await onSandbox(() => checkAwaitingPaymentRequest(env, request))).status).toBe("paid");
    expect(await listInboundTransfers()).toHaveLength(1);
  });

  it("still rejects a transfer whose reference does not match the request", async () => {
    const request = await createRequest({ token: SOL_MINT, expiresAt: null });
    mockExactCandidate();
    rpc.answer(
      "getTransaction",
      asRpcJson(
        await exactTransferResponse({
          token: SOL_MINT,
          rawAmount: 1_500_000_000n,
          reference: syntheticAddress(334),
          lookupTable: null,
        })
      )
    );

    expect((await onSandbox(() => checkAwaitingPaymentRequest(env, request))).status).toBe(
      "awaiting_payment"
    );
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it.each([
    "Token mint account does not exist",
    "Unsupported token program for mint",
    "Payments do not support the InterestBearingConfig mint extension",
  ])("skips a request whose legacy mint is no longer admitted: %s", async (message) => {
    const warn = vi.spyOn(rootLogger, "warn").mockImplementation(() => {});
    const invalidMint = syntheticAddress(501);
    vi.spyOn(paymentAmounts, "loadPaymentMint").mockRejectedValue(badRequest(message));
    const request = await createRequest({ token: invalidMint, expiresAt: null });
    mockSettlementSucceeds(null);

    const unchanged = await onSandbox(() => checkAwaitingPaymentRequest(env, request));

    expect(unchanged).toEqual(request);
    expect(signaturesSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ payment_request_id: request.id, reason: "mint_not_admitted" }),
      expect.any(String)
    );
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
      (db, scope) => {
        const repository = real(db, scope);
        vi.spyOn(repository, "markPaymentRequest").mockRejectedValue(
          new Error("transition failed")
        );
        return repository;
      }
    );
    mockSettlementSucceeds(null);
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
      (db, scope) => {
        const repository = real(db, scope);
        const lookup = repository.listTransfersBySignatures.bind(repository);
        vi.spyOn(repository, "listTransfersBySignatures").mockImplementation((params) =>
          lookups++ === 0 ? Promise.resolve([]) : lookup(params)
        );
        return repository;
      }
    );
    mockSettlementSucceeds(null);

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
    mockSignatures(signatureInfo(SIGNATURE, { blockTime: null, err: null }));
    mockStatus(FINALIZED);
    validateTransferSpy.mockResolvedValue(validatedTransfer(null));

    await reconcileOnSandbox(await createRequest({ token: SOL_MINT, expiresAt: null }));

    expect(statusesSpy).toHaveBeenCalledWith(expect.anything(), [SIGNATURE], {
      searchTransactionHistory: true,
    });
  });

  it("settles a valid payment that follows a failed transaction on the same reference", async () => {
    mockSignatures(
      signatureInfo(LATER_SIGNATURE, { blockTime: null, err: null }),
      signatureInfo(FAILED_SIGNATURE, { blockTime: null, err: {} })
    );
    mockStatus(FINALIZED);
    validateTransferSpy.mockResolvedValue(validatedTransfer(null));

    const settled = await reconcileOnSandbox(
      await createRequest({ token: SOL_MINT, expiresAt: null })
    );

    expect(settled.status).toBe("paid");
    expect(checkedSignatures()).not.toContain(FAILED_SIGNATURE);
    expect(await listInboundTransfers()).toMatchObject([{ signature: LATER_SIGNATURE }]);
  });

  it("settles on a later signature when the oldest one does not validate", async () => {
    mockSignatures(
      signatureInfo(LATER_SIGNATURE, { blockTime: null, err: null }),
      signatureInfo(SIGNATURE, { blockTime: null, err: null })
    );
    mockStatus(FINALIZED);
    validateTransferSpy.mockImplementation(async (sig) => {
      if (sig === SIGNATURE) throw new ValidateTransferError("wrong amount");
      return validatedTransfer(null);
    });

    const settled = await reconcileOnSandbox(
      await createRequest({ token: SOL_MINT, expiresAt: null })
    );

    expect(settled.status).toBe("paid");
    expect(validateTransferSpy.mock.calls.map((call) => call[0])).toEqual([
      SIGNATURE,
      LATER_SIGNATURE,
    ]);
    expect(await listInboundTransfers()).toMatchObject([{ signature: LATER_SIGNATURE }]);
  });

  it("checks a bounded number of candidate signatures", async () => {
    mockSignatures(
      ...Array.from({ length: 30 }, (_, index) =>
        signatureInfo(signature(getBase58Decoder().decode(new Uint8Array(64).fill(index + 10))), {
          blockTime: null,
          err: null,
        })
      )
    );
    mockStatus(FINALIZED);
    validateTransferSpy.mockRejectedValue(new ValidateTransferError("wrong amount"));

    const result = await checkOnSandbox(await createRequest({ token: SOL_MINT, expiresAt: null }));

    expect(result.status).toBe("awaiting_payment");
    expect(validateTransferSpy).toHaveBeenCalledTimes(25);
  });
});

describe("closeLapsedPaymentRequest while a payment is indexing", () => {
  installSettlementHooks();

  it("leaves the request awaiting when a candidate is finalized but not yet indexed", async () => {
    mockSignatures(signatureInfo(SIGNATURE, { blockTime: null, err: null }));
    mockUnindexed(SIGNATURE, async () => validatedTransfer(null));
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(result).toMatchObject({ status: "awaiting_payment" });
    expect(await readStored(request.id)).toMatchObject({ status: "awaiting_payment" });
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("leaves the request awaiting when one candidate is indexing and another is invalid", async () => {
    mockSignatures(
      signatureInfo(LATER_SIGNATURE, { blockTime: null, err: null }),
      signatureInfo(SIGNATURE, { blockTime: null, err: null })
    );
    mockUnindexed(SIGNATURE, async () => {
      throw new ValidateTransferError("wrong amount");
    });
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(result.status).toBe("awaiting_payment");
    expect(await readStored(request.id)).toMatchObject({ status: "awaiting_payment" });
  });

  it("settles a later valid candidate even while an earlier one is indexing", async () => {
    mockSignatures(
      signatureInfo(LATER_SIGNATURE, { blockTime: null, err: null }),
      signatureInfo(SIGNATURE, { blockTime: null, err: null })
    );
    mockUnindexed(SIGNATURE, async () => validatedTransfer(null));
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(result.status).toBe("paid");
    expect(await listInboundTransfers()).toMatchObject([{ signature: LATER_SIGNATURE }]);
  });

  it("leaves the request awaiting when the only candidate is not confirmed by the status node yet", async () => {
    mockSignatures(signatureInfo(SIGNATURE, { blockTime: null, err: null }));
    mockStatus(null);
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(result.status).toBe("awaiting_payment");
    expect(await readStored(request.id)).toMatchObject({
      status: "awaiting_payment",
      signature_scan_cursor: null,
    });
  });

  it("stores expired and advances the cursor when the only candidate failed on-chain", async () => {
    mockSignatures(signatureInfo(SIGNATURE, { blockTime: null, err: null }));
    mockStatus(FAILED_ON_CHAIN);
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(result.status).toBe("expired");
    expect(await readStored(request.id)).toMatchObject({ signature_scan_cursor: SIGNATURE });
  });

  it.for(["Transaction not found", "Transaction meta missing"])(
    "leaves the request awaiting when the transfer check answers '%s'",
    async (message) => {
      mockSignatures(signatureInfo(SIGNATURE, { blockTime: null, err: null }));
      mockStatus(FINALIZED);
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
    mockSignatures(signatureInfo(SIGNATURE, { blockTime: null, err: null }));
    mockStatus(FINALIZED);
    validateTransferSpy.mockRejectedValueOnce(new ValidateTransferError("Transaction not found"));
    validateTransferSpy.mockResolvedValueOnce(validatedTransfer(null));
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
        reason: "not_finalized",
        setup: () => mockStatus(CONFIRMED_ONLY),
      },
      {
        reason: "not_confirmed",
        setup: () => mockStatus(null),
      },
      {
        reason: "Transaction not found",
        setup: () => {
          mockStatus(FINALIZED);
          validateTransferSpy.mockRejectedValue(new ValidateTransferError("Transaction not found"));
        },
      },
      {
        reason: "Transaction meta missing",
        setup: () => {
          mockStatus(FINALIZED);
          validateTransferSpy.mockRejectedValue(
            new ValidateTransferError("Transaction meta missing")
          );
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
        mockSignatures(signatureInfo(SIGNATURE, { blockTime: listedHoursAgo, err: null }));
        setup();
        const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

        const first = await onSandbox(() => closeLapsedPaymentRequest(env, request));

        expect(first.status).toBe("awaiting_payment");
        const stored = await readStored(request.id);
        expect(stored).toMatchObject({ status: "awaiting_payment", signature_scan_cursor: null });
        expectRecentlyStuck(stored, SIGNATURE);
        expectNoGiveUp(logSpy);

        mockStatus(FINALIZED);
        validateTransferSpy.mockResolvedValue(validatedTransfer(null));
        const second = await onSandbox(() => closeLapsedPaymentRequest(env, stored));

        expect(second.status).toBe("paid");
        expect(await listInboundTransfers()).toMatchObject([{ signature: SIGNATURE }]);
      }
    );

    it.for(unreadableVerdicts)(
      "gives up on a signature that stayed $reason for over an hour and stores expired",
      async ({ reason, setup }) => {
        const logSpy = vi.spyOn(moneyPathEvents, "logEvent");
        mockSignatures(signatureInfo(SIGNATURE, { blockTime: null, err: null }));
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
      mockSignatures(signatureInfo(SIGNATURE, { blockTime: null, err: null }));
      mockStatus(FINALIZED);
      validateTransferSpy.mockRejectedValue(new ValidateTransferError("Transaction not found"));
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
      mockSignatures(signatureInfo(SIGNATURE, { blockTime: null, err: null }));
      mockStatus(FINALIZED);
      validateTransferSpy.mockRejectedValue(new ValidateTransferError("Transaction not found"));
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
      mockSignatures(
        signatureInfo(LATER_SIGNATURE, { blockTime: null, err: null }),
        signatureInfo(SIGNATURE, { blockTime: null, err: null })
      );
      mockStatus(FINALIZED);
      validateTransferSpy.mockRejectedValue(new ValidateTransferError("Transaction not found"));
      const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

      await onSandbox(() => closeLapsedPaymentRequest(env, request));

      expectRecentlyStuck(await readStored(request.id), SIGNATURE);
    });

    it("clears the stuck signature once it reads as definitive", async () => {
      mockSignatures(signatureInfo(SIGNATURE, { blockTime: null, err: null }));
      mockStatus(FINALIZED);
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
      mockSignatures(
        signatureInfo(LATER_SIGNATURE, { blockTime: null, err: null }),
        signatureInfo(SIGNATURE, { blockTime: null, err: null })
      );
      mockStatus(FINALIZED);
      validateTransferSpy.mockRejectedValue(new ValidateTransferError("Transaction not found"));
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
      mockSignatures(
        signatureInfo(LATER_SIGNATURE, { blockTime: null, err: null }),
        signatureInfo(SIGNATURE, { blockTime: null, err: null })
      );
      mockUnindexed(SIGNATURE, async () => validatedTransfer(null));
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
    mockSignatures(signatureInfo(SIGNATURE, { blockTime: null, err: null }));
    mockStatus(FINALIZED);
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
      page.push(signatureInfo(sig, { blockTime: null, err: failed.has(sig) ? {} : null }));
    }
    return page;
  });
}

function mockOnlyValid(paid: Signature) {
  mockStatus(FINALIZED);
  validateTransferSpy.mockImplementation(async (sig) => {
    if (sig !== paid) throw new ValidateTransferError("wrong amount");
    return validatedTransfer(null);
  });
}

function validatedSignatures() {
  return validateTransferSpy.mock.calls.map((call) => call[0]);
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
    expect(checkedSignatures()).toEqual([REAL]);
  });

  it("does not advance the cursor past a signature that is not indexed yet", async () => {
    const [rejected, indexing, later] = chainOf(3);
    if (rejected === undefined || indexing === undefined || later === undefined) {
      throw new Error("chain too short");
    }
    mockChain([rejected, indexing, later]);
    mockUnindexed(indexing, async () => {
      throw new ValidateTransferError("wrong amount");
    });
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
    signaturesSpy.mockResolvedValue([
      signatureInfo(rejected, { blockTime: null, err: null }),
      signatureInfo(failed, { blockTime: null, err: {} }),
    ]);
    mockStatus(FINALIZED);
    validateTransferSpy.mockRejectedValue(new ValidateTransferError("wrong amount"));
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const result = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(result.status).toBe("expired");
    expect(checkedSignatures()).toEqual([rejected]);
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
      expect(statusesSpy).not.toHaveBeenCalled();
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
