import { parseDecimalAmount } from "@sdp/solana/amount";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { describe, expect, it } from "vitest";
import {
  earnStrategyResponse,
  earnVaultDepositPreviewResponse,
  earnWalletDepositResponse,
  earnWalletDepositTransactionResponse,
  earnWalletEarningsResponse,
  earnWalletMovementDetailResponse,
  earnWalletMovementsResponse,
  earnWalletPositionSummaryResponse,
  earnWalletPositionsResponse,
  earnWalletQueuedWithdrawalPreviewResponse,
  earnWalletWithdrawalOptionsResponse,
  earnWalletWithdrawalPreviewResponse,
  earnWalletWithdrawalRequestCancellationResponse,
  earnWalletWithdrawalRequestCancelTransactionResponse,
  earnWalletWithdrawalRequestResponse,
  earnWalletWithdrawalRequestsResponse,
  earnWalletWithdrawalRequestTransactionResponse,
  earnWalletWithdrawalResponse,
  earnWalletWithdrawalTransactionResponse,
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
  earnVaultDepositPreviewSchema,
  earnWalletDepositTransactionSchema,
  earnWalletQueuedWithdrawalPreviewSchema,
  earnWalletSubmitSchema,
  earnWalletWithdrawalOptionsSchema,
  earnWalletWithdrawalPreviewSchema,
  earnWalletWithdrawalRequestCancelTransactionSchema,
  earnWalletWithdrawalRequestTransactionSchema,
  earnWalletWithdrawalTransactionSchema,
} from "@/routes/earn/schemas";

const meta = { requestId: "req_example", timestamp: "2026-11-06T18:00:00.000Z" };

// The API reference shows these as the routes' answers, so each must be a body
// the route could actually return.
describe("Earn reference examples", () => {
  it.each([
    ["strategy", earnStrategyResponse, { strategy: EARN_STRATEGY_EXAMPLE }],
    ["deposit preview", earnVaultDepositPreviewResponse, EARN_DEPOSIT_PREVIEW_EXAMPLE],
    ["deposit build", earnWalletDepositTransactionResponse, EARN_DEPOSIT_TRANSACTION_EXAMPLE],
    ["deposit submit", earnWalletDepositResponse, { deposit: EARN_DEPOSIT_SUBMIT_EXAMPLE }],
    [
      "withdrawal submit",
      earnWalletWithdrawalResponse,
      { withdrawal: EARN_WITHDRAWAL_SUBMIT_EXAMPLE },
    ],
    ["movement", earnWalletMovementDetailResponse, { movement: EARN_MOVEMENT_FINALIZED_EXAMPLE }],
    ["movements", earnWalletMovementsResponse, EARN_MOVEMENTS_EXAMPLE],
    ["positions", earnWalletPositionsResponse, EARN_POSITIONS_EXAMPLE],
    ["position totals", earnWalletPositionSummaryResponse, EARN_POSITION_SUMMARY_EXAMPLE],
    ["earnings", earnWalletEarningsResponse, { earnings: EARN_EARNINGS_EXAMPLE }],
    ["withdrawal preview", earnWalletWithdrawalPreviewResponse, EARN_WITHDRAWAL_PREVIEW_EXAMPLE],
    ["withdrawal options", earnWalletWithdrawalOptionsResponse, EARN_WITHDRAWAL_OPTIONS_EXAMPLE],
    [
      "withdrawal build",
      earnWalletWithdrawalTransactionResponse,
      EARN_WITHDRAWAL_TRANSACTION_EXAMPLE,
    ],
    [
      "queued preview",
      earnWalletQueuedWithdrawalPreviewResponse,
      EARN_QUEUED_WITHDRAWAL_PREVIEW_EXAMPLE,
    ],
    [
      "request build",
      earnWalletWithdrawalRequestTransactionResponse,
      EARN_WITHDRAWAL_REQUEST_TRANSACTION_EXAMPLE,
    ],
    [
      "cancel build",
      earnWalletWithdrawalRequestCancelTransactionResponse,
      EARN_WITHDRAWAL_REQUEST_CANCEL_TRANSACTION_EXAMPLE,
    ],
    ["request", earnWalletWithdrawalRequestResponse, EARN_WITHDRAWAL_REQUEST_EXAMPLE],
    [
      "cancellation",
      earnWalletWithdrawalRequestCancellationResponse,
      EARN_WITHDRAWAL_REQUEST_CANCELLING_EXAMPLE,
    ],
    ["requests", earnWalletWithdrawalRequestsResponse, EARN_WITHDRAWAL_REQUESTS_EXAMPLE],
  ])("the %s example parses as its response", (_name, schema, data) => {
    expect(schema.safeParse({ data, meta }).success).toBe(true);
  });

  // The cURL samples send these bodies, so the running API must accept each one.
  it.each([
    ["deposit preview", earnVaultDepositPreviewSchema, EARN_DEPOSIT_PREVIEW_REQUEST_EXAMPLE],
    ["deposit build", earnWalletDepositTransactionSchema, EARN_DEPOSIT_TRANSACTION_REQUEST_EXAMPLE],
    ["deposit submit", earnWalletSubmitSchema, EARN_DEPOSIT_SUBMIT_REQUEST_EXAMPLE],
    [
      "withdrawal preview",
      earnWalletWithdrawalPreviewSchema,
      EARN_WITHDRAWAL_PREVIEW_REQUEST_EXAMPLE,
    ],
    [
      "withdrawal build",
      earnWalletWithdrawalTransactionSchema,
      EARN_WITHDRAWAL_TRANSACTION_REQUEST_EXAMPLE,
    ],
    ["withdrawal submit", earnWalletSubmitSchema, EARN_WITHDRAWAL_SUBMIT_REQUEST_EXAMPLE],
    [
      "withdrawal options",
      earnWalletWithdrawalOptionsSchema,
      EARN_WITHDRAWAL_OPTIONS_REQUEST_EXAMPLE,
    ],
    [
      "queued preview",
      earnWalletQueuedWithdrawalPreviewSchema,
      EARN_QUEUED_WITHDRAWAL_REQUEST_EXAMPLE,
    ],
    [
      "request build",
      earnWalletWithdrawalRequestTransactionSchema,
      EARN_QUEUED_WITHDRAWAL_REQUEST_EXAMPLE,
    ],
    ["request submit", earnWalletSubmitSchema, EARN_WITHDRAWAL_REQUEST_SUBMIT_REQUEST_EXAMPLE],
    [
      "cancel build",
      earnWalletWithdrawalRequestCancelTransactionSchema,
      EARN_CANCEL_TRANSACTION_REQUEST_EXAMPLE,
    ],
    ["cancel submit", earnWalletSubmitSchema, EARN_CANCEL_SUBMIT_REQUEST_EXAMPLE],
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
    const decimals = WELL_KNOWN_TOKENS.USDC.mints.devnet.decimals;
    for (const total of EARN_EARNINGS_EXAMPLE.totalsByToken) {
      expect(
        parseDecimalAmount(total.currentValue, decimals) +
          parseDecimalAmount(total.totalWithdrawn, decimals) -
          parseDecimalAmount(total.totalDeposited, decimals)
      ).toBe(parseDecimalAmount(total.earned, decimals));
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
