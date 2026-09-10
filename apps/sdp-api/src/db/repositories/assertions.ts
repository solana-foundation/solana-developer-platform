import { internalError } from "@/lib/errors";

/**
 * Requires a database column to contain a string.
 *
 * @param value - Untrusted value returned by the database driver.
 * @param entity - Entity name used in the corruption error.
 * @param field - Column name used in the corruption error.
 * @returns The validated string.
 */
export function assertRepositoryString(value: unknown, entity: string, field: string): string {
  if (typeof value !== "string") {
    throw internalError(`${entity} ${field} is missing`);
  }
  return value;
}

/**
 * Requires a nullable database column to contain a string or null.
 *
 * @param value - Untrusted value returned by the database driver.
 * @param entity - Entity name used in the corruption error.
 * @param field - Column name used in the corruption error.
 * @returns The validated string or null.
 */
export function assertRepositoryNullableString(
  value: unknown,
  entity: string,
  field: string
): string | null {
  if (value !== null && typeof value !== "string") {
    throw internalError(`${entity} ${field} is invalid`);
  }
  return value;
}
