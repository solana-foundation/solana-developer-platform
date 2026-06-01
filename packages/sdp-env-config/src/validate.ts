import { FIELDS, isFieldVisible } from "./fields";
import type { Values } from "./types";

export type Errors = Record<string, string>;

/** Validate only visible fields: required-but-empty and pattern mismatches. */
export function validateValues(values: Values): Errors {
  const errors: Errors = {};
  for (const f of FIELDS) {
    // Derived fields are computed, not user input — nothing to validate.
    if (f.derive) continue;
    if (!isFieldVisible(f, values)) continue;
    const value = (values[f.key] ?? "").trim();

    if (f.required && value === "") {
      errors[f.key] = `${f.label} is required`;
      continue;
    }
    // Reject control characters that could inject additional .env lines.
    if (value !== "" && /[\r\n\0]/.test(value)) {
      errors[f.key] = `${f.label} must be a single line`;
      continue;
    }
    if (value !== "" && f.pattern && !f.pattern.test(value)) {
      errors[f.key] = `${f.label} has an invalid format`;
      continue;
    }
    // A select must hold one of its declared options; this catches a bad value
    // injected through the environment in the non-interactive path.
    if (value !== "" && f.kind === "select" && f.options) {
      const allowed = f.options.map((o) => o.value);
      if (!allowed.includes(value)) {
        errors[f.key] = `${f.label} must be one of: ${allowed.join(", ")}`;
      }
    }
  }
  return errors;
}
