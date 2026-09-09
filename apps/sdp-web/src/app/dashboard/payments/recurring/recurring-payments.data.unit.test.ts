import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecurringPayment, updateRecurringPayment } from "./recurring-payments.data";

const t = ((key: string) => key) as Parameters<typeof createRecurringPayment>[2];

describe("recurring payment write requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the exact SDP Wallet ID for create and source replacement", async () => {
    const fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { recurringPayment: { id: "prp_1" } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    vi.stubGlobal("fetch", fetch);

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

    expect(fetch).toHaveBeenCalledTimes(2);
    const createInit = fetch.mock.calls[0][1] as RequestInit;
    const updateInit = fetch.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(createInit.body))).toMatchObject({
      sourceCustodyWalletId: "cwlt_create",
    });
    expect(JSON.parse(String(updateInit.body))).toEqual({
      sourceCustodyWalletId: "cwlt_replacement",
    });
  });
});
