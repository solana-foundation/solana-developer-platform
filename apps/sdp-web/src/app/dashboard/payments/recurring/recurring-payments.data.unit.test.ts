import type { PaymentRecurringPaymentResponse } from "@sdp/types";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const successResponse = () =>
  Promise.resolve(
    new Response(JSON.stringify(responseEnvelope), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );

const sentIdempotencyKey = (call: Parameters<typeof fetch> | undefined) =>
  new Headers(
    (call as [string, RequestInit | undefined] | undefined)?.[1]?.headers ?? undefined
  ).get("Idempotency-Key");

const CREATE_INPUT = {
  sourceCustodyWalletId: "cwlt_create",
  counterpartyId: "cpty_1",
  counterpartyAccountId: "cpa_1",
  token: "USDC",
  amount: "1",
  periodHours: 24,
} satisfies Parameters<typeof createRecurringPayment>[0];

describe("recurring payment write requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the exact SDP Wallet ID for create and source replacement, minting an Idempotency-Key for the create", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(successResponse);
    vi.stubGlobal("fetch", fetchMock);

    await createRecurringPayment(CREATE_INPUT, undefined, t);
    await updateRecurringPayment(
      "prp_1",
      { sourceCustodyWalletId: "cwlt_replacement" },
      undefined,
      t
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/dashboard/payments/recurring-payments", {
      method: "POST",
      headers: expect.objectContaining({ "Content-Type": "application/json" }),
      body: JSON.stringify(CREATE_INPUT),
      signal: undefined,
    });
    expect(sentIdempotencyKey(fetchMock.mock.calls[0])).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/dashboard/payments/recurring-payments/prp_1",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceCustodyWalletId: "cwlt_replacement" }),
        signal: undefined,
      }
    );
  });

  it("replays the same Idempotency-Key when an ambiguous failure is retried", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockImplementationOnce(successResponse);
    vi.stubGlobal("fetch", fetchMock);

    await expect(createRecurringPayment(CREATE_INPUT, undefined, t)).rejects.toThrow(
      "network down"
    );
    await createRecurringPayment(CREATE_INPUT, undefined, t);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentIdempotencyKey(fetchMock.mock.calls[0])).toBeTruthy();
    expect(sentIdempotencyKey(fetchMock.mock.calls[1])).toBe(
      sentIdempotencyKey(fetchMock.mock.calls[0])
    );
  });

  it("releases the key after a definite 4xx refusal, so a corrected resubmit is a new schedule", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "nope" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockImplementationOnce(successResponse);
    vi.stubGlobal("fetch", fetchMock);

    await expect(createRecurringPayment(CREATE_INPUT, undefined, t)).rejects.toThrow("nope");
    await createRecurringPayment(CREATE_INPUT, undefined, t);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentIdempotencyKey(fetchMock.mock.calls[0])).toBeTruthy();
    expect(sentIdempotencyKey(fetchMock.mock.calls[1])).not.toBe(
      sentIdempotencyKey(fetchMock.mock.calls[0])
    );
  });

  it("mints different keys for different schedules", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(successResponse);
    vi.stubGlobal("fetch", fetchMock);

    await createRecurringPayment(CREATE_INPUT, undefined, t);
    await createRecurringPayment({ ...CREATE_INPUT, amount: "2" }, undefined, t);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentIdempotencyKey(fetchMock.mock.calls[0])).toBeTruthy();
    expect(sentIdempotencyKey(fetchMock.mock.calls[1])).not.toBe(
      sentIdempotencyKey(fetchMock.mock.calls[0])
    );
  });
});
