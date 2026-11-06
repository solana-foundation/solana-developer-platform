import { describe, expect, it } from "vitest";
import {
  earnExternalWalletDepositResponse,
  earnExternalWalletDepositTransactionResponse,
  earnExternalWalletEarningsResponse,
  earnExternalWalletMovementDetailResponse,
  earnExternalWalletMovementsResponse,
  earnExternalWalletPositionSummaryResponse,
  earnExternalWalletPositionsResponse,
  earnExternalWalletQueuedWithdrawalPreviewResponse,
  earnExternalWalletWithdrawalOptionsResponse,
  earnExternalWalletWithdrawalPreviewResponse,
  earnExternalWalletWithdrawalRequestCancellationResponse,
  earnExternalWalletWithdrawalRequestCancelTransactionResponse,
  earnExternalWalletWithdrawalRequestResponse,
  earnExternalWalletWithdrawalRequestsResponse,
  earnExternalWalletWithdrawalRequestTransactionResponse,
  earnExternalWalletWithdrawalResponse,
  earnExternalWalletWithdrawalTransactionResponse,
  earnStrategyResponse,
  earnVaultDepositPreviewResponse,
} from "@/openapi/schemas/earn";
import {
  EARN_CANCEL_SUBMIT_REQUEST_EXAMPLE,
  EARN_CANCEL_TRANSACTION_REQUEST_EXAMPLE,
  EARN_DEPOSIT_PREVIEW_EXAMPLE,
  EARN_DEPOSIT_PREVIEW_REQUEST_EXAMPLE,
  EARN_DEPOSIT_SUBMIT_EXAMPLE,
  EARN_DEPOSIT_SUBMIT_REQUEST_EXAMPLE,
  EARN_DEPOSIT_TRANSACTION_EXAMPLE,
  EARN_DEPOSIT_TRANSACTION_REQUEST_EXAMPLE,
  EARN_EARNINGS_EXAMPLE,
  EARN_MOVEMENT_FINALIZED_EXAMPLE,
  EARN_MOVEMENTS_EXAMPLE,
  EARN_POSITION_SUMMARY_EXAMPLE,
  EARN_POSITIONS_EXAMPLE,
  EARN_QUEUED_WITHDRAWAL_PREVIEW_EXAMPLE,
  EARN_QUEUED_WITHDRAWAL_REQUEST_EXAMPLE,
  EARN_STRATEGY_EXAMPLE,
  EARN_WITHDRAWAL_OPTIONS_EXAMPLE,
  EARN_WITHDRAWAL_OPTIONS_REQUEST_EXAMPLE,
  EARN_WITHDRAWAL_PREVIEW_EXAMPLE,
  EARN_WITHDRAWAL_PREVIEW_REQUEST_EXAMPLE,
  EARN_WITHDRAWAL_REQUEST_CANCEL_TRANSACTION_EXAMPLE,
  EARN_WITHDRAWAL_REQUEST_CANCELLING_EXAMPLE,
  EARN_WITHDRAWAL_REQUEST_EXAMPLE,
  EARN_WITHDRAWAL_REQUEST_SUBMIT_REQUEST_EXAMPLE,
  EARN_WITHDRAWAL_REQUEST_TRANSACTION_EXAMPLE,
  EARN_WITHDRAWAL_REQUESTS_EXAMPLE,
  EARN_WITHDRAWAL_SUBMIT_EXAMPLE,
  EARN_WITHDRAWAL_SUBMIT_REQUEST_EXAMPLE,
  EARN_WITHDRAWAL_TRANSACTION_EXAMPLE,
  EARN_WITHDRAWAL_TRANSACTION_REQUEST_EXAMPLE,
} from "@/openapi/schemas/earn-examples";
import {
  earnExternalWalletDepositTransactionSchema,
  earnExternalWalletQueuedWithdrawalPreviewSchema,
  earnExternalWalletSubmitSchema,
  earnExternalWalletWithdrawalOptionsSchema,
  earnExternalWalletWithdrawalPreviewSchema,
  earnExternalWalletWithdrawalRequestCancelTransactionSchema,
  earnExternalWalletWithdrawalRequestTransactionSchema,
  earnExternalWalletWithdrawalTransactionSchema,
  earnVaultDepositPreviewSchema,
} from "@/routes/earn/schemas";

