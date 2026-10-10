import type { PaymentRecurringPaymentResponse } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWindowPathname } from "@/test/window-location";
import { createRecurringPayment, updateRecurringPayment } from "./recurring-payments.data";

const t: Parameters<typeof createRecurringPayment>[2] = (key) => key;

const responseEnvelope = {
  data: {
    recurringPayment: {
      id: "prp_1",
      organizationId: "org_1",
      projectId: "project_1",
      sourceCustodyWalletId: "cwlt_create",
      sourceProviderWalletId: "provider-wallet-1",
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
    const [create, update] = fetchMock.mock.calls;
    expect(create?.[0]).toBe("/api/dashboard/payments/recurring-payments");
    expect(create?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        sourceCustodyWalletId: "cwlt_create",
        counterpartyId: "cpty_1",
        counterpartyAccountId: "cpa_1",
        token: "USDC",
        amount: "1",
        periodHours: 24,
      }),
    });
    expect(update?.[0]).toBe("/api/dashboard/payments/recurring-payments/prp_1");
    expect(update?.[1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ sourceCustodyWalletId: "cwlt_replacement" }),
    });
    for (const call of [create, update]) {
      const sent = new Headers(call?.[1]?.headers);
      for (const [name, value] of headers) expect(sent.get(name)).toBe(value);
      // Each write carries the key for its own user action (HOO-1918).
      expect(sent.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
