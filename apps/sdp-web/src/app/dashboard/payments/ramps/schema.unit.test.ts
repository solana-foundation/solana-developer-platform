import type { RequirementField } from "@sdp/types/ramp-requirements";
import { describe, expect, it } from "vitest";
import { requirementFieldError } from "./schema";

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

const requiredConsent = {
  kind: "consent",
  key: "acceptTerms",
  label: "I have read and accept the",
  documentLabel: "Terms & Conditions",
  documentUrl: "https://example.com/terms",
  required: true,
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
    // A consent is satisfied by the affirmative literal alone; the web form clears it to "" when unticked.
    [requiredConsent, "true", null],
    [requiredConsent, "", "Terms & Conditions must be accepted."],
    [requiredConsent, undefined, "Terms & Conditions must be accepted."],
    [requiredConsent, "false", "Terms & Conditions must be accepted."],
    [{ ...requiredConsent, required: false }, "", null],
    [{ ...requiredConsent, required: false }, "false", "Terms & Conditions must be accepted."],
  ] satisfies [RequirementField, string | undefined, string | null][])(
    "validates provider requirement fields",
    (field, value, error) => {
      expect(requirementFieldError(field, value)).toBe(error);
    }
  );
});
