import { SdpPaymentsError } from "@sdp/payments";
import {
  coinbaseCounterpartyRequirements,
  resolveCoinbasePhone,
} from "@sdp/payments/ramps/providers/coinbase/counterparty";
import type { Counterparty } from "@sdp/types";
import { describe, expect, it } from "vitest";

const COUNTERPARTY: Counterparty = {
  id: "cp_coinbase",
  organizationId: "org_1",
  projectId: "proj_1",
  externalId: null,
  entityType: "individual",
  displayName: "Ada Lovelace",
  email: "ada@example.com",
  identity: {
    firstName: "Ada",
    lastName: "Lovelace",
    dateOfBirth: "1990-01-15",
  },
  status: "active",
  createdBy: null,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

describe("coinbaseCounterpartyRequirements", () => {
  it("collects a canonical E.164 phone field", () => {
    const requirements = coinbaseCounterpartyRequirements(COUNTERPARTY, {
      direction: "onramp",
      country: "US",
      providerData: {},
    });

    expect(requirements).toMatchObject({
      provider: "coinbase",
      direction: "onramp",
      status: "collect",
    });
    if (requirements.status !== "collect") throw new Error("Expected collect requirements");
    expect(requirements.fields).toEqual([
      expect.objectContaining({
        kind: "text",
        key: "phone",
        required: true,
        pattern: "^\\+[1-9]\\d{1,14}$",
      }),
    ]);
  });

  it("is ready when quote context contains a valid phone", () => {
    expect(
      coinbaseCounterpartyRequirements(COUNTERPARTY, {
        direction: "onramp",
        country: "US",
        providerData: {},
        collectedData: { phone: "+14155551234" },
      })
    ).toEqual({ provider: "coinbase", direction: "onramp", status: "ready" });
  });
});

describe("resolveCoinbasePhone", () => {
  it("fails loudly when the transient phone is absent or malformed", () => {
    expect(() => resolveCoinbasePhone(undefined)).toThrowError(SdpPaymentsError);
    expect(() => resolveCoinbasePhone({ phone: "14155551234" })).toThrowError(SdpPaymentsError);
  });
});
