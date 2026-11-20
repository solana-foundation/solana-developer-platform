import {
  type ClosedPaymentRequestStatus,
  PAYMENT_REQUEST_CLOSED_STATUSES,
} from "@sdp/types/payments";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import {
  createPaymentRequestsRepository,
  createSystemPaymentRequestsRepository,
} from "@/db/repositories/repository-factory";
import { createTenantScope } from "@/lib/tenant-scope";
import { TEST_CUSTODY_PUBLIC_KEY } from "@/test/fixtures/custody";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  type PaymentRequestTenant,
  resetPaymentRequestTenant,
} from "@/test/helpers/payment-request-tenant";
import {
  seedPaymentRequestTransfer,
  setPaymentRequestColumns,
} from "@/test/helpers/payment-requests";
import { expectProjectScoped } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import { seedTestDatabase } from "@/test/mocks/db";
import type {
  CancelPaymentRequestInput,
  CreatePaymentRequestInput,
  PaymentRequestRow,
  PaymentRequestsRepository,
  SignatureScanPosition,
} from "./payment-requests.repository";
import { createPostgresPaymentRequestsRepository } from "./payment-requests.repository.postgres";

const TEST_PROJECT_ID = "prj_preq_repo_test";
const TEST_CUSTODY_WALLET_ID = "cwlt_preq_repo_test";
const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

async function claimWindow(id: string, lastValidBlockHeight: string) {
  await setPaymentRequestColumns(env, id, {
    sponsored_tx_account: TEST_SOLANA_ADDRESSES.wallet1,
    sponsored_tx_unsigned: "tx",
    sponsored_tx_last_valid_block_height: lastValidBlockHeight,
  });
}

function scanAt(position: Partial<SignatureScanPosition>): SignatureScanPosition {
  return {
    cursor: null,
    before: null,
    progress: null,
    cycleHadRetry: false,
    stuckSignature: null,
    stuckSince: null,
    ...position,
  };
}

