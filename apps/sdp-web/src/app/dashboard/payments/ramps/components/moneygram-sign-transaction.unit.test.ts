import type { PaymentTransferSummary } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_SOLANA_ADDRESSES } from "../../../../../../../sdp-api/src/test/fixtures/tokens";
import { postMoneygramRampEvent, type Translate } from "../../payments-workspace.data";
import { sendTransferUnderKey } from "../../transfer-idempotency";
import { fundMoneygramDeposit, type MoneygramFundingContext } from "./moneygram-sign-transaction";

vi.mock("../../payments-workspace.data", () => ({ postMoneygramRampEvent: vi.fn() }));
vi.mock("../../transfer-idempotency", () => ({ sendTransferUnderKey: vi.fn() }));

const DEPOSIT = {
  chain: "solana",
  asset: "USDC",
  address: TEST_SOLANA_ADDRESSES.wallet3,
  amount: "250",
  memo: "mg_widget_memo_1",
};

const RAMP: PaymentTransferSummary = {
  id: "xfr_mg_ramp_1",
  custodyWalletId: "cwlt_mg_1",
  providerWalletId: "wal_mg_1",
  status: "pending",
  signature: null,
  rampsMemo: {},
  moneygram: {
    depositAddress: TEST_SOLANA_ADDRESSES.wallet2,
    sendAmount: "25",
    depositMemo: "mg_memo_1",
  },
};

const CRYPTO_LEG: PaymentTransferSummary = {
  id: "xfr_mg_deposit_leg",
  custodyWalletId: "cwlt_mg_1",
  providerWalletId: "wal_mg_1",
  status: "confirmed",
  signature: "sig_mg_deposit_1",
  rampsMemo: {},
};

