"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export function SentryUserContext() {
  const { userId, orgId } = useAuth();
  const { user } = useUser();

  useEffect(() => {
    if (userId) {
      Sentry.setUser({
        id: userId,
        email: user?.primaryEmailAddress?.emailAddress,
      });
      Sentry.setTag("clerk.orgId", orgId ?? "none");
    } else {
      Sentry.setUser(null);
      Sentry.setTag("clerk.orgId", null);
    }
  }, [userId, orgId, user]);

  return null;
}
