"use client";

import { useAuth } from "@clerk/nextjs";
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/**
 * Identifies the session to Sentry by opaque id only.
 *
 * The email and display name were previously attached here, which put them on
 * every event and in Sentry's issue index regardless of `sendDefaultPii: false`.
 * The Clerk user id resolves to a person in Clerk when someone genuinely needs
 * to reach them, and it correlates issues just as well — so the identifying
 * fields buy nothing that outweighs storing them in a third-party system.
 */
export function SentryUserContext() {
  const { userId, orgId } = useAuth();

  useEffect(() => {
    if (userId) {
      Sentry.setUser({ id: userId });
      Sentry.setTag("clerk.orgId", orgId ?? "none");
    } else {
      Sentry.setUser(null);
      Sentry.setTag("clerk.orgId", null);
    }
  }, [orgId, userId]);

  return null;
}
