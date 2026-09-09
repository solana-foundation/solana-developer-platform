import type { PrivateChannelRow } from "@sdp/private-channels/channels";
import { validatePrivateChannelName } from "@sdp/private-channels/channels";
import { PRIVATE_CHANNEL_EVENT_TYPES, type PrivateChannelDto } from "@sdp/types";
import { getAuth } from "@/lib/auth";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { created, noContent, success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import {
  type AppContext,
  getPrivateChannelRepository,
  getPrivateChannelUserRepository,
} from "../context";
import { emitLifecycle, emitMember, requireActiveInstance } from "../helpers";
import type { createChannelBodySchema } from "../schemas";

function toPrivateChannelDto(row: PrivateChannelRow): PrivateChannelDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isDefault: row.is_default,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** GET /channels — list all channels in the active instance (newest first). */
export async function listChannels(c: AppContext) {
  const instance = await requireActiveInstance(c);
  const channels = await getPrivateChannelRepository(c).listChannels({ instanceId: instance.id });
  return success(c, { channels: channels.map(toPrivateChannelDto) });
}

/** POST /channels — create a named channel in the active instance. */
export async function createChannel(c: ValidatedBodyContext<typeof createChannelBodySchema>) {
  const instance = await requireActiveInstance(c);
  const auth = getAuth(c);

  const body = c.req.valid("json");

  const name = body.name.trim();
  const nameError = validatePrivateChannelName(name);
  if (nameError) {
    throw badRequest(nameError);
  }

  const channel = await getPrivateChannelRepository(c).createChannel({
    instanceId: instance.id,
    organizationId: instance.organization_id,
    projectId: instance.project_id,
    name,
    description: body.description?.trim() || null,
  });
  if (!channel) {
    throw conflict("A channel with this name already exists in the instance");
  }

  await emitLifecycle(c, instance, PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_CREATED, {
    channelId: channel.id,
    payload: { name: channel.name },
  });

  // New channels start on the project's default principal. Additional
  // principals receive explicit access from the Principals screen.
  const userRepo = getPrivateChannelUserRepository(c);
  const principal = await userRepo.findDefaultPrincipal(
    { organizationId: instance.organization_id, projectId: instance.project_id },
    instance.id
  );
  if (principal) {
    const membership = await userRepo.addMembership({
      channelId: channel.id,
      privateChannelUserId: principal.id,
      addedBy: auth.userId ?? null,
    });
    if (!membership) {
      throw conflict("The default Private Channels identity is not active");
    }
    await emitMember(
      c,
      {
        organizationId: instance.organization_id,
        projectId: instance.project_id,
        instanceId: instance.id,
      },
      PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_ADDED,
      {
        channelId: channel.id,
        payload: { principalId: principal.id, membershipId: membership.id },
      }
    );
  }

  return created(c, toPrivateChannelDto(channel));
}

/** GET /channels/:id — fetch a single channel in the active instance. */
export async function getChannel(c: AppContext) {
  const instance = await requireActiveInstance(c);
  const channelId = c.req.param("id");
  if (!channelId) {
    throw badRequest("Channel id is required");
  }
  const channel = await getPrivateChannelRepository(c).getChannel({
    channelId,
    instanceId: instance.id,
  });
  if (!channel) {
    throw notFound("Channel");
  }
  return success(c, toPrivateChannelDto(channel));
}

/** DELETE /channels/:id — archive a channel (soft delete). The default is protected. */
export async function deleteChannel(c: AppContext) {
  const instance = await requireActiveInstance(c);
  const channelId = c.req.param("id");
  if (!channelId) {
    throw badRequest("Channel id is required");
  }

  const repo = getPrivateChannelRepository(c);
  const channel = await repo.getChannel({ channelId, instanceId: instance.id });
  if (!channel) {
    throw notFound("Channel");
  }
  if (channel.is_default) {
    throw conflict("The default channel cannot be deleted");
  }

  await repo.archiveChannel({ channelId, instanceId: instance.id });
  await emitLifecycle(c, instance, PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_ARCHIVED, {
    channelId: channel.id,
    payload: { name: channel.name },
  });
  return noContent(c);
}
