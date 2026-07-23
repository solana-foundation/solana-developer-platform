"use client";

import { useClerk, useOrganization, useOrganizationList } from "@clerk/nextjs";
import { ChevronsUpDownIcon, LockIcon, PlusIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";
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
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

function OrgAvatar({ name, imageUrl }: { name: string; imageUrl: string | null }) {
  if (imageUrl) {
    return (
      // biome-ignore lint/performance/noImgElement: Clerk provides external URLs not in next/image config.
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
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-[10px] font-semibold text-on-primary">
      {initials}
    </span>
  );
}

export function WorkspaceSwitcher({
  collapsed = false,
  onOrganizationSwitchingChange,
}: {
  collapsed?: boolean;
  onOrganizationSwitchingChange?: (isSwitching: boolean) => void;
}) {
  const t = useTranslations();
  const { organization: activeOrg } = useOrganization();
  const { userMemberships, setActive, isLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const { openOrganizationProfile, openCreateOrganization } = useClerk();
  const { projects, selectedProjectId, selectProject, isProjectSwitching } =
    useDashboardWorkspace();
  const [isOrganizationSwitching, setOrganizationSwitching] = useState(false);

  const memberships = userMemberships.data ?? [];
  const activeProject = projects.find((project) => project.id === selectedProjectId) ?? null;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-busy={isOrganizationSwitching || isProjectSwitching}
          aria-label={activeOrg?.name ?? t("Shared.SharedComponents.selectOrganization")}
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
                  {activeOrg?.name ?? t("Shared.SharedComponents.selectOrganization")}
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
          {t("Shared.SharedComponents.organizations")}
        </DropdownMenuLabel>
        {memberships.map((membership) => {
          const org = membership.organization;
          const isActive = org.id === activeOrg?.id;

          return (
            <DropdownMenuItem
              key={org.id}
              disabled={isOrganizationSwitching || isProjectSwitching}
              onSelect={() => {
                if (!isActive && setActive) {
                  setOrganizationSwitching(true);
                  onOrganizationSwitchingChange?.(true);
                  const finishSwitch = () => {
                    setOrganizationSwitching(false);
                    onOrganizationSwitchingChange?.(false);
                  };
                  void setActive({ organization: org.id }).then(finishSwitch, finishSwitch);
                }
              }}
              className="gap-2 text-xs"
            >
              <OrgAvatar name={org.name} imageUrl={org.imageUrl} />
              <span className="min-w-0 flex-1 truncate">{org.name}</span>
              {isActive ? (
                <span className="shrink-0 rounded-full bg-fill-subtle px-1.5 py-0.5 text-[10px] font-medium text-secondary">
                  {t("Shared.SharedComponents.current")}
                </span>
              ) : null}
            </DropdownMenuItem>
          );
        })}
        {isLoaded && memberships.length === 0 ? (
          <p className="px-2.5 py-2 text-xs text-tertiary">
            {t("Shared.SharedComponents.noOrganizations")}
          </p>
        ) : null}
        {activeOrg ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-medium normal-case tracking-normal text-secondary">
              {t("Shared.SharedComponents.projects")}
            </DropdownMenuLabel>
            {projects.length === 0 ? (
              <p className="px-2.5 py-2 text-xs text-tertiary">
                {t("Shared.SharedComponents.noProjects")}
              </p>
            ) : (
              projects.map((project) => {
                const isActive = project.id === selectedProjectId;
                const isProduction = project.environment === "production";
                return (
                  <DropdownMenuItem
                    key={project.id}
                    disabled={isProduction || isOrganizationSwitching || isProjectSwitching}
                    onSelect={() => selectProject(project.id)}
                    className="gap-2 text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    {isProduction ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="pointer-events-auto shrink-0 text-tertiary">
                              <LockIcon
                                className="size-3.5"
                                aria-label={t("Shared.SharedComponents.locked")}
                              />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top" align="center">
                            <span className="block">
                              {t("Shared.SharedComponents.sandboxOnly")}
                            </span>
                            <span className="block">
                              {t("Shared.SharedComponents.mainnetSoon")}
                            </span>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : isActive ? (
                      <span className="shrink-0 rounded-full bg-fill-subtle px-1.5 py-0.5 text-[10px] font-medium text-secondary">
                        {t("Shared.SharedComponents.current")}
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
          <span>{t("Shared.SharedComponents.createOrganization")}</span>
        </DropdownMenuItem>
        {activeOrg ? (
          <DropdownMenuItem
            onSelect={() => openOrganizationProfile()}
            className="gap-2 text-xs text-secondary"
          >
            <Settings2Icon className="size-4" />
            <span>{t("Shared.SharedComponents.manageOrganization")}</span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
