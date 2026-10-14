import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  buildEarnVaultDepositFingerprint,
  buildEarnVaultParRedemptionFingerprint,
  canonicalJson,
  normalizeForFingerprint,
  resolveIdempotencyReplay,
} from "./idempotency";

describe("canonicalJson", () => {
  it("orders keys by UTF-16 code unit at every depth, whatever their insertion order", () => {
    expect(canonicalJson({ b: 1, B: 2, a: { é: 1, z: [2, 1] }, "10": 0, "9": 0 })).toBe(
      '{"10":0,"9":0,"B":2,"a":{"z":[2,1],"é":1},"b":1}'
    );
  });
});

describe("buildEarnVaultDepositFingerprint", () => {
  const base = {
    environment: "sandbox",
    provider: "kamino",
    providerReference: "vault_1",
    custodyWalletId: "cwlt_1",
    amount: "1",
    minSharesOut: "0.5",
  };

  it("normalizes insignificant decimal zeroes without rounding", () => {
    expect(buildEarnVaultDepositFingerprint(base)).toBe(
      buildEarnVaultDepositFingerprint({
        ...base,
        amount: "0001.000000",
        minSharesOut: "00.5000",
      })
    );
  });

  it("keeps different exact decimal magnitudes distinct", () => {
    expect(buildEarnVaultDepositFingerprint(base)).not.toBe(
      buildEarnVaultDepositFingerprint({ ...base, amount: "1.000001" })
    );
  });
});

describe("resolveIdempotencyReplay", () => {
  it("returns null when no row has claimed the key", async () => {
    expect(await resolveIdempotencyReplay(async () => null, "fp")).toBeNull();
  });

  it("returns the existing row when its fingerprint matches", async () => {
    const row = { id: "row_1", idempotency_fingerprint: "fp" };
    expect(await resolveIdempotencyReplay(async () => row, "fp")).toBe(row);
  });

  it("treats a stored row without a fingerprint as unclaimed", async () => {
    const row = { id: "row_1", idempotency_fingerprint: null };
    expect(await resolveIdempotencyReplay(async () => row, "fp")).toBeNull();
  });

  it("throws CONFLICT when the fingerprint differs", async () => {
    const row = { id: "row_1", idempotency_fingerprint: "other" };
    await expect(resolveIdempotencyReplay(async () => row, "fp")).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.code === "CONFLICT"
    );
  });
});

describe("normalizeForFingerprint", () => {
  it("orders object keys deterministically and drops undefined", () => {
    const a = normalizeForFingerprint({ b: 1, a: 2, c: undefined });
    const b = normalizeForFingerprint({ a: 2, b: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("buildEarnVaultParRedemptionFingerprint", () => {
  const base = { environment: "production", provider: "hastra", positionId: "earn_position_1" };

  it("keeps a shares-sourced fingerprint byte-identical to the recorded format", () => {
    // Replays and approval executions compare against fingerprints stored
    // before a par request could be sourced from held intermediate.
    expect(buildEarnVaultParRedemptionFingerprint({ ...base, shares: "1600.50" })).toBe(
      '{"environment":"production","positionId":"earn_position_1","provider":"hastra",' +
        '"scope":"earn_vault_par_redemption_request","shares":"1600.5","transactionId":null}'
    );
  });

  it("never lets an intermediate-sourced request replay a shares-sourced one", () => {
    const intermediate = buildEarnVaultParRedemptionFingerprint({
      ...base,
      intermediateAmount: "1600.5",
    });
    expect(intermediate).toContain('"intermediateAmount":"1600.5"');
    expect(intermediate).not.toContain('"shares"');
    expect(intermediate).not.toBe(
      buildEarnVaultParRedemptionFingerprint({ ...base, shares: "1600.5" })
    );
  });
});
