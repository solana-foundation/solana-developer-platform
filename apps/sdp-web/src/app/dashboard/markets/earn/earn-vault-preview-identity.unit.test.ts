import { describe, expect, it } from "vitest";
import { earnVaultPreviewInputFingerprint } from "./earn-vault-preview-identity";

describe("earnVaultPreviewInputFingerprint", () => {
  it("is stable across key insertion order for the same intent", () => {
    expect(
      earnVaultPreviewInputFingerprint({
        positionId: "position_1",
        shares: "5",
        discountBps: 25,
        deadlineSeconds: 360,
      })
    ).toBe(
      earnVaultPreviewInputFingerprint({
        deadlineSeconds: 360,
        discountBps: 25,
        shares: "5",
        positionId: "position_1",
      })
    );
  });

  it("separates every changed intent field", () => {
    const base = { positionId: "position_1", shares: "5", discountBps: 25, deadlineSeconds: 360 };
    const variants = [
      { ...base, shares: "10" },
      { ...base, discountBps: 50 },
      { ...base, deadlineSeconds: 450 },
      { ...base, positionId: "position_2" },
    ];
    for (const variant of variants) {
      expect(earnVaultPreviewInputFingerprint(variant)).not.toBe(
        earnVaultPreviewInputFingerprint(base)
      );
    }
  });

  it("does not confuse the queue route with the operator-redemption route", () => {
    expect(
      earnVaultPreviewInputFingerprint({
        positionId: "position_1",
        shares: "5",
        mechanism: "operatorRedemption",
      })
    ).not.toBe(
      earnVaultPreviewInputFingerprint({
        positionId: "position_1",
        shares: "5",
        discountBps: 25,
        deadlineSeconds: 360,
      })
    );
  });
});
