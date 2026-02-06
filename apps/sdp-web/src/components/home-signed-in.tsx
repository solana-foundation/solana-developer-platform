"use client";

import { AutoDashboardRedirect } from "@/components/redirects";
import { OrganizationSwitcher, useAuth } from "@clerk/nextjs";

export function HomeSignedInCard() {
  const { isLoaded, orgId } = useAuth();

  if (!isLoaded) {
    return <p className="text-body-md text-[color:var(--text-medium)]">Loading...</p>;
  }

  if (!orgId) {
    return (
      <>
        <h2 className="text-title-md">Select your organization</h2>
        <p className="text-body-md mt-3 text-[color:var(--text-medium)]">
          Choose or create an organization to continue.
        </p>
        <div className="mt-6">
          <OrganizationSwitcher hidePersonal />
        </div>
      </>
    );
  }

  return (
    <>
      <AutoDashboardRedirect />
      <p className="text-body-md text-[color:var(--text-medium)]">Loading your dashboard...</p>
    </>
  );
}
