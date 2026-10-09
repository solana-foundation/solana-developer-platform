import {
  generateKeyPairSigner,
  isMessagePartialSigner,
  isTransactionPartialSigner,
  isTransactionSendingSigner,
  type TransactionSigner,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { MoneyMovementRefusedError } from "@/lib/money-admission";
import * as moneyPathEvents from "@/runtime/money-path-events";
import { admittedSigner } from "./admitted-signer";

const CONTEXT = {
  movement: "payments.transfer",
  organizationId: "org_admitted_signer",
  projectId: "prj_admitted_signer",
  custodyWalletId: "cwlt_admitted_signer",
} as const;

describe("admittedSigner", () => {
  it("hands back the provider's signer unchanged when the movement is admitted", async () => {
    const signer = await generateKeyPairSigner();

    expect(admittedSigner(signer, { admitted: true }, CONTEXT)).toBe(signer);
  });

  it("refuses every signing method of a refused start and keeps only the address", async () => {
    const signer = await generateKeyPairSigner();
    const events = vi.spyOn(moneyPathEvents, "logEvent").mockImplementation(() => {});

    const refused = admittedSigner(
      signer,
      { admitted: false, reason: "organization_inactive" },
      CONTEXT
    );

    expect(refused.address).toBe(signer.address);
    expect(Object.keys(refused).sort()).toEqual(
      ["address", ...Object.keys(signer).filter((key) => key.startsWith("sign"))].sort()
    );
    // The kit guards classify it as the real signer would be.
    expect(isTransactionPartialSigner(refused)).toBe(isTransactionPartialSigner(signer));
    expect(isMessagePartialSigner(refused)).toBe(isMessagePartialSigner(signer));
    expect(isTransactionSendingSigner(refused)).toBe(false);

    const transactionRefusal = await (
      refused as Extract<TransactionSigner, { signTransactions: unknown }>
    )
      .signTransactions([])
      .catch((error: unknown) => error);
    expect(transactionRefusal).toBeInstanceOf(MoneyMovementRefusedError);
    expect(transactionRefusal).toMatchObject({
      code: "FORBIDDEN",
      reason: "organization_inactive",
    });
    expect(events).toHaveBeenCalledWith("warn", {
      event: "sdp_money_refused",
      surface: "signer",
      movement: "payments.transfer",
      subject_id: "cwlt_admitted_signer",
      organization_id: "org_admitted_signer",
      project_id: "prj_admitted_signer",
      reason: "organization_inactive",
    });
    events.mockRestore();
  });

  it("refuses only when asked to sign, so resolving a signer that is never used stays harmless", async () => {
    const { address } = await generateKeyPairSigner();
    const sign = vi.fn();
    const signer = { address, signTransactions: sign } as unknown as TransactionSigner;
    const events = vi.spyOn(moneyPathEvents, "logEvent").mockImplementation(() => {});

    admittedSigner(signer, { admitted: false, reason: "production_not_enabled" }, CONTEXT);

    expect(events).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    events.mockRestore();
  });
});
