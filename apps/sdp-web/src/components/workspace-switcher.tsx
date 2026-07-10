"use client";

import { useClerk, useOrganization, useOrganizationList } from "@clerk/nextjs";
import { ChevronsUpDownIcon, LockIcon, PlusIcon, Settings2Icon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-[10px] font-semibold text-white">
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
            "flex h-10 items-center rounded-[var(--button-radius-lg)] text-left transition-colors hover:bg-fill-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
            collapsed ? "w-10 justify-center" : "w-full min-w-0 gap-2 px-2"
          )}
        >
          <OrgAvatar name={activeOrg?.name ?? ""} imageUrl={activeOrg?.imageUrl ?? null} />
          {collapsed ? null : (
            <>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold leading-tight text-primary">
                  {activeOrg?.name ?? "Select organization"}
                </span>
                {activeProject ? (
                  <span className="truncate text-xs leading-tight text-tertiary">
                    {activeProject.name}
                  </span>
                ) : null}
              </span>
              <ChevronsUpDownIcon className="size-4 shrink-0 text-tertiary" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-64">
        <DropdownMenuLabel className="text-xs font-medium normal-case tracking-normal text-secondary">
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
                <span className="shrink-0 rounded-full bg-fill-subtle px-1.5 py-0.5 text-[10px] font-medium text-secondary">
                  Current
                </span>
              ) : null}
            </DropdownMenuItem>
          );
        })}
        {isLoaded && memberships.length === 0 ? (
          <p className="px-2.5 py-2 text-xs text-tertiary">No organizations yet.</p>
        ) : null}
        {activeOrg ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-medium normal-case tracking-normal text-secondary">
              Projects
            </DropdownMenuLabel>
            {projects.length === 0 ? (
              <p className="px-2.5 py-2 text-xs text-tertiary">No projects yet.</p>
            ) : (
              projects.map((project) => {
                const isActive = project.id === selectedProjectId;
                const isProduction = project.environment === "production";
                return (
                  <DropdownMenuItem
                    key={project.id}
                    disabled={isProduction}
                    onSelect={() => selectProject(project.id)}
                    className="gap-2 text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    {isProduction ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="pointer-events-auto shrink-0 text-tertiary">
                              <LockIcon className="size-3.5" aria-label="Locked" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top" align="center">
                            <span className="block">Only sandbox mode is supported for now.</span>
                            <span className="block">Mainnet support coming soon.</span>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : isActive ? (
                      <span className="shrink-0 rounded-full bg-fill-subtle px-1.5 py-0.5 text-[10px] font-medium text-secondary">
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
          className="gap-2 text-xs text-secondary"
        >
          <PlusIcon className="size-4" />
          <span>Create organization</span>
        </DropdownMenuItem>
        {activeOrg ? (
          <DropdownMenuItem
            onSelect={() => openOrganizationProfile()}
            className="gap-2 text-xs text-secondary"
          >
            <Settings2Icon className="size-4" />
            <span>Manage organization</span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
