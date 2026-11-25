import { SigningError } from "@sdp/custody/signing";
import {
  assertIsMessageModifyingSigner,
  assertIsMessagePartialSigner,
  assertIsTransactionModifyingSigner,
  assertIsTransactionPartialSigner,
  assertIsTransactionSendingSigner,
  generateKeyPairSigner,
  type MessageModifyingSigner,
  type MessagePartialSigner,
  type TransactionModifyingSigner,
  type TransactionPartialSigner,
  type TransactionSendingSigner,
  type TransactionSigner,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { type MoneyAdmissionDecision, MoneyMovementRefusedError } from "@/lib/money-admission";
import * as moneyPathEvents from "@/runtime/money-path-events";
import { admittedSigner } from "./admitted-signer";

const CONTEXT = {
  movement: "payments.transfer",
  organizationId: "org_admitted_signer",
  projectId: "prj_admitted_signer",
  custodyWalletId: "cwlt_admitted_signer",
  provider: "privy",
  credential: null,
} as const;

const ADMITTED: MoneyAdmissionDecision = { admitted: true };
const REFUSED: MoneyAdmissionDecision = { admitted: false, reason: "organization_inactive" };

async function partialSigner(
  sign: TransactionPartialSigner["signTransactions"]
): Promise<TransactionPartialSigner> {
  const { address } = await generateKeyPairSigner();
  return { address, signTransactions: sign };
}

describe("admittedSigner", () => {
  it("offers exactly the real signer's signing kinds, so the kit guards classify it the same", async () => {
    const signer = await generateKeyPairSigner();

    const admitted = admittedSigner(signer, async () => ADMITTED, CONTEXT);

    expect(admitted.address).toBe(signer.address);
    expect(Object.keys(admitted).sort()).toEqual(["address", "signMessages", "signTransactions"]);
  });

  it("refuses a start the organization may not make, without reaching the provider", async () => {
    const sign = vi.fn<TransactionPartialSigner["signTransactions"]>();
    const events = vi.spyOn(moneyPathEvents, "logEvent").mockImplementation(() => {});

    const refusal = await signTransactions(
      admittedSigner(await partialSigner(sign), async () => REFUSED, CONTEXT)
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(MoneyMovementRefusedError);
    expect(refusal).toMatchObject({ code: "FORBIDDEN", reason: "organization_inactive" });
    expect(sign).not.toHaveBeenCalled();
    expect(events).toHaveBeenCalledExactlyOnceWith("warn", {
      event: "sdp_money_refused",
      surface: "signer",
      movement: "payments.transfer",
      module: "payments",
      subject_id: "cwlt_admitted_signer",
      organization_id: "org_admitted_signer",
      project_id: "prj_admitted_signer",
      principal_kind: null,
      principal: null,
      reason: "organization_inactive",
    });
    events.mockRestore();
  });

  // A flow can hold a signer across slow calls; a suspension that lands in
  // between must stop the next start it signs.
  it("decides again at every signature, so a revocation after resolution still refuses", async () => {
    const sign = vi.fn<TransactionPartialSigner["signTransactions"]>().mockResolvedValue([]);
    const decide = vi
      .fn<() => Promise<MoneyAdmissionDecision>>()
      .mockResolvedValueOnce(ADMITTED)
      .mockResolvedValueOnce(REFUSED);
    const events = vi.spyOn(moneyPathEvents, "logEvent").mockImplementation(() => {});
    const admitted = admittedSigner(await partialSigner(sign), decide, CONTEXT);

    await expect(signTransactions(admitted)).resolves.toEqual([]);
    await expect(signTransactions(admitted)).rejects.toMatchObject({
      reason: "organization_inactive",
    });

    expect(decide).toHaveBeenCalledTimes(2);
    expect(sign).toHaveBeenCalledOnce();
    events.mockRestore();
  });

  it("decides only when asked to sign, so resolving a signer that is never used stays harmless", async () => {
    const decide = vi.fn<() => Promise<MoneyAdmissionDecision>>();

    admittedSigner(await partialSigner(vi.fn()), decide, CONTEXT);

    expect(decide).not.toHaveBeenCalled();
  });
});

function signTransactions(signer: TransactionSigner) {
  assertIsTransactionPartialSigner(signer);
  return signer.signTransactions([]);
}

function modifyAndSignTransactions(signer: TransactionSigner) {
  assertIsTransactionModifyingSigner(signer);
  return signer.modifyAndSignTransactions([]);
}

function signAndSendTransactions(signer: TransactionSigner) {
  assertIsTransactionSendingSigner(signer);
  return signer.signAndSendTransactions([]);
}

function signMessages(signer: TransactionSigner) {
  assertIsMessagePartialSigner(signer);
  return signer.signMessages([]);
}

function modifyAndSignMessages(signer: TransactionSigner) {
  assertIsMessageModifyingSigner(signer);
  return signer.modifyAndSignMessages([]);
}

async function signerRejectingWith(
  error: Error
): Promise<
  TransactionPartialSigner &
    TransactionModifyingSigner &
    TransactionSendingSigner &
    MessagePartialSigner &
    MessageModifyingSigner
> {
  const { address } = await generateKeyPairSigner();
  const reject = async () => {
    throw error;
  };
  return {
    address,
    signTransactions: reject,
    modifyAndSignTransactions: reject,
    signAndSendTransactions: reject,
    signMessages: reject,
    modifyAndSignMessages: reject,
  };
}

describe("admittedSigner custody policy refusals (HOO-2333)", () => {
  it.each([
    ["signTransactions", signTransactions],
    ["modifyAndSignTransactions", modifyAndSignTransactions],
    ["signAndSendTransactions", signAndSendTransactions],
    ["signMessages", signMessages],
    ["modifyAndSignMessages", modifyAndSignMessages],
  ] as const)(
    "raises a policy refusal from %s as CUSTODY_POLICY_REFUSED, keeping the refusal as its cause",
    async (_method, sign) => {
      const refusal = new SigningError("Private provider failure details", "POLICY_REFUSED");
      const signer = admittedSigner(
        await signerRejectingWith(refusal),
        async () => ADMITTED,
        CONTEXT
      );

      const error = await sign(signer).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        code: "CUSTODY_POLICY_REFUSED",
        statusCode: 422,
        message:
          "Privy blocked signing due to a wallet policy. Review the policy in Privy or adjust the request.",
        cause: refusal,
      });
    }
  );

  it.each([
    ["fireblocks", "Fireblocks"],
    ["turnkey", "Turnkey"],
  ] as const)("names %s as the provider whose policy refused", async (provider, label) => {
    const refusal = new SigningError("Private provider failure details", "POLICY_REFUSED");
    const signer = admittedSigner(await signerRejectingWith(refusal), async () => ADMITTED, {
      ...CONTEXT,
      provider,
    });

    await expect(signTransactions(signer)).rejects.toMatchObject({
      code: "CUSTODY_POLICY_REFUSED",
      message: `${label} blocked signing due to a wallet policy. Review the policy in ${label} or adjust the request.`,
    });
  });

  it("rethrows any other signing failure unchanged", async () => {
    const unavailable = new SigningError("Privy unreachable", "NETWORK_ERROR");
    const signer = admittedSigner(
      await signerRejectingWith(unavailable),
      async () => ADMITTED,
      CONTEXT
    );

    await expect(signTransactions(signer)).rejects.toBe(unavailable);
  });
});
