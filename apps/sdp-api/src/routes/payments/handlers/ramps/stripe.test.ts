import type { CounterpartyIndividualIdentity } from "@sdp/types";
import { describe, expect, it } from "vitest";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { buildStripeCustomerInfo } from "./stripe";

function counterparty(identity: CounterpartyIndividualIdentity, email?: string): CounterpartyRow {
  return {
    id: "counterparty_1",
    organization_id: "org_1",
    project_id: "proj_1",
    external_id: null,
    entity_type: "individual",
    display_name: "Jane Doe",
    email: email ? email : "jane@doe.com",
    identity,
    provider_data: {},
    status: "active",
    created_by: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("buildStripeCustomerInfo", () => {
  it("maps identity, parses ISO dob, and strips the ISO-3166-2 subdivision prefix", () => {
    const info = buildStripeCustomerInfo(
      counterparty({
        firstName: "Jane",
        lastName: "Doe",
        dateOfBirth: "1990-07-04",
        phone: "+15555550123",
        address: {
          line1: "1 Market St",
          line2: "Suite 5",
          city: "SF",
          postalCode: "94080",
          countryCode: "US",
          subdivisionCode: "US-CA",
        },
      })
    );

    expect(info).toEqual({
      email: "jane@doe.com",
      firstName: "Jane",
      lastName: "Doe",
      dob: { year: 1990, month: 7, day: 4 },
      address: {
        line1: "1 Market St",
        line2: "Suite 5",
        city: "SF",
        state: "CA",
        postalCode: "94080",
        country: "US",
      },
    });
  });

  it("accepts an already-bare subdivision code", () => {
    const info = buildStripeCustomerInfo(
      counterparty({
        firstName: "Jane",
        lastName: "Doe",
        dateOfBirth: "1990-07-04",
        phone: "+15555550123",
        address: { line1: "1 A St", city: "SF", countryCode: "US", subdivisionCode: "CA" },
      })
    );

    expect(info.address).toMatchObject({ state: "CA" });
  });

  it("drops a malformed date of birth instead of sending NaN parts to Stripe", () => {
    expect(
      buildStripeCustomerInfo(
        counterparty({
          firstName: "Jane",
          lastName: "Doe",
          dateOfBirth: "not-a-date",
          phone: "+15555550123",
          address: { line1: "1 A St", city: "SF", countryCode: "US" },
        })
      ).dob
    ).toBeUndefined();

    expect(
      buildStripeCustomerInfo(
        counterparty({
          firstName: "Jane",
          lastName: "Doe",
          dateOfBirth: "1990-07",
          phone: "+15555550123",
          address: { line1: "1 A St", city: "SF", countryCode: "US" },
        })
      ).dob
    ).toBeUndefined();
  });
});
