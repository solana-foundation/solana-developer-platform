"use client";

import {
  SidebarOrgSwitcherSkeleton,
  SidebarUserRowSkeleton,
} from "@/components/dashboard-loading";
import { SidebarNav } from "@/components/layouts";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { OrganizationSwitcher, UserButton, useOrganization, useUser } from "@clerk/nextjs";
import { motion } from "framer-motion";
import { useRef } from "react";

export function DashboardSidebar() {
  const { organization } = useOrganization();
  const { user } = useUser();
  const { isSidebarOpen, setSidebarOpen } = useDashboardWorkspace();
  const userButtonRef = useRef<HTMLDivElement>(null);
  const orgSwitcherRef = useRef<HTMLDivElement>(null);
  const userName =
    user?.fullName ?? user?.username ?? user?.primaryEmailAddress?.emailAddress ?? "";

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
        orgName={organization?.name ?? ""}
        orgImageUrl={organization?.imageUrl}
        userName={userName}
        userImageUrl={user?.imageUrl}
        orgSwitcher={organization ? undefined : <SidebarOrgSwitcherSkeleton />}
        orgSwitcherOverlay={
          <div
            ref={orgSwitcherRef}
            className="absolute inset-0 opacity-0 pointer-events-none [&>div]:pointer-events-auto [&>div]:opacity-100"
          >
            <OrganizationSwitcher hidePersonal />
          </div>
        }
        userRow={user ? undefined : <SidebarUserRowSkeleton />}
        userRowOverlay={
          <div
            ref={userButtonRef}
            className="absolute inset-0 opacity-0 pointer-events-none [&>div]:pointer-events-auto [&>div]:opacity-100"
          >
            <UserButton afterSignOutUrl="/sign-in" />
          </div>
        }
        onOrgClick={() => {
          const trigger = orgSwitcherRef.current?.querySelector("button");
          trigger?.click();
        }}
        onUserClick={() => {
          const trigger = userButtonRef.current?.querySelector("button");
          trigger?.click();
        }}
        onCollapse={() => setSidebarOpen(false)}
      />
    </motion.aside>
  );
}
