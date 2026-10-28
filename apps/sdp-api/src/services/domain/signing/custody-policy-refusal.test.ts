import { SigningError } from "@sdp/custody/signing";
import {
  address,
  assertIsMessagePartialSigner,
  assertIsTransactionModifyingSigner,
  assertIsTransactionPartialSigner,
  type MessagePartialSigner,
  type TransactionModifyingSigner,
  type TransactionPartialSigner,
  type TransactionSigner,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { translateCustodyPolicyRefusals } from "./custody-policy-refusal";

function signTransactions(signer: TransactionSigner) {
  assertIsTransactionPartialSigner(signer);
  return signer.signTransactions([]);
}

function modifyAndSignTransactions(signer: TransactionSigner) {
  assertIsTransactionModifyingSigner(signer);
  return signer.modifyAndSignTransactions([]);
}

function signMessages(signer: TransactionSigner) {
  assertIsMessagePartialSigner(signer);
  return signer.signMessages([]);
}

function signerRejectingWith(
  error: Error
): TransactionPartialSigner & TransactionModifyingSigner & MessagePartialSigner {
  const reject = async () => {
    throw error;
  };
  return {
    address: address("11111111111111111111111111111111"),
    signTransactions: reject,
    modifyAndSignTransactions: reject,
    signMessages: reject,
  };
}

describe("translateCustodyPolicyRefusals", () => {
  it.each([
    ["signTransactions", signTransactions],
    ["modifyAndSignTransactions", modifyAndSignTransactions],
    ["signMessages", signMessages],
  ] as const)(
    "raises a policy refusal from %s as CUSTODY_POLICY_REFUSED, keeping the refusal as its cause",
    async (_method, sign) => {
      const refusal = new SigningError("Privy policy refused", "POLICY_REFUSED");

      const failure = await sign(
        translateCustodyPolicyRefusals(signerRejectingWith(refusal))
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AppError);
      expect(failure).toMatchObject({
        code: "CUSTODY_POLICY_REFUSED",
        statusCode: 422,
        cause: refusal,
      });
    }
  );

  it("rethrows any other signing failure unchanged", async () => {
    const unavailable = new SigningError("Privy unreachable", "NETWORK_ERROR");

    await expect(
      signTransactions(translateCustodyPolicyRefusals(signerRejectingWith(unavailable)))
    ).rejects.toBe(unavailable);
  });
});
