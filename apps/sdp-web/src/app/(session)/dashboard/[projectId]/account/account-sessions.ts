import type { SessionStatus } from "@clerk/nextjs/types";

// Clerk's own session vocabulary, so it lives beside the Account code rather than in @sdp/types.
const LIVE_SESSION_STATUSES = ["active", "pending"] as const satisfies readonly SessionStatus[];

/**
 * Whether a Clerk session can still be used: signed in, or signed in with a task pending. Takes a
 * plain string because Clerk types `SessionWithActivitiesResource.status` as one.
 */
export function isLiveSession(session: { status: string }): boolean {
  return LIVE_SESSION_STATUSES.some((status) => status === session.status);
}
