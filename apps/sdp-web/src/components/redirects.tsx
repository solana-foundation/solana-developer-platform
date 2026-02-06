"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

export function AutoDashboardRedirect() {
  const router = useRouter();
  const { isLoaded, isSignedIn, orgId } = useAuth();

  useEffect(() => {
    if (isLoaded && isSignedIn && orgId) {
      router.replace("/dashboard");
    }
  }, [isLoaded, isSignedIn, orgId, router]);

  return null;
}
