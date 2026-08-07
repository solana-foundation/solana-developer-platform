import {
  PRIVATE_CHANNEL_EVENT_TYPES,
  type PrivateChannelMembershipChannelDto,
  type PrivateChannelUserDto,
} from "@sdp/types";
import type {
  PrivateChannelMembershipWithChannelRow,
  PrivateChannelUserWithIdentityRow,
} from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { sendInviteEmail } from "@/lib/spc-invite-email";
import { getLogger } from "@/runtime/logger";
import { inviteMember, mapPrivateChannelError } from "@/services/private-channels";
import type { AppContext } from "../context";
import {
  getPrivateChannelInstanceRepository,
  getPrivateChannelRepository,
  getPrivateChannelUserRepository,
  getProjectUserRepository,
} from "../context";
import { emitMember } from "../helpers";
import { addMembershipBodySchema, inviteMemberBodySchema } from "../schemas";

function toDto(
  row: PrivateChannelUserWithIdentityRow,
  memberships: PrivateChannelMembershipWithChannelRow[]
): PrivateChannelUserDto {
  const channels: PrivateChannelMembershipChannelDto[] = memberships.map((m) => ({
    id: m.channel_id,
    name: m.channel_name,
    isDefault: m.channel_is_default,
  }));
  return {
    id: row.id,
    userId: row.user_id,
    email: row.user_email,
    name: row.user_name,
    projectRole: row.project_role,
    verifiedWalletCount: row.verified_wallet_count,
    invitedAt: row.invited_at,
    channels,
  };
}

export const listPrivateChannelUsers = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const scope = { organizationId: auth.organizationId, projectId };

  const repo = getPrivateChannelUserRepository(c);
  const [rows, membershipsByUser] = await Promise.all([
    repo.listByProject(scope),
    repo.listMembershipsByProject(scope),
  ]);

  const users: PrivateChannelUserDto[] = rows.map((row) =>
    toDto(row, membershipsByUser.get(row.id) ?? [])
  );
  return success(c, { users });
};

// Caller's own workspace membership for the active project. Returns { user: null }
// when the caller isn't a member — the UI uses that to decide whether to show
// invitee-specific affordances (e.g. the wallet-verify button).
export const getAuthenticatedPrivateChannelUser = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  if (!auth.userId) {
    return success(c, { user: null });
  }

  const repo = getPrivateChannelUserRepository(c);
  const scope = { organizationId: auth.organizationId, projectId };
  const row = await repo.getByProjectAndUser(scope, auth.userId);
  if (!row) return success(c, { user: null });

  const memberships = await repo.listMembershipsForUser(row.id);
  return success(c, { user: toDto(row, memberships) });
};

export const getPrivateChannelUser = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const id = c.req.param("privateChannelUserId");
  if (!id) throw badRequest("privateChannelUserId is required");

  const repo = getPrivateChannelUserRepository(c);
  const row = await repo.getById({ organizationId: auth.organizationId, projectId }, id);
  if (!row) throw notFound("Private channel user");

  const memberships = await repo.listMembershipsForUser(row.id);
  return success(c, { user: toDto(row, memberships) });
};

export const invitePrivateChannelUser = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const body = await c.req.json();
  const parsed = inviteMemberBodySchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid invite payload");
  }

  const scope = { organizationId: auth.organizationId, projectId };

  // Instance must exist and be active — SPC user registration requires the
  // configured auth service (guaranteed present on every active instance).
  const instance = await getPrivateChannelInstanceRepository(c).getActiveByProject(scope);
  if (!instance) {
    throw new AppError(
      "CONFLICT",
      "No active Private Channel instance for this project. Connect one first."
    );
  }

  const target = await getProjectUserRepository(c).getByProjectAndUserId(
    projectId,
    parsed.data.userId
  );
  if (!target) throw notFound("Project user");

  try {
    const repo = getPrivateChannelUserRepository(c);
    const { member, inviteToken } = await inviteMember(c.env, repo, {
      ...scope,
      authUrl: instance.auth_url,
      targetUserId: parsed.data.userId,
      targetUserEmail: target.email,
      invitedBy: auth.userId ?? null,
    });

    // Email is scaffolded — log the URL so admins can copy it from stdout.
    const frontendUrl = c.env.FRONTEND_URL ?? "";
    const inviteUrl = frontendUrl
      ? `${frontendUrl.replace(/\/$/, "")}/invite/${encodeURIComponent(inviteToken)}`
      : `<invite token: ${inviteToken}>`;
    await sendInviteEmail({
      to: target.email,
      inviteUrl,
      invitedByName: null,
    });

    return success(c, { user: toDto(member, []), inviteUrl });
  } catch (error) {
    throw mapPrivateChannelError(error);
  }
};

