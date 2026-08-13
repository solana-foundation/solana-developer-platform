import { describe, expect, it } from "vitest";
import { floorUsdToCents, laneCeilingFromErrorBody } from "./earn-withdraw-modal";

/**
 * The two helpers that carry PRO-1675's provider-quirk handling. Both exist
 * because Ground's sandbox behaviour diverges from its published contract in
 * ways measured on 2026-08-13 — see `packages/sdp-earn/CLAUDE.md` → Conventions.
 */

describe("floorUsdToCents", () => {
  // The reason this function exists: a lane reporting `20.001241` answers 409
  // for `20.001241` and 200 for `20.00`, so `Max` must offer the floored value
  // or it recreates the refused-max bug the ticket removed.
  it("floors the measured Ground case to a fillable amount", () => {
    expect(floorUsdToCents("20.001241")).toBe("20.00");
  });

  it("truncates rather than rounds, so the offer is never above the ceiling", () => {
    // 0.999 must not become 1.00 — that would offer MORE than the provider has.
    expect(floorUsdToCents("0.999")).toBe("0.99");
    expect(floorUsdToCents("19.9999999")).toBe("19.99");
  });

  it("pads short and absent fractions to a well-formed decimal", () => {
    expect(floorUsdToCents("19")).toBe("19.00");
    expect(floorUsdToCents("19.5")).toBe("19.50");
    expect(floorUsdToCents("0")).toBe("0.00");
  });

  it("is exact on values a binary float would mangle", () => {
    // Math.floor(1.005 * 100) / 100 === 1 in IEEE-754; string work gives 1.00
    // for the right reason and keeps the trailing shape the API expects.
    expect(floorUsdToCents("1.005")).toBe("1.00");
    expect(floorUsdToCents("8.115")).toBe("8.11");
    expect(floorUsdToCents("1234567.891234")).toBe("1234567.89");
  });

  it("tolerates surrounding whitespace from a provider string", () => {
    expect(floorUsdToCents(" 20.001241 ")).toBe("20.00");
  });
});

describe("laneCeilingFromErrorBody", () => {
  // The shape actually observed from Ground sandbox through the SDP API.
  const groundConflict = {
    error: {
      code: "CONFLICT",
      message: "ground request failed with status 409",
      details: {
        provider: "ground",
        providerStatus: 409,
        balance: { totalUsd: "20.001241", withdrawableUsd: "20.001241", reservedUsd: "0.000000" },
      },
    },
  };

  it("reads the lane ceiling out of a real 409 envelope", () => {
    expect(laneCeilingFromErrorBody(groundConflict)).toBe("20.001241");
  });

  it("returns undefined for a conflict carrying no balance", () => {
    expect(
      laneCeilingFromErrorBody({
        error: {
          code: "CONFLICT",
          message: "request_id_conflict",
          details: { provider: "ground" },
        },
      })
    ).toBeUndefined();
  });

  it("never throws on a malformed or hostile body", () => {
    for (const body of [
      undefined,
      null,
      "",
      0,
      [],
      {},
      { error: null },
      { error: "boom" },
      { error: { details: null } },
      { error: { details: { balance: "nope" } } },
      { error: { details: { balance: { withdrawableUsd: null } } } },
      // A number here is NOT adopted: the contract is decimal strings, and the
      // API has already normalized. Anything else is a shape we do not know.
      { error: { details: { balance: { withdrawableUsd: 412.5 } } } },
      { error: { details: { balance: { withdrawableUsd: "   " } } } },
    ]) {
      expect(laneCeilingFromErrorBody(body)).toBeUndefined();
    }
  });
});
