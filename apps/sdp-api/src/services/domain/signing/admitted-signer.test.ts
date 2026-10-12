import {
  generateKeyPairSigner,
  isMessagePartialSigner,
  isTransactionPartialSigner,
  isTransactionSendingSigner,
  type TransactionSigner,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { type MoneyAdmissionDecision, MoneyMovementRefusedError } from "@/lib/money-admission";
import * as moneyPathEvents from "@/runtime/money-path-events";
import { admittedSigner } from "./admitted-signer";

const CONTEXT = {
  movement: "payments.transfer",
  organizationId: "org_admitted_signer",
  projectId: "prj_admitted_signer",
  custodyWalletId: "cwlt_admitted_signer",
} as const;

const ADMITTED: MoneyAdmissionDecision = { admitted: true };
const REFUSED: MoneyAdmissionDecision = { admitted: false, reason: "organization_inactive" };

type PartialSigner = Extract<TransactionSigner, { signTransactions: unknown }>;

describe("admittedSigner", () => {
  it("hands back the provider's signer unchanged for an exit, and never decides", async () => {
    const signer = await generateKeyPairSigner();
    const decide = vi.fn();

    expect(admittedSigner(signer, decide, { ...CONTEXT, movement: "recurring.cancel" })).toBe(
      signer
    );
    expect(decide).not.toHaveBeenCalled();
  });

  it("keeps exactly the real signer's signing kinds, so the kit guards classify it the same", async () => {
    const signer = await generateKeyPairSigner();

    const admitted = admittedSigner(signer, async () => ADMITTED, CONTEXT);

    expect(admitted.address).toBe(signer.address);
    expect(Object.keys(admitted).sort()).toEqual(
      ["address", ...Object.keys(signer).filter((key) => key.startsWith("sign"))].sort()
    );
    expect(isTransactionPartialSigner(admitted)).toBe(isTransactionPartialSigner(signer));
    expect(isMessagePartialSigner(admitted)).toBe(isMessagePartialSigner(signer));
    expect(isTransactionSendingSigner(admitted)).toBe(false);
  });

  it("refuses a start the organization may not make, without reaching the provider", async () => {
    const { address } = await generateKeyPairSigner();
    const sign = vi.fn();
    const signer = { address, signTransactions: sign } as unknown as TransactionSigner;
    const events = vi.spyOn(moneyPathEvents, "logEvent").mockImplementation(() => {});

    const refusal = await (admittedSigner(signer, async () => REFUSED, CONTEXT) as PartialSigner)
      .signTransactions([])
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(MoneyMovementRefusedError);
    expect(refusal).toMatchObject({ code: "FORBIDDEN", reason: "organization_inactive" });
    expect(sign).not.toHaveBeenCalled();
    expect(events).toHaveBeenCalledWith("warn", {
      event: "sdp_money_refused",
      surface: "signer",
      movement: "payments.transfer",
      module: "payments",
      subject_id: "cwlt_admitted_signer",
      organization_id: "org_admitted_signer",
      project_id: "prj_admitted_signer",
      reason: "organization_inactive",
    });
    events.mockRestore();
  });

  // A flow can hold a signer across slow calls; a suspension that lands in
  // between must stop the next start it signs.
  it("decides again at every signature, so a revocation after resolution still refuses", async () => {
    const { address } = await generateKeyPairSigner();
    const sign = vi.fn().mockResolvedValue([]);
    const signer = { address, signTransactions: sign } as unknown as TransactionSigner;
    const decide = vi.fn().mockResolvedValueOnce(ADMITTED).mockResolvedValueOnce(REFUSED);
    const events = vi.spyOn(moneyPathEvents, "logEvent").mockImplementation(() => {});
    const admitted = admittedSigner(signer, decide, CONTEXT) as PartialSigner;

    await admitted.signTransactions([]);
    const second = await admitted.signTransactions([]).catch((error: unknown) => error);

    expect(decide).toHaveBeenCalledTimes(2);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(second).toBeInstanceOf(MoneyMovementRefusedError);
    events.mockRestore();
  });

  it("decides only when asked to sign, so resolving a signer that is never used stays harmless", async () => {
    const { address } = await generateKeyPairSigner();
    const signer = { address, signTransactions: vi.fn() } as unknown as TransactionSigner;
    const decide = vi.fn();

    admittedSigner(signer, decide, CONTEXT);

    expect(decide).not.toHaveBeenCalled();
  });
});