describe("PaymentRequestsRepository (postgres)", () => {
  let repo: PaymentRequestsRepository;
  let tenant: PaymentRequestTenant;

  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    tenant = await resetPaymentRequestTenant(env, "preq_repo_test");
    repo = createPostgresPaymentRequestsRepository(getDb(env));
  });

  function key(request: PaymentRequestRow) {
    return { requestId: request.id, organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID };
  }

  function cancelInput(
    request: PaymentRequestRow,
    liveClaimMinLastValidBlockHeight: bigint | null
  ): CancelPaymentRequestInput {
    return {
      ...key(request),
      canceledBy: { apiKeyId: null, userId: TEST_USER.id },
      liveClaimMinLastValidBlockHeight,
    };
  }

  async function stored(request: PaymentRequestRow): Promise<PaymentRequestRow> {
    return required(await repo.getPaymentRequestById(key(request)));
  }

  function createInput(overrides: Partial<CreatePaymentRequestInput>): CreatePaymentRequestInput {
    return {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: tenant.walletId,
      destinationAddress: TEST_CUSTODY_PUBLIC_KEY,
      token: SOL_MINT,
      amount: "25.00",
      expiresAt: FUTURE,
      createdBy: TEST_USER.id,
      ...overrides,
    };
  }

  function markExpired(request: PaymentRequestRow) {
    return repo.markPaymentRequest({
      ...key(request),
      status: "expired",
      fulfilledByTransferId: null,
      paidLate: false,
      chainRead: true,
    });
  }

  function markPaid(request: PaymentRequestRow, transferId: string) {
    return repo.markPaymentRequest({
      ...key(request),
      status: "paid",
      fulfilledByTransferId: transferId,
      paidLate: false,
      chainRead: true,
    });
  }

  describe("createPaymentRequest", () => {
    it("creates an open request with its own id, link token and reference", async () => {
      const first = await repo.createPaymentRequest(createInput({}));
      const second = await repo.createPaymentRequest(createInput({}));

      expect(first).toMatchObject({
        organization_id: TEST_ORG.id,
        project_id: TEST_PROJECT_ID,
        custody_wallet_id: TEST_CUSTODY_WALLET_ID,
        wallet_id: tenant.walletId,
        destination_address: TEST_CUSTODY_PUBLIC_KEY,
        token: SOL_MINT,
        amount: "25.00",
        expires_at: FUTURE,
        created_by: TEST_USER.id,
        status: "awaiting_payment",
        lifecycle: [{ status: "awaiting_payment", at: expect.any(String) }],
        fulfilled_by_transfer_id: null,
        paid_late: false,
        canceled_at: null,
        canceled_by_api_key_id: null,
        canceled_by_user_id: null,
        signature_scan_cursor: null,
        signature_scan_before: null,
        signature_scan_progress: null,
        signature_scan_cycle_had_retry: false,
        signature_scan_stuck_signature: null,
        signature_scan_stuck_since: null,
      });
      expect(first.id).toMatch(/^preq_/);
      expect(first.public_token).toMatch(/^[A-Za-z0-9-]{16}$/);
      expect(second.id).not.toBe(first.id);
      expect(second.public_token).not.toBe(first.public_token);
      expect(second.reference).not.toBe(first.reference);
    });
  });

  describe("getPaymentRequestByPublicToken", () => {
    it("resolves a row by its public token, unscoped by org/project", async () => {
      const created = await repo.createPaymentRequest(createInput({}));

      const row = await repo.getPaymentRequestByPublicToken(created.public_token);
      expect(required(row).id).toBe(created.id);
    });

    it("returns null for an unknown token", async () => {
      const row = await repo.getPaymentRequestByPublicToken("does_not_exist0");
      expect(row).toBeNull();
    });
  });

  describe("getPaymentRequestById", () => {
    it("returns null when org doesn't match (tenancy guard)", async () => {
      const created = await repo.createPaymentRequest(createInput({}));

      const row = await repo.getPaymentRequestById({
        ...key(created),
        organizationId: "org_does_not_exist",
      });
      expect(row).toBeNull();
    });

    it("returns null when the project does not match", async () => {
      const created = await repo.createPaymentRequest(createInput({}));
      await expectProjectScoped(
        (projectId) => repo.getPaymentRequestById({ ...key(created), projectId }),
        { own: tenant.projects.sandbox, other: tenant.projects.production },
        (row) => row === null
      );
    });
  });

  describe("listPaymentRequests", () => {
    it("returns rows newest first with a total", async () => {
      const first = await repo.createPaymentRequest(createInput({}));
      const second = await repo.createPaymentRequest(createInput({}));
      await setPaymentRequestColumns(env, first.id, { created_at: "2026-01-01T00:00:00.000Z" });
      await setPaymentRequestColumns(env, second.id, { created_at: "2026-01-01T00:00:01.000Z" });

      const { rows, total } = await repo.listPaymentRequests({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        limit: 50,
        offset: 0,
      });

      expect(total).toBe(2);
      expect(rows.map((row) => row.id)).toEqual([second.id, first.id]);
    });

    it("scopes lists by project", async () => {
      await repo.createPaymentRequest(createInput({}));
      await expectProjectScoped(
        (projectId) =>
          repo.listPaymentRequests({
            organizationId: TEST_ORG.id,
            projectId,
            limit: 50,
            offset: 0,
          }),
        { own: tenant.projects.sandbox, other: tenant.projects.production },
        ({ rows }) => rows.length === 0
      );
    });

    it("filters by status, listing an open request past its expiry as expired", async () => {
      const open = await repo.createPaymentRequest(createInput({}));
      const lapsed = await repo.createPaymentRequest(createInput({ expiresAt: PAST }));
      const canceled = await repo.createPaymentRequest(createInput({}));
      await repo.cancelPaymentRequest(cancelInput(canceled, null));
      const listed = async (status: "awaiting_payment" | "expired" | "canceled") => {
        const { rows, total } = await repo.listPaymentRequests({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          status,
          limit: 50,
          offset: 0,
        });
        return { ids: rows.map((row) => row.id), total };
      };

      expect(await listed("awaiting_payment")).toEqual({ ids: [open.id], total: 1 });
      expect(await listed("expired")).toEqual({ ids: [lapsed.id], total: 1 });
      expect(await listed("canceled")).toEqual({ ids: [canceled.id], total: 1 });
    });
  });

  describe("status transitions", () => {
    it("marks an open request paid by its settling transfer", async () => {
      const created = await repo.createPaymentRequest(createInput({}));
      const transferId = await seedPaymentRequestTransfer(env, created);

      const paid = required(await markPaid(created, transferId));

      expect(paid).toMatchObject({
        status: "paid",
        fulfilled_by_transfer_id: transferId,
        paid_late: false,
      });
      expect(paid.lifecycle.map((event) => event.status)).toEqual(["awaiting_payment", "paid"]);
    });

    it("rejects a paid transition with no settling transfer (paid_requires_transfer)", async () => {
      const created = await repo.createPaymentRequest(createInput({}));

      await expect(
        repo.markPaymentRequest({
          ...key(created),
          status: "paid",
          fulfilledByTransferId: null,
          paidLate: false,
          chainRead: true,
        })
      ).rejects.toThrow(/payment_requests_paid_requires_transfer/);
    });

    it("expires an open request", async () => {
      const created = await repo.createPaymentRequest(createInput({}));

      const expired = required(await markExpired(created));

      expect(expired).toMatchObject({ status: "expired", fulfilled_by_transfer_id: null });
      expect(expired.lifecycle.map((event) => event.status)).toEqual([
        "awaiting_payment",
        "expired",
      ]);
    });

    it("cancels an open request once, recording who canceled it and when", async () => {
      const open = await repo.createPaymentRequest(createInput({}));

      const canceled = required(await repo.cancelPaymentRequest(cancelInput(open, null)));

      expect(canceled).toMatchObject({
        status: "canceled",
        canceled_by_api_key_id: null,
        canceled_by_user_id: TEST_USER.id,
        canceled_at: expect.any(String),
      });
      expect(canceled.lifecycle.map((event) => event.status)).toEqual([
        "awaiting_payment",
        "canceled",
      ]);
      expect(await repo.cancelPaymentRequest(cancelInput(open, null))).toBeNull();
      expect(await stored(open)).toEqual(canceled);
    });

    it("refuses to cancel an open request past its expires_at", async () => {
      const lapsed = await repo.createPaymentRequest(createInput({ expiresAt: PAST }));

      expect(await repo.cancelPaymentRequest(cancelInput(lapsed, null))).toBeNull();
      expect(await stored(lapsed)).toMatchObject({
        status: "awaiting_payment",
        canceled_at: null,
      });
    });

    it.each([
      ["1000", 500n, "awaiting_payment"],
      ["500", 500n, "awaiting_payment"],
      ["499", 500n, "canceled"],
      ["10", null, "awaiting_payment"],
    ] as const)(
      "leaves a request claimed through height %s, canceled against %s, %s",
      async (lastValidBlockHeight, liveClaimMinLastValidBlockHeight, status) => {
        const request = await repo.createPaymentRequest(createInput({}));
        await claimWindow(request.id, lastValidBlockHeight);

        await repo.cancelPaymentRequest(cancelInput(request, liveClaimMinLastValidBlockHeight));

        expect((await stored(request)).status).toBe(status);
      }
    );

    it("settles an expired request a late payment reached, recording lateness as given", async () => {
      const request = await repo.createPaymentRequest(createInput({ expiresAt: PAST }));
      const transferId = await seedPaymentRequestTransfer(env, request);
      await markExpired(request);
      await setPaymentRequestColumns(env, request.id, {
        last_verified_at: null,
        signature_scan_stuck_signature: "unresolved_signature",
        signature_scan_stuck_since: PAST,
      });

      const paid = required(
        await createSystemPaymentRequestsRepository(env).markExpiredPaymentRequestPaid({
          ...key(request),
          fulfilledByTransferId: transferId,
          paidLate: true,
        })
      );

      expect(paid).toMatchObject({
        status: "paid",
        paid_late: true,
        fulfilled_by_transfer_id: transferId,
        last_verified_at: expect.any(String),
        signature_scan_stuck_signature: null,
        signature_scan_stuck_since: null,
      });
      expect(paid.lifecycle.map((event) => event.status)).toEqual([
        "awaiting_payment",
        "expired",
        "paid",
      ]);
    });

    it("leaves an open request past its expires_at unpaid by the expired-request write", async () => {
      const lapsed = await repo.createPaymentRequest(createInput({ expiresAt: PAST }));
      const transferId = await seedPaymentRequestTransfer(env, lapsed);
      const before = await stored(lapsed);

      expect(
        await createSystemPaymentRequestsRepository(env).markExpiredPaymentRequestPaid({
          ...key(lapsed),
          fulfilledByTransferId: transferId,
          paidLate: true,
        })
      ).toBeNull();
      expect(await stored(lapsed)).toEqual(before);
    });

    it("settles a canceled request a late payment reached, keeping who canceled it and when", async () => {
      const request = await repo.createPaymentRequest(createInput({}));
      const transferId = await seedPaymentRequestTransfer(env, request);
      const canceled = required(await repo.cancelPaymentRequest(cancelInput(request, null)));

      const paid = required(
        await createSystemPaymentRequestsRepository(env).markCanceledPaymentRequestPaid({
          ...key(request),
          fulfilledByTransferId: transferId,
          paidLate: false,
        })
      );

      expect(paid).toMatchObject({
        status: "paid",
        paid_late: false,
        fulfilled_by_transfer_id: transferId,
        canceled_by_api_key_id: null,
        canceled_by_user_id: TEST_USER.id,
        canceled_at: canceled.canceled_at,
      });
      expect(paid.lifecycle.map((event) => event.status)).toEqual([
        "awaiting_payment",
        "canceled",
        "paid",
      ]);
    });

    const closeTo = {
      paid: (request: PaymentRequestRow, transferId: string) => markPaid(request, transferId),
      expired: (request: PaymentRequestRow) => markExpired(request),
      canceled: (request: PaymentRequestRow) =>
        repo.cancelPaymentRequest(cancelInput(request, null)),
    } satisfies Record<
      ClosedPaymentRequestStatus,
      (request: PaymentRequestRow, transferId: string) => Promise<PaymentRequestRow | null>
    >;
    const refusedWrites = {
      paid: ["pay", "expire", "cancel", "payExpired", "payCanceled"],
      expired: ["pay", "expire", "cancel", "payCanceled"],
      canceled: ["pay", "expire", "cancel", "payExpired"],
    } as const satisfies Record<ClosedPaymentRequestStatus, readonly string[]>;

    it.each(PAYMENT_REQUEST_CLOSED_STATUSES)(
      "leaves a %s request unchanged under every write that does not start from it",
      async (status) => {
        const request = await repo.createPaymentRequest(createInput({}));
        const transferId = await seedPaymentRequestTransfer(env, request);
        await closeTo[status](request, transferId);
        const before = await stored(request);
        const system = createSystemPaymentRequestsRepository(env);
        const write = {
          pay: () => markPaid(request, transferId),
          expire: () => markExpired(request),
          cancel: () => repo.cancelPaymentRequest(cancelInput(request, null)),
          payExpired: () =>
            system.markExpiredPaymentRequestPaid({
              ...key(request),
              fulfilledByTransferId: transferId,
              paidLate: true,
            }),
          payCanceled: () =>
            system.markCanceledPaymentRequestPaid({
              ...key(request),
              fulfilledByTransferId: transferId,
              paidLate: true,
            }),
        };

        for (const refused of refusedWrites[status]) {
          expect(await write[refused]()).toBeNull();
        }
        expect(await stored(request)).toEqual(before);
      }
    );

    it("leaves another project's request untouched by every write", async () => {
      const open = await repo.createPaymentRequest(createInput({}));
      const expired = await repo.createPaymentRequest(createInput({}));
      const transferId = await seedPaymentRequestTransfer(env, open);
      await markExpired(expired);
      const before = [await stored(open), await stored(expired)];
      const otherProject = { projectId: tenant.projects.production.id };

      expect(
        await repo.markPaymentRequest({
          ...key(open),
          ...otherProject,
          status: "paid",
          fulfilledByTransferId: transferId,
          paidLate: false,
          chainRead: true,
        })
      ).toBeNull();
      expect(
        await repo.markPaymentRequest({
          ...key(open),
          ...otherProject,
          status: "expired",
          fulfilledByTransferId: null,
          paidLate: false,
          chainRead: true,
        })
      ).toBeNull();
      expect(
        await repo.cancelPaymentRequest({ ...cancelInput(open, null), ...otherProject })
      ).toBeNull();
      expect(
        await repo.markExpiredPaymentRequestPaid({
          ...key(expired),
          ...otherProject,
          fulfilledByTransferId: transferId,
          paidLate: false,
        })
      ).toBeNull();
      expect(
        await repo.advanceSignatureScan({
          ...key(open),
          ...otherProject,
          from: scanAt({}),
          to: scanAt({ cursor: "sigA" }),
        })
      ).toBe(false);
      expect([await stored(open), await stored(expired)]).toEqual(before);
    });
  });

  describe("sponsored transaction window", () => {
    const ACCOUNT_A = TEST_SOLANA_ADDRESSES.wallet1;
    const ACCOUNT_B = TEST_SOLANA_ADDRESSES.wallet2;

    it("admits exactly one of two concurrent claims", async () => {
      const request = await repo.createPaymentRequest(createInput({}));
      const results = await Promise.all([
        repo.claimSponsoredTransactionWindow({
          requestId: request.id,
          account: ACCOUNT_A,
          unsignedTransaction: "dHhB",
          lastValidBlockHeight: 1_000n,
          currentBlockHeight: 900n,
        }),
        repo.claimSponsoredTransactionWindow({
          requestId: request.id,
          account: ACCOUNT_B,
          unsignedTransaction: "dHhC",
          lastValidBlockHeight: 1_000n,
          currentBlockHeight: 900n,
        }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);

      const claim = required(await repo.getSponsoredTransactionClaim(request.id));
      expect([ACCOUNT_A, ACCOUNT_B]).toContain(claim.account);
      expect(claim).toMatchObject({ signedTransaction: null, lastValidBlockHeight: 1_000n });
    });

    it("refuses a claim on a request past its deadline that is still awaiting payment", async () => {
      const request = await repo.createPaymentRequest(
        createInput({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
      );
      expect(
        await repo.claimSponsoredTransactionWindow({
          requestId: request.id,
          account: ACCOUNT_A,
          unsignedTransaction: "dHhB",
          lastValidBlockHeight: 1_000n,
          currentBlockHeight: 900n,
        })
      ).toBe(false);
      expect(await repo.getSponsoredTransactionClaim(request.id)).toBeNull();
    });

    it("refuses a reclaim while the window is live and admits one after expiry", async () => {
      const request = await repo.createPaymentRequest(createInput({}));
      expect(
        await repo.claimSponsoredTransactionWindow({
          requestId: request.id,
          account: ACCOUNT_A,
          unsignedTransaction: "dHhB",
          lastValidBlockHeight: 1_000n,
          currentBlockHeight: 900n,
        })
      ).toBe(true);
      expect(
        await repo.claimSponsoredTransactionWindow({
          requestId: request.id,
          account: ACCOUNT_B,
          unsignedTransaction: "dHhC",
          lastValidBlockHeight: 1_100n,
          currentBlockHeight: 950n,
        })
      ).toBe(false);
      expect(
        await repo.claimSponsoredTransactionWindow({
          requestId: request.id,
          account: ACCOUNT_B,
          unsignedTransaction: "dHhC",
          lastValidBlockHeight: 1_200n,
          currentBlockHeight: 1_001n,
        })
      ).toBe(true);
      expect(await repo.getSponsoredTransactionClaim(request.id)).toMatchObject({
        account: ACCOUNT_B,
        signedTransaction: null,
      });
    });

    it("stores the signature for the claiming account only", async () => {
      const request = await repo.createPaymentRequest(createInput({}));
      await repo.claimSponsoredTransactionWindow({
        requestId: request.id,
        account: ACCOUNT_A,
        unsignedTransaction: "dHhB",
        lastValidBlockHeight: 1_000n,
        currentBlockHeight: 900n,
      });
      await repo.storeSponsoredTransactionSignature({
        requestId: request.id,
        account: ACCOUNT_B,
        unsignedTransaction: "dHhB",
        signedTransaction: "c2lnQg==",
      });
      expect(
        required(await repo.getSponsoredTransactionClaim(request.id)).signedTransaction
      ).toBeNull();

      await repo.storeSponsoredTransactionSignature({
        requestId: request.id,
        account: ACCOUNT_A,
        unsignedTransaction: "dHhB",
        signedTransaction: "c2lnQQ==",
      });
      expect(required(await repo.getSponsoredTransactionClaim(request.id)).signedTransaction).toBe(
        "c2lnQQ=="
      );
    });

    it("refuses a stale signature written against superseded unsigned bytes", async () => {
      const request = await repo.createPaymentRequest(createInput({}));
      await repo.claimSponsoredTransactionWindow({
        requestId: request.id,
        account: ACCOUNT_A,
        unsignedTransaction: "dHhPbGQ=",
        lastValidBlockHeight: 1_000n,
        currentBlockHeight: 900n,
      });
      await repo.claimSponsoredTransactionWindow({
        requestId: request.id,
        account: ACCOUNT_A,
        unsignedTransaction: "dHhOZXc=",
        lastValidBlockHeight: 1_200n,
        currentBlockHeight: 1_001n,
      });

      expect(
        await repo.storeSponsoredTransactionSignature({
          requestId: request.id,
          account: ACCOUNT_A,
          unsignedTransaction: "dHhPbGQ=",
          signedTransaction: "c2lnT2xk",
        })
      ).toBe(false);
      expect(
        required(await repo.getSponsoredTransactionClaim(request.id)).signedTransaction
      ).toBeNull();

      expect(
        await repo.storeSponsoredTransactionSignature({
          requestId: request.id,
          account: ACCOUNT_A,
          unsignedTransaction: "dHhOZXc=",
          signedTransaction: "c2lnTmV3",
        })
      ).toBe(true);
      expect(required(await repo.getSponsoredTransactionClaim(request.id)).signedTransaction).toBe(
        "c2lnTmV3"
      );
    });

    it("refuses a signature once the request is paid and reports the paid status on its claim", async () => {
      const request = await repo.createPaymentRequest(createInput({}));
      await repo.claimSponsoredTransactionWindow({
        requestId: request.id,
        account: ACCOUNT_A,
        unsignedTransaction: "dHhB",
        lastValidBlockHeight: 1_000n,
        currentBlockHeight: 900n,
      });
      expect(required(await repo.getSponsoredTransactionClaim(request.id)).requestStatus).toBe(
        "awaiting_payment"
      );
      await markPaid(request, await seedPaymentRequestTransfer(env, request));

      expect(
        await repo.storeSponsoredTransactionSignature({
          requestId: request.id,
          account: ACCOUNT_A,
          unsignedTransaction: "dHhB",
          signedTransaction: "c2lnQQ==",
        })
      ).toBe(false);
      expect(await repo.getSponsoredTransactionClaim(request.id)).toMatchObject({
        requestStatus: "paid",
        signedTransaction: null,
      });
    });

    it("refuses a claim on a request that is not awaiting payment", async () => {
      const request = await repo.createPaymentRequest(createInput({}));
      await repo.cancelPaymentRequest(cancelInput(request, null));
      expect(
        await repo.claimSponsoredTransactionWindow({
          requestId: request.id,
          account: ACCOUNT_A,
          unsignedTransaction: "dHhB",
          lastValidBlockHeight: 1_000n,
          currentBlockHeight: 900n,
        })
      ).toBe(false);
    });
  });

  describe("reconciler constraint", () => {
    it("refuses paid_late on a request that is not paid", async () => {
      const request = await repo.createPaymentRequest(createInput({ token: SOL_MINT }));
      await expect(
        getDb(env)
          .prepare("UPDATE payment_requests SET paid_late = true WHERE id = ?")
          .bind(request.id)
          .run()
      ).rejects.toThrow(/payment_requests_paid_late_only_when_paid/);
    });
  });

  describe("reconciler queries", () => {
    it("lists hot requests whose sponsored transaction can still land", async () => {
      const live = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: null })
      );
      const lapsedClaim = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: null })
      );
      await repo.createPaymentRequest(createInput({ token: SOL_MINT, expiresAt: null }));
      await claimWindow(live.id, "1000");
      await claimWindow(lapsedClaim.id, "10");

      const rows = await createSystemPaymentRequestsRepository(env).listHotPaymentRequests({
        environment: "sandbox",
        minLastValidBlockHeight: 500n,
        limit: 10,
      });

      expect(rows.map((row) => row.id)).toEqual([live.id]);
    });

    it("probes for an open sponsored window in one environment only", async () => {
      const systemRepo = createSystemPaymentRequestsRepository(env);
      const request = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: null })
      );
      // Awaiting without a window: the hot lane has no height to compare.
      expect(await systemRepo.hasHotPaymentRequests({ environment: "sandbox" })).toBe(false);

      // Any window counts, live or not: the lane's height bound decides that.
      await claimWindow(request.id, "10");
      expect(await systemRepo.hasHotPaymentRequests({ environment: "sandbox" })).toBe(true);
      expect(await systemRepo.hasHotPaymentRequests({ environment: "production" })).toBe(false);

      // An expired request belongs to the expiry lane.
      await setPaymentRequestColumns(env, request.id, { expires_at: PAST });
      expect(await systemRepo.hasHotPaymentRequests({ environment: "sandbox" })).toBe(false);
    });

    it("probes for a lapsed request due for its expiry check in one environment only", async () => {
      const systemRepo = createSystemPaymentRequestsRepository(env);
      const checkedBefore = ago(45 * SECOND);
      await repo.createPaymentRequest(createInput({ token: SOL_MINT, expiresAt: FUTURE }));
      expect(
        await systemRepo.hasLapsedPaymentRequests({ environment: "sandbox", checkedBefore })
      ).toBe(false);

      const lapsed = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: PAST })
      );
      expect(
        await systemRepo.hasLapsedPaymentRequests({ environment: "sandbox", checkedBefore })
      ).toBe(true);
      expect(
        await systemRepo.hasLapsedPaymentRequests({ environment: "production", checkedBefore })
      ).toBe(false);

      // A lapse checked since the cutoff waits for its next turn, as the list does.
      await setPaymentRequestColumns(env, lapsed.id, { last_checked_at: ago(SECOND) });
      expect(
        await systemRepo.hasLapsedPaymentRequests({ environment: "sandbox", checkedBefore })
      ).toBe(false);
    });

    it("lists unexpired awaiting requests not checked since the cutoff, never-checked first", async () => {
      const never = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: null })
      );
      const old = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: null })
      );
      const fresh = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: null })
      );
      const lapsed = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: PAST })
      );
      await setPaymentRequestColumns(env, old.id, { last_checked_at: "2026-01-01T00:00:00.000Z" });
      await setPaymentRequestColumns(env, fresh.id, { last_checked_at: FUTURE });

      const rows = await createSystemPaymentRequestsRepository(env).listPaymentRequestsDueForCheck({
        environment: "sandbox",
        recentCheckedBefore: "2026-06-01T00:00:00.000Z",
        agedCheckedBefore: "2026-06-01T00:00:00.000Z",
        agedCreatedBefore: "2000-01-01T00:00:00.000Z",
        limit: 10,
      });

      expect(rows.map((row) => row.id)).toEqual([never.id, old.id]);
      expect(rows.map((row) => row.id)).not.toContain(lapsed.id);
    });

    it("does not list another environment's requests", async () => {
      await repo.createPaymentRequest(createInput({ token: SOL_MINT, expiresAt: null }));
      const rows = await createSystemPaymentRequestsRepository(env).listPaymentRequestsDueForCheck({
        environment: "production",
        recentCheckedBefore: FUTURE,
        agedCheckedBefore: FUTURE,
        agedCreatedBefore: FUTURE,
        limit: 10,
      });
      expect(rows).toEqual([]);
    });

    it("lists awaiting requests past expires_at as lapsed", async () => {
      const lapsed = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: PAST })
      );
      await repo.createPaymentRequest(createInput({ token: SOL_MINT, expiresAt: FUTURE }));
      await repo.createPaymentRequest(createInput({ token: SOL_MINT, expiresAt: null }));

      const rows = await createSystemPaymentRequestsRepository(env).listLapsedPaymentRequests({
        environment: "sandbox",
        checkedBefore: ago(45 * SECOND),
        liveClaimMinLastValidBlockHeight: 500n,
        limit: 10,
      });

      expect(rows.map((row) => row.id)).toEqual([lapsed.id]);
    });

    it("lists never-checked lapses first, oldest lapse first, then the longest unchecked", async () => {
      const recentlyChecked = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: "2019-01-01T00:00:00.000Z" })
      );
      const neverCheckedNewer = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: ago(MINUTE) })
      );
      const longUnchecked = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: "2019-06-01T00:00:00.000Z" })
      );
      const neverCheckedOlder = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: PAST })
      );
      await setPaymentRequestColumns(env, recentlyChecked.id, { last_checked_at: ago(MINUTE) });
      await setPaymentRequestColumns(env, longUnchecked.id, { last_checked_at: ago(DAY) });

      const rows = await createSystemPaymentRequestsRepository(env).listLapsedPaymentRequests({
        environment: "sandbox",
        checkedBefore: ago(45 * SECOND),
        liveClaimMinLastValidBlockHeight: 500n,
        limit: 10,
      });

      expect(rows.map((row) => row.id)).toEqual([
        neverCheckedOlder.id,
        neverCheckedNewer.id,
        longUnchecked.id,
        recentlyChecked.id,
      ]);
    });

    it("rotates lapsed rows a run just checked behind the ones it did not reach", async () => {
      const lapses = [];
      for (const expiresAt of [ago(3 * DAY), ago(2 * DAY), ago(DAY)]) {
        lapses.push(await repo.createPaymentRequest(createInput({ token: SOL_MINT, expiresAt })));
      }
      const [first, second, third] = lapses.map((row) => row.id);
      const systemRepo = createSystemPaymentRequestsRepository(env);
      const listDue = () =>
        systemRepo.listLapsedPaymentRequests({
          environment: "sandbox",
          checkedBefore: new Date(Date.now() + MINUTE).toISOString(),
          liveClaimMinLastValidBlockHeight: 500n,
          limit: 2,
        });

      const firstRun = await listDue();
      await systemRepo.markPaymentRequestsChecked(
        firstRun.map((row) => ({ id: row.id, outcome: { kind: "skipped" } }))
      );
      const secondRun = await listDue();

      expect(firstRun.map((row) => row.id)).toEqual([first, second]);
      expect(secondRun.map((row) => row.id)[0]).toBe(third);
    });

    it("skips lapsed requests checked since the cutoff so failing rows rotate", async () => {
      const due = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: PAST })
      );
      const justChecked = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: "2021-01-01T00:00:00.000Z" })
      );
      await setPaymentRequestColumns(env, due.id, { last_checked_at: ago(MINUTE) });
      await setPaymentRequestColumns(env, justChecked.id, { last_checked_at: ago(SECOND) });

      const rows = await createSystemPaymentRequestsRepository(env).listLapsedPaymentRequests({
        environment: "sandbox",
        checkedBefore: ago(45 * SECOND),
        liveClaimMinLastValidBlockHeight: 500n,
        limit: 10,
      });

      expect(rows.map((row) => row.id)).toEqual([due.id]);
    });

    it("skips lapsed requests whose sponsored transaction can still land", async () => {
      const live = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: PAST })
      );
      const atBoundary = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: PAST })
      );
      const passed = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: PAST })
      );
      const unclaimed = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: PAST })
      );
      await claimWindow(live.id, "1000");
      await claimWindow(atBoundary.id, "500");
      await claimWindow(passed.id, "499");

      const rows = await createSystemPaymentRequestsRepository(env).listLapsedPaymentRequests({
        environment: "sandbox",
        checkedBefore: ago(45 * SECOND),
        liveClaimMinLastValidBlockHeight: 500n,
        limit: 10,
      });

      expect(rows.map((row) => row.id).sort()).toEqual([passed.id, unclaimed.id].sort());
    });

    it("does not list another environment's lapsed requests", async () => {
      await repo.createPaymentRequest(createInput({ token: SOL_MINT, expiresAt: PAST }));

      const rows = await createSystemPaymentRequestsRepository(env).listLapsedPaymentRequests({
        environment: "production",
        checkedBefore: ago(45 * SECOND),
        liveClaimMinLastValidBlockHeight: 500n,
        limit: 10,
      });

      expect(rows).toEqual([]);
    });

    it("rechecks requests older than the age cutoff less often", async () => {
      const young = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: null })
      );
      const agedRecent = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: null })
      );
      const agedDue = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: null })
      );
      const youngFresh = await repo.createPaymentRequest(
        createInput({ token: SOL_MINT, expiresAt: null })
      );
      await setPaymentRequestColumns(env, young.id, { last_checked_at: ago(MINUTE) });
      await setPaymentRequestColumns(env, youngFresh.id, { last_checked_at: ago(10 * SECOND) });
      await setPaymentRequestColumns(env, agedRecent.id, {
        created_at: ago(2 * DAY),
        last_checked_at: ago(MINUTE),
      });
      await setPaymentRequestColumns(env, agedDue.id, {
        created_at: ago(2 * DAY),
        last_checked_at: ago(20 * MINUTE),
      });

      const rows = await createSystemPaymentRequestsRepository(env).listPaymentRequestsDueForCheck({
        environment: "sandbox",
        recentCheckedBefore: ago(45 * SECOND),
        agedCheckedBefore: ago(10 * MINUTE),
        agedCreatedBefore: ago(DAY),
        limit: 10,
      });

      expect(rows.map((row) => row.id)).toEqual([agedDue.id, young.id]);
    });

    it("stamps last_checked_at on every listed id and last_verified_at only on verified ones", async () => {
      const a = await repo.createPaymentRequest(createInput({ token: SOL_MINT, expiresAt: null }));
      const b = await repo.createPaymentRequest(createInput({ token: SOL_MINT, expiresAt: null }));
      const systemRepo = createSystemPaymentRequestsRepository(env);

      await systemRepo.markPaymentRequestsChecked([
        { id: a.id, outcome: { kind: "read" } },
        { id: b.id, outcome: { kind: "skipped" } },
      ]);

      const rows = [await stored(a), await stored(b)];
      expect(rows.map((row) => row.last_checked_at === null)).toEqual([false, false]);
      expect(rows.map((row) => row.last_verified_at === null)).toEqual([false, true]);
    });

    it("records a block, keeps it on a skip, and clears it on a read or a failure", async () => {
      const systemRepo = createSystemPaymentRequestsRepository(env);
      const create = async () =>
        (await repo.createPaymentRequest(createInput({ token: SOL_MINT, expiresAt: null }))).id;
      const blocked = await create();
      const skipped = await create();
      const read = await create();
      const failed = await create();
      for (const id of [skipped, read, failed]) {
        await setPaymentRequestColumns(env, id, { settlement_blocked_reason: "invalid_amount" });
      }

      await systemRepo.markPaymentRequestsChecked([
        { id: blocked, outcome: { kind: "blocked", reason: "mint_not_admitted" } },
        { id: skipped, outcome: { kind: "skipped" } },
        { id: read, outcome: { kind: "read" } },
        { id: failed, outcome: { kind: "failed" } },
      ]);

      const rows = await Promise.all(
        [blocked, skipped, read, failed].map(async (requestId) =>
          required(
            await repo.getPaymentRequestById({
              requestId,
              organizationId: TEST_ORG.id,
              projectId: TEST_PROJECT_ID,
            })
          )
        )
      );
      expect(rows.map((row) => row.settlement_blocked_reason)).toEqual([
        "mint_not_admitted",
        "invalid_amount",
        null,
        null,
      ]);
      expect(rows.map((row) => row.last_verified_at === null)).toEqual([true, true, false, true]);
    });

    describe("listClosedPaymentRequestsForLateCheck", () => {
      async function closedRequest(fields: Record<string, string | null>) {
        const request = await repo.createPaymentRequest(
          createInput({ token: SOL_MINT, expiresAt: null })
        );
        await setPaymentRequestColumns(env, request.id, {
          status: "expired",
          last_checked_at: PAST,
          ...fields,
        });
        return request;
      }

      function listLateCheck(environment: "sandbox" | "production" = "sandbox") {
        return createSystemPaymentRequestsRepository(env).listClosedPaymentRequestsForLateCheck({
          environment,
          closedSince: ago(7 * DAY),
          checkedBefore: ago(10 * MINUTE),
          limit: 10,
        });
      }

      it("lists expired requests inside the late-payment window only", async () => {
        const inside = await closedRequest({ expires_at: ago(6 * DAY) });
        await closedRequest({ expires_at: ago(8 * DAY) });

        expect((await listLateCheck()).map((row) => row.id)).toEqual([inside.id]);
      });

      it("keeps an older expired request in the watch while a signature is unresolved", async () => {
        const unresolved = await closedRequest({
          expires_at: ago(8 * DAY),
          signature_scan_stuck_signature: "unresolved_signature",
          signature_scan_stuck_since: ago(8 * DAY),
        });

        expect((await listLateCheck()).map((row) => row.id)).toEqual([unresolved.id]);
      });

      it("lists canceled requests by when they were canceled, not when they expire", async () => {
        const canceled = {
          status: "canceled",
          canceled_by_user_id: TEST_USER.id,
          expires_at: FUTURE,
        };
        const inside = await closedRequest({ ...canceled, canceled_at: ago(6 * DAY) });
        await closedRequest({ ...canceled, canceled_at: ago(8 * DAY) });

        expect((await listLateCheck()).map((row) => row.id)).toEqual([inside.id]);
      });

      it("skips expired requests checked since the cutoff", async () => {
        const due = await closedRequest({ expires_at: ago(DAY) });
        await closedRequest({ expires_at: ago(DAY), last_checked_at: ago(MINUTE) });

        expect((await listLateCheck()).map((row) => row.id)).toEqual([due.id]);
      });

      it("skips expired requests with no resolved receiving wallet", async () => {
        await closedRequest({ expires_at: ago(DAY), custody_wallet_id: null });

        expect(await listLateCheck()).toEqual([]);
      });

      it("does not list another environment's expired requests", async () => {
        await closedRequest({ expires_at: ago(DAY) });

        expect(await listLateCheck("production")).toEqual([]);
      });
    });

    describe("countStaleAwaitingPaymentRequests", () => {
      function countStale(environment: "sandbox" | "production" = "sandbox") {
        return createSystemPaymentRequestsRepository(env).countStaleAwaitingPaymentRequests({
          environment,
          checkedBefore: ago(10 * MINUTE),
        });
      }

      async function staleRequest(expiresAt: string | null, fields = {}) {
        const request = await repo.createPaymentRequest(
          createInput({ token: SOL_MINT, expiresAt })
        );
        await setPaymentRequestColumns(env, request.id, {
          created_at: PAST,
          last_verified_at: PAST,
          ...fields,
        });
        return request;
      }

      it("counts unexpired awaiting requests not checked since the cutoff", async () => {
        await staleRequest(null);
        await staleRequest(FUTURE);
        await staleRequest(null, { last_verified_at: ago(MINUTE) });

        expect(await countStale()).toBe(2);
      });

      it("counts a request attempted recently but not verified since the cutoff", async () => {
        await staleRequest(null, { last_checked_at: ago(MINUTE) });

        expect(await countStale()).toBe(1);
      });

      it("excludes a request blocked by its mint or amount", async () => {
        await staleRequest(null, { settlement_blocked_reason: "mint_not_admitted" });

        expect(await countStale()).toBe(0);
      });

      it("excludes lapsed requests, which the expiry lane owns", async () => {
        await staleRequest(PAST);

        expect(await countStale()).toBe(0);
      });

      it("excludes requests with no resolved receiving wallet", async () => {
        await staleRequest(null, { custody_wallet_id: null });

        expect(await countStale()).toBe(0);
      });

      it("excludes another environment's requests", async () => {
        await staleRequest(null);

        expect(await countStale("production")).toBe(0);
      });
    });

    describe("countStaleLateWatchPaymentRequests", () => {
      async function expiredRequest(fields: Record<string, string | null>) {
        const request = await repo.createPaymentRequest(
          createInput({ token: SOL_MINT, expiresAt: null })
        );
        await setPaymentRequestColumns(env, request.id, {
          status: "expired",
          last_verified_at: PAST,
          ...fields,
        });
        return request;
      }

      function countStaleLateWatch(environment: "sandbox" | "production" = "sandbox") {
        return createSystemPaymentRequestsRepository(env).countStaleLateWatchPaymentRequests({
          environment,
          closedSince: ago(7 * DAY),
          checkedBefore: ago(20 * MINUTE),
        });
      }

      it("counts expired requests inside the window not checked since the cutoff", async () => {
        await expiredRequest({ expires_at: ago(DAY) });
        await expiredRequest({ expires_at: ago(8 * DAY) });
        await expiredRequest({ expires_at: ago(DAY), last_verified_at: ago(MINUTE) });
        await expiredRequest({ expires_at: ago(DAY), last_checked_at: ago(MINUTE) });
        await expiredRequest({ expires_at: ago(DAY), custody_wallet_id: null });

        expect(await countStaleLateWatch()).toBe(2);
        await expiredRequest({ expires_at: ago(DAY), settlement_blocked_reason: "invalid_amount" });
        expect(await countStaleLateWatch()).toBe(2);
        expect(await countStaleLateWatch("production")).toBe(0);
      });

      it("counts an old unresolved signature as still watched", async () => {
        await expiredRequest({
          expires_at: ago(8 * DAY),
          signature_scan_stuck_signature: "unresolved_signature",
          signature_scan_stuck_since: ago(8 * DAY),
        });

        expect(await countStaleLateWatch()).toBe(1);
      });
    });

    describe("countStaleLapsedPaymentRequests", () => {
      function countStaleLapsed(environment: "sandbox" | "production" = "sandbox") {
        return createSystemPaymentRequestsRepository(env).countStaleLapsedPaymentRequests({
          environment,
          checkedBefore: ago(10 * MINUTE),
        });
      }

      async function lapsedRequest(
        expiresAt: string | null,
        fields: Record<string, string | null> = {}
      ) {
        const request = await repo.createPaymentRequest(
          createInput({ token: SOL_MINT, expiresAt })
        );
        if (Object.keys(fields).length > 0) {
          await setPaymentRequestColumns(env, request.id, fields);
        }
        return request;
      }

      it("counts lapsed awaiting requests not checked since the cutoff", async () => {
        await lapsedRequest(PAST);
        await lapsedRequest(PAST, { last_verified_at: ago(DAY) });
        await lapsedRequest(PAST, { last_verified_at: ago(MINUTE) });
        await lapsedRequest(ago(MINUTE));

        expect(await countStaleLapsed()).toBe(2);
      });

      it("counts a blocked lapse, which needs no chain read to close", async () => {
        await lapsedRequest(PAST, { settlement_blocked_reason: "mint_not_admitted" });

        expect(await countStaleLapsed()).toBe(1);
      });

      it("counts a lapse attempted recently but not verified since the cutoff", async () => {
        await lapsedRequest(PAST, { last_checked_at: ago(MINUTE), last_verified_at: ago(DAY) });

        expect(await countStaleLapsed()).toBe(1);
      });

      it("excludes unexpired requests, which the awaiting lanes own", async () => {
        await lapsedRequest(null, { created_at: PAST });
        await lapsedRequest(FUTURE, { created_at: PAST });

        expect(await countStaleLapsed()).toBe(0);
      });

      it("excludes requests with no resolved receiving wallet", async () => {
        await lapsedRequest(PAST, { custody_wallet_id: null });

        expect(await countStaleLapsed()).toBe(0);
      });

      it("excludes stored-expired and another environment's requests", async () => {
        await lapsedRequest(PAST, { status: "expired" });
        await lapsedRequest(PAST);

        expect(await countStaleLapsed()).toBe(1);
        expect(await countStaleLapsed("production")).toBe(0);
      });
    });

    describe("advanceSignatureScan", () => {
      it("moves the scan position when the expected position matches", async () => {
        const created = await repo.createPaymentRequest(createInput({}));

        const advanced = await repo.advanceSignatureScan({
          ...key(created),
          from: scanAt({}),
          to: scanAt({
            cursor: "sigA",
            before: "sigB",
            progress: "sigProgress",
            cycleHadRetry: true,
            stuckSignature: "sigC",
            stuckSince: PAST,
          }),
        });

        expect(advanced).toBe(true);
        expect(await repo.getPaymentRequestById(key(created))).toMatchObject({
          signature_scan_cursor: "sigA",
          signature_scan_before: "sigB",
          signature_scan_progress: "sigProgress",
          signature_scan_cycle_had_retry: true,
          signature_scan_stuck_signature: "sigC",
          signature_scan_stuck_since: PAST,
        });
      });

      it("does not overwrite a newer position with a stale expected one", async () => {
        const created = await repo.createPaymentRequest(createInput({}));
        await repo.advanceSignatureScan({
          ...key(created),
          from: scanAt({}),
          to: scanAt({ cursor: "sigNewer" }),
        });

        const stale = await repo.advanceSignatureScan({
          ...key(created),
          from: scanAt({}),
          to: scanAt({ cursor: "sigOlder" }),
        });
        const staleBefore = await repo.advanceSignatureScan({
          ...key(created),
          from: scanAt({ cursor: "sigNewer", before: "sigOther" }),
          to: scanAt({ cursor: "sigOlder" }),
        });

        expect(stale).toBe(false);
        expect(staleBefore).toBe(false);
        expect(await repo.getPaymentRequestById(key(created))).toMatchObject({
          signature_scan_cursor: "sigNewer",
          signature_scan_before: null,
        });
      });

      it("does not overwrite a position whose stuck signature changed meanwhile", async () => {
        const created = await repo.createPaymentRequest(createInput({}));
        await repo.advanceSignatureScan({
          ...key(created),
          from: scanAt({}),
          to: scanAt({ stuckSignature: "sigStuck", stuckSince: PAST }),
        });

        const staleStuck = await repo.advanceSignatureScan({
          ...key(created),
          from: scanAt({ stuckSignature: "sigStuck", stuckSince: FUTURE }),
          to: scanAt({ cursor: "sigStuck" }),
        });
        const staleClear = await repo.advanceSignatureScan({
          ...key(created),
          from: scanAt({}),
          to: scanAt({ stuckSignature: "sigOther", stuckSince: FUTURE }),
        });

        expect(staleStuck).toBe(false);
        expect(staleClear).toBe(false);
        expect(await repo.getPaymentRequestById(key(created))).toMatchObject({
          signature_scan_cursor: null,
          signature_scan_stuck_signature: "sigStuck",
          signature_scan_stuck_since: PAST,
        });
      });

      it("is available to tenant callers of the request's project", async () => {
        const created = await repo.createPaymentRequest(createInput({}));
        const tenant = createPaymentRequestsRepository(
          env,
          createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID })
        );

        expect(
          await tenant.advanceSignatureScan({
            ...key(created),
            from: scanAt({}),
            to: scanAt({ cursor: "sigA" }),
          })
        ).toBe(true);
      });
    });

    it("denies the reconciler methods to tenant callers", () => {
      const tenant = createPaymentRequestsRepository(
        env,
        createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID })
      );
      expect(() => tenant.markPaymentRequestsChecked([])).toThrow(/system-only/);
      expect(() =>
        tenant.countStaleLapsedPaymentRequests({ environment: "sandbox", checkedBefore: PAST })
      ).toThrow(/system-only/);
    });
  });
});
