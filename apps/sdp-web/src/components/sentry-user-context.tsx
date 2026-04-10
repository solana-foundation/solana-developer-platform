"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export function SentryUserContext() {
  const { userId, orgId } = useAuth();
  const { user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress;
  const fallbackName = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  const name = user?.fullName || fallbackName || user?.username || email;

  useEffect(() => {
    if (userId) {
      Sentry.setUser({
        id: userId,
        email,
        name: name || undefined,
      });
      Sentry.setTag("clerk.orgId", orgId ?? "none");
    } else {
      Sentry.setUser(null);
      Sentry.setTag("clerk.orgId", null);
    }
  }, [email, name, orgId, userId]);

  return null;
}