const meta = { requestId: "req_example", timestamp: "2026-11-06T18:00:00.000Z" };

// The API reference shows these as the routes' answers, so each must be a body
// the route could actually return.
describe("Earn reference examples", () => {
  it.each([
    ["strategy", earnStrategyResponse, { strategy: EARN_STRATEGY_EXAMPLE }],
    ["deposit preview", earnVaultDepositPreviewResponse, EARN_DEPOSIT_PREVIEW_EXAMPLE],
    [
      "deposit build",
      earnExternalWalletDepositTransactionResponse,
      EARN_DEPOSIT_TRANSACTION_EXAMPLE,
    ],
    ["deposit submit", earnExternalWalletDepositResponse, { deposit: EARN_DEPOSIT_SUBMIT_EXAMPLE }],
    [
      "withdrawal submit",
      earnExternalWalletWithdrawalResponse,
      { withdrawal: EARN_WITHDRAWAL_SUBMIT_EXAMPLE },
    ],
    [
      "movement",
      earnExternalWalletMovementDetailResponse,
      { movement: EARN_MOVEMENT_FINALIZED_EXAMPLE },
    ],
    ["movements", earnExternalWalletMovementsResponse, EARN_MOVEMENTS_EXAMPLE],
    ["positions", earnExternalWalletPositionsResponse, EARN_POSITIONS_EXAMPLE],
    ["position totals", earnExternalWalletPositionSummaryResponse, EARN_POSITION_SUMMARY_EXAMPLE],
    ["earnings", earnExternalWalletEarningsResponse, { earnings: EARN_EARNINGS_EXAMPLE }],
    [
      "withdrawal preview",
      earnExternalWalletWithdrawalPreviewResponse,
      EARN_WITHDRAWAL_PREVIEW_EXAMPLE,
    ],
    [
      "withdrawal options",
      earnExternalWalletWithdrawalOptionsResponse,
      EARN_WITHDRAWAL_OPTIONS_EXAMPLE,
    ],
    [
      "withdrawal build",
      earnExternalWalletWithdrawalTransactionResponse,
      EARN_WITHDRAWAL_TRANSACTION_EXAMPLE,
    ],
    [
      "queued preview",
      earnExternalWalletQueuedWithdrawalPreviewResponse,
      EARN_QUEUED_WITHDRAWAL_PREVIEW_EXAMPLE,
    ],
    [
      "request build",
      earnExternalWalletWithdrawalRequestTransactionResponse,
      EARN_WITHDRAWAL_REQUEST_TRANSACTION_EXAMPLE,
    ],
    [
      "cancel build",
      earnExternalWalletWithdrawalRequestCancelTransactionResponse,
      EARN_WITHDRAWAL_REQUEST_CANCEL_TRANSACTION_EXAMPLE,
    ],
    ["request", earnExternalWalletWithdrawalRequestResponse, EARN_WITHDRAWAL_REQUEST_EXAMPLE],
    [
      "cancellation",
      earnExternalWalletWithdrawalRequestCancellationResponse,
      EARN_WITHDRAWAL_REQUEST_CANCELLING_EXAMPLE,
    ],
    ["requests", earnExternalWalletWithdrawalRequestsResponse, EARN_WITHDRAWAL_REQUESTS_EXAMPLE],
  ])("the %s example parses as its response", (_name, schema, data) => {
    expect(schema.safeParse({ data, meta }).success).toBe(true);
  });

  // The cURL samples send these bodies, so the running API must accept each one.
  it.each([
    ["deposit preview", earnVaultDepositPreviewSchema, EARN_DEPOSIT_PREVIEW_REQUEST_EXAMPLE],
    [
      "deposit build",
      earnExternalWalletDepositTransactionSchema,
      EARN_DEPOSIT_TRANSACTION_REQUEST_EXAMPLE,
    ],
    ["deposit submit", earnExternalWalletSubmitSchema, EARN_DEPOSIT_SUBMIT_REQUEST_EXAMPLE],
    [
      "withdrawal preview",
      earnExternalWalletWithdrawalPreviewSchema,
      EARN_WITHDRAWAL_PREVIEW_REQUEST_EXAMPLE,
    ],
    [
      "withdrawal build",
      earnExternalWalletWithdrawalTransactionSchema,
      EARN_WITHDRAWAL_TRANSACTION_REQUEST_EXAMPLE,
    ],
    ["withdrawal submit", earnExternalWalletSubmitSchema, EARN_WITHDRAWAL_SUBMIT_REQUEST_EXAMPLE],
    [
      "withdrawal options",
      earnExternalWalletWithdrawalOptionsSchema,
      EARN_WITHDRAWAL_OPTIONS_REQUEST_EXAMPLE,
    ],
    [
      "queued preview",
      earnExternalWalletQueuedWithdrawalPreviewSchema,
      EARN_QUEUED_WITHDRAWAL_REQUEST_EXAMPLE,
    ],
    [
      "request build",
      earnExternalWalletWithdrawalRequestTransactionSchema,
      EARN_QUEUED_WITHDRAWAL_REQUEST_EXAMPLE,
    ],
    [
      "request submit",
      earnExternalWalletSubmitSchema,
      EARN_WITHDRAWAL_REQUEST_SUBMIT_REQUEST_EXAMPLE,
    ],
    [
      "cancel build",
      earnExternalWalletWithdrawalRequestCancelTransactionSchema,
      EARN_CANCEL_TRANSACTION_REQUEST_EXAMPLE,
    ],
    ["cancel submit", earnExternalWalletSubmitSchema, EARN_CANCEL_SUBMIT_REQUEST_EXAMPLE],
  ])("the %s request example passes the route's validation", (_name, schema, body) => {
    expect(schema.safeParse(body).success).toBe(true);
  });

  it("tells one story across requests and responses", () => {
    expect(EARN_DEPOSIT_TRANSACTION_EXAMPLE.transaction.transactionId).toBe(
      EARN_DEPOSIT_SUBMIT_REQUEST_EXAMPLE.transactionId
    );
    expect(EARN_WITHDRAWAL_TRANSACTION_EXAMPLE.transaction.transactionId).toBe(
      EARN_WITHDRAWAL_SUBMIT_REQUEST_EXAMPLE.transactionId
    );
    expect(EARN_WITHDRAWAL_REQUEST_TRANSACTION_EXAMPLE.transaction.transactionId).toBe(
      EARN_WITHDRAWAL_REQUEST_SUBMIT_REQUEST_EXAMPLE.transactionId
    );
    expect(EARN_WITHDRAWAL_REQUEST_CANCEL_TRANSACTION_EXAMPLE.transaction.transactionId).toBe(
      EARN_CANCEL_SUBMIT_REQUEST_EXAMPLE.transactionId
    );
    expect(EARN_QUEUED_WITHDRAWAL_PREVIEW_EXAMPLE.shares).toBe(
      EARN_QUEUED_WITHDRAWAL_REQUEST_EXAMPLE.shares
    );
    expect(
      Number(EARN_QUEUED_WITHDRAWAL_PREVIEW_EXAMPLE.deadlineTimestamp) -
        Number(EARN_QUEUED_WITHDRAWAL_PREVIEW_EXAMPLE.maturityTimestamp)
    ).toBe(EARN_QUEUED_WITHDRAWAL_REQUEST_EXAMPLE.deadlineSeconds);
  });

  it("states earnings that add up", () => {
    // Exact six-decimal units, never a JavaScript number.
    const units = (value: string) => {
      const [whole = "0", fraction = ""] = value.split(".");
      return BigInt(whole + fraction.padEnd(6, "0"));
    };
    for (const total of EARN_EARNINGS_EXAMPLE.totalsByToken) {
      expect(
        units(total.currentValue) + units(total.totalWithdrawn) - units(total.totalDeposited)
      ).toBe(units(total.earned));
    }
  });

  it("describes a withdrawal in shares with no payout observed yet", () => {
    expect(EARN_WITHDRAWAL_SUBMIT_EXAMPLE.direction).toBe("withdrawal");
    expect(EARN_WITHDRAWAL_SUBMIT_EXAMPLE.denomination).not.toBe(
      EARN_WITHDRAWAL_SUBMIT_EXAMPLE.tokenMint
    );
    expect(EARN_WITHDRAWAL_SUBMIT_EXAMPLE.tokenAmount).toBeNull();
  });
});
