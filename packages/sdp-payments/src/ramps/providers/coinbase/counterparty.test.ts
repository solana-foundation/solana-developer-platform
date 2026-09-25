import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Counterparty } from "@sdp/types";
import {
  coinbaseCounterpartyRequirements,
  coinbaseCustomerLinkMetadataSchema,
} from "./counterparty";

const INDIVIDUAL: Counterparty = {
  id: "cpty_123",
  organizationId: "org_123",
  projectId: "proj_123",
  externalId: null,
  entityType: "individual",
  displayName: "Ada Lovelace",
  status: "active",
  createdBy: null,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
};
const BUSINESS: Counterparty = {
  ...INDIVIDUAL,
  id: "cpty_456",
  entityType: "business",
  displayName: "Acme Ltd",
};

describe("coinbaseCounterpartyRequirements", () => {
  it("is ready for an individual on the on-ramp with nothing to collect", () => {
    assert.deepEqual(
      coinbaseCounterpartyRequirements(INDIVIDUAL, { direction: "onramp", providerData: {} }),
      {
        provider: "coinbase",
        direction: "onramp",
        status: "ready",
      }
    );
  });

  it("refuses a business counterparty with a reason", () => {
    assert.deepEqual(
      coinbaseCounterpartyRequirements(BUSINESS, { direction: "onramp", providerData: {} }),
      {
        provider: "coinbase",
        direction: "onramp",
        status: "unsupported",
        reason: "Coinbase Onramp supports individual counterparties only.",
      }
    );
  });

  it("refuses the off-ramp for everyone", () => {
    assert.deepEqual(
      coinbaseCounterpartyRequirements(INDIVIDUAL, { direction: "offramp", providerData: {} }),
      {
        provider: "coinbase",
        direction: "offramp",
        status: "unsupported",
        reason: "Coinbase Onramp supports on-ramp only.",
      }
    );
  });
});

describe("coinbaseCustomerLinkMetadataSchema", () => {
  it("accepts an empty link and a token with its expiry", () => {
    assert.equal(coinbaseCustomerLinkMetadataSchema.safeParse({}).success, true);
    assert.equal(
      coinbaseCustomerLinkMetadataSchema.safeParse({
        userAuthTokenCiphertext: "v2:abc",
        userAuthTokenExpiresAt: "2026-11-24T00:00:00.000Z",
      }).success,
      true
    );
  });

  it("refuses a token without its expiry, an expiry without its token, and anything else", () => {
    assert.equal(
      coinbaseCustomerLinkMetadataSchema.safeParse({ userAuthTokenCiphertext: "v2:abc" }).success,
      false
    );
    assert.equal(
      coinbaseCustomerLinkMetadataSchema.safeParse({
        userAuthTokenExpiresAt: "2026-11-24T00:00:00.000Z",
      }).success,
      false
    );
    assert.equal(
      coinbaseCustomerLinkMetadataSchema.safeParse({
        userAuthTokenCiphertext: "v2:abc",
        userAuthTokenExpiresAt: "2026-11-24T00:00:00.000Z",
        email: "buyer@example.com",
      }).success,
      false
    );
  });
});
