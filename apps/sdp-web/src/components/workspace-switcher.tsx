"use client";

import { useClerk, useOrganization, useOrganizationList } from "@clerk/nextjs";
import { ChevronsUpDownIcon, PlusIcon, Settings2Icon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { cn } from "@/lib/utils";

function OrgAvatar({ name, imageUrl }: { name: string; imageUrl: string | null }) {
  if (imageUrl) {
    // biome-ignore lint/performance/noImgElement: Clerk provides external URLs not in next/image config.
    return (
      <img
        src={imageUrl}
        alt=""
        className="size-6 shrink-0 rounded-md object-cover"
        aria-hidden="true"
      />
    );
  }
  const initials = name.trim().slice(0, 2).toUpperCase() || "?";
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-text-extra-high text-[10px] font-semibold text-white">
      {initials}
    </span>
  );
}

export function WorkspaceSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { organization: activeOrg } = useOrganization();
  const { userMemberships, setActive, isLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const { openOrganizationProfile, openCreateOrganization } = useClerk();
  const { projects, selectedProjectId, selectProject } = useDashboardWorkspace();

  const memberships = userMemberships.data ?? [];
  const activeProject = projects.find((project) => project.id === selectedProjectId) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={activeOrg?.name ?? "Select organization"}
          className={cn(
            "flex h-10 items-center rounded-[var(--button-radius-lg)] text-left transition-colors hover:bg-border-light focus:outline-none focus-visible:ring-2 focus-visible:ring-text-extra-high",
            collapsed ? "w-10 justify-center" : "w-full min-w-0 gap-2 px-2"
          )}
        >
          <OrgAvatar name={activeOrg?.name ?? ""} imageUrl={activeOrg?.imageUrl ?? null} />
          {collapsed ? null : (
            <>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold leading-tight text-text-extra-high">
                  {activeOrg?.name ?? "Select organization"}
                </span>
                {activeProject ? (
                  <span className="truncate text-xs leading-tight text-text-low">
                    {activeProject.name}
                  </span>
                ) : null}
              </span>
              <ChevronsUpDownIcon className="size-4 shrink-0 text-text-low" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-64">
        <DropdownMenuLabel className="text-xs font-medium normal-case tracking-normal text-text-medium">
          Organizations
        </DropdownMenuLabel>
        {memberships.map((membership) => {
          const org = membership.organization;
          const isActive = org.id === activeOrg?.id;

          return (
            <DropdownMenuItem
              key={org.id}
              onSelect={() => {
                if (!isActive && setActive) {
                  void setActive({ organization: org.id });
                }
              }}
              className="gap-2 text-xs"
            >
              <OrgAvatar name={org.name} imageUrl={org.imageUrl} />
              <span className="min-w-0 flex-1 truncate">{org.name}</span>
              {isActive ? (
                <span className="shrink-0 rounded-full bg-border-extra-light px-1.5 py-0.5 text-[10px] font-medium text-text-medium">
                  Current
                </span>
              ) : null}
            </DropdownMenuItem>
          );
        })}
        {isLoaded && memberships.length === 0 ? (
          <p className="px-2.5 py-2 text-xs text-text-low">No organizations yet.</p>
        ) : null}
        {activeOrg ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-medium normal-case tracking-normal text-text-medium">
              Projects
            </DropdownMenuLabel>
            {projects.length === 0 ? (
              <p className="px-2.5 py-2 text-xs text-text-low">No projects yet.</p>
            ) : (
              projects.map((project) => {
                const isActive = project.id === selectedProjectId;
                return (
                  <DropdownMenuItem
                    key={project.id}
                    onSelect={() => selectProject(project.id)}
                    className="gap-2 text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    {isActive ? (
                      <span className="shrink-0 rounded-full bg-border-extra-light px-1.5 py-0.5 text-[10px] font-medium text-text-medium">
                        Current
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                );
              })
            )}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => openCreateOrganization()}
          className="gap-2 text-xs text-text-medium"
        >
          <PlusIcon className="size-4" />
          <span>Create organization</span>
        </DropdownMenuItem>
        {activeOrg ? (
          <DropdownMenuItem
            onSelect={() => openOrganizationProfile()}
            className="gap-2 text-xs text-text-medium"
          >
            <Settings2Icon className="size-4" />
            <span>Manage organization</span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
