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
export const PRIVATE_CHANNELS_CHANNELS_PATH = "/dashboard/integrations/private-channels/channels";
export const PRIVATE_CHANNELS_WALLETS_PATH = "/dashboard/integrations/private-channels/wallets";
