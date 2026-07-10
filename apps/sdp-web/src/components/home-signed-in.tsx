"use client";

import { OrganizationSwitcher, useAuth } from "@clerk/nextjs";
import { AutoDashboardRedirect } from "@/components/redirects";

export function HomeSignedInCard() {
  const { isLoaded, orgId } = useAuth();

  if (!isLoaded) {
    return <p className="text-sm text-secondary">Loading...</p>;
  }

  if (!orgId) {
    return (
      <div className="rounded-[var(--sdp-surface-radius)] border border-border-default bg-white p-6 shadow-sm">
        <h2 className="text-[19px] leading-6 font-medium text-primary">
          Select your organization
        </h2>
        <p className="mt-3 text-sm text-secondary">
          Choose or create an organization to continue.
        </p>
        <div className="mt-6">
          <OrganizationSwitcher hidePersonal />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[var(--sdp-surface-radius)] border border-border-default bg-white p-6 shadow-sm">
      <AutoDashboardRedirect />
      <p className="text-sm text-secondary">Loading your dashboard...</p>
    </div>
  );
}
