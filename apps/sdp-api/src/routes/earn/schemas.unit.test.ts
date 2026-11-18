import { EARN_QUEUED_WITHDRAWAL_MAXIMUM_DEADLINE_SECONDS } from "@sdp/types/earn";
import { describe, expect, it } from "vitest";
import {
  earnWalletQueuedWithdrawalPreviewSchema,
  earnWalletWithdrawalRequestCancelTransactionSchema,
  earnWalletWithdrawalRequestTransactionSchema,
} from "./schemas";

describe("wallet queued withdrawal schemas", () => {
  const positionRequest = {
    positionId: "earn_position_example",
    shares: "1",
    discountBps: 25,
    deadlineSeconds: EARN_QUEUED_WITHDRAWAL_MAXIMUM_DEADLINE_SECONDS,
  };

  it("accepts the exact deadline ceiling and refuses one second above it", () => {
    expect(earnWalletQueuedWithdrawalPreviewSchema.safeParse(positionRequest).success).toBe(true);
    expect(
      earnWalletQueuedWithdrawalPreviewSchema.safeParse({
        ...positionRequest,
        deadlineSeconds: EARN_QUEUED_WITHDRAWAL_MAXIMUM_DEADLINE_SECONDS + 1,
      }).success
    ).toBe(false);
  });

  it("keeps request builds on the authenticated position shape", () => {
    expect(earnWalletWithdrawalRequestTransactionSchema.safeParse(positionRequest).success).toBe(
      true
    );
    expect(
      earnWalletWithdrawalRequestTransactionSchema.safeParse({
        strategyId: "earn_strategy_example",
        ownerAddress: "7YfVedaQueueOwner111111111111111111111111111",
        shares: "1",
        discountBps: 25,
        deadlineSeconds: 300,
      }).success
    ).toBe(false);
    expect(
      earnWalletWithdrawalRequestTransactionSchema.safeParse({
        positionId: "earn_position_example",
        shares: "1",
        mechanism: "operatorRedemption",
      }).success
    ).toBe(true);
    expect(
      earnWalletWithdrawalRequestTransactionSchema.safeParse({
        strategyId: "earn_strategy_example",
        ownerAddress: "7YfVedaQueueOwner111111111111111111111111111",
        shares: "1",
        mechanism: "operatorRedemption",
      }).success
    ).toBe(false);
  });

  it("requires the durable request id for cancellation builds", () => {
    expect(
      earnWalletWithdrawalRequestCancelTransactionSchema.safeParse({
        withdrawalRequestId: "earn_vault_withdrawal_request_example",
      }).success
    ).toBe(true);
    expect(
      earnWalletWithdrawalRequestCancelTransactionSchema.safeParse({
        strategyId: "earn_strategy_example",
        ownerAddress: "7YfVedaQueueOwner111111111111111111111111111",
        requestAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      }).success
    ).toBe(false);
  });
});
