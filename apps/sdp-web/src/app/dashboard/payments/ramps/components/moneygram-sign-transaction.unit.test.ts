// @vitest-environment jsdom
/**
 * The signature MoneyGram waits for, and every reason it may not come.
 *
 * The person is inside the provider's flow when this runs, so each refusal has
 * to say what happened to their money: nothing sent, held for approval, or a
 * transfer recorded without a signature.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Translate } from "../../payments-workspace.data";
import { resetTransferIdempotencyStateForTests } from "../../transfer-idempotency";
import { signMoneygramTransfer } from "./moneygram-sign-transaction";

const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const REQUEST = {
  chain: "solana",
  asset: "USDC",
  to: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  amount: "250",
};

function context(overrides: Partial<Parameters<typeof signMoneygramTransfer>[1]> = {}) {
  return {
    cryptoAsset: "USDC",
    sessionId: "sess_1",
    sourceWalletId: "cwlt_1",
    sourceTokenMint: USDC_MINT,
    onSigned: vi.fn(),
    t: ((key) => key) satisfies Translate,
    ...overrides,
  };
}

function transferResponse(transfer: {
  id: string;
  status: string;
  signature?: string | null;
}): Response {
  return Response.json({ data: { transfer } });
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetTransferIdempotencyStateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signMoneygramTransfer", () => {
  it("sends the transfer and answers with its signature", async () => {
    const fetchMock = vi.fn(async (input: string) =>
      input === "/api/dashboard/payments/transfers"
        ? transferResponse({ id: "xfr_1", status: "confirmed", signature: "sig_1" })
        : Response.json({ data: { transfer: { id: "ramp_1" } } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const ctx = context();

    await expect(signMoneygramTransfer(REQUEST, ctx)).resolves.toBe("sig_1");

    expect(ctx.onSigned).toHaveBeenCalledWith("xfr_1");
    // The session is told which transfer was signed, for the events after it.
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("moneygram"))).toBe(true);
  });

  it("reuses the payment after a lost signed-event response and reload", async () => {
    const paymentKeys: (string | null)[] = [];
    let eventAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input === "/api/dashboard/payments/transfers") {
          paymentKeys.push(new Headers(init?.headers).get("Idempotency-Key"));
          return transferResponse({ id: "xfr_1", status: "confirmed", signature: "sig_1" });
        }
        if (eventAttempts++ === 0) throw new TypeError("connection lost");
        return Response.json({ data: { transfer: { id: "ramp_1" } } });
      })
    );

    await expect(signMoneygramTransfer(REQUEST, context())).rejects.toThrow("connection lost");
    resetTransferIdempotencyStateForTests();
    await expect(signMoneygramTransfer(REQUEST, context())).resolves.toBe("sig_1");
    expect(paymentKeys).toHaveLength(2);
    expect(paymentKeys[0]).toBeTruthy();
    expect(paymentKeys[1]).toBe(paymentKeys[0]);
  });

  it.each([
    ["another chain", { ...REQUEST, chain: "ethereum" }],
    ["another asset", { ...REQUEST, asset: "USDT" }],
  ])("refuses a transaction for %s without sending anything", async (_label, request) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(signMoneygramTransfer(request, context())).rejects.toThrow(
      "DashboardPayments.ramps.unsupportedMoneygramTransaction"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when the wallet holds none of the asset", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      signMoneygramTransfer(REQUEST, context({ sourceTokenMint: null }))
    ).rejects.toThrow("DashboardPayments.ramps.sourceWalletNoUsdc");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // MoneyGram needs a signature now. An approval answers later, so the widget
  // is told nothing moved rather than that the payment failed.
  it("says a payment held for approval sent nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "SIGNING_PENDING",
              message: "Approval required",
              details: { approvalRequestId: "apr_1" },
            },
          },
          { status: 202 }
        )
      )
    );
    const ctx = context();

    await expect(signMoneygramTransfer(REQUEST, ctx)).rejects.toThrow(
      "DashboardPayments.ramps.transferHeldForApproval"
    );
    expect(ctx.onSigned).not.toHaveBeenCalled();
  });

  it("refuses a recorded transfer that carries no signature", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => transferResponse({ id: "xfr_1", status: "processing", signature: null }))
    );

    await expect(signMoneygramTransfer(REQUEST, context())).rejects.toThrow(
      "DashboardPayments.ramps.transferSignatureMissing"
    );
  });
});
