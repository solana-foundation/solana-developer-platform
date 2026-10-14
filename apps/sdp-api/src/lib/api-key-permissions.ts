import {
  type ApiKeyRole,
  getPermissionsForApiKeyRole,
  PERMISSIONS,
  type Permission,
} from "@sdp/types";
import { z } from "zod";
import { parsePostgresJson } from "@/db/postgres-utils";
import { internalError } from "@/lib/errors";

const explicitPermissionsSchema = z.array(z.enum(PERMISSIONS));

/**
 * Parse a key's stored `permissions` column. SQL NULL inherits the role's
 * permissions; an explicit empty array grants nothing. The API writes this
 * column itself, so anything else that does not parse is a bug and fails
 * loudly instead of granting or silently denying.
 */
export function parseStoredApiKeyPermissions(
  role: ApiKeyRole,
  stored: string | null
): Permission[] {
  if (stored === null) {
    return getPermissionsForApiKeyRole(role);
  }
  try {
    return explicitPermissionsSchema.parse(parsePostgresJson<unknown>(stored));
  } catch {
    throw internalError("Stored API key permissions are invalid");
  }
}
