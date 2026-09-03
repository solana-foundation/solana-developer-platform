import type { PayoutRequirementTree, RequirementField } from "@sdp/types/ramp-requirements";
import { describe, expect, it } from "vitest";
import {
  activePayoutAccounts,
  derivePayoutRequirementFields,
  payoutAccountSelectionAfterFieldChange,
  resolvePayoutAccountSelection,
} from "./use-counterparty-requirements";

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
        key: "bankAccount.accountNumber",
        label: "Account number",
        required: true,
      },
    ],
    SEPA: [
      {
        kind: "text",
        key: "bankAccount.iban",
        label: "IBAN",
        required: true,
      },
    ],
    SWIFT: [
      {
        kind: "text",
        key: "bankAccount.accountNumber",
        label: "Account number",
        required: false,
      },
      {
        kind: "text",
        key: "bankAccount.swiftCode",
        label: "SWIFT / BIC code",
        required: true,
      },
    ],
  },
  accounts: [
    {
      id: "account_ca",
      destinationCountry: "CA",
      paymentRail: "SWIFT",
      status: "ACTIVE",
    },
  ],
} satisfies PayoutRequirementTree;

describe("derivePayoutRequirementFields", () => {
  it("builds the country select from payout country keys", () => {
    const fields = derivePayoutRequirementFields(payout, {}, labels, { kind: "none" });

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
    const fields = derivePayoutRequirementFields(payout, { destinationCountry: "CA" }, labels, {
      kind: "existing",
      id: "account_ca",
    });

    expect(fields.map((field) => field.key)).toEqual(["destinationCountry"]);
  });

  it("reveals rail fields when the user chooses a new account", () => {
    const fields = derivePayoutRequirementFields(
      payout,
      { destinationCountry: "CA", paymentRails: "SWIFT" },
      labels,
      { kind: "new" }
    );

    expect(fields.map((field) => field.key)).toEqual([
      "destinationCountry",
      "paymentRails",
      "bankAccount.accountNumber",
      "bankAccount.swiftCode",
    ]);
  });

  it("reveals the selected country's rail options verbatim", () => {
    const fields = derivePayoutRequirementFields(payout, { destinationCountry: "US" }, labels, {
      kind: "none",
    });

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
      labels,
      { kind: "none" }
    );

    expect(fields.map((field) => field.key)).toEqual([
      "destinationCountry",
      "paymentRails",
      "bankAccount.accountNumber",
    ]);
    expect(fields[2]).toMatchObject({ required: true });
  });
});

describe("payout account selection", () => {
  it("pre-selects a single active account for the selected country", () => {
    const selection = resolvePayoutAccountSelection(
      { kind: "none" },
      activePayoutAccounts(payout, "CA")
    );

    expect(selection).toEqual({ kind: "existing", id: "account_ca" });
  });

  it("resets the account choice when the destination country changes", () => {
    const selection = payoutAccountSelectionAfterFieldChange(
      { kind: "existing", id: "account_ca" },
      "destinationCountry",
      "CA",
      "US"
    );

    expect(selection).toEqual({ kind: "none" });
  });
});

describe("activePayoutAccounts", () => {
  it("returns every active account for the selected country", () => {
    const accounts = activePayoutAccounts(
      {
        ...payout,
        accounts: [
          ...payout.accounts,
          {
            id: "account_ca_second",
            destinationCountry: "CA",
            paymentRail: "SEPA",
            status: "ACTIVE",
          },
          {
            id: "account_ca_archived",
            destinationCountry: "CA",
            paymentRail: "ACH",
            status: "ARCHIVED",
          },
        ],
      },
      "CA"
    );

    expect(accounts.map((account) => account.id)).toEqual(["account_ca", "account_ca_second"]);
  });
});
