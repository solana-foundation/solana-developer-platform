import { hasPermission } from "@sdp/types";
import { type ApiKeyContext, getAuth, requireProjectId } from "@/lib/auth";
import { forbidden } from "@/lib/errors";
import type { AppContext } from "./context";
import { getPrivateChannelUserRepository } from "./context";

export type EventViewer =
  | { scope: "all" }
  | { scope: "member"; channelIds: string[]; userId: string }
  | { scope: "none" };

interface EventViewerResolverDependencies {
  findPrivateChannelUser(
    scope: { organizationId: string; projectId: string },
    userId: string
  ): Promise<{ id: string } | null>;
  listMemberships(privateChannelUserId: string): Promise<Array<{ channel_id: string }>>;
}

export async function resolveEventViewerForAuth(
  auth: ApiKeyContext,
  projectId: string,
  dependencies: EventViewerResolverDependencies
): Promise<EventViewer> {
  if (auth.authType === "api_key") {
    if (auth.projectId !== projectId) {
      throw forbidden("API key is not scoped to the requested project");
    }
    return { scope: "all" };
  }
  if (hasPermission(auth.permissions, "projects:write")) {
    return { scope: "all" };
  }
  if (!auth.userId) {
    return { scope: "none" };
  }

  const scope = { organizationId: auth.organizationId, projectId };
  const privateChannelUser = await dependencies.findPrivateChannelUser(scope, auth.userId);
  if (!privateChannelUser) {
    return { scope: "member", channelIds: [], userId: auth.userId };
  }

  const memberships = await dependencies.listMemberships(privateChannelUser.id);
  return {
    scope: "member",
    channelIds: memberships.map((membership) => membership.channel_id),
    userId: auth.userId,
  };
}

export async function resolveEventViewer(c: AppContext): Promise<EventViewer> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const userRepository = getPrivateChannelUserRepository(c);

  return resolveEventViewerForAuth(auth, projectId, {
    findPrivateChannelUser: (scope, userId) => userRepository.findByProjectAndUser(scope, userId),
    listMemberships: (privateChannelUserId) =>
      userRepository.listMembershipsForUser(privateChannelUserId),
  });
}
