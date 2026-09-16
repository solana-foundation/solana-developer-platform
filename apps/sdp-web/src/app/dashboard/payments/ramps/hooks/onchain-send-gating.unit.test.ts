import { type PaymentsDashboardWallet, SOL_MINT } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { canProceedOnchainReceive } from "./use-onchain-receive-wizard";
import {
  canProceedOnchainSend,
  nextAssetAfterWalletChange,
  onchainAmountExceedsBalance,
  resolveReadySubmission,
} from "./use-onchain-send-wizard";

const completeFields = {
  accountId: "account-1",
  walletId: "wallet-1",
  asset: SOL_MINT,
  amount: "1",
  memo: "",
};

const wallet: PaymentsDashboardWallet = {
  id: "wallet-1",
  walletId: "custody-wallet-1",
  isRuntimeExecutionAllowed: true,
  custodyConfigId: "cc_test",
  publicKey: "wallet-address",
  label: "Treasury",
};

describe("onchain wizard gating", () => {
  it.each([
    {
      name: "accepts a valid destination",
      run: () =>
        canProceedOnchainSend({
          stepId: "DESTINATION",
          fields: completeFields,
          destinationAddress: "destination-address",
          exceedsBalance: false,
          selectedMint: SOL_MINT,
          readySubmission: null,
        }),
      expected: true,
    },
    {
      name: "rejects a missing destination",
      run: () =>
        canProceedOnchainSend({
          stepId: "DESTINATION",
          fields: completeFields,
          destinationAddress: null,
          exceedsBalance: false,
          selectedMint: SOL_MINT,
          readySubmission: null,
        }),
      expected: false,
    },
    {
      name: "accepts valid details within balance",
      run: () =>
        canProceedOnchainSend({
          stepId: "DETAILS",
          fields: completeFields,
          destinationAddress: "destination-address",
          exceedsBalance: false,
          selectedMint: SOL_MINT,
          readySubmission: null,
        }),
      expected: true,
    },
    {
      name: "rejects details exceeding balance",
      run: () =>
        canProceedOnchainSend({
          stepId: "DETAILS",
          fields: completeFields,
          destinationAddress: "destination-address",
          exceedsBalance: true,
          selectedMint: SOL_MINT,
          readySubmission: null,
        }),
      expected: false,
    },
    {
      name: "rejects details without a mint",
      run: () =>
        canProceedOnchainSend({
          stepId: "DETAILS",
          fields: completeFields,
          destinationAddress: "destination-address",
          exceedsBalance: false,
          selectedMint: null,
          readySubmission: null,
        }),
      expected: false,
    },
    {
      name: "accepts review only with a ready submission",
      run: () => {
        const readySubmission = resolveReadySubmission(
          completeFields,
          "destination-address",
          SOL_MINT
        );
        return canProceedOnchainSend({
          stepId: "REVIEW",
          fields: completeFields,
          destinationAddress: "destination-address",
          exceedsBalance: false,
          selectedMint: SOL_MINT,
          readySubmission,
        });
      },
      expected: true,
    },
    {
      name: "rejects review without a ready submission",
      run: () =>
        canProceedOnchainSend({
          stepId: "REVIEW",
          fields: completeFields,
          destinationAddress: "destination-address",
          exceedsBalance: false,
          selectedMint: SOL_MINT,
          readySubmission: null,
        }),
      expected: false,
    },
    {
      name: "resets the asset when a wallet does not carry it",
      run: () => nextAssetAfterWalletChange("old-mint", [{ value: SOL_MINT }]),
      expected: SOL_MINT,
    },
    {
      name: "rejects a stale receive wallet selection",
      run: () => canProceedOnchainReceive("WALLET", null),
      expected: false,
    },
    {
      name: "accepts a live receive wallet selection",
      run: () => canProceedOnchainReceive("WALLET", wallet),
      expected: true,
    },
  ])("$name", ({ run, expected }) => {
    expect(run()).toBe(expected);
  });

  it.each([
    { name: "below balance", amount: "0.9", availableAmount: "1", expected: false },
    { name: "equal balance", amount: "1.0", availableAmount: "1", expected: false },
    { name: "above balance", amount: "1.000000001", availableAmount: "1", expected: true },
    { name: "partial input", amount: "1.", availableAmount: "1", expected: false },
  ])("compares an amount $name", ({ amount, availableAmount, expected }) => {
    expect(onchainAmountExceedsBalance(amount, availableAmount)).toBe(expected);
  });
});
