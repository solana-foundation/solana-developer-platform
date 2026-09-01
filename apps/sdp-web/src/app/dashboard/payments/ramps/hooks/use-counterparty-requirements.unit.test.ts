import type { PayoutRequirementTree, RequirementField } from "@sdp/types/ramp-requirements";
import { describe, expect, it } from "vitest";
import { derivePayoutRequirementFields } from "./use-counterparty-requirements";

const labels = {
  destinationCountry: "Destination country",
  paymentRail: "Payment rail",
};

const payout = {
  countryRails: {
    CA: [
      { value: "SWIFT", label: "SWIFT" },
      { value: "SEPA", label: "SEPA" },
    ],
    US: [{ value: "ACH", label: "ACH" }],
  },
  railFields: {
    ACH: [
      {
        kind: "text",
        key: "accountNumber",
        label: "Account number",
        required: true,
      },
    ],
    SEPA: [
      {
        kind: "text",
        key: "iban",
        label: "IBAN",
        required: true,
      },
    ],
    SWIFT: [
      {
        kind: "text",
        key: "accountNumber",
        label: "Account number",
        required: false,
      },
      {
        kind: "text",
        key: "swiftCode",
        label: "SWIFT / BIC code",
        required: true,
      },
    ],
  },
  accounts: [{ destinationCountry: "CA", status: "ACTIVE" }],
} satisfies PayoutRequirementTree;

describe("derivePayoutRequirementFields", () => {
  it("builds the country select from payout country keys", () => {
    const fields = derivePayoutRequirementFields(payout, {}, labels);

    expect(fields).toEqual([
      {
        kind: "select",
        key: "destinationCountry",
        label: "Destination country",
        required: true,
        options: [
          { value: "CA", label: "Canada" },
          { value: "US", label: "United States" },
        ],
      },
    ] satisfies RequirementField[]);
  });

  it("uses the existing active account without revealing rail fields", () => {
    const fields = derivePayoutRequirementFields(payout, { destinationCountry: "CA" }, labels);

    expect(fields.map((field) => field.key)).toEqual(["destinationCountry"]);
  });

  it("reveals the selected country's rail options verbatim", () => {
    const fields = derivePayoutRequirementFields(payout, { destinationCountry: "US" }, labels);

    expect(fields[1]).toEqual({
      kind: "select",
      key: "paymentRails",
      label: "Payment rail",
      required: true,
      options: payout.countryRails.US,
    });
  });

  it("renders only the selected rail's exact fields", () => {
    const fields = derivePayoutRequirementFields(
      payout,
      { destinationCountry: "US", paymentRails: "ACH" },
      labels
    );

    expect(fields.map((field) => field.key)).toEqual([
      "destinationCountry",
      "paymentRails",
      "accountNumber",
    ]);
    expect(fields[2]).toMatchObject({ required: true });
  });
});
