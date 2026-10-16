/**
 * Route literals for the Private Channels segment.
 *
 * Deliberately import-free so client components can reach them. These used to
 * live in `private-channels-access.ts`, but that module pulls in `@/flags` and
 * `@clerk/nextjs/server`; importing a constant from it inside a `"use client"`
 * file drags the server-only `flags` package into the browser bundle and the
 * build fails resolving `async_hooks`.
 */

/** Provider detail and connection-management destinations under Integrations. */
export const PRIVATE_CHANNELS_INTEGRATION_PATH = "/dashboard/integrations/private-channels";
export const PRIVATE_CHANNELS_SETUP_PATH = `${PRIVATE_CHANNELS_INTEGRATION_PATH}/setup`;
export const PRIVATE_CHANNELS_OVERVIEW_PATH = "/dashboard/integrations/private-channels/overview";

/** An active Private Channels connection is a persisted, project-scoped instance. */
export function privateChannelsInstancePath(instanceId: string): string {
  return `${PRIVATE_CHANNELS_INTEGRATION_PATH}/${encodeURIComponent(instanceId)}`;
}

export function privateChannelsSetupPath(instanceId: string): string {
  return `${privateChannelsInstancePath(instanceId)}/setup`;
}

export function privateChannelCreatePath(instanceId: string): string {
  return `${privateChannelsInstancePath(instanceId)}/channels/new`;
}

export function privateChannelPath(instanceId: string, channelId: string): string {
  return `${privateChannelsInstancePath(instanceId)}/channels/${encodeURIComponent(channelId)}`;
}