export const deletePrivateChannelUser = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const id = c.req.param("privateChannelUserId");
  if (!id) throw badRequest("privateChannelUserId is required");

  const repo = getPrivateChannelUserRepository(c);
  const scope = { organizationId: auth.organizationId, projectId };
  const user = await repo.getById(scope, id);
  if (!user) throw notFound("Private channel user");

  const memberships = await repo.listMembershipsForUser(user.id);
  const instance = await getPrivateChannelInstanceRepository(c).getActiveByProject(scope);

  const deleted = await repo.deleteById(scope, id);
  if (!deleted) throw notFound("Private channel user");

  // Emit per-channel revokes using memberships captured before delete.
  // Best-effort when no active instance remains (we can't attribute an instance).
  if (instance) {
    const eventScope = {
      organizationId: instance.organization_id,
      projectId: instance.project_id,
      instanceId: instance.id,
    };
    for (const membership of memberships) {
      await emitMember(c, eventScope, PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_REVOKED, {
        channelId: membership.channel_id,
        payload: {
          privateChannelUserId: user.id,
          targetUserId: user.user_id,
          reason: "user_deleted",
        },
      });
    }
  }

  // SPC has no delete-user endpoint; the SPC credential is intentionally
  // orphaned. Log so operators can spot excess accumulation if needed.
  getLogger().info(
    {
      id,
      organizationId: auth.organizationId,
      projectId,
    },
    "[members] deleted private_channel_users row; SPC credential remains orphaned"
  );

  return success(c, { deleted: true });
};

export const addChannelMembership = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const channelId = c.req.param("channelId");
  if (!channelId) throw badRequest("channelId is required");

  const body = await c.req.json();
  const parsed = addMembershipBodySchema.safeParse(body);
  if (!parsed.success) throw badRequest("Invalid membership payload");

  const scope = { organizationId: auth.organizationId, projectId };
  const repo = getPrivateChannelUserRepository(c);

  const user = await repo.getById(scope, parsed.data.privateChannelUserId);
  if (!user) throw notFound("Private channel user");

  const channel = await getPrivateChannelRepository(c).findInProject({
    ...scope,
    channelId,
  });
  if (!channel) throw notFound("Channel");

  const alreadyMember = (await repo.listMembershipsForUser(user.id)).some(
    (m) => m.channel_id === channelId
  );

  const membership = await repo.addMembership({
    channelId,
    privateChannelUserId: user.id,
    addedBy: auth.userId ?? null,
  });

  // Only emit on a genuine add (membership insert is idempotent).
  if (!alreadyMember) {
    await emitMember(
      c,
      {
        organizationId: channel.organization_id,
        projectId: channel.project_id,
        instanceId: channel.instance_id,
      },
      PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_ADDED,
      {
        channelId,
        payload: {
          privateChannelUserId: user.id,
          targetUserId: user.user_id,
          membershipId: membership.id,
        },
      }
    );
  }

  return success(c, { membership });
};

export const removeChannelMembership = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const channelId = c.req.param("channelId");
  const userId = c.req.param("privateChannelUserId");
  if (!channelId || !userId) {
    throw badRequest("channelId and privateChannelUserId are required");
  }

  const scope = { organizationId: auth.organizationId, projectId };
  const repo = getPrivateChannelUserRepository(c);

  // Scope checks: both the user and the channel must belong to this project.
  const user = await repo.getById(scope, userId);
  if (!user) throw notFound("Private channel user");

  const channel = await getPrivateChannelRepository(c).findInProject({
    ...scope,
    channelId,
  });
  if (!channel) throw notFound("Channel");

  const removed = await repo.removeMembership(channelId, userId);
  if (!removed) throw notFound("Membership");

  await emitMember(
    c,
    {
      organizationId: channel.organization_id,
      projectId: channel.project_id,
      instanceId: channel.instance_id,
    },
    PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_REVOKED,
    {
      channelId,
      payload: {
        privateChannelUserId: user.id,
        targetUserId: user.user_id,
      },
    }
  );

  return success(c, { removed: true });
};
