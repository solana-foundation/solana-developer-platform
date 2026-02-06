"use client";

import { useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

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
