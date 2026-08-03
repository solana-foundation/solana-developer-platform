/**
 * Logical channels domain: row/type contracts, enums, and validation. The
 * repository, migrations, and routes live in `sdp-api`.
 */

/** Soft-delete lifecycle. Channels are archived, never hard-deleted. */
export type PrivateChannelStatus = "active" | "archived";

/** A channel row, scoped to an SPC instance. `name` is unique within the instance. */
export interface PrivateChannelRow {
  id: string;
  organization_id: string;
  project_id: string;
  instance_id: string;
  name: string;
  description: string | null;
  /** Exactly one row per instance has this set (the auto-provisioned channel). */
  is_default: boolean;
  status: PrivateChannelStatus;
  created_at: string;
  updated_at: string;
}

/** Max length for a channel name (enforced in the API layer). */
export const PRIVATE_CHANNEL_NAME_MAX_LENGTH = 64;

/** Name used when the instance's default channel is auto-provisioned. */
export const DEFAULT_PRIVATE_CHANNEL_NAME = "Default";

/** Validate a channel name. Returns an error string, or null when valid. */
export function validatePrivateChannelName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return "Channel name is required.";
  }
  if (trimmed.length > PRIVATE_CHANNEL_NAME_MAX_LENGTH) {
    return `Channel name must be at most ${PRIVATE_CHANNEL_NAME_MAX_LENGTH} characters.`;
  }
  return null;
}
