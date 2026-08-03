import type { PolicyDecision, PolicyRule } from "@sdp/types";

/** The outcome of matching a single rule against an operation. */
export interface RuleEvaluation {
  decision: PolicyDecision;
  reason: string;
  rule: PolicyRule;
}

/**
 * Merge a rule criterion's singular and plural forms (e.g. `asset` + `assets`)
 * into one de-duplicated list.
 *
 * @param single - The singular field.
 * @param many - The plural field.
 * @returns The unique values across both forms.
 */
export function ruleValues<T extends string>(
  single: T | undefined,
  many: readonly T[] | undefined
): T[] {
  const values: T[] = [];
  if (single !== undefined) {
    values.push(single);
  }
  if (many !== undefined) {
    values.push(...many);
  }
  return [...new Set(values)];
}
