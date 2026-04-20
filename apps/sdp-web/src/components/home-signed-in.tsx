"use client";

import { OrganizationSwitcher, useAuth } from "@clerk/nextjs";
import { AutoDashboardRedirect } from "@/components/redirects";

export function HomeSignedInCard() {
  const { isLoaded, orgId } = useAuth();

  if (!isLoaded) {
    return <p className="text-sm text-text-medium">Loading...</p>;
  }

  if (!orgId) {
    return (
      <div className="rounded-[var(--sdp-surface-radius)] border border-border-light bg-white p-6 shadow-sm">
        <h2 className="text-[19px] leading-6 font-medium text-text-extra-high">
          Select your organization
        </h2>
        <p className="mt-3 text-sm text-text-medium">
          Choose or create an organization to continue.
        </p>
        <div className="mt-6">
          <OrganizationSwitcher hidePersonal />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[var(--sdp-surface-radius)] border border-border-light bg-white p-6 shadow-sm">
      <AutoDashboardRedirect />
      <p className="text-sm text-text-medium">Loading your dashboard...</p>
    </div>
  );
}
