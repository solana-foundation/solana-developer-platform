import assert from "node:assert/strict";

export function required<T>(value: T | null | undefined): T {
  assert(value !== null && value !== undefined, "Expected required test data");
  return value;
}
