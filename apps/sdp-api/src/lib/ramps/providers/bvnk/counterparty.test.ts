import { SdpPaymentsError } from "@sdp/payments";
import {
  bvnkOnrampFields,
  validateBvnkCounterparty,
} from "@sdp/payments/ramps/providers/bvnk/counterparty";
import { normalizeBvnkStateCode } from "@sdp/payments/ramps/providers/bvnk/provider-data";
import type { Counterparty } from "@sdp/types";
import { describe, expect, it } from "vitest";

const ONRAMP_REQUIREMENTS_OPTIONS = {
  cryptoToken: "USDC_SOLANA",
  fiatCurrency: "USD",
  destinationWalletAddress: "dest",
} as const;

function counterparty(overrides?: Partial<Counterparty>): Counterparty {
  return {
    id: "cp_123",
    organizationId: "org_123",
    projectId: "proj_123",
    externalId: null,
    entityType: "individual",
    displayName: "Ada Lovelace",
    status: "active",
    createdBy: null,
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("validateBvnkCounterparty", () => {
  it("uses provider status after a BVNK customer exists", () => {
    const requirements = validateBvnkCounterparty(counterparty(), {
      direction: "onramp",
      ...ONRAMP_REQUIREMENTS_OPTIONS,
      providerData: {
        bvnk: {
          customer: { customerReference: "cust_123", status: "VERIFIED" },
        },
      },
    });

    expect(requirements).toEqual({
      provider: "bvnk",
      direction: "onramp",
      status: "funding_account_provisioning",
    });
  });

  it("fails loudly at the unwired JIT seam for a new BVNK customer", () => {
    const run = () =>
      validateBvnkCounterparty(counterparty(), {
        direction: "onramp",
        ...ONRAMP_REQUIREMENTS_OPTIONS,
        providerData: {},
      });

    expect(run).toThrowError(SdpPaymentsError);
    expect(run).toThrowError(
      "BVNK onramp requires identity fields that are no longer stored; JIT collection is not wired yet"
    );
  });
});

describe("bvnkOnrampFields", () => {
  it("adds the US-only fields for US counterparties", () => {
    const usKeys = bvnkOnrampFields("US").map((field) => field.key);
    const baseKeys = bvnkOnrampFields("GB").map((field) => field.key);

    expect(usKeys).toContain("address.stateCode");
    expect(baseKeys).not.toContain("address.stateCode");
    expect(usKeys).toEqual(expect.arrayContaining(baseKeys));
  });
});

describe("normalizeBvnkStateCode", () => {
  it("strips a matching ISO 3166-2 country prefix", () => {
    expect(normalizeBvnkStateCode("US", "US-TX")).toBe("TX");
  });

  it("returns an already-bare code unchanged", () => {
    expect(normalizeBvnkStateCode("US", "TX")).toBe("TX");
  });

  it("uppercases a lowercase code", () => {
    expect(normalizeBvnkStateCode("US", "tx")).toBe("TX");
  });

  it("throws when the stripped remainder is not 2 characters", () => {
    expect(() => normalizeBvnkStateCode("GB", "GB-ENG")).toThrowError(SdpPaymentsError);
  });

  it("does not strip a prefix that does not match the country code", () => {
    expect(() => normalizeBvnkStateCode("US", "XX-TX")).toThrowError(SdpPaymentsError);
  });

  it("throws for a 1-character code", () => {
    expect(() => normalizeBvnkStateCode("US", "X")).toThrowError(SdpPaymentsError);
  });
});
