import type { PaymentRecurringPaymentResponse } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWindowPathname } from "@/test/window-location";
import {
  createRecurringPayment,
  getRecurringPayment,
  updateRecurringPayment,
} from "./recurring-payments.data";
import { getRecurringPayment as getRedesignRecurringPayment } from "./recurring-payments.data.redesign";

const t: Parameters<typeof createRecurringPayment>[2] = (key) => key;

const responseEnvelope = {
  data: {
    recurringPayment: {
      id: "prp_1",
      organizationId: "org_1",
      projectId: "project_1",
      sourceCustodyWalletId: "cwlt_create",
      sourceAddress: "source-address-1",
      counterpartyId: "cpty_1",
      counterpartyAccountId: "cpa_1",
      destinationAddress: "destination-address-1",
      destinationTokenAccount: null,
      token: "USDC",
      amount: "1",
      periodHours: 24,
      firstCollectionAt: null,
      nextCollectionDueAt: null,
      planId: null,
      subscriptionId: null,
      planPda: null,
      planCreatedAt: null,
      planCreationSignature: null,
      subscriptionPda: null,
      subscriptionAuthorityAddress: null,
      authorizationSignature: null,
      status: "pending_activation",
      metadataUri: null,
      createdBy: null,
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
    },
  },
} satisfies { data: PaymentRecurringPaymentResponse };

describe("recurring payment write requests", () => {
  beforeEach(() => setWindowPathname("/dashboard/prj_test_sandbox/payments/recurring"));
  afterEach(() => vi.unstubAllGlobals());

  it.each([getRecurringPayment, getRedesignRecurringPayment])(
    "reads saved exact identity and address without exposing provider response metadata",
    async (getPayment) => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(
          Response.json({
            data: {
              recurringPayment: {
                ...responseEnvelope.data.recurringPayment,
                sourceProviderWalletId: "provider-wallet-1",
              },
            },
          })
        )
      );
      const payment = await getPayment("prp_1", undefined, t);
      expect(payment.sourceCustodyWalletId).toBe("cwlt_create");
      expect(payment.sourceAddress).toBe("source-address-1");
      expect(payment).not.toHaveProperty("sourceProviderWalletId");
    }
  );

  it("sends the exact SDP Wallet ID for create and source replacement", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify(responseEnvelope), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const headers = new Headers({
      "Content-Type": "application/json",
      "x-project-id": "prj_test_sandbox",
    });

    await createRecurringPayment(
      {
        sourceCustodyWalletId: "cwlt_create",
        counterpartyId: "cpty_1",
        counterpartyAccountId: "cpa_1",
        token: "USDC",
        amount: "1",
        periodHours: 24,
      },
      undefined,
      t
    );
    await updateRecurringPayment(
      "prp_1",
      { sourceCustodyWalletId: "cwlt_replacement" },
      undefined,
      t
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/dashboard/payments/recurring-payments", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sourceCustodyWalletId: "cwlt_create",
        counterpartyId: "cpty_1",
        counterpartyAccountId: "cpa_1",
        token: "USDC",
        amount: "1",
        periodHours: 24,
      }),
      signal: undefined,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/dashboard/payments/recurring-payments/prp_1",
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ sourceCustodyWalletId: "cwlt_replacement" }),
        signal: undefined,
      }
    );
  });
});
