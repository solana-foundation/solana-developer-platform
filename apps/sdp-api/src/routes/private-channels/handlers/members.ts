import {
  PRIVATE_CHANNEL_EVENT_TYPES,
  type PrivateChannelMembershipChannelDto,
  type PrivateChannelPrincipalDto,
} from "@sdp/types";
import type {
  PrivateChannelMembershipWithChannelRow,
  PrivateChannelUserRow,
} from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError, badRequest, conflict, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { mapPrivateChannelError, provisionPrincipal } from "@/services/private-channels";
import type { AppContext } from "../context";
import {
  getPrivateChannelInstanceRepository,
  getPrivateChannelRepository,
  getPrivateChannelUserRepository,
} from "../context";
import { emitMember } from "../helpers";
import type { addPrincipalMembershipBodySchema, createPrincipalBodySchema } from "../schemas";

function toDto(
  row: PrivateChannelUserRow,
  memberships: PrivateChannelMembershipWithChannelRow[]
): PrivateChannelPrincipalDto {
  const channels: PrivateChannelMembershipChannelDto[] = memberships.map((membership) => ({
    id: membership.channel_id,
    name: membership.channel_name,
    isDefault: membership.channel_is_default,
  }));
  return {
    id: row.id,
    name: row.name,
    isDefault: row.is_default,
    status: row.disabled_at ? "disabled" : "active",
    verifiedWalletCount: row.verified_wallet_count ?? 0,
    createdAt: row.created_at,
    channels,
  };
}

async function activeInstance(c: AppContext) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const scope = { organizationId: auth.organizationId, projectId };
  const instance = await getPrivateChannelInstanceRepository(c).getActiveByProject(scope);
  if (!instance) {
    throw new AppError(
      "CONFLICT",
      "No active Private Channel instance for this project. Connect one first."
    );
  }
  return { auth, scope, instance };
}

export const listPrivateChannelPrincipals = async (c: AppContext) => {
  const { auth, scope, instance } = await activeInstance(c);
  const repo = getPrivateChannelUserRepository(c);
  let defaultPrincipal = await repo.findDefaultPrincipal(scope, instance.id);
  if (!defaultPrincipal) {
    try {
      defaultPrincipal = (
        await provisionPrincipal(c.env, repo, {
          ...scope,
          instanceId: instance.id,
          authUrl: instance.auth_url,
          name: "Default",
          isDefault: true,
          createdBy: auth.userId ?? null,
        })
      ).principal;
      const { channel } = await getPrivateChannelRepository(c).getOrCreateDefault({
        instanceId: instance.id,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
      });
      await repo.addMembership({
        channelId: channel.id,
        privateChannelUserId: defaultPrincipal.id,
        addedBy: auth.userId ?? null,
      });
    } catch (error) {
      throw mapPrivateChannelError(error);
    }
  }
  const [rows, memberships] = await Promise.all([
    repo.listPrincipals(scope, instance.id),
    repo.listMembershipsByProject(scope),
  ]);
  return success(c, {
    principals: rows.map((row) => toDto(row, memberships.get(row.id) ?? [])),
  });
};

export const createPrivateChannelPrincipal = async (
  c: ValidatedBodyContext<typeof createPrincipalBodySchema>
) => {
  const { auth, scope, instance } = await activeInstance(c);
  const body = c.req.valid("json");
  try {
    const { principal } = await provisionPrincipal(c.env, getPrivateChannelUserRepository(c), {
      ...scope,
      instanceId: instance.id,
      authUrl: instance.auth_url,
      name: body.name.trim(),
      isDefault: false,
      createdBy: auth.userId ?? null,
    });
    return success(c, { principal: toDto(principal, []) });
  } catch (error) {
    throw mapPrivateChannelError(error);
  }
};

export const disablePrivateChannelPrincipal = async (c: AppContext) => {
  const { scope, instance } = await activeInstance(c);
  const id = c.req.param("principalId");
  if (!id) throw badRequest("principalId is required");

  const repo = getPrivateChannelUserRepository(c);
  const principal = await repo.getById(scope, id);
  if (!principal || principal.instance_id !== instance.id) {
    throw notFound("Private Channels principal");
  }
  if (principal.is_default) {
    throw conflict("The default Private Channels principal cannot be disabled.");
  }
  if (principal.disabled_at) return success(c, { disabled: true });

  const memberships = await repo.listMembershipsForUser(principal.id);
  const disabled = await repo.disablePrincipal(scope, principal.id);
  if (!disabled) throw notFound("Private Channels principal");

  for (const membership of memberships) {
    await repo.removeMembership(membership.channel_id, principal.id);
    await emitMember(
      c,
      { ...scope, instanceId: instance.id },
      PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_REVOKED,
      {
        channelId: membership.channel_id,
        payload: { principalId: principal.id, reason: "principal_disabled" },
      }
    );
  }
  return success(c, { disabled: true });
};

export const addPrincipalChannelMembership = async (
  c: ValidatedBodyContext<typeof addPrincipalMembershipBodySchema>
) => {
  const { auth, scope, instance } = await activeInstance(c);
  const channelId = c.req.param("channelId");
  if (!channelId) throw badRequest("channelId is required");
  const { principalId } = c.req.valid("json");

  const repo = getPrivateChannelUserRepository(c);
  const principal = await repo.getById(scope, principalId);
  if (!principal || principal.instance_id !== instance.id || principal.disabled_at) {
    throw notFound("Active Private Channels principal");
  }
  const channel = await getPrivateChannelRepository(c).findInProject({ ...scope, channelId });
  if (!channel || channel.instance_id !== instance.id) throw notFound("Channel");

  const alreadyMember = (await repo.listMembershipsForUser(principal.id)).some(
    (membership) => membership.channel_id === channelId
  );
  const membership = await repo.addMembership({
    channelId,
    privateChannelUserId: principal.id,
    addedBy: auth.userId ?? null,
  });
  if (!alreadyMember) {
    await emitMember(
      c,
      { ...scope, instanceId: instance.id },
      PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_ADDED,
      {
        channelId,
        payload: { principalId: principal.id, membershipId: membership.id },
      }
    );
  }
  return success(c, { membership });
};

export const removePrincipalChannelMembership = async (c: AppContext) => {
  const { scope, instance } = await activeInstance(c);
  const channelId = c.req.param("channelId");
  const principalId = c.req.param("principalId");
  if (!channelId || !principalId) {
    throw badRequest("channelId and principalId are required");
  }

  const repo = getPrivateChannelUserRepository(c);
  const principal = await repo.getById(scope, principalId);
  if (!principal || principal.instance_id !== instance.id) {
    throw notFound("Private Channels principal");
  }
  const channel = await getPrivateChannelRepository(c).findInProject({ ...scope, channelId });
  if (!channel || channel.instance_id !== instance.id) throw notFound("Channel");

  const removed = await repo.removeMembership(channelId, principalId);
  if (!removed) throw notFound("Membership");
  await emitMember(
    c,
    { ...scope, instanceId: instance.id },
    PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_REVOKED,
    { channelId, payload: { principalId: principal.id } }
  );
  return success(c, { removed: true });
};
