import { FIELDS, isFieldVisible } from "./fields";
import type { Values } from "./types";

export type Errors = Record<string, string>;

/** Validate only visible fields: required-but-empty and pattern mismatches. */
export function validateValues(values: Values): Errors {
  const errors: Errors = {};
  for (const f of FIELDS) {
    if (!isFieldVisible(f, values)) continue;
    const value = (values[f.key] ?? "").trim();

    if (f.required && value === "") {
      errors[f.key] = `${f.label} is required`;
      continue;
    }
    if (value !== "" && f.pattern && !f.pattern.test(value)) {
      errors[f.key] = `${f.label} has an invalid format`;
    }
  }
  return errors;
}
