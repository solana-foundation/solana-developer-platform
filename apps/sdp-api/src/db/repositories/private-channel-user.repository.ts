// Owns two tables:
//   - `private_channel_users`        (workspace-level invite + SPC credential)
//   - `private_channel_memberships`  (channel × user junction)
// Rows FK to `users(id)`; SDP-native user identity stays in the `users` table.

import type { RepositoryDbClient } from "./base";

export function generatePrivateChannelUserId(): string {
  return `pcu_${crypto.randomUUID()}`;
}

export function generatePrivateChannelMembershipId(): string {
  return `pcm_${crypto.randomUUID()}`;
}

export interface PrivateChannelUserRow {
  id: string;
  organization_id: string;
  project_id: string;
  user_id: string;
  spc_user_id: string | null;
  spc_username: string | null;
  spc_credential_ciphertext: string | null;
  invited_by: string | null;
  invite_token: string | null;
  invited_at: string;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Row + joined columns from `users` (denormalized display fields) + verified-wallet count. */
export interface PrivateChannelUserWithIdentityRow extends PrivateChannelUserRow {
  user_email: string;
  user_name: string | null;
  /** Number of wallets this member has verified (from private_channel_verified_wallets). */
  verified_wallet_count: number;
  /** Per-project role; null once the user's project_members row is removed. */
  project_role: string | null;
}

export interface PrivateChannelMembershipRow {
  id: string;
  channel_id: string;
  private_channel_user_id: string;
  added_by: string | null;
  added_at: string;
}

/** Channel joined onto a membership row for display. */
export interface PrivateChannelMembershipWithChannelRow extends PrivateChannelMembershipRow {
  channel_name: string;
  channel_is_default: boolean;
}

export interface ProjectScope {
  organizationId: string;
  projectId: string;
}

export interface CreatePrivateChannelUserInput extends ProjectScope {
  userId: string;
  spcUserId: string;
  spcUsername: string;
  spcCredentialCiphertext: string;
  invitedBy: string | null;
  inviteToken: string | null;
}

export interface AddMembershipInput {
  channelId: string;
  privateChannelUserId: string;
  addedBy: string | null;
}

export interface PrivateChannelUserRepositoryContext {
  db: RepositoryDbClient;
}

export interface PrivateChannelUserRepository {
  /** Project-scoped list, joined with `users` for display fields. */
  listByProject(scope: ProjectScope): Promise<PrivateChannelUserWithIdentityRow[]>;

  /** Single row, joined with `users`. Null when not found or not in scope. */
  getById(scope: ProjectScope, id: string): Promise<PrivateChannelUserWithIdentityRow | null>;

  /** Duplicate-invite check before hitting SPC /register. */
  findByProjectAndUser(scope: ProjectScope, userId: string): Promise<PrivateChannelUserRow | null>;

  /** Same as findByProjectAndUser but joined with `users` for display. */
  getByProjectAndUser(
    scope: ProjectScope,
    userId: string
  ): Promise<PrivateChannelUserWithIdentityRow | null>;

  /** Insert only after SPC /register succeeds (invite atomicity). */
  create(input: CreatePrivateChannelUserInput): Promise<PrivateChannelUserWithIdentityRow>;

  /** Hard-delete. FK cascade removes channel memberships. */
  deleteById(scope: ProjectScope, id: string): Promise<boolean>;

  /** All channel memberships for a project's users, keyed by user id (for list join). */
  listMembershipsByProject(
    scope: ProjectScope
  ): Promise<Map<string, PrivateChannelMembershipWithChannelRow[]>>;

  /** Channel memberships for a single user. */
  listMembershipsForUser(
    privateChannelUserId: string
  ): Promise<PrivateChannelMembershipWithChannelRow[]>;

  /** Insert-if-not-exists. Returns the row (existing or newly created). */
  addMembership(input: AddMembershipInput): Promise<PrivateChannelMembershipRow>;

  /** Remove a user from a channel. Returns true if a row was deleted. */
  removeMembership(channelId: string, privateChannelUserId: string): Promise<boolean>;
}
