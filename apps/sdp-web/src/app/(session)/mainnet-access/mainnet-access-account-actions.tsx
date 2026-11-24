"use client";

import { useClerk, useOrganization, useOrganizationList } from "@clerk/nextjs";
import { Button } from "@sdp/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sdp/ui/dropdown-menu";
import { ChevronsUpDownIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/provider";

/**
 * The mainnet request page's way out: another organization of the user's, or signing out. The
 * picker is SDP's own, never Clerk's OrganizationSwitcher: its Manage modal is Clerk's membership
 * UI, which lists everyone as a Member and which the dashboard never exposes (ADR 0012).
 */
export function MainnetAccessAccountActions() {
  const t = useTranslations();
  const router = useRouter();
  const { signOut } = useClerk();
  const { organization: activeOrganization } = useOrganization();
  const { userMemberships, setActive, isLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const [isSwitching, setSwitching] = useState(false);
  const otherOrganizations = (userMemberships.data ?? [])
    .map(({ organization }) => organization)
    .filter((organization) => organization.id !== activeOrganization?.id);

  const switchTo = async (organizationId: string) => {
    if (!setActive) return;
    setSwitching(true);
    try {
      await setActive({ organization: organizationId });
      router.push("/dashboard");
    } catch {
      setSwitching(false);
      toast.error(t("Shared.SharedComponents.changeOrganizationFailed"));
    }
  };

  return (
    <div className="flex items-center gap-2">
      {isLoaded && otherOrganizations.length > 0 ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" disabled={isSwitching} aria-busy={isSwitching}>
              {activeOrganization?.name ?? t("Shared.SharedComponents.selectOrganization")}
              <ChevronsUpDownIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {otherOrganizations.map((organization) => (
              <DropdownMenuItem
                key={organization.id}
                disabled={isSwitching}
                onSelect={() => void switchTo(organization.id)}
              >
                {organization.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        disabled={isSwitching}
        onClick={() => void signOut({ redirectUrl: "/" })}
      >
        {t("Shared.dashboardShell.signOut")}
      </Button>
    </div>
  );
}
