import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { SelectExistingOrganizationPanel } from "@/components/select-existing-organization-panel";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { getSdpAuth } from "@/lib/sdp-api";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const { orgId, userId } = await getSdpAuth();

  if (!userId) {
    redirect(await getAuthEntryPath());
  }

  if (!orgId) {
    return <SelectExistingOrganizationPanel />;
  }

  return children;
}
