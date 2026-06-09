import { FIELDS, isFieldVisible, parseList } from "./fields";
import type { EnvField, Values } from "./types";

export type Errors = Record<string, string>;

/** Resolve a field's options, preferring the dynamic `optionsWhen` when present. */
function resolveOptions(field: EnvField, values: Values) {
  return field.optionsWhen ? field.optionsWhen(values) : field.options;
}

/**
 * A select/multiselect must hold values drawn from its (possibly dynamic)
 * options; this also catches a bad value injected via the environment.
 * Returns an error message, or undefined when the values are acceptable.
 */
function optionMembershipError(
  field: EnvField,
  values: Values,
  selected: string[]
): string | undefined {
  if (field.kind !== "select" && field.kind !== "multiselect") return undefined;
  const opts = resolveOptions(field, values);
  // Skip membership when there are no resolvable options yet (e.g. a default
  // select whose options depend on a not-yet-chosen list): let the upstream
  // field's own error stand instead of an empty "must be one of: " message.
  if (!opts || opts.length === 0) return undefined;
  const allowed = opts.map((o) => o.value);
  if (selected.some((s) => !allowed.includes(s))) {
    return `${field.label} must be one of: ${allowed.join(", ")}`;
  }
  return undefined;
}

/** Validate a single visible field; returns an error message or undefined. */
function validateField(f: EnvField, values: Values): string | undefined {
  const value = (values[f.key] ?? "").trim();
  const isMultiselect = f.kind === "multiselect";
  // A multiselect's emptiness is about its parsed entries, not the raw string,
  // so a value like ",," counts as empty rather than satisfying `required`.
  const selected = isMultiselect ? parseList(value) : value === "" ? [] : [value];

  if (f.required && (isMultiselect ? selected.length === 0 : value === "")) {
    return `${f.label} is required`;
  }
  if (value === "") return undefined;
  // Reject control characters that could inject additional .env lines.
  if (/[\r\n\0]/.test(value)) return `${f.label} must be a single line`;
  if (f.pattern && !f.pattern.test(value)) return `${f.label} has an invalid format`;
  return optionMembershipError(f, values, selected);
}

/** Validate only visible fields: required-but-empty, pattern, and option membership. */
export function validateValues(values: Values): Errors {
  const errors: Errors = {};
  for (const f of FIELDS) {
    // Derived fields are computed, not user input — nothing to validate.
    if (f.derive) continue;
    // Skip hidden fields, except `alwaysEmit` ones: those are emitted even when
    // hidden, so a required-but-empty value must still be caught.
    if (!isFieldVisible(f, values) && !f.alwaysEmit) continue;
    const error = validateField(f, values);
    if (error) errors[f.key] = error;
  }
  return errors;
}