function context(overrides: Partial<MoneygramFundingContext>): MoneygramFundingContext {
  return {
    cryptoAsset: "USDC",
    sessionId: "mg_session_1",
    sourceWalletId: "cwlt_mg_1",
    sourceTokenMint: TEST_SOLANA_ADDRESSES.mint,
    onSigned: vi.fn(),
    t: ((key) => key) satisfies Translate,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(postMoneygramRampEvent).mockResolvedValue(RAMP);
  vi.mocked(sendTransferUnderKey).mockResolvedValue({
    outcome: { kind: "submitted", transfer: CRYPTO_LEG },
    fingerprint: "mg_fingerprint_1",
  });
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("fundMoneygramDeposit", () => {
  it("funds the API deposit instruction instead of the widget payload and posts signed", async () => {
    const ctx = context({});
    vi.mocked(sendTransferUnderKey).mockImplementation(async () => {
      expect(postMoneygramRampEvent).toHaveBeenCalledExactlyOnceWith(
        { kind: "deposit_address", sessionId: ctx.sessionId },
        ctx.t
      );
      return {
        outcome: { kind: "submitted", transfer: CRYPTO_LEG },
        fingerprint: "mg_fingerprint_1",
      };
    });

    await expect(fundMoneygramDeposit(DEPOSIT, ctx)).resolves.toBe("sig_mg_deposit_1");

    expect(sendTransferUnderKey).toHaveBeenCalledExactlyOnceWith(
      {
        sourceCustodyWalletId: "cwlt_mg_1",
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: TEST_SOLANA_ADDRESSES.mint,
        amount: "25",
        memo: "mg_memo_1",
      },
      ctx.t,
      ctx.sessionId
    );
    expect(ctx.onSigned).toHaveBeenCalledExactlyOnceWith("xfr_mg_deposit_leg");
    expect(postMoneygramRampEvent).toHaveBeenCalledTimes(2);
    expect(postMoneygramRampEvent).toHaveBeenNthCalledWith(
      2,
      { kind: "signed", sessionId: ctx.sessionId, cryptoTransferId: "xfr_mg_deposit_leg" },
      ctx.t
    );
  });

  it("reuses the session payment key after a lost signed-event response", async () => {
    vi.mocked(postMoneygramRampEvent)
      .mockResolvedValueOnce(RAMP)
      .mockRejectedValueOnce(new TypeError("connection lost"));
    const ctx = context({});

    await expect(fundMoneygramDeposit(DEPOSIT, ctx)).rejects.toThrow("connection lost");
    await expect(fundMoneygramDeposit(DEPOSIT, ctx)).resolves.toBe("sig_mg_deposit_1");

    expect(sendTransferUnderKey).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendTransferUnderKey).mock.calls[0]).toEqual(
      vi.mocked(sendTransferUnderKey).mock.calls[1]
    );
    expect(vi.mocked(sendTransferUnderKey).mock.calls[1][2]).toBe("mg_session_1");
  });

  it.each([
    ["another chain", { ...DEPOSIT, chain: "ethereum" }],
    ["another asset", { ...DEPOSIT, asset: "USDT" }],
  ])("refuses a deposit for %s without sending anything", async (_label, deposit) => {
    await expect(fundMoneygramDeposit(deposit, context({}))).rejects.toThrow(
      "DashboardPayments.ramps.unsupportedMoneygramTransaction"
    );
    expect(sendTransferUnderKey).not.toHaveBeenCalled();
    expect(postMoneygramRampEvent).toHaveBeenCalledTimes(1);
  });

  it("refuses when the wallet holds none of the asset", async () => {
    await expect(fundMoneygramDeposit(DEPOSIT, context({ sourceTokenMint: null }))).rejects.toThrow(
      "DashboardPayments.ramps.sourceWalletNoUsdc"
    );
    expect(sendTransferUnderKey).not.toHaveBeenCalled();
    expect(postMoneygramRampEvent).toHaveBeenCalledTimes(1);
  });

  it("says a payment held for approval sent nothing", async () => {
    vi.mocked(sendTransferUnderKey).mockResolvedValue({
      outcome: { kind: "approval_pending", approvalRequestId: "apr_mg_1" },
      fingerprint: "mg_fingerprint_1",
    });
    const ctx = context({});

    await expect(fundMoneygramDeposit(DEPOSIT, ctx)).rejects.toThrow(
      "DashboardPayments.ramps.transferHeldForApproval"
    );
    expect(ctx.onSigned).not.toHaveBeenCalled();
    expect(postMoneygramRampEvent).toHaveBeenCalledTimes(1);
  });

  it("refuses a recorded transfer that carries no signature", async () => {
    vi.mocked(sendTransferUnderKey).mockResolvedValue({
      outcome: {
        kind: "submitted",
        transfer: { ...CRYPTO_LEG, status: "processing", signature: null },
      },
      fingerprint: "mg_fingerprint_1",
    });
    const ctx = context({});

    await expect(fundMoneygramDeposit(DEPOSIT, ctx)).rejects.toThrow(
      "DashboardPayments.ramps.transferSignatureMissing"
    );
    expect(ctx.onSigned).not.toHaveBeenCalled();
    expect(postMoneygramRampEvent).toHaveBeenCalledTimes(1);
  });

  it("refuses an API response without a confirmed deposit address", async () => {
    vi.mocked(postMoneygramRampEvent).mockResolvedValue({
      ...RAMP,
      moneygram: { sendAmount: "25" },
    });
    const ctx = context({});

    await expect(fundMoneygramDeposit(DEPOSIT, ctx)).rejects.toThrow(
      "DashboardPayments.ramps.moneygramDepositUnconfirmed"
    );
    expect(sendTransferUnderKey).not.toHaveBeenCalled();
    expect(ctx.onSigned).not.toHaveBeenCalled();
    expect(postMoneygramRampEvent).toHaveBeenCalledExactlyOnceWith(
      { kind: "deposit_address", sessionId: ctx.sessionId },
      ctx.t
    );
  });
});
