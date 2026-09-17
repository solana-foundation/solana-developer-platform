import type { RequirementField } from "@sdp/types/ramp-requirements";
import { describe, expect, it } from "vitest";
import { depositAmountSchema, depositSelectionSchema, requirementFieldError } from "./schema";

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

describe("requirementFieldError", () => {
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
  ] satisfies [RequirementField, string | undefined, string | null][])(
    "validates provider requirement fields",
    (field, value, error) => {
      expect(requirementFieldError(field, value)).toBe(error);
    }
  );
});

const depositFields = {
  walletId: "wal_1",
  amount: "100.00",
  counterpartyId: "cpty_1",
  buyerEmail: "",
  buyerPhone: "",
};

describe("deposit buyer contact", () => {
  it("requires email and phone for Coinbase, on the step gate and the selection alike", () => {
    const coinbase = { ...depositFields, provider: "coinbase" as const };

    for (const schema of [depositAmountSchema, depositSelectionSchema]) {
      const result = schema.safeParse(coinbase);
      expect(result.success).toBe(false);
      const paths = result.error?.issues.map((issue) => issue.path.join("."));
      expect(paths).toEqual(expect.arrayContaining(["buyerEmail", "buyerPhone"]));
    }
  });

  it("accepts a Coinbase selection once both are supplied", () => {
    const coinbase = {
      ...depositFields,
      provider: "coinbase" as const,
      buyerEmail: "buyer@example.com",
      buyerPhone: "+1 555 123 4567",
    };

    expect(depositAmountSchema.safeParse(coinbase).success).toBe(true);
    expect(depositSelectionSchema.safeParse(coinbase).success).toBe(true);
  });

  it("leaves every other provider free to quote without contact details", () => {
    const moonpay = { ...depositFields, provider: "moonpay" as const };

    expect(depositAmountSchema.safeParse(moonpay).success).toBe(true);
    expect(depositSelectionSchema.safeParse(moonpay).success).toBe(true);
  });

  it("rejects a phone that is not a phone", () => {
    const result = depositSelectionSchema.safeParse({
      ...depositFields,
      provider: "coinbase" as const,
      buyerEmail: "buyer@example.com",
      buyerPhone: "not a phone",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["buyerPhone"]);
  });
});
