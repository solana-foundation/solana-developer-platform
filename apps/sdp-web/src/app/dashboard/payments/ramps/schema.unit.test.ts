import type { RequirementField } from "@sdp/types/ramp-requirements";
import { describe, expect, it } from "vitest";
import { requirementFieldError, withdrawSelectionSchema } from "./schema";

describe("withdrawSelectionSchema", () => {
  const validSelection = {
    walletId: "wallet_123",
    amount: "0.2",
    provider: "moonpay",
    counterpartyId: "cpty_123",
  } as const;

  it("accepts a complete off-ramp selection", () => {
    expect(withdrawSelectionSchema.safeParse(validSelection).success).toBe(true);
  });

  it.each([
    [{ ...validSelection, walletId: "" }, "Select a source wallet."],
    [{ ...validSelection, amount: "0" }, "Enter an amount greater than 0."],
    [{ ...validSelection, amount: "-1" }, "Enter a valid crypto amount."],
    [{ ...validSelection, amount: "0.1234567890" }, "Enter a valid crypto amount."],
    [{ ...validSelection, amount: "not-an-amount" }, "Enter a valid crypto amount."],
    [{ ...validSelection, provider: null }, "Choose a provider."],
    [{ ...validSelection, counterpartyId: "" }, "Select a counterparty."],
  ])("rejects an invalid off-ramp selection", (selection, message) => {
    const result = withdrawSelectionSchema.safeParse(selection);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(message);
    }
  });
});

describe("requirementFieldError", () => {
  const requiredText = {
    kind: "text",
    key: "accountNumber",
    label: "Account number",
    required: true,
    minLength: 4,
    maxLength: 8,
    pattern: "^\\d+$",
    placeholder: "123456",
  } as const satisfies RequirementField;
  const select = {
    kind: "select",
    key: "accountType",
    label: "Account type",
    required: true,
    options: [
      { value: "checking", label: "Checking" },
      { value: "savings", label: "Savings" },
    ],
  } as const satisfies RequirementField;

  it.each([
    [requiredText, undefined, "Account number is required."],
    [{ ...requiredText, required: false }, "  ", null],
    [requiredText, "123", "Account number must be at least 4 characters."],
    [requiredText, "123456789", "Account number must be at most 8 characters."],
    [requiredText, "abcd", "Account number doesn't match the expected format (e.g. 123456)."],
    [
      { ...requiredText, placeholder: undefined },
      "abcd",
      "Account number doesn't match the expected format.",
    ],
    [requiredText, "123456", null],
    [select, "checking", null],
    [select, "brokerage", "Select a valid account type."],
  ] satisfies [RequirementField, string | undefined, string | null][])(
    "validates provider requirement fields",
    (field, value, error) => {
      expect(requirementFieldError(field, value)).toBe(error);
    }
  );
});
