import { beforeEach, describe, expect, it, vi } from "vitest";

const claimRampTransfersToVerify = vi.hoisted(() => vi.fn());
const advanceRampVerification = vi.hoisted(() => vi.fn());
const verifyRampSettlement = vi.hoisted(() => vi.fn());

vi.mock("@/db/repositories", () => ({
  createSystemPaymentsRepository: () => ({ claimRampTransfersToVerify, advanceRampVerification }),
}));
vi.mock("@/services/ramps/settlement-verifier", () => ({ verifyRampSettlement }));

import type { Env } from "@/types/env";
import { verifyRampSettlements } from "./verify-ramp-settlements";

const enabled = { RAMP_SETTLEMENT_VERIFICATION_ENABLED: "true" } as Env;

function row(id: string, attempts = 0) {
  return { id, provider: "coinbase", verification_attempts: attempts };
}

describe("verifyRampSettlements", () => {
  beforeEach(() => {
    claimRampTransfersToVerify.mockReset().mockResolvedValue([]);
    advanceRampVerification.mockReset().mockResolvedValue(undefined);
    verifyRampSettlement.mockReset();
  });

  it("does nothing at all while the flag is off", async () => {
    await verifyRampSettlements({} as Env);
    expect(claimRampTransfersToVerify).not.toHaveBeenCalled();
  });

  it("records proof when the settlement verifies", async () => {
    claimRampTransfersToVerify.mockResolvedValue([row("xfr_a")]);
    verifyRampSettlement.mockResolvedValue({
      verified: true,
      slot: 77,
      method: "provider_signature",
    });

    await verifyRampSettlements(enabled);

    expect(advanceRampVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: "xfr_a",
        slot: 77,
        verifiedAt: expect.any(String),
        method: "provider_signature",
      })
    );
  });

  it("never writes a verifiedAt when verification fails", async () => {
    claimRampTransfersToVerify.mockResolvedValue([row("xfr_b")]);
    verifyRampSettlement.mockResolvedValue({ verified: false, reason: "transaction not found" });

    await verifyRampSettlements(enabled);

    const call = advanceRampVerification.mock.calls[0]?.[0];
    expect(call).toMatchObject({ transferId: "xfr_b" });
    // The row rotates and burns an attempt, but nothing marks it proven.
    expect(call.verifiedAt).toBeUndefined();
    expect(call.slot).toBeUndefined();
  });

  it("burns an attempt when the verifier throws, so a broken row cannot spin forever", async () => {
    claimRampTransfersToVerify.mockResolvedValue([row("xfr_c")]);
    verifyRampSettlement.mockRejectedValue(new Error("boom"));

    await verifyRampSettlements(enabled);

    expect(advanceRampVerification).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: "xfr_c" })
    );
    expect(advanceRampVerification.mock.calls[0]?.[0].verifiedAt).toBeUndefined();
  });

  it("keeps processing the page after one row throws", async () => {
    claimRampTransfersToVerify.mockResolvedValue([row("xfr_d"), row("xfr_e")]);
    verifyRampSettlement
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ verified: true, slot: 5, method: "provider_signature" });

    await verifyRampSettlements(enabled);

    expect(advanceRampVerification).toHaveBeenCalledTimes(2);
    expect(advanceRampVerification).toHaveBeenLastCalledWith(
      expect.objectContaining({ transferId: "xfr_e", slot: 5 })
    );
  });

  it("bounds each run by a page size and an attempt cap", async () => {
    await verifyRampSettlements(enabled);
    expect(claimRampTransfersToVerify).toHaveBeenCalledWith({
      maxAttempts: expect.any(Number),
      limit: expect.any(Number),
      claimedAt: expect.any(String),
      claimToken: expect.any(String),
      claimedUntil: expect.any(String),
    });
    const { maxAttempts, limit } = claimRampTransfersToVerify.mock.calls[0][0];
    expect(maxAttempts).toBeGreaterThan(0);
    expect(limit).toBeGreaterThan(0);
  });
});
