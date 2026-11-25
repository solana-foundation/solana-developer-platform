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

/** An organization the picker offers: all it shows and switches by. */
export interface PickableOrganization {
  id: string;
  name: string;
}

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
    <AccountActions
      activeOrganization={activeOrganization ?? null}
      organizations={isLoaded ? (userMemberships.data ?? []).map((m) => m.organization) : []}
      isSwitching={isSwitching}
      onSwitch={(organizationId) => void switchTo(organizationId)}
      onSignOut={() => void signOut({ redirectUrl: "/" })}
    />
  );
}

/**
 * The picker and Sign out, from plain values: the other organizations to switch to, under the
 * active one's name, and both held while a switch runs.
 */
export function AccountActions({
  activeOrganization,
  organizations,
  isSwitching,
  onSwitch,
  onSignOut,
}: {
  activeOrganization: PickableOrganization | null;
  organizations: readonly PickableOrganization[];
  isSwitching: boolean;
  onSwitch: (organizationId: string) => void;
  onSignOut: () => void;
}) {
  const t = useTranslations();
  const others = organizations.filter((organization) => organization.id !== activeOrganization?.id);
  return (
    <div className="flex items-center gap-2">
      {others.length > 0 ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" disabled={isSwitching} aria-busy={isSwitching}>
              {activeOrganization?.name ?? t("Shared.SharedComponents.selectOrganization")}
              <ChevronsUpDownIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {others.map((organization) => (
              <DropdownMenuItem
                key={organization.id}
                disabled={isSwitching}
                onSelect={() => onSwitch(organization.id)}
              >
                {organization.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <Button variant="ghost" size="sm" disabled={isSwitching} onClick={onSignOut}>
        {t("Shared.dashboardShell.signOut")}
      </Button>
    </div>
  );
}
