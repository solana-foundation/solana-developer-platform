"use client";

import { SidebarNav } from "@/components/layouts";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { OrganizationSwitcher, UserButton, useOrganization, useUser } from "@clerk/nextjs";
import { motion } from "framer-motion";
import { useRef } from "react";

const organizationSwitcherAppearance = {
  elements: {
    rootBox: "inline-block max-w-[var(--layout-shell-top-control-max-width)]",
    organizationSwitcherTrigger:
      "relative flex h-auto max-w-[var(--layout-shell-top-control-max-width)] items-center gap-[var(--layout-shell-top-controls-gap)] rounded-[10px] border border-[rgba(28,28,29,0.08)] bg-white py-2 pr-3 pl-2 shadow-[0px_1px_3px_0px_rgba(0,0,0,0.1)] outline-none transition-[background-color,box-shadow] duration-150 ease-out hover:bg-[rgba(255,255,255,0.9)] focus-visible:ring-2 focus-visible:ring-[rgba(28,28,29,0.14)] motion-reduce:transition-none after:pointer-events-none after:absolute after:inset-[-1px] after:rounded-[inherit] after:shadow-[inset_0px_-1px_0px_0px_rgba(0,0,0,0.1)] after:content-['']",
    organizationSwitcherTriggerIcon: "h-6 w-6 shrink-0 text-text-extra-low",
    organizationPreview__organizationSwitcherTrigger: "min-w-0 flex flex-1 items-center gap-2",
    organizationPreviewAvatarContainer__organizationSwitcherTrigger: "shrink-0",
    organizationPreviewAvatarBox__organizationSwitcherTrigger: "h-7 w-7 rounded-[6px]",
    organizationPreviewAvatarImage__organizationSwitcherTrigger: "rounded-[6px]",
    organizationPreviewTextContainer__organizationSwitcherTrigger: "min-w-0 flex-1",
    organizationPreviewMainIdentifier__organizationSwitcherTrigger:
      "text-body-lg-bold block truncate text-left text-text-extra-high",
    organizationPreviewSecondaryIdentifier__organizationSwitcherTrigger: "hidden",
    organizationSwitcherPopoverRootBox: "mt-2 w-[22rem] max-w-[calc(100vw-2rem)]",
    organizationSwitcherPopoverCard:
      "overflow-hidden rounded-[24px] border border-[rgba(28,28,29,0.08)] shadow-[0_24px_64px_rgba(28,28,29,0.16)]",
  },
} as const;

export function DashboardSidebar() {
  const { organization } = useOrganization();
  const { user } = useUser();
  const { isSidebarOpen, setSidebarOpen } = useDashboardWorkspace();
  const userButtonRef = useRef<HTMLDivElement>(null);

  return (
    <motion.aside
      initial={false}
      animate={{ width: isSidebarOpen ? "var(--layout-shell-sidebar-width)" : 0 }}
      transition={{ duration: 0.22, ease: "easeInOut" }}
      style={{
        maxWidth: "var(--layout-shell-sidebar-width)",
        pointerEvents: isSidebarOpen ? "auto" : "none",
      }}
      className="relative hidden w-full overflow-hidden lg:sticky lg:top-0 lg:flex lg:h-screen lg:shrink-0"
    >
      <SidebarNav
        orgName={organization?.name ?? "Organization"}
        orgImageUrl={organization?.imageUrl}
        userName={
          user?.fullName ?? user?.username ?? user?.primaryEmailAddress?.emailAddress ?? "User"
        }
        userImageUrl={user?.imageUrl}
        orgSwitcher={
          <OrganizationSwitcher hidePersonal appearance={organizationSwitcherAppearance} />
        }
        onUserClick={() => {
          const trigger = userButtonRef.current?.querySelector("button");
          trigger?.click();
        }}
        onCollapse={() => setSidebarOpen(false)}
        className="border-[var(--layout-shell-frame-border-width)] border-r-0 border-[rgba(28,28,29,0.10)]"
      />

      <div
        ref={userButtonRef}
        className="absolute top-0 left-0 opacity-0 pointer-events-none [&>div]:pointer-events-auto [&>div]:opacity-100"
      >
        <UserButton afterSignOutUrl="/sign-in" />
      </div>
    </motion.aside>
  );
}
