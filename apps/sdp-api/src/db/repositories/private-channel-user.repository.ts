// Owns two compatibility-named tables:
//   - `private_channel_users`        (project identity + SPC credential)
//   - `private_channel_memberships`  (channel × identity junction)
// New identities are project-scoped and do not belong to an SDP user.

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
  /** Legacy SDP-user link. New project principals do not belong to a human. */
  user_id: string | null;
  instance_id: string | null;
  name: string;
  is_default: boolean;
  disabled_at: string | null;
  created_by: string | null;
  verified_wallet_count?: number;
  spc_user_id: string | null;
  spc_username: string | null;
  spc_credential_ciphertext: string | null;
  provisioned_at: string | null;
  invited_by: string | null;
  invite_token: string | null;
  invited_at: string;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Row + joined columns from `users` (denormalized display fields) + verified-wallet count. */
export interface PrivateChannelUserWithIdentityRow extends PrivateChannelUserRow {
  user_email: string | null;
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

export interface ReservePrivateChannelPrincipalInput extends ProjectScope {
  instanceId: string;
  name: string;
  isDefault: boolean;
  createdBy: string | null;
  spcUsername: string;
  spcCredentialCiphertext: string;
}

export interface CompletePrivateChannelPrincipalInput extends ProjectScope {
  id: string;
  spcUserId: string | null;
  spcUsername: string;
  spcCredentialCiphertext: string;
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
  /** Project principals for one connected instance, including disabled rows. */
  listPrincipals(scope: ProjectScope, instanceId: string): Promise<PrivateChannelUserRow[]>;

  /** The active default principal for an instance. */
  findDefaultPrincipal(
    scope: ProjectScope,
    instanceId: string
  ): Promise<PrivateChannelUserRow | null>;

  /** The active default principal for the project's active instance. */
  findDefaultPrincipalByProject(scope: ProjectScope): Promise<PrivateChannelUserRow | null>;

  /** Reserve the unique local identity before creating its upstream SPC user. */
  reservePrincipal(input: ReservePrivateChannelPrincipalInput): Promise<PrivateChannelUserRow>;

  /** Find an incomplete reservation so provisioning can resume its credentials. */
  findPrincipalReservation(
    input: Pick<
      ReservePrivateChannelPrincipalInput,
      "organizationId" | "projectId" | "instanceId" | "name"
    >
  ): Promise<PrivateChannelUserRow | null>;

  /** Attach the successfully registered SPC credentials to a reservation. */
  completePrincipal(input: CompletePrivateChannelPrincipalInput): Promise<PrivateChannelUserRow>;

  /** Remove a reservation that never received an SPC user. */
  deletePrincipalReservation(scope: ProjectScope, id: string): Promise<boolean>;

  /** Disable a non-default principal without erasing operation history. */
  disablePrincipal(scope: ProjectScope, id: string): Promise<boolean>;

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

  /**
   * Insert-if-not-exists while holding the principal row lock. Returns null
   * when the principal is disabled before the insert can commit.
   */
  addMembership(input: AddMembershipInput): Promise<PrivateChannelMembershipRow | null>;

  /** Remove a user from a channel. Returns true if a row was deleted. */
  removeMembership(channelId: string, privateChannelUserId: string): Promise<boolean>;
}
