/**
 * Route literals for the Private Channels segment.
 *
 * Deliberately import-free so client components can reach them. These used to
 * live in `private-channels-access.ts`, but that module pulls in `@/flags` and
 * `@clerk/nextjs/server`; importing a constant from it inside a `"use client"`
 * file drags the server-only `flags` package into the browser bundle and the
 * build fails resolving `async_hooks`.
 */

/** Where a page sends the operator when no instance is connected yet. */
export const PRIVATE_CHANNELS_INSTANCE_PATH = "/dashboard/payments/private-channels/instance";
export const PRIVATE_CHANNELS_OVERVIEW_PATH = "/dashboard/payments/private-channels/overview";
