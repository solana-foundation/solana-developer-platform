"use client";

import { AutoDashboardRedirect } from "@/components/redirects";
import { OrganizationSwitcher, useAuth } from "@clerk/nextjs";

export function HomeSignedInCard() {
  const { isLoaded, orgId } = useAuth();

  if (!isLoaded) {
    return <p className="text-sm text-[rgba(28,28,29,0.72)]">Loading...</p>;
  }

  if (!orgId) {
    return (
      <div className="rounded-3xl border border-[rgba(28,28,29,0.08)] bg-white p-6 shadow-[0_12px_32px_rgba(28,28,29,0.05)]">
        <h2 className="text-[19px] leading-6 font-medium tracking-[0] text-[#1c1c1d]">
          Select your organization
        </h2>
        <p className="mt-3 text-sm text-[rgba(28,28,29,0.72)]">
          Choose or create an organization to continue.
        </p>
        <div className="mt-6">
          <OrganizationSwitcher hidePersonal />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-[rgba(28,28,29,0.08)] bg-white p-6 shadow-[0_12px_32px_rgba(28,28,29,0.05)]">
      <AutoDashboardRedirect />
      <p className="text-sm text-[rgba(28,28,29,0.72)]">Loading your dashboard...</p>
    </div>
  );
}
