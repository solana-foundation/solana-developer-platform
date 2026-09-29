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
