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
import { getDb } from "@/db";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { SOL_MINT } from "@/services/payment-operation.service";
import { TEST_CUSTODY_PUBLIC_KEY } from "@/test/fixtures/custody";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { reconcilePaymentRequest, reconcilePaymentRequestBestEffort } from "./payment-requests";

const TEST_PROJECT_ID = "prj_preq_handler_test";
const TEST_WALLET_ID = "wal_preq_handler_test";
const SIGNATURE = "S".repeat(64);

let findReferenceSpy: MockInstance<typeof solanaPay.findReference>;
let validateTransferSpy: MockInstance<typeof solanaPay.validateTransfer>;

function foundSignature(): Awaited<ReturnType<typeof solanaPay.findReference>> {
  return {
    signature: SIGNATURE as Awaited<ReturnType<typeof solanaPay.findReference>>["signature"],
    slot: 1n,
    err: null,
    memo: null,
    blockTime: null,
    confirmationStatus: "confirmed",
  };
}

function mockSettlementSucceeds() {
  findReferenceSpy.mockResolvedValue(foundSignature());
  validateTransferSpy.mockResolvedValue(
    undefined as unknown as Awaited<ReturnType<typeof solanaPay.validateTransfer>>
  );
}

async function createRequest(overrides?: { token?: string; expiresAt?: string }) {
  return createPaymentRequestsRepository(env).createPaymentRequest({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT_ID,
    counterpartyId: null,
    walletId: TEST_WALLET_ID,
    destinationAddress: TEST_CUSTODY_PUBLIC_KEY,
    token: overrides?.token ?? SOL_MINT,
    amount: "1.5",
    expiresAt: overrides?.expiresAt ?? null,
    createdBy: TEST_USER.id,
  });
}

async function listInboundTransfers() {
  const result = await getDb(env)
    .prepare("SELECT * FROM payment_transfers WHERE wallet_id = ?")
    .bind(TEST_WALLET_ID)
    .all<Record<string, unknown>>();
  return result.results;
}

describe("reconcilePaymentRequest", () => {
  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    findReferenceSpy = vi.spyOn(solanaPay, "findReference");
    validateTransferSpy = vi.spyOn(solanaPay, "validateTransfer");

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
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT_ID, TEST_ORG.id, TEST_PROJECT_ID, TEST_USER.id)
      .run();
  });

  it("settles an awaiting request and links a recorded inbound transfer", async () => {
    mockSettlementSucceeds();

    const settled = await reconcilePaymentRequest(env, await createRequest());

    expect(settled.status).toBe("paid");
    expect(settled.fulfilled_by_transfer_id).not.toBeNull();

    const transfers = await listInboundTransfers();
    expect(transfers).toHaveLength(1);
    expect(transfers[0].id).toBe(settled.fulfilled_by_transfer_id);
    expect(transfers[0].direction).toBe("inbound");
    expect(transfers[0].status).toBe("confirmed");
    expect(transfers[0].signature).toBe(SIGNATURE);
  });

  it("settles an SPL request, exercising the splToken branch", async () => {
    mockSettlementSucceeds();

    const settled = await reconcilePaymentRequest(
      env,
      await createRequest({ token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" })
    );

    expect(settled.status).toBe("paid");
    const fields = validateTransferSpy.mock.calls[0][2];
    expect(fields.splToken).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  it("converges concurrent reconciles of the same request to a single settlement", async () => {
    mockSettlementSucceeds();
    const request = await createRequest();

    const [a, b] = await Promise.all([
      reconcilePaymentRequest(env, request),
      reconcilePaymentRequest(env, request),
    ]);

    expect(a.status).toBe("paid");
    expect(b.status).toBe("paid");
    expect(await listInboundTransfers()).toHaveLength(1);
  });

  it("leaves the request awaiting when no transfer references it", async () => {
    findReferenceSpy.mockRejectedValue(new FindReferenceError("not found"));

    const result = await reconcilePaymentRequest(env, await createRequest());

    expect(result.status).toBe("awaiting_payment");
    expect(result.fulfilled_by_transfer_id).toBeNull();
    expect(validateTransferSpy).not.toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("leaves the request awaiting when the referenced transfer is invalid", async () => {
    findReferenceSpy.mockResolvedValue(foundSignature());
    validateTransferSpy.mockRejectedValue(new ValidateTransferError("wrong amount"));

    const result = await reconcilePaymentRequest(env, await createRequest());

    expect(result.status).toBe("awaiting_payment");
    expect(result.fulfilled_by_transfer_id).toBeNull();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("rethrows unexpected errors instead of swallowing them", async () => {
    findReferenceSpy.mockRejectedValue(new Error("rpc exploded"));

    await expect(reconcilePaymentRequest(env, await createRequest())).rejects.toThrow(
      "rpc exploded"
    );
  });

  it("best-effort returns the stored row and logs when reconcile errors unexpectedly", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findReferenceSpy.mockRejectedValue(new Error("rpc exploded"));
    const request = await createRequest();

    const result = await reconcilePaymentRequestBestEffort(env, request);

    expect(result).toBe(request);
    expect(errorSpy).toHaveBeenCalled();
    expect(await listInboundTransfers()).toHaveLength(0);
  });

  it("short-circuits non-awaiting requests without touching the chain", async () => {
    const canceled: PaymentRequestRow = { ...(await createRequest()), status: "canceled" };

    const result = await reconcilePaymentRequest(env, canceled);

    expect(result).toBe(canceled);
    expect(findReferenceSpy).not.toHaveBeenCalled();
  });

  it("short-circuits expired requests without touching the chain", async () => {
    const expired = await createRequest({ expiresAt: "2000-01-01T00:00:00.000Z" });

    const result = await reconcilePaymentRequest(env, expired);

    expect(result.status).toBe("awaiting_payment");
    expect(findReferenceSpy).not.toHaveBeenCalled();
  });
});
