import { runInClusterScope } from "@sdp/rpc/scope";
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
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signature,
} from "@solana/kit";
import * as solanaPay from "@solana/pay";
import { FindReferenceError, ValidateTransferError } from "@solana/pay";
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
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import {
  createPaymentRequestsRepository,
  createPaymentsRepository,
} from "@/db/repositories/repository-factory";
import { createTenantScope } from "@/lib/tenant-scope";
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
const DEVNET_USDC_MINT = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;
const PAST = "2020-01-01T00:00:00.000Z";
const PAST_SECONDS = BigInt(Date.parse(PAST) / 1000);

let findReferenceSpy: MockInstance<typeof solanaPay.findReference>;
let validateTransferSpy: MockInstance<typeof solanaPay.validateTransfer>;
let verifyTransactionLandedSpy: MockInstance<typeof verifiedConfirmation.verifyTransactionLanded>;

function verifiedOk(): Awaited<ReturnType<typeof verifiedConfirmation.verifyTransactionLanded>> {
  return {
    ok: true,
    status: { slot: 1n, confirmations: 5n, confirmationStatus: "confirmed", err: null },
    transaction: { slot: 1n, executionResultKnown: true, err: null, instructions: [] },
  };
}

function foundSignature(): Awaited<ReturnType<typeof solanaPay.findReference>> {
  return {
    signature: SIGNATURE,
    slot: 1n,
    err: null,
    memo: null,
    blockTime: null,
    confirmationStatus: "confirmed",
  };
}

function validatedTransfer(): Awaited<ReturnType<typeof solanaPay.validateTransfer>> {
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
    blockTime: null,
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

function mockSettlementSucceeds() {
  findReferenceSpy.mockResolvedValue(foundSignature());
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

function reconcileOnSandbox(row: PaymentRequestRow) {
  return onSandbox(() => reconcilePaymentRequest(env, row));
}

function foundAt(blockTime: bigint | null): Awaited<ReturnType<typeof solanaPay.findReference>> {
  return { ...foundSignature(), blockTime };
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
    findReferenceSpy = vi.spyOn(solanaPay, "findReference");
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
    expect(transfers[0].status).toBe("confirmed");
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

  it("does not settle when the signature fails the independent confirmation check", async () => {
    findReferenceSpy.mockResolvedValue(foundSignature());
    verifyTransactionLandedSpy.mockResolvedValue({ ok: false, reason: "not_confirmed" });
    validateTransferSpy.mockResolvedValue(validatedTransfer());

    const result = await reconcileOnSandbox(
      await createRequest({ token: SOL_MINT, expiresAt: null })
    );

    expect(result.status).toBe("awaiting_payment");
    expect(validateTransferSpy).not.toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("does not settle while the transaction is confirmed but not yet indexed", async () => {
    findReferenceSpy.mockResolvedValue(foundSignature());
    verifyTransactionLandedSpy.mockResolvedValue({ ok: false, reason: "not_indexed" });

    const result = await reconcileOnSandbox(
      await createRequest({ token: SOL_MINT, expiresAt: null })
    );

    expect(result.status).toBe("awaiting_payment");
    expect(validateTransferSpy).not.toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("leaves the request awaiting when no transfer references it", async () => {
    findReferenceSpy.mockRejectedValue(new FindReferenceError("not found"));

    const result = await reconcileOnSandbox(
      await createRequest({ token: SOL_MINT, expiresAt: null })
    );

    expect(result.status).toBe("awaiting_payment");
    expect(result.fulfilled_by_transfer_id).toBeNull();
    expect(validateTransferSpy).not.toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("leaves the request awaiting when the referenced transfer is invalid", async () => {
    findReferenceSpy.mockResolvedValue(foundSignature());
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
    findReferenceSpy.mockRejectedValue(new Error("rpc exploded"));

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
    expect(findReferenceSpy).not.toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("short-circuits non-awaiting requests without touching the chain", async () => {
    const canceled: PaymentRequestRow = {
      ...(await createRequest({ token: SOL_MINT, expiresAt: null })),
      status: "canceled",
    };

    const result = await reconcileOnSandbox(canceled);

    expect(result).toBe(canceled);
    expect(findReferenceSpy).not.toHaveBeenCalled();
  });

  it("short-circuits expired requests without touching the chain", async () => {
    const expired = await createRequest({ token: SOL_MINT, expiresAt: "2000-01-01T00:00:00.000Z" });

    const result = await reconcileOnSandbox(expired);

    expect(result.status).toBe("awaiting_payment");
    expect(findReferenceSpy).not.toHaveBeenCalled();
  });
});

describe("closeLapsedPaymentRequest", () => {
  installSettlementHooks();

  it("stores expired when the final chain check finds nothing", async () => {
    findReferenceSpy.mockRejectedValue(new FindReferenceError("not found"));
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const closed = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(closed).toMatchObject({ status: "expired", paid_late: false });
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("settles on time when the payment landed before expires_at", async () => {
    mockSettlementSucceeds();
    findReferenceSpy.mockResolvedValue(foundAt(PAST_SECONDS - 10n));
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const closed = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(closed).toMatchObject({ status: "paid", paid_late: false });
  });

  it("settles late when the payment landed after expires_at", async () => {
    mockSettlementSucceeds();
    findReferenceSpy.mockResolvedValue(foundAt(PAST_SECONDS + 10n));
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });

    const closed = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    expect(closed).toMatchObject({ status: "paid", paid_late: true });
  });

  it("settles late when the chain gives no block time", async () => {
    mockSettlementSucceeds();
    findReferenceSpy.mockResolvedValue(foundAt(null));
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
    expect(findReferenceSpy).not.toHaveBeenCalled();
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
    expect(findReferenceSpy).not.toHaveBeenCalled();
  });
});

describe("checkExpiredPaymentRequestForLatePayment", () => {
  installSettlementHooks();

  it("moves an expired request to paid late when a payment shows up", async () => {
    findReferenceSpy.mockRejectedValue(new FindReferenceError("not found"));
    const request = await createRequest({ token: SOL_MINT, expiresAt: PAST });
    const expired = await onSandbox(() => closeLapsedPaymentRequest(env, request));

    mockSettlementSucceeds();
    findReferenceSpy.mockResolvedValue(foundAt(PAST_SECONDS + 60n));
    const late = await onSandbox(() => checkExpiredPaymentRequestForLatePayment(env, expired));

    expect(late).toMatchObject({ status: "paid", paid_late: true });
    expect(late.fulfilled_by_transfer_id).not.toBeNull();
    expect(await listInboundTransfers()).toHaveLength(1);
  });

  it("keeps an expired request expired while no payment shows up", async () => {
    findReferenceSpy.mockRejectedValue(new FindReferenceError("not found"));
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
    expect(findReferenceSpy).not.toHaveBeenCalled();
  });

  it("skips an unresolved legacy request without touching the chain", async () => {
    const request: PaymentRequestRow = {
      ...(await createRequest({ token: SOL_MINT, expiresAt: null })),
      custody_wallet_id: null,
    };

    const checked = await onSandbox(() => checkAwaitingPaymentRequest(env, request));

    expect(checked).toBe(request);
    expect(findReferenceSpy).not.toHaveBeenCalled();
  });
});
