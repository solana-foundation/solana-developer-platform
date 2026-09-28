import { EARN_QUEUED_WITHDRAWAL_MAXIMUM_DEADLINE_SECONDS } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  earnExternalWalletQueuedWithdrawalPreviewSchema,
  earnExternalWalletWithdrawalRequestCancelTransactionSchema,
  earnExternalWalletWithdrawalRequestTransactionSchema,
} from "./schemas";

describe("external-wallet queued withdrawal schemas", () => {
  const positionRequest = {
    positionId: "earn_position_example",
    shares: "1",
    discountBps: 25,
    deadlineSeconds: EARN_QUEUED_WITHDRAWAL_MAXIMUM_DEADLINE_SECONDS,
  };

  it("accepts the exact deadline ceiling and refuses one second above it", () => {
    expect(earnExternalWalletQueuedWithdrawalPreviewSchema.safeParse(positionRequest).success).toBe(
      true
    );
    expect(
      earnExternalWalletQueuedWithdrawalPreviewSchema.safeParse({
        ...positionRequest,
        deadlineSeconds: EARN_QUEUED_WITHDRAWAL_MAXIMUM_DEADLINE_SECONDS + 1,
      }).success
    ).toBe(false);
  });

  it("keeps request builds on the authenticated position shape", () => {
    expect(
      earnExternalWalletWithdrawalRequestTransactionSchema.safeParse(positionRequest).success
    ).toBe(true);
    expect(
      earnExternalWalletWithdrawalRequestTransactionSchema.safeParse({
        strategyId: "earn_strategy_example",
        ownerAddress: "7YfVedaQueueOwner111111111111111111111111111",
        shares: "1",
        discountBps: 25,
        deadlineSeconds: 300,
      }).success
    ).toBe(false);
    expect(
      earnExternalWalletWithdrawalRequestTransactionSchema.safeParse({
        positionId: "earn_position_example",
        shares: "1",
        mechanism: "operatorRedemption",
      }).success
    ).toBe(true);
    expect(
      earnExternalWalletWithdrawalRequestTransactionSchema.safeParse({
        strategyId: "earn_strategy_example",
        ownerAddress: "7YfVedaQueueOwner111111111111111111111111111",
        shares: "1",
        mechanism: "operatorRedemption",
      }).success
    ).toBe(false);
  });

  it("requires the durable request id for cancellation builds", () => {
    expect(
      earnExternalWalletWithdrawalRequestCancelTransactionSchema.safeParse({
        withdrawalRequestId: "earn_vault_withdrawal_request_example",
      }).success
    ).toBe(true);
    expect(
      earnExternalWalletWithdrawalRequestCancelTransactionSchema.safeParse({
        strategyId: "earn_strategy_example",
        ownerAddress: "7YfVedaQueueOwner111111111111111111111111111",
        requestAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      }).success
    ).toBe(false);
  });
});
