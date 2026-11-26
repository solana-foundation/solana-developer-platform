/** The value a test needs, failing the test where it is read when it is missing. */
export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected required test data");
  return value;
}
