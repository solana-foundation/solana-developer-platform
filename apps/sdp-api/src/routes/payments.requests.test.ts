import type { ListPaymentRequestsResponse, PaymentRequest } from "@sdp/types";
import { SOL_MINT } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { getDb } from "@/db";
import type {
  CreatePaymentRequestInput,
  PaymentRequestRow,
} from "@/db/repositories/payment-requests.repository";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import app from "@/index";
import { createTenantScope } from "@/lib/tenant-scope";
import * as paymentRequestsService from "@/services/payments/payment-requests";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  installPaymentsRouteTestHooks,
  seedCounterparty,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";

type ListBody = { data: ListPaymentRequestsResponse };
type ReadBody = { data: PaymentRequest };
type ErrorBody = { error: { code: string } };

describe("Payments routes — payment requests", () => {
  installPaymentsRouteTestHooks();

  let reconcileSpy: MockInstance<typeof paymentRequestsService.reconcilePaymentRequest>;

  // Every read reconciles against the chain; the stub keeps the stored row so
  // these tests exercise the routes, not the RPC path, and each test can
  // replace the behaviour for the rows it cares about.
  beforeEach(() => {
    reconcileSpy = vi
      .spyOn(paymentRequestsService, "reconcilePaymentRequest")
      .mockImplementation(async (_env, row) => row);
  });

  afterEach(() => {
    reconcileSpy.mockRestore();
  });

  function requestsRepo() {
    return createPaymentRequestsRepository(
      env,
      createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
    );
  }

  function createRequest(overrides: Partial<CreatePaymentRequestInput> = {}) {
    return requestsRepo().createPaymentRequest({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      counterpartyId: null,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: TEST_WALLET_ID,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet1,
      token: SOL_MINT,
      amount: "1.5",
      expiresAt: null,
      createdBy: TEST_USER.id,
      ...overrides,
    });
  }

  function listRequests(query: string) {
    return app.request(
      `/v1/payments/requests?${query}`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
  }

  function readRequest(requestId: string) {
    return app.request(
      `/v1/payments/requests/${requestId}`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
  }

  async function settleOnChain(row: PaymentRequestRow): Promise<PaymentRequestRow> {
    if (row.status !== "awaiting_payment") {
      return row;
    }
    const transferId = `xfr_${row.id}`;
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id, organization_id, project_id, wallet_id, source_address, destination_address,
           token, amount, type, direction, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'transfer', 'inbound', 'confirmed',
                   sdp_iso_now(), sdp_iso_now())`
      )
      .bind(
        transferId,
        row.organization_id,
        row.project_id,
        row.wallet_id,
        TEST_SOLANA_ADDRESSES.wallet2,
        row.destination_address,
        row.token,
        row.amount
      )
      .run();
    const settled = await requestsRepo().markPaymentRequest({
      requestId: row.id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      status: "paid",
      fulfilledByTransferId: transferId,
      canceledBy: null,
    });
    if (!settled) {
      throw new Error("settleOnChain: request was not awaiting payment");
    }
    return settled;
  }

  describe("list", () => {
    it("narrows the page to requests matching the search needle", async () => {
      const counterpartyId = await seedCounterparty();
      const named = await createRequest({ counterpartyId });
      const plain = await createRequest({ amount: "42.25" });

      const byName = await listRequests("search=moonpay%20test");
      expect(byName.status).toBe(200);
      const byNameBody = (await byName.json()) as ListBody;
      expect(byNameBody.data.paymentRequests.map((request) => request.id)).toEqual([named.id]);
      expect(byNameBody.data.total).toBe(1);

      const byAmount = await listRequests("search=42.2");
      const byAmountBody = (await byAmount.json()) as ListBody;
      expect(byAmountBody.data.paymentRequests.map((request) => request.id)).toEqual([plain.id]);
      expect(byAmountBody.data.total).toBe(1);
    });

    it("rejects a search needle longer than 200 characters", async () => {
      const response = await listRequests(`search=${"a".repeat(201)}`);

      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorBody).error.code).toBe("BAD_REQUEST");
    });

    it("reconciles the open requests before applying the awaiting_payment filter, once each", async () => {
      const open = await createRequest();

      const response = await listRequests("status=awaiting_payment");

      expect(response.status).toBe(200);
      const body = (await response.json()) as ListBody;
      expect(body.data.paymentRequests.map((request) => request.id)).toEqual([open.id]);
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(reconcileSpy.mock.calls[0]?.[1].id).toBe(open.id);
    });

    it("moves a request the sweep settles from the awaiting list to the paid list", async () => {
      const open = await createRequest();
      reconcileSpy.mockImplementation((_env, row) => settleOnChain(row));

      const awaiting = await listRequests("status=awaiting_payment");
      expect(awaiting.status).toBe(200);
      const awaitingBody = (await awaiting.json()) as ListBody;
      expect(awaitingBody.data.paymentRequests).toEqual([]);
      expect(awaitingBody.data.total).toBe(0);
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(reconcileSpy.mock.calls[0]?.[1].id).toBe(open.id);

      const paid = await listRequests("status=paid");
      expect(paid.status).toBe(200);
      const paidBody = (await paid.json()) as ListBody;
      expect(paidBody.data.paymentRequests.map((request) => request.id)).toEqual([open.id]);
      expect(paidBody.data.paymentRequests[0]?.status).toBe("paid");
    });

    it("does not sweep open requests for other status filters", async () => {
      await createRequest();

      const response = await listRequests("status=canceled");

      expect(response.status).toBe(200);
      expect(((await response.json()) as ListBody).data.total).toBe(0);
      expect(reconcileSpy).not.toHaveBeenCalled();
    });
  });

  describe("read by id", () => {
    it("returns the reconciled request", async () => {
      const created = await createRequest();

      const response = await readRequest(created.id);

      expect(response.status).toBe(200);
      const body = (await response.json()) as ReadBody;
      expect(body.data).toMatchObject({
        id: created.id,
        publicToken: created.public_token,
        status: "awaiting_payment",
        amount: "1.5",
      });
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
    });

    it("answers 404 for an unknown request", async () => {
      const response = await readRequest("preq_does_not_exist");

      expect(response.status).toBe(404);
      expect(((await response.json()) as ErrorBody).error.code).toBe("NOT_FOUND");
      expect(reconcileSpy).not.toHaveBeenCalled();
    });
  });
});
